import { parseCriterion } from '../../src/core/criteria/parser';
import type { DescContext } from '../../src/core/desc/context';
import { parse } from '../../src/core/desc/parser';
import { EXAMPLE_SECTIONS, type Example, type ExampleSection } from '../../src/shared/syntax';

/**
 * Running the in-app syntax reference (`src/shared/syntax.ts`) through the
 * parsers it documents. Shared by the fixture-context test and the opt-in
 * real-install one, so that "every example is executable" is one rule checked
 * twice over, and not two rules that could disagree.
 */
export interface SyntaxRow {
  readonly section: ExampleSection;
  readonly row: Example;
}

/** Every row of every example section, flattened, with the section it came from. */
export function syntaxRows(): SyntaxRow[] {
  return EXAMPLE_SECTIONS.flatMap((section) =>
    section.groups.flatMap((group) => group.rows.map((row) => ({ section, row }))),
  );
}

/**
 * One row, parsed by the parser its section names. Throws unless the row does
 * exactly what it advertises: an ordinary row parses, and a row carrying
 * `fails` fails with the app's own message — the words, not a paraphrase,
 * since a reader who is shown an error should recognize it when it appears.
 */
export function checkExampleRow({ section, row }: SyntaxRow, ctx: DescContext): void {
  const result =
    section.parses === 'description' ? parse(row.syntax, ctx) : parseCriterion(row.syntax, ctx);
  if (row.fails === undefined) {
    if (result.ok) return;
    throw new Error(`\`${row.syntax}\` must parse as a ${section.parses}: ${result.message}`);
  }
  if (result.ok) throw new Error(`\`${row.syntax}\` must fail as a ${section.parses}, and did not`);
  if (!result.message.includes(row.fails))
    throw new Error(
      `\`${row.syntax}\` fails with "${result.message}", which does not contain "${row.fails}"`,
    );
}
