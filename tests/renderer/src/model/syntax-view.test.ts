import { describe, expect, it } from 'vitest';
import { textRuns } from '../../../../src/renderer/src/model/syntax-view';
import { EXAMPLE_SECTIONS, FACT_SECTIONS } from '../../../../src/shared/syntax';

describe('textRuns', () => {
  it('reads plain text as one run of prose', () => {
    expect(textRuns('a limit, counted over the whole hand')).toEqual([
      { code: false, text: 'a limit, counted over the whole hand' },
    ]);
  });

  it('marks a backticked span as code', () => {
    expect(textRuns('the `x` is optional')).toEqual([
      { code: false, text: 'the ' },
      { code: true, text: 'x' },
      { code: false, text: ' is optional' },
    ]);
  });

  it('marks every span, not only the first', () => {
    expect(textRuns('`or` joins descriptions; `/` joins values')).toEqual([
      { code: true, text: 'or' },
      { code: false, text: ' joins descriptions; ' },
      { code: true, text: '/' },
      { code: false, text: ' joins values' },
    ]);
  });

  it('drops the empty runs a leading or adjacent backtick would make', () => {
    expect(textRuns('`a``b`')).toEqual([
      { code: true, text: 'a' },
      { code: true, text: 'b' },
    ]);
  });

  /**
   * An odd backtick is a typo in the reference, not a reason to lose the
   * sentence: the tail stays, as prose. The test below keeps the reference
   * itself free of them, so this is only the safety net.
   */
  it('keeps the tail of an unclosed span as prose', () => {
    expect(textRuns('write `FIRE/WATER instead')).toEqual([
      { code: false, text: 'write ' },
      { code: false, text: 'FIRE/WATER instead' },
    ]);
  });

  it('reads the empty string as nothing at all', () => {
    expect(textRuns('')).toEqual([]);
  });

  // The reference is the only caller, and a stray backtick in it would render
  // as prose rather than loudly: this is what notices one.
  it('finds every backtick in the reference paired', () => {
    const prose = [
      ...EXAMPLE_SECTIONS.flatMap((section) => [
        section.blurb,
        ...section.notes,
        ...section.groups.flatMap((group) => [
          group.heading,
          group.note ?? '',
          ...group.rows.map((row) => row.means),
        ]),
      ]),
      ...FACT_SECTIONS.flatMap((section) => [
        section.blurb,
        ...section.notes,
        ...section.rows.map((row) => `${row.label} ${row.means}`),
      ]),
    ];
    for (const text of prose) expect((text.match(/`/g) ?? []).length % 2, text).toBe(0);
  });
});
