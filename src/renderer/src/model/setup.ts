import type { CardStatus, WorkdirHealth } from '../../../shared/types';

// First-run setup (PRD §8.1): what the main region shows while there is no
// card index, and how a probed folder reads.

/**
 * `choose`: nothing usable is set, so the first-run panel asks for a folder.
 * `error`: a folder IS set and the load failed — a moved install, or no
 * database in it — which is a different thing to say, and retryable.
 */
export type SetupStage = 'ready' | 'loading' | 'choose' | 'error';

export function setupStage(status: CardStatus | null): SetupStage {
  // Before the first push, main is still starting: `choose` would flash the
  // first-run panel at someone whose install was detected a moment later.
  if (status === null) return 'loading';
  switch (status.state) {
    case 'ready':
      return 'ready';
    case 'loading':
      return 'loading';
    case 'idle':
      return 'choose';
    case 'error':
      return status.workdir === null ? 'choose' : 'error';
  }
}

/** Why the folder that IS set could not be loaded; empty unless the load failed. */
export function setupFailure(status: CardStatus): string[] {
  if (status.state !== 'error') return [];
  const where = status.workdir ?? 'the chosen folder';
  return [
    `The cards in ${where} could not be loaded.`,
    status.error ?? 'No reason was reported.',
    'The folder may have moved, or may no longer hold a card database. Try again, or choose another folder.',
  ];
}

export interface ProbeReadout {
  ok: boolean;
  headline: string;
  /** Why the folder cannot be used; empty when `ok`. */
  problems: string[];
  /** Worth saying, and no obstacle: a missing `strings.conf`, an empty `cards.cdb`. */
  notes: string[];
}

/**
 * What the probe of a chosen folder says. A missing `strings.conf` is a NOTE
 * (TDD §13): archetype names are unavailable, the folder is still usable — so
 * notes never make it into `problems` and never turn `ok` off.
 */
export function probeReadout(health: WorkdirHealth): ProbeReadout {
  const databases = `${health.databases.toLocaleString('en-US')} card database${health.databases === 1 ? '' : 's'}`;
  const strings = `${health.stringsConf} strings.conf file${health.stringsConf === 1 ? '' : 's'}`;
  return {
    ok: health.ok,
    headline: health.ok
      ? `${health.path} — ${databases}, ${strings}`
      : `Not an EDOPro folder: ${health.path}`,
    problems: health.problems,
    notes: health.notes,
  };
}
