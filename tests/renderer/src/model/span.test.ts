import { describe, expect, it } from 'vitest';
import { splitAtSpan } from '../../../../src/renderer/src/model/span';

describe('splitAtSpan', () => {
  it('cuts the text into what precedes the span, the span, and what follows', () => {
    expect(splitAtSpan('level 4 monstr', { start: 8, end: 14 })).toEqual({
      before: 'level 4 ',
      at: 'monstr',
      after: '',
    });
    expect(splitAtSpan('levl 4 monster', { start: 0, end: 4 })).toEqual({
      before: '',
      at: 'levl',
      after: ' 4 monster',
    });
  });

  it('gives an empty middle for a span at the end of the text: something is missing there', () => {
    expect(splitAtSpan('normal', { start: 6, end: 6 })).toEqual({
      before: 'normal',
      at: '',
      after: '',
    });
  });

  it('clamps a span that does not fit the text, losing none of it', () => {
    for (const span of [
      { start: -3, end: 2 },
      { start: 4, end: 99 },
      { start: 5, end: 2 },
      { start: 50, end: 60 },
    ]) {
      const { before, at, after } = splitAtSpan('monster', span);
      expect(before + at + after).toBe('monster');
    }
    expect(splitAtSpan('monster', { start: 5, end: 2 }).at).toBe('');
  });
});
