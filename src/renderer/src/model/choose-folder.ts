import type { RendererApi } from '../../../shared/ipc';
import type { WorkdirHealth } from '../../../shared/types';

export type ChooseFolderApi = Pick<RendererApi, 'pickDirectory' | 'probeWorkdir' | 'setSettings'>;

export type ChooseFolderOutcome =
  | { kind: 'cancelled' }
  /** Not an install: nothing was saved, and `health.problems` says why. */
  | { kind: 'rejected'; health: WorkdirHealth }
  /** Saved as the workdir; main reloads the cards and pushes the status. */
  | { kind: 'saved'; health: WorkdirHealth };

/** "Choose EDOPro folder…" (PRD §8.1): pick → probe → save, the last only if the probe is ok. */
export async function chooseFolder(api: ChooseFolderApi): Promise<ChooseFolderOutcome> {
  const dir = await api.pickDirectory();
  if (dir === null) return { kind: 'cancelled' };
  const health = await api.probeWorkdir(dir);
  if (!health.ok) return { kind: 'rejected', health };
  await api.setSettings({ workdir: dir });
  return { kind: 'saved', health };
}
