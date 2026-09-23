import { describe, expect, it } from 'vitest';
import type { Expr } from '../../../src/core/criteria/ast';
import {
  CRITERION_FIELDS,
  exprFields,
  FIELD_NAMES,
  fieldIsEmpty,
  filledFields,
  labelledFields,
  parseCriterionField,
  parseCriterionFields,
  splitsTheHand,
  v1Fields,
} from '../../../src/core/criteria/fields';
import { parseCriterion } from '../../../src/core/criteria/parser';
import { cardRecord, contextOf, FakeCards } from '../../helpers/desc-context';

const ctx = contextOf(
  new FakeCards([
    cardRecord({ code: 1, name: 'C' }),
    cardRecord({ code: 2, name: 'Then Finally' }),
  ]),
);

/** A text parsed by the plain criterion parser, which must succeed. */
function expr(text: string, maxDrawnSlots?: number): Expr {
  const result = parseCriterion(text, ctx, maxDrawnSlots === undefined ? {} : { maxDrawnSlots });
  if (!result.ok) throw new Error(`${text}: ${result.message}`);
  return result.expr;
}

describe('CRITERION_FIELDS', () => {
  it('lists the fields in the order the cards arrive, each with the name readouts use', () => {
    expect(CRITERION_FIELDS).toEqual(['opening', 'drawn', 'text']);
    expect(FIELD_NAMES).toEqual({ opening: 'opening 5', drawn: 'drawn', text: 'whole hand' });
  });
});

describe('fieldIsEmpty', () => {
  it('is true of nothing, and of spaces alone: an empty field asks nothing', () => {
    expect(fieldIsEmpty(undefined)).toBe(true);
    expect(fieldIsEmpty('')).toBe(true);
    expect(fieldIsEmpty('   ')).toBe(true);
    expect(fieldIsEmpty('1x monster')).toBe(false);
  });
});

describe('filledFields', () => {
  it('is the fields that say something, in window order', () => {
    expect(filledFields({ text: '1x trap', opening: '1x monster' })).toEqual(['opening', 'text']);
    expect(filledFields({ text: ' ', drawn: 'no trap' })).toEqual(['drawn']);
    expect(filledFields({ text: '' })).toEqual([]);
  });
});

describe('splitsTheHand', () => {
  it('is true exactly when the opening-5 or drawn-cards field says something', () => {
    expect(splitsTheHand({ text: '1x monster' })).toBe(false);
    expect(splitsTheHand({ text: '1x monster', opening: '  ' })).toBe(false);
    expect(splitsTheHand({ text: '', opening: '1x monster' })).toBe(true);
    expect(splitsTheHand({ text: '', drawn: 'no trap' })).toBe(true);
  });
});

describe('labelledFields', () => {
  it('is the whole-hand text as typed when it is the only field', () => {
    expect(labelledFields({ text: '1x monster,  no trap' })).toBe('1x monster,  no trap');
  });

  it('names each filled field otherwise, in window order', () => {
    expect(labelledFields({ opening: ' 1x monster ', drawn: 'no trap', text: '2x spell' })).toBe(
      'opening 5: 1x monster · drawn: no trap · whole hand: 2x spell',
    );
    expect(labelledFields({ drawn: 'no trap', text: '' })).toBe('drawn: no trap');
  });
});

