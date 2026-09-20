import { describe, expect, it } from 'vitest';
import type { Description } from '../../../src/core/desc/ast';
import { criterionMeaning, lineMeaning } from '../../../src/core/model/meaning';
import { cardRecord, contextOf, FakeCards } from '../../helpers/desc-context';

const CTX = contextOf(
  new FakeCards([
    cardRecord({ code: 14558127, name: 'Ash Blossom & Joyous Spring' }),
    cardRecord({ code: 89631139, name: 'Blue-Eyes White Dragon' }),
  ]),
);

const LEVEL_4: Description = {
  anyOf: [{ t: 'clause', clause: { kinds: ['monster'], level: [4] } }],
};
const LEVEL_5: Description = {
  anyOf: [{ t: 'clause', clause: { kinds: ['monster'], level: [5] } }],
};

describe('lineMeaning', () => {
  it('reads a card line as the card it names', () => {
    const meant = lineMeaning(
      { id: 'l1', card: { passcode: 14558127, name: 'Ash' }, min: 0, max: 3 },
      CTX,
    );
    expect(meant).toEqual({
      ok: true,
      desc: { anyOf: [{ t: 'card', passcode: 14558127 }] },
      stale: null,
    });
  });

  it('parses the text of a line that has no stored description', () => {
    expect(lineMeaning({ id: 'l1', text: 'level 4 monster', min: 0, max: 3 }, CTX)).toEqual({
      ok: true,
      desc: LEVEL_4,
      stale: null,
    });
  });

  it('carries the parse failure of a line that has no stored description', () => {
    const meant = lineMeaning({ id: 'l1', text: 'level 4 monstr', min: 0, max: 3 }, CTX);
    expect(meant.ok).toBe(false);
    if (meant.ok) throw new Error('expected a failure');
    expect(meant.message).toContain('monstr');
    expect(meant.span).toEqual({ start: 8, end: 14 });
  });

  it('is silent when the stored description is what the text says', () => {
    expect(
      lineMeaning({ id: 'l1', text: 'level 4 monster', desc: LEVEL_4, min: 0, max: 3 }, CTX),
    ).toEqual({ ok: true, desc: LEVEL_4, stale: null });
  });

  it('is silent when the text says the same thing in other words', () => {
    // The comparison is of the canonical ASTs, not of the two strings: a file
    // written before the printer changed its mind about spacing is not stale.
    expect(
      lineMeaning({ id: 'l1', text: 'LEVEL 4 monsters', desc: LEVEL_4, min: 0, max: 3 }, CTX),
    ).toMatchObject({ ok: true, stale: null });
  });

  // TDD §14: the AST is authoritative and the text is kept for editing, so a
  // file whose text no longer reads as its AST still MEANS what it meant — and
  // the line is flagged rather than quietly re-read.
  it('runs the STORED description when the text no longer reads as it, and says so', () => {
    const meant = lineMeaning(
      { id: 'l1', text: 'level 5 monster', desc: LEVEL_4, min: 0, max: 3 },
      CTX,
    );
    expect(meant).toMatchObject({ ok: true, desc: LEVEL_4 });
    expect(meant.ok && meant.stale).toBe(
      'this line means the saved description `level 4 monster`; the text beside it now reads as `level 5 monster`. Editing the text replaces the saved one.',
    );
    expect(meant.ok && meant.desc).not.toEqual(LEVEL_5);
  });

  it('runs the stored description when the text no longer parses at all', () => {
    const meant = lineMeaning(
      { id: 'l1', text: 'level 4 monstr', desc: LEVEL_4, min: 0, max: 3 },
      CTX,
    );
    expect(meant).toMatchObject({ ok: true, desc: LEVEL_4 });
    expect(meant.ok && meant.stale).toContain(
      'this line means the saved description `level 4 monster`; the text beside it no longer parses',
    );
    expect(meant.ok && meant.stale).toContain('monstr');
  });

  it('runs the stored description when the text is empty, which a new line is', () => {
    const meant = lineMeaning({ id: 'l1', text: '', desc: LEVEL_4, min: 0, max: 3 }, CTX);
    expect(meant).toMatchObject({ ok: true, desc: LEVEL_4 });
    expect(meant.ok && meant.stale).not.toBeNull();
  });
});

describe('criterionMeaning', () => {
  const ONE_MONSTER = { op: 'req' as const, n: 1, desc: LEVEL_4 };

  it('parses the text of a criterion that has no stored expression', () => {
    expect(criterionMeaning({ id: 'c1', text: '1x level 4 monster' }, CTX)).toEqual({
      ok: true,
      expr: ONE_MONSTER,
      stale: null,
    });
  });

  it('carries the parse failure of a criterion that has no stored expression', () => {
    const meant = criterionMeaning({ id: 'c1', text: '1x level 4 monstr' }, CTX);
    expect(meant.ok).toBe(false);
  });

  it('is silent when the stored expression is what the text says', () => {
    expect(
      criterionMeaning({ id: 'c1', text: '1x level 4 monster', expr: ONE_MONSTER }, CTX),
    ).toMatchObject({ ok: true, stale: null });
  });

  it('runs the STORED expression when the text no longer reads as it, and says so', () => {
    const meant = criterionMeaning(
      { id: 'c1', text: '2x level 4 monster', expr: ONE_MONSTER },
      CTX,
    );
    expect(meant).toMatchObject({ ok: true, expr: ONE_MONSTER });
    expect(meant.ok && meant.stale).toBe(
      'this criterion means the saved expression `1x level 4 monster`; the text beside it now reads as `2x level 4 monster`. Editing the text replaces the saved one.',
    );
  });

  it('runs the stored expression when the text no longer parses at all', () => {
    const meant = criterionMeaning({ id: 'c1', text: '1x level 4 monstr', expr: ONE_MONSTER }, CTX);
    expect(meant).toMatchObject({ ok: true, expr: ONE_MONSTER });
    expect(meant.ok && meant.stale).toContain('no longer parses');
  });
});
