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
