// Third-party notices for the packaged app (TDD §17, PRD §4.4). The installers
// bundle the production dependencies into `out/`, and every one of their
// licenses (MIT, and others like it) asks that its notice travel with copies —
// so `package:mac` and `package:win` write this file and electron-builder ships
// it beside the app, next to the AGPL text of the app itself.
//
// The dependency closure is walked HERE, from `package.json`'s `dependencies`,
// rather than asked of `npm ls --omit=dev`: that answer depends on how the tree
// was installed, and a tree installed with dev dependencies reports vitest and
// esbuild as production packages. What the app can contain is what
// `dependencies` reaches, and nothing else.
//
// A package with no license file is an ERROR, not a gap in the output: a
// notices file that silently omits a package is worse than none, because it
// looks complete.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[a-z-]+|-[a-z-]+(\.[a-z]+)?)?$/i;

/** Where `name` resolves from `fromDir`, as Node does: the nearest `node_modules` up the tree. */
export function resolvePackageDir(name, fromDir, rootDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.resolve(dir) === path.resolve(rootDir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readManifest(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function licenseOf(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === 'string') return license;
  if (license && typeof license.type === 'string') return license.type;
  if (Array.isArray(licenses)) return licenses.map((l) => l.type).join(' OR ');
  return '(no license field)';
}

/**
 * Every package the project's `dependencies` reach, each once, sorted by name.
 * `optionalDependencies` count when installed (they ship when present); peer
 * dependencies do not, since whatever satisfies them is reached on its own.
 */
export function productionClosure(rootDir) {
  const root = readManifest(rootDir);
  const seen = new Map();
  const queue = Object.keys(root.dependencies ?? {}).map((name) => ({
    name,
    from: rootDir,
    required: true,
  }));
  const missing = [];
  while (queue.length > 0) {
    const { name, from, required } = queue.shift();
    const dir = resolvePackageDir(name, from, rootDir);
    if (dir === null) {
      if (required) missing.push(name);
      continue;
    }
    const manifest = readManifest(dir);
    const key = `${manifest.name}@${manifest.version}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      name: manifest.name,
      version: manifest.version,
      license: licenseOf(manifest),
      dir,
    });
    for (const dep of Object.keys(manifest.dependencies ?? {}))
      queue.push({ name: dep, from: dir, required: true });
    for (const dep of Object.keys(manifest.optionalDependencies ?? {}))
      queue.push({ name: dep, from: dir, required: false });
  }
  if (missing.length > 0)
    throw new Error(
      `third-party-notices: not installed: ${[...new Set(missing)].join(', ')} — run npm ci`,
    );
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/** The license and notice files of the package in `dir`, by name, e.g. `LICENSE`, `NOTICE.txt`. */
export function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort();
}

/** The notices document for `packages`; throws naming every package that carries no license file. */
export function noticesFor(packages, { appName = 'YGO Deck Optimizer' } = {}) {
  const without = packages.filter((pkg) => licenseFiles(pkg.dir).length === 0);
  if (without.length > 0)
    throw new Error(
      `third-party-notices: no license file in ${without.map((p) => `${p.name}@${p.version}`).join(', ')}`,
    );
  const out = [
    '# Third-party notices',
    '',
    `${appName} is free software under the GNU Affero General Public License, version 3 or (at your option) any later version — see LICENSE. It includes the following third-party packages, each under its own license, reproduced in full below.`,
    '',
    "Electron and Chromium ship their own licenses with the app, as `LICENSE.electron.txt` and `LICENSES.chromium.html` — on macOS in the app's `Contents/Resources` folder beside this file, on Windows in the install folder beside the executable.",
    '',
    ...packages.map((pkg) => `- ${pkg.name} ${pkg.version} — ${pkg.license}`),
    '',
  ];
  for (const pkg of packages) {
    out.push('---', '', `## ${pkg.name} ${pkg.version}`, '', `License: ${pkg.license}`, '');
    for (const file of licenseFiles(pkg.dir)) {
      out.push(
        `### ${file}`,
        '',
        '```',
        readFileSync(path.join(pkg.dir, file), 'utf8').trimEnd(),
        '```',
        '',
      );
    }
  }
  return `${out.join('\n')}\n`;
}

function main() {
  const target = process.argv[2] ?? path.join('out', 'THIRD_PARTY_NOTICES.md');
  const packages = productionClosure(process.cwd());
  const text = noticesFor(packages);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
  console.log(`third-party-notices: ${packages.length} packages → ${target}`);
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) main();
