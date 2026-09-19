import type { Settings, SettingsPatch } from '../../../shared/types';

// The settings panel's arithmetic: the plateau's width reads as percentage
// points, and a save sends only what changed.

/** The most the plateau's width can be, in percentage points: all of it. */
const POINTS_MAX = 100;

/**
 * `plateauDelta` is stored as a probability (TDD §13) and read as percentage
 * points, because that is how a player says it: `0.005` is `0.5` points. The
 * rounding keeps binary floating point out of the field — `0.003 × 100` is
 * `0.30000000000000004`.
 */
export function deltaToPoints(probability: number): string {
  return String(Number((probability * POINTS_MAX).toFixed(6)));
}

/** The field read back as a probability, or `null` when it is not a width. */
export function deltaFromPoints(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const points = Number(trimmed);
  if (!Number.isFinite(points) || points < 0 || points > POINTS_MAX) return null;
  return Number((points / POINTS_MAX).toFixed(8));
}

/**
 * The fields of `next` that actually differ from `current`. An unchanged
 * `workdir` or `includePrerelease` would cost a card reload for nothing (TDD
 * §12), so a save sends the difference, not the form.
 */
export function settingsPatch(current: Settings, next: SettingsPatch): SettingsPatch {
  const patch: SettingsPatch = {};
  if (next.workdir !== undefined && next.workdir !== current.workdir) patch.workdir = next.workdir;
  if (next.includePrerelease !== undefined && next.includePrerelease !== current.includePrerelease)
    patch.includePrerelease = next.includePrerelease;
  if (next.plateauDelta !== undefined && next.plateauDelta !== current.plateauDelta)
    patch.plateauDelta = next.plateauDelta;
  return patch;
}
