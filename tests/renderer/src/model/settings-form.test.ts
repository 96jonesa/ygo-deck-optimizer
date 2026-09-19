import { describe, expect, it } from 'vitest';
import {
  deltaFromPoints,
  deltaToPoints,
  settingsPatch,
} from '../../../../src/renderer/src/model/settings-form';
import type { Settings } from '../../../../src/shared/types';

function settings(over: Partial<Settings> = {}): Settings {
  return { version: 1, workdir: '/edopro', includePrerelease: true, plateauDelta: 0.005, ...over };
}

describe('deltaToPoints', () => {
  it('shows the stored probability 0.005 as half a percentage point', () => {
    expect(deltaToPoints(0.005)).toBe('0.5');
  });

  it('shows a whole point as a whole number', () => {
    expect(deltaToPoints(0.01)).toBe('1');
  });

  it('shows zero width as zero', () => {
    expect(deltaToPoints(0)).toBe('0');
  });

  it('does not let binary floating point leak into the field', () => {
    expect(deltaToPoints(0.003)).toBe('0.3');
    expect(deltaToPoints(0.07)).toBe('7');
  });
});

describe('deltaFromPoints', () => {
  it('reads half a percentage point back as the stored probability', () => {
    expect(deltaFromPoints('0.5')).toBe(0.005);
  });

  it('round-trips every value the field can show', () => {
    for (const probability of [0, 0.001, 0.005, 0.01, 0.1, 1])
      expect(deltaFromPoints(deltaToPoints(probability))).toBe(probability);
  });

  it('accepts a field the user is still typing in, and surrounding spaces', () => {
    expect(deltaFromPoints(' 2 ')).toBe(0.02);
  });

  it('refuses what is not a number', () => {
    expect(deltaFromPoints('')).toBeNull();
    expect(deltaFromPoints('half')).toBeNull();
    expect(deltaFromPoints('.')).toBeNull();
  });

  it('refuses a width outside 0–100 points, which is no probability', () => {
    expect(deltaFromPoints('-1')).toBeNull();
    expect(deltaFromPoints('101')).toBeNull();
    expect(deltaFromPoints('100')).toBe(1);
  });
});

describe('settingsPatch', () => {
  it('sends only what changed', () => {
    expect(settingsPatch(settings(), { includePrerelease: false })).toEqual({
      includePrerelease: false,
    });
  });

  it('sends nothing when nothing changed — an unchanged workdir would reload the cards for no reason', () => {
    expect(
      settingsPatch(settings(), {
        workdir: '/edopro',
        includePrerelease: true,
        plateauDelta: 0.005,
      }),
    ).toEqual({});
  });

  it('sends a changed folder', () => {
    expect(settingsPatch(settings(), { workdir: '/other' })).toEqual({ workdir: '/other' });
  });

  it('sends a cleared folder, which is not the same as leaving it alone', () => {
    expect(settingsPatch(settings(), { workdir: null })).toEqual({ workdir: null });
  });

  it('ignores a field the caller did not mention', () => {
    expect(settingsPatch(settings({ includePrerelease: false }), { plateauDelta: 0.01 })).toEqual({
      plateauDelta: 0.01,
    });
  });

  it('sends every field that changed at once', () => {
    expect(settingsPatch(settings(), { workdir: '/other', plateauDelta: 0.02 })).toEqual({
      workdir: '/other',
      plateauDelta: 0.02,
    });
  });
});
