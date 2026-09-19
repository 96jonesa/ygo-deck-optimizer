import * as nodeFs from 'node:fs';
import path from 'node:path';
import type { Settings, SettingsPatch } from '../../shared/types';

// `settings.json` under the app's user-data folder (TDD §13): the sibling's
// `SettingsStore`, lifted. Node only — the folder is injected, so nothing here
// imports Electron.

/** The slice of `node:fs` the store uses; injectable so a crash mid-write can be staged. */
export interface SettingsFs {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string): void;
  renameSync(from: string, to: string): void;
  mkdirSync(dir: string, options: { recursive: true }): unknown;
}

export const SETTINGS_VERSION = 1;

export function defaultSettings(): Settings {
  return { version: SETTINGS_VERSION, workdir: null, includePrerelease: true, plateauDelta: 0.005 };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The settings in `value` — a parsed file, or a patch from the renderer — read
 * field by field: a field that is missing or not what it should be keeps its
 * value in `base`. A file of another version is not guessed at: it reads as
 * `base` whole. Never throws.
 */
export function readSettings(value: unknown, base: Settings = defaultSettings()): Settings {
  const settings = { ...base, version: SETTINGS_VERSION } satisfies Settings;
  if (!isObject(value) || value.version !== SETTINGS_VERSION) return settings;
  const { workdir, includePrerelease, plateauDelta } = value;
  if (workdir === null || (typeof workdir === 'string' && workdir !== ''))
    settings.workdir = workdir;
  if (typeof includePrerelease === 'boolean') settings.includePrerelease = includePrerelease;
  // A probability; NaN fails both comparisons.
  if (typeof plateauDelta === 'number' && plateauDelta >= 0 && plateauDelta <= 1)
    settings.plateauDelta = plateauDelta;
  return settings;
}

/** Versioned JSON settings, loaded tolerantly and written write-then-rename. */
export class SettingsStore {
  private readonly file: string;
  private cached: Settings | null = null;

  constructor(
    userDataDir: string,
    private readonly fs: SettingsFs = nodeFs,
  ) {
    this.file = path.join(userDataDir, 'settings.json');
  }

  /** A missing, unreadable, corrupt or unknown-version file is the defaults: settings never block startup. */
  get(): Settings {
    if (this.cached === null) {
      let stored: unknown;
      try {
        stored = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      } catch {
        stored = undefined;
      }
      this.cached = readSettings(stored);
    }
    return { ...this.cached };
  }

  /**
   * Change the fields of `patch` and persist. The file is written whole to a
   * temporary name and renamed into place, so a crash mid-write cannot leave
   * half a file behind; if the write fails, this throws and nothing changed.
   */
  set(patch: SettingsPatch): Settings {
    const next = readSettings({ ...patch, version: SETTINGS_VERSION }, this.get());
    this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    this.fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
    this.fs.renameSync(temporary, this.file);
    this.cached = next;
    return { ...next };
  }
}
