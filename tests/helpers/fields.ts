import { type CriterionFieldTexts, v1Fields } from '../../src/core/criteria/fields';

/**
 * A criterion written the short way a test can hold on one line — `A then B
 * finally C` — laid out in the editor's three fields (PRD §5.5) exactly as a
 * version 1 file is when it is opened: `A` the opening five, `B` the cards
 * drawn, `C` the whole hand, and a text with neither keyword the whole hand
 * alone. The conversion itself is tested in `tests/core/criteria/fields.test.ts`;
 * this is only how the tests of everything downstream of it write a split.
 */
export function fieldsOf(text: string): CriterionFieldTexts {
  return v1Fields(text);
}
