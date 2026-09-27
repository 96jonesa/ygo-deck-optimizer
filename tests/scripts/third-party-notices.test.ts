import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  licenseFiles,
  noticesFor,
  productionClosure,
  resolvePackageDir,
  // @ts-expect-error -- plain .mjs script, no type declarations
} from '../../scripts/third-party-notices.mjs';

interface Closed {
  name: string;
  version: string;
  license: string;
  dir: string;
}

const REPO = path.resolve(import.meta.dirname, '../..');

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

/**
 * A throwaway project: `tree` maps a directory under the root to the package
 * manifest written there, plus any files to write beside it.
 */
function project(
  tree: Record<string, { manifest: Record<string, unknown>; files?: Record<string, string> }>,
): string {
  const root = mkdtempSync(path.join(tmpdir(), 'notices-'));
  roots.push(root);
  for (const [dir, { manifest, files = { LICENSE: 'MIT License\n' } }] of Object.entries(tree)) {
    const full = path.join(root, dir);
    mkdirSync(full, { recursive: true });
    writeFileSync(path.join(full, 'package.json'), JSON.stringify(manifest));
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(full, name), text);
  }
  return root;
}

const pkg = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  name,
  version,
  license: 'MIT',
  ...extra,
});

describe('resolvePackageDir', () => {
  it('prefers the nearest node_modules, as Node resolves', () => {
    const root = project({
      '.': { manifest: pkg('app', '1.0.0'), files: {} },
      'node_modules/a': { manifest: pkg('a', '1.0.0') },
      'node_modules/b': { manifest: pkg('b', '2.0.0') },
      'node_modules/a/node_modules/b': { manifest: pkg('b', '1.0.0') },
    });
    expect(resolvePackageDir('b', path.join(root, 'node_modules/a'), root)).toBe(
      path.join(root, 'node_modules/a/node_modules/b'),
    );
    expect(resolvePackageDir('b', root, root)).toBe(path.join(root, 'node_modules/b'));
    expect(resolvePackageDir('nope', root, root)).toBeNull();
  });
});

describe('productionClosure', () => {
  it('walks dependencies transitively, each version once, and never devDependencies', () => {
    const root = project({
      '.': {
        manifest: pkg('app', '1.0.0', {
          dependencies: { a: '*', c: '*' },
          devDependencies: { tooling: '*' },
        }),
        files: {},
      },
      'node_modules/a': { manifest: pkg('a', '1.0.0', { dependencies: { b: '*' } }) },
      'node_modules/c': { manifest: pkg('c', '1.0.0', { dependencies: { b: '*' } }) },
      'node_modules/b': { manifest: pkg('b', '2.0.0') },
      'node_modules/a/node_modules/b': { manifest: pkg('b', '1.0.0') },
      'node_modules/tooling': { manifest: pkg('tooling', '9.9.9') },
    });
    const closed = productionClosure(root).map((p: Closed) => `${p.name}@${p.version}`);
    expect(closed).toEqual(['a@1.0.0', 'b@1.0.0', 'b@2.0.0', 'c@1.0.0']);
  });

  it('includes an installed optional dependency and skips one that is not installed', () => {
    const root = project({
      '.': { manifest: pkg('app', '1.0.0', { dependencies: { a: '*' } }), files: {} },
      'node_modules/a': {
        manifest: pkg('a', '1.0.0', { optionalDependencies: { here: '*', absent: '*' } }),
      },
      'node_modules/here': { manifest: pkg('here', '1.0.0') },
    });
    expect(productionClosure(root).map((p: Closed) => p.name)).toEqual(['a', 'here']);
  });

  it('does not follow peer dependencies', () => {
    const root = project({
      '.': { manifest: pkg('app', '1.0.0', { dependencies: { a: '*' } }), files: {} },
      'node_modules/a': { manifest: pkg('a', '1.0.0', { peerDependencies: { peer: '*' } }) },
      'node_modules/peer': { manifest: pkg('peer', '1.0.0') },
    });
    expect(productionClosure(root).map((p: Closed) => p.name)).toEqual(['a']);
  });

  it('refuses a required dependency that is not installed, naming it', () => {
    const root = project({
      '.': { manifest: pkg('app', '1.0.0', { dependencies: { gone: '*' } }), files: {} },
    });
    expect(() => productionClosure(root)).toThrow(/not installed: gone/);
  });

  /**
   * The real tree. Names only, not versions, so a routine upgrade passes — but
   * a NEW runtime dependency fails here until someone has looked at what it
   * ships and under which license.
   */
  it('is exactly the seven MIT packages this app ships today', () => {
    const closed: Closed[] = productionClosure(REPO);
    expect(closed.map((p) => p.name)).toEqual([
      'js-tokens',
      'loose-envify',
      'react',
      'react-dom',
      'scheduler',
      'sql.js',
      'zustand',
    ]);
    for (const p of closed) expect(p.license, p.name).toBe('MIT');
  });
});

describe('licenseFiles', () => {
  it('finds the spellings packages actually use, and nothing else', () => {
    const root = project({
      '.': {
        manifest: pkg('x', '1.0.0'),
        files: {
          LICENSE: '',
          LICENCE: '',
          'license.md': '',
          'LICENSE-MIT.txt': '',
          'NOTICE.txt': '',
          COPYING: '',
          'README.md': '',
          'index.js': '',
        },
      },
    });
    expect(licenseFiles(root)).toEqual([
      'COPYING',
      'LICENCE',
      'LICENSE',
      'LICENSE-MIT.txt',
      'NOTICE.txt',
      'license.md',
    ]);
  });
});

describe('noticesFor', () => {
  it('reproduces each license in full, under its package', () => {
    const root = project({
      '.': { manifest: pkg('app', '1.0.0', { dependencies: { a: '*' } }), files: {} },
      'node_modules/a': {
        manifest: pkg('a', '1.2.3'),
        files: { LICENSE: 'Copyright (c) Someone\nPermission is hereby granted' },
      },
    });
    const text: string = noticesFor(productionClosure(root));
    expect(text).toMatch(/GNU Affero General Public License/);
    expect(text).toContain('- a 1.2.3 — MIT');
    expect(text).toContain('## a 1.2.3');
    expect(text).toContain('Copyright (c) Someone\nPermission is hereby granted');
  });

  it('refuses a package with no license file rather than leaving it out', () => {
    const root = project({
      '.': { manifest: pkg('app', '1.0.0', { dependencies: { a: '*', b: '*' } }), files: {} },
      'node_modules/a': { manifest: pkg('a', '1.0.0') },
      'node_modules/b': { manifest: pkg('b', '4.5.6'), files: {} },
    });
    expect(() => noticesFor(productionClosure(root))).toThrow(/no license file in b@4\.5\.6/);
  });

  it('covers every package of the real tree', () => {
    const text: string = noticesFor(productionClosure(REPO));
    for (const name of ['react', 'react-dom', 'sql.js', 'zustand'])
      expect(text).toMatch(new RegExp(`^## ${name.replace('.', '\\.')} `, 'm'));
  });
});
