import { describe, expect, it } from 'vitest';
import { CRITERION_FIELDS as CORE_FIELDS } from '../../../../src/core/criteria/fields';
import {
  CRITERION_FIELDS,
  FIELD_HINTS,
  FIELD_LABELS,
  FIELD_PLACEHOLDER,
  fieldCanonical,
  fieldFailureOf,
  fieldText,
  shownFields,
} from '../../../../src/renderer/src/model/criterion-fields';
import type { TemplateCriterion } from '../../../../src/shared/types';
import { criterionOf } from '../../../helpers/analysis';

const SPLIT: TemplateCriterion = {
  id: 'c1',
  opening: '1x [Elemental HERO Stratos]',
  drawn: 'no trap',
  text: '',
  when: 'second',
};

describe('CRITERION_FIELDS', () => {
  it('is the core’s list, copied: the renderer takes no code from `core`', () => {
    expect(CRITERION_FIELDS).toEqual(CORE_FIELDS);
  });
});

describe('FIELD_LABELS', () => {
  it('names the three windows in the order the cards arrive, in one wording whatever draws', () => {
    expect(CRITERION_FIELDS.map((field) => FIELD_LABELS[field])).toEqual([
      'Opening 5',
      'Drawn cards',
      'Whole hand',
    ]);
  });

  it('says under the drawn-cards field what it holds, draw cards or none', () => {
    expect(FIELD_HINTS).toEqual({
      drawn: 'the card drawn for turn, plus anything draw cards fetch',
    });
  });

  it('shows "(anything)" in a field left empty', () => {
    expect(FIELD_PLACEHOLDER).toBe('(anything)');
  });
});

describe('fieldText', () => {
  it('is what the field holds, and empty for an absent going-second field', () => {
    expect(fieldText(SPLIT, 'opening')).toBe('1x [Elemental HERO Stratos]');
    expect(fieldText({ id: 'c1', text: '1x monster' }, 'drawn')).toBe('');
  });
});

describe('shownFields', () => {
  it('is all three fields going second, filled or not', () => {
    expect(shownFields({ id: 'c1', text: '' }, 'second')).toEqual(['opening', 'drawn', 'text']);
  });

  it('is the whole hand alone going first or for either hand', () => {
    expect(shownFields({ id: 'c1', text: '1x monster' }, 'first')).toEqual(['text']);
    expect(shownFields({ id: 'c1', text: '1x monster', opening: ' ' }, 'both')).toEqual(['text']);
  });

  it('keeps a going-second field that holds text on screen after the tag changes', () => {
    expect(shownFields(SPLIT, 'first')).toEqual(['opening', 'drawn', 'text']);
    expect(shownFields({ id: 'c1', drawn: 'no trap', text: '1x monster' }, 'both')).toEqual([
      'drawn',
      'text',
    ]);
  });
});

describe('fieldFailureOf', () => {
  const failed = criterionOf('c1', {
    parsed: { ok: false, message: 'no', span: { start: 0, end: 2 }, field: 'drawn' },
  });

  it('is the failure under the field it names, and nothing under the others', () => {
    expect(fieldFailureOf(failed, 'drawn')).toEqual({
      message: 'no',
      span: { start: 0, end: 2 },
    });
    expect(fieldFailureOf(failed, 'opening')).toBeNull();
    expect(fieldFailureOf(failed, 'text')).toBeNull();
  });

  it('puts a failure naming no field under the whole hand', () => {
    const plain = criterionOf('c1', {
      parsed: { ok: false, message: 'no', span: { start: 0, end: 1 } },
    });
    expect(fieldFailureOf(plain, 'text')).toMatchObject({ message: 'no' });
  });

  it('is nothing for a criterion that parsed, or before the analysis has caught up', () => {
    expect(fieldFailureOf(criterionOf('c1'), 'text')).toBeNull();
    expect(fieldFailureOf(null, 'text')).toBeNull();
  });
});

describe('fieldCanonical', () => {
  const found = criterionOf('c1', {
    parsed: {
      ok: true,
      canonical: 'opening 5: 1x #40044918 · drawn: no trap',
      fields: { opening: '1x #40044918', drawn: 'no trap' },
    },
  });

  it('is the printed form of a field when it says the same thing another way', () => {
    expect(fieldCanonical(found, SPLIT, 'opening')).toBe('1x #40044918');
  });

  it('is nothing where the field IS the canonical form, or is empty', () => {
    expect(fieldCanonical(found, SPLIT, 'drawn')).toBeNull();
    expect(fieldCanonical(found, SPLIT, 'text')).toBeNull();
  });

  it('is nothing for a criterion that did not parse, or before the analysis has caught up', () => {
    const broken = criterionOf('c1', {
      parsed: { ok: false, message: 'no', span: { start: 0, end: 1 } },
    });
    expect(fieldCanonical(broken, SPLIT, 'opening')).toBeNull();
    expect(fieldCanonical(null, SPLIT, 'opening')).toBeNull();
  });
});
