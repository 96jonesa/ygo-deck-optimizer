import { describe, expect, it } from 'vitest';
import {
  type ChooseFolderApi,
  chooseFolder,
} from '../../../../src/renderer/src/model/choose-folder';
import type { Settings, SettingsPatch, WorkdirHealth } from '../../../../src/shared/types';

function healthOf(path: string, ok: boolean): WorkdirHealth {
  return {
    ok,
    path,
    databases: ok ? 3 : 0,
    stringsConf: ok ? 1 : 0,
    problems: ok ? [] : ['no card database found'],
    notes: [],
  };
}

/** The three api calls the flow makes, recording what was asked of them. */
class FakeApi implements ChooseFolderApi {
  readonly calls: string[] = [];

  constructor(
    private readonly picked: string | null,
    private readonly ok: boolean,
  ) {}

  async pickDirectory(): Promise<string | null> {
    this.calls.push('pick');
    return this.picked;
  }

  async probeWorkdir(dir: string): Promise<WorkdirHealth> {
    this.calls.push(`probe ${dir}`);
    return healthOf(dir, this.ok);
  }

  async setSettings(patch: SettingsPatch): Promise<Settings> {
    this.calls.push(`save ${JSON.stringify(patch)}`);
    return { version: 1, workdir: null, includePrerelease: true, plateauDelta: 0.005, ...patch };
  }
}

describe('chooseFolder', () => {
  it('picks, probes, and saves a folder that probes ok', async () => {
    const api = new FakeApi('/edopro', true);
    expect(await chooseFolder(api)).toEqual({ kind: 'saved', health: healthOf('/edopro', true) });
    expect(api.calls).toEqual(['pick', 'probe /edopro', 'save {"workdir":"/edopro"}']);
  });

  it('does NOT save a folder that is no install, and hands back why', async () => {
    const api = new FakeApi('/downloads', false);
    expect(await chooseFolder(api)).toEqual({
      kind: 'rejected',
      health: healthOf('/downloads', false),
    });
    expect(api.calls).toEqual(['pick', 'probe /downloads']);
  });

  it('does nothing when the dialog is cancelled', async () => {
    const api = new FakeApi(null, true);
    expect(await chooseFolder(api)).toEqual({ kind: 'cancelled' });
    expect(api.calls).toEqual(['pick']);
  });
});
