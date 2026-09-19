import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no type declarations
import { isAllowed } from '../../scripts/check-licenses.mjs';

describe('isAllowed', () => {
  it('accepts permissive licenses', () => {
    for (const id of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'BlueOak-1.0.0'])
      expect(isAllowed(id)).toBe(true);
  });

  it('rejects copyleft licenses', () => {
    for (const id of ['GPL-3.0', 'AGPL-3.0-or-later', 'LGPL-2.1', 'MPL-2.0', 'EPL-2.0'])
      expect(isAllowed(id)).toBe(false);
  });

  it('rejects a license it has never heard of, and a missing one', () => {
    expect(isAllowed('SEE LICENSE IN LICENSE.txt')).toBe(false);
    expect(isAllowed('UNLICENSED')).toBe(false);
    expect(isAllowed('')).toBe(false);
  });

  it('passes an OR expression when either side is allowed', () => {
    expect(isAllowed('(MIT OR GPL-3.0)')).toBe(true);
    expect(isAllowed('WTFPL OR ISC')).toBe(true);
    expect(isAllowed('(GPL-2.0 OR LGPL-3.0)')).toBe(false);
  });

  it('needs every side of an AND expression', () => {
    expect(isAllowed('MIT AND Apache-2.0')).toBe(true);
    expect(isAllowed('MIT AND GPL-3.0')).toBe(false);
  });
});
