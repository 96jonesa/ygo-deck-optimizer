import type { CardStatus } from '../../../shared/types';

function int(n: number): string {
  return n.toLocaleString('en-US');
}

/** The card status in one line. */
export function statusHeadline(status: CardStatus): string {
  switch (status.state) {
    case 'idle':
      return 'No EDOPro folder chosen yet';
    case 'loading':
      return 'Loading cards…';
    case 'ready':
      return `${int(status.cards)} cards ready`;
    case 'error':
      return `Could not load the cards: ${status.error ?? 'unknown error'}`;
  }
}

export interface StatusChip {
  label: string;
  value: string;
}

/**
 * What the status bar counts of a loaded index (PRD §8.1). Empty in every
 * other state: there is nothing to count, and a row of zeroes would read like
 * an empty database rather than an absent one.
 */
export function statusChips(status: CardStatus | null): StatusChip[] {
  if (status === null || status.state !== 'ready') return [];
  return [
    { label: 'cards', value: int(status.cards) },
    { label: 'databases', value: int(status.databases) },
    { label: 'archetypes', value: status.setnames === null ? 'none' : int(status.setnames) },
    { label: 'conflicts', value: int(status.conflicts) },
  ];
}

/** How loudly the status bar should say it: `warn` covers "usable, but look at this". */
export type StatusTone = 'ok' | 'busy' | 'warn' | 'bad';

export function statusTone(status: CardStatus | null): StatusTone {
  if (status === null || status.state === 'loading') return 'busy';
  if (status.state === 'error') return 'bad';
  if (status.state === 'idle') return 'warn';
  // Loaded, but something about the load deserves a look (TDD §4.4).
  return status.conflicts > 0 || status.skippedDatabases > 0 || status.setnames === null
    ? 'warn'
    : 'ok';
}

/** The card status as label / value rows (PRD §8.1: show what was loaded). */
export function statusRows(status: CardStatus): [label: string, value: string][] {
  const rows: [string, string][] = [
    ['State', status.state],
    ['Folder', status.workdir ?? '—'],
  ];
  if (status.state !== 'ready') return rows;
  const skipped = status.skippedDatabases > 0 ? ` (${int(status.skippedDatabases)} skipped)` : '';
  rows.push(
    ['Databases', `${int(status.databases)}${skipped}`],
    ['Cards', int(status.cards)],
    [
      'Archetype names',
      status.setnames === null
        ? 'none — no strings.conf found, so archetype descriptions are unavailable'
        : int(status.setnames),
    ],
    ['Conflicts', int(status.conflicts)],
  );
  return rows;
}