describe('parseCriterionField', () => {
  describe('the keywords the fields replaced', () => {
    it('refuses `then` with the span of the word and the field to use instead', () => {
      const text = '1x monster then 1x trap';
      for (const field of ['opening', 'text'] as const) {
        const result = parseCriterionField(field, text, ctx);
        expect(result.ok, field).toBe(false);
        if (result.ok) continue;
        expect(result.message, field).toBe(
          'no `then` needed — put what the drawn cards must be in the drawn-cards field (going second, the second of the three)',
        );
        expect(text.slice(result.span.start, result.span.end)).toBe('then');
      }
      expect(parseCriterionField('drawn', 'then 1x trap', ctx)).toMatchObject({
        ok: false,
        message: 'no `then` needed: this field is already about the cards you draw',
      });
    });

    it('refuses `finally` likewise, in any case', () => {
      const text = '1x monster FINALLY at most 1x trap';
      const result = parseCriterionField('opening', text, ctx);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.message).toContain('no `finally` needed — put what the whole hand must hold');
      expect(text.slice(result.span.start, result.span.end)).toBe('FINALLY');
      expect(parseCriterionField('text', 'finally 1x trap', ctx)).toMatchObject({
        ok: false,
        message: 'no `finally` needed: this field is already about the whole hand',
      });
    });

    it('leaves the words alone inside a card name', () => {
      expect(parseCriterionField('opening', '1x [Then Finally]', ctx).ok).toBe(true);
    });
  });

  describe('the drawn-cards field', () => {
    it('holds one card where nothing draws, refused with the span of the whole field', () => {
      const text = '  1x monster and 1x trap ';
      const result = parseCriterionField('drawn', text, ctx);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.message).toContain('the card you draw is one card, and this asks 2 of it');
      expect(result.message).toContain('in the drawn-cards field');
      expect(text.slice(result.span.start, result.span.end)).toBe('1x monster and 1x trap');
    });

    it('holds what the draw cards can fetch where a line draws', () => {
      expect(parseCriterionField('drawn', '2x monster', ctx, { maxDrawnSlots: 3 }).ok).toBe(true);
      const result = parseCriterionField('drawn', '4x monster', ctx, { maxDrawnSlots: 3 });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.message).toContain('you draw at most 3 cards here');
    });

    it('takes limits alone, which cost no card', () => {
      expect(parseCriterionField('drawn', 'no trap and at most 1x spell', ctx).ok).toBe(true);
    });
  });

  it('bounds the opening five and the whole hand by NOTHING on the text: `expand` drops', () => {
    expect(parseCriterionField('opening', '6x monster', ctx).ok).toBe(true);
    expect(parseCriterionField('text', '7x monster', ctx).ok).toBe(true);
  });

  it('hands every other error back as the plain parser gives it', () => {
    expect(parseCriterionField('opening', 'monster', ctx)).toEqual(parseCriterion('monster', ctx));
  });
});

describe('parseCriterionFields', () => {
  it('is the PLAIN expression when the whole hand is the only field', () => {
    expect(parseCriterionFields({ text: '1x monster and no trap' }, ctx)).toEqual({
      ok: true,
      expr: expr('1x monster and no trap'),
    });
    // Empty going-second fields change nothing.
    expect(parseCriterionFields({ text: '1x monster', opening: ' ', drawn: '' }, ctx)).toEqual({
      ok: true,
      expr: expr('1x monster'),
    });
  });

  it('is the split the keywords wrote, for every other combination', () => {
    const cases: [Parameters<typeof parseCriterionFields>[0], string][] = [
      [{ opening: '1x monster', drawn: '1x trap', text: '' }, '1x monster then 1x trap'],
      [{ opening: '1x monster', text: 'at most 1x trap' }, '1x monster finally at most 1x trap'],
      [{ drawn: 'no trap', text: '' }, 'then no trap'],
      [{ drawn: 'no trap', text: '2x spell' }, 'then no trap finally 2x spell'],
      [
        { opening: '1x monster', drawn: 'no trap', text: '2x spell' },
        '1x monster then no trap finally 2x spell',
      ],
    ];
    for (const [fields, keywords] of cases)
      expect(parseCriterionFields(fields, ctx), keywords).toEqual({
        ok: true,
        expr: expr(keywords),
      });
  });

  it('is a split of the opening five ALONE when that is the only field', () => {
    expect(parseCriterionFields({ opening: '1x monster', text: '' }, ctx)).toEqual({
      ok: true,
      expr: { op: 'split', five: expr('1x monster') },
    });
  });

  it('bounds the drawn-cards field by the template it is given', () => {
    const fields = { drawn: '2x monster', text: '' };
    expect(parseCriterionFields(fields, ctx).ok).toBe(false);
    expect(parseCriterionFields(fields, ctx, { maxDrawnSlots: 2 }).ok).toBe(true);
  });

  it('says WHICH field failed — the first in window order — with the span inside it', () => {
    const result = parseCriterionFields(
      { opening: '1x monster', drawn: 'trap', text: 'monstr' },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, field: 'drawn' });
    if (!result.ok) expect('trap'.slice(result.span.start, result.span.end)).toBe('trap');
  });

  it('gives an empty criterion the empty whole-hand field’s own error', () => {
    const empty = parseCriterion('', ctx);
    if (empty.ok) throw new Error('an empty criterion parses');
    expect(parseCriterionFields({ text: '', opening: ' ' }, ctx)).toEqual({
      ok: false,
      field: 'text',
      message: empty.message,
      span: empty.span,
    });
  });
});

