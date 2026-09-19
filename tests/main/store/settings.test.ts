import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  readSettings,
  type SettingsFs,
  SettingsStore,
} from '../../../src/main/store/settings';
import { tempDirs } from '../../helpers/workdir';

const temp = tempDirs('ygo-settings-');

function fileOf(dir: string): string {
  return path.join(dir, 'settings.json');
}

/**
 * The real filesystem, with a power cut on demand: the next write leaves half
 * its bytes behind and throws, as a crash in the middle of a write would.
 */
class CrashingFs implements SettingsFs {
  crashOnNextWrite = false;
  readonly written: string[] = [];
  readonly renamed: [string, string][] = [];

  readFileSync(file: string, encoding: 'utf8'): string {
    return nodeFs.readFileSync(file, encoding);
  }

  writeFileSync(file: string, data: string): void {
    this.written.push(file);
    if (this.crashOnNextWrite) {
      this.crashOnNextWrite = false;
      nodeFs.writeFileSync(file, data.slice(0, Math.floor(data.length / 2)));
      throw new Error('power cut');
    }
    nodeFs.writeFileSync(file, data);
  }

  renameSync(from: string, to: string): void {
    this.renamed.push([from, to]);
    nodeFs.renameSync(from, to);
  }

  mkdirSync(dir: string, options: { recursive: true }): void {
    nodeFs.mkdirSync(dir, options);
  }
}

describe('defaultSettings', () => {
  it('is version 1, no install, pre-release cards in, a half-point plateau', () => {
    expect(defaultSettings()).toEqual({
      version: 1,
      workdir: null,
      includePrerelease: true,
      plateauDelta: 0.005,
    });
  });

  it('returns a fresh object each time', () => {
    const first = defaultSettings();
    first.workdir = '/mutated';
    expect(defaultSettings().workdir).toBeNull();
  });
});

describe('readSettings', () => {
  it('reads a complete version-1 object as it is', () => {
    const stored = { version: 1, workdir: '/edopro', includePrerelease: false, plateauDelta: 0.01 };
    expect(readSettings(stored)).toEqual(stored);
  });

  it('fills a missing field from the defaults', () => {
    expect(readSettings({ version: 1, workdir: '/edopro' })).toEqual({
      ...defaultSettings(),
      workdir: '/edopro',
    });
  });

  it('replaces a field of the wrong type, or out of range, by its default — one by one', () => {
    const broken = { version: 1, workdir: 7, includePrerelease: 'yes', plateauDelta: -1 };
    expect(readSettings(broken)).toEqual(defaultSettings());
    expect(readSettings({ version: 1, workdir: '', plateauDelta: Number.NaN })).toEqual(
      defaultSettings(),
    );
    expect(readSettings({ version: 1, workdir: '/w', plateauDelta: 2 })).toEqual({
      ...defaultSettings(),
      workdir: '/w',
    });
  });

  it('keeps a plateau of zero, and of one', () => {
    expect(readSettings({ version: 1, plateauDelta: 0 }).plateauDelta).toBe(0);
    expect(readSettings({ version: 1, plateauDelta: 1 }).plateauDelta).toBe(1);
  });

  it('ignores a file of an unknown version entirely, rather than guess at its fields', () => {
    expect(readSettings({ version: 2, workdir: '/from-the-future' })).toEqual(defaultSettings());
    expect(readSettings({ workdir: '/unversioned' })).toEqual(defaultSettings());
  });

  it('reads anything that is not an object as the defaults', () => {
    for (const value of [null, undefined, 3, 'text', [], [{ version: 1 }]])
      expect(readSettings(value)).toEqual(defaultSettings());
  });

  it('falls back to `base`, not the defaults, when given one', () => {
    const base = { ...defaultSettings(), workdir: '/current', plateauDelta: 0.02 };
    expect(
      readSettings({ version: 1, includePrerelease: false, plateauDelta: 'wide' }, base),
    ).toEqual({ ...base, includePrerelease: false });
  });

  it('drops unknown fields', () => {
    expect(readSettings({ version: 1, theme: 'dark' })).toEqual(defaultSettings());
  });
});

