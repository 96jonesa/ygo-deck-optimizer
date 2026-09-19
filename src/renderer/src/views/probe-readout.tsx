import type { WorkdirHealth } from '../../../shared/types';
import { probeReadout } from '../model/setup';

/**
 * What the probe of a chosen folder found. A problem is why the folder cannot
 * be used; a note is worth saying and is no obstacle — a missing
 * `strings.conf` costs archetype names and nothing else (TDD §13).
 */
export function ProbeReadout({ health }: { health: WorkdirHealth }) {
  const readout = probeReadout(health);
  return (
    <div className={readout.ok ? 'probe' : 'probe bad'} data-testid="probe">
      <p className="path">{readout.headline}</p>
      {(readout.problems.length > 0 || readout.notes.length > 0) && (
        <ul>
          {readout.problems.map((problem) => (
            <li key={problem} className="problem">
              {problem}
            </li>
          ))}
          {readout.notes.map((note) => (
            <li key={note} className="note">
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