describe('exprFields', () => {
  it('gives a plain expression to the whole hand, and a split’s parts to their fields', () => {
    const plain = expr('1x monster');
    expect(exprFields(plain)).toEqual({ text: plain });
    const split = expr('1x monster then no trap finally 2x spell');
    if (split.op !== 'split') throw new Error('expected a split');
    expect(exprFields(split)).toEqual({
      opening: split.five,
      drawn: split.sixth,
      text: split.whole,
    });
    expect(exprFields(expr('then no trap'))).toEqual({ drawn: expr('no trap') });
  });
});

/**
 * THE MIGRATION (TDD §14). A version 1 criterion is one text; the fields are
 * three. The one row that must never go wrong is the first: a PLAIN version 1
 * criterion is about the whole hand, and the first field is about the first
 * five, so a plain text belongs in the whole-hand field.
 */
describe('v1Fields', () => {
  it.each([
    ['1x monster and no trap', { text: '1x monster and no trap' }],
    ['1x monster then 1x trap', { opening: '1x monster', drawn: '1x trap', text: '' }],
    ['1x monster finally at most 1x trap', { opening: '1x monster', text: 'at most 1x trap' }],
    [
      '1x monster then no trap finally 2x spell',
      { opening: '1x monster', drawn: 'no trap', text: '2x spell' },
    ],
    ['then 1x trap', { drawn: '1x trap', text: '' }],
    ['finally 2x spell', { text: '2x spell' }],
  ])('lays out `%s` as the table says', (text, fields) => {
    expect(v1Fields(text)).toEqual(fields);
  });

  it('puts a plain criterion in the WHOLE-HAND field, never the opening five', () => {
    const fields = v1Fields('2x monster');
    expect(fields.text).toBe('2x monster');
    expect(fields).not.toHaveProperty('opening');
    expect(fields).not.toHaveProperty('drawn');
  });

  it('keeps the user’s own spelling of every part, trimmed at the keywords', () => {
    expect(v1Fields('1X [C] ,no TRAP   THEN   1 [C]  Finally at most 1x trap')).toEqual({
      opening: '1X [C] ,no TRAP',
      drawn: '1 [C]',
      text: 'at most 1x trap',
    });
  });

  /**
   * Every part parses to exactly the part of the whole: the keywords stand at
   * the top level of any text that parses, so cutting there cuts nothing else.
   */
  it('cuts a text into parts that parse to the parts of its split', () => {
    const texts = [
      '(1x monster or 1x trap) and no spell then 1x [C] or no trap finally 1-2x monster',
      '1x (monster or trap) then no trap',
      'then no [C] finally at most 1x (spell or trap)',
    ];
    for (const text of texts) {
      const whole = expr(text, 2);
      const parsed = parseCriterionFields(v1Fields(text), ctx, { maxDrawnSlots: 2 });
      expect(parsed, text).toEqual({ ok: true, expr: whole });
    }
  });

  it('leaves a text it cannot cut cleanly whole, in the whole-hand field', () => {
    for (const text of [
      '1x monster then 1x trap then 1x spell',
      '1x monster finally 1x trap then 1x spell',
      '1x monster finally 1x trap finally 1x spell',
      '(1x monster then 1x trap)',
      '1x monster then',
      '1x monster finally',
      'then finally 1x trap',
      '1x "unclosed then 1x trap',
    ])
      expect(v1Fields(text), text).toEqual({ text });
  });

  it('leaves the words alone inside a card name', () => {
    expect(v1Fields('1x [Then Finally]')).toEqual({ text: '1x [Then Finally]' });
  });
});