describe('SettingsStore', () => {
  it('round-trips through disk: a second store on the same folder reads what the first wrote', () => {
    const dir = temp.dir();
    const written = new SettingsStore(dir).set({ workdir: '/edopro', plateauDelta: 0.01 });
    expect(written).toEqual({
      version: 1,
      workdir: '/edopro',
      includePrerelease: true,
      plateauDelta: 0.01,
    });
    expect(new SettingsStore(dir).get()).toEqual(written);
  });

  it('survives a crash mid-write: the previous settings are intact and still load', () => {
    const dir = temp.dir();
    const fs = new CrashingFs();
    const store = new SettingsStore(dir, fs);
    store.set({ workdir: '/before' });

    fs.crashOnNextWrite = true;
    expect(() => store.set({ workdir: '/after' })).toThrow('power cut');

    expect(new SettingsStore(dir).get().workdir).toBe('/before');
    // Nor does the store that crashed believe what it never managed to write.
    expect(store.get().workdir).toBe('/before');
  });

  describe('get', () => {
    it('returns the defaults when there is no file, and creates none', () => {
      const dir = temp.dir();
      expect(new SettingsStore(dir).get()).toEqual(defaultSettings());
      expect(readdirSync(dir)).toEqual([]);
    });

    it('returns the defaults for a corrupt file, without throwing', () => {
      const dir = temp.dir();
      writeFileSync(fileOf(dir), '{ "version": 1, "workdir": ');
      expect(new SettingsStore(dir).get()).toEqual(defaultSettings());
    });

    it('returns the defaults for an unknown version', () => {
      const dir = temp.dir();
      writeFileSync(fileOf(dir), JSON.stringify({ version: 99, workdir: '/w' }));
      expect(new SettingsStore(dir).get()).toEqual(defaultSettings());
    });

    it('returns the defaults when the file cannot be read at all', () => {
      const dir = temp.dir();
      mkdirSync(fileOf(dir)); // a directory where the file should be
      expect(new SettingsStore(dir).get()).toEqual(defaultSettings());
    });

    it('returns the defaults when the folder does not exist yet', () => {
      expect(new SettingsStore(path.join(temp.dir(), 'not', 'yet')).get()).toEqual(
        defaultSettings(),
      );
    });

    it('hands out copies: mutating one changes nothing', () => {
      const store = new SettingsStore(temp.dir());
      store.get().workdir = '/mutated';
      expect(store.get().workdir).toBeNull();
    });
  });

  describe('set', () => {
    it('changes only the fields of the patch', () => {
      const store = new SettingsStore(temp.dir());
      store.set({ workdir: '/edopro', includePrerelease: false });
      expect(store.set({ plateauDelta: 0.02 })).toEqual({
        version: 1,
        workdir: '/edopro',
        includePrerelease: false,
        plateauDelta: 0.02,
      });
    });

    it('can clear the workdir', () => {
      const store = new SettingsStore(temp.dir());
      store.set({ workdir: '/edopro' });
      expect(store.set({ workdir: null }).workdir).toBeNull();
    });

    it('keeps the current value of a field the patch gets wrong', () => {
      const store = new SettingsStore(temp.dir());
      store.set({ workdir: '/edopro', plateauDelta: 0.02 });
      const patch = { workdir: 5, plateauDelta: -3, version: 7 } as unknown as { workdir: string };
      expect(store.set(patch)).toEqual({
        version: 1,
        workdir: '/edopro',
        includePrerelease: true,
        plateauDelta: 0.02,
      });
    });

    it('writes a temporary file and renames it over settings.json — never the file itself', () => {
      const dir = temp.dir();
      const fs = new CrashingFs();
      new SettingsStore(dir, fs).set({ workdir: '/edopro' });
      expect(fs.written).toEqual([`${fileOf(dir)}.tmp`]);
      expect(fs.renamed).toEqual([[`${fileOf(dir)}.tmp`, fileOf(dir)]]);
      expect(readdirSync(dir)).toEqual(['settings.json']);
    });

    it('writes versioned, human-readable JSON with a trailing newline', () => {
      const dir = temp.dir();
      new SettingsStore(dir).set({ workdir: '/edopro' });
      const raw = readFileSync(fileOf(dir), 'utf8');
      expect(JSON.parse(raw)).toEqual({ ...defaultSettings(), workdir: '/edopro' });
      expect(raw).toContain('\n  "workdir"');
      expect(raw.endsWith('}\n')).toBe(true);
    });

    it('creates the folder when it does not exist yet', () => {
      const dir = path.join(temp.dir(), 'fresh', 'userData');
      new SettingsStore(dir).set({ workdir: '/edopro' });
      expect(existsSync(fileOf(dir))).toBe(true);
    });
  });
});
