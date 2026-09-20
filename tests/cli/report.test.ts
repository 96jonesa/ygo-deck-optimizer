import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  classesSection,
  criteriaSection,
  formatAnalysis,
  formatDuration,
  formatEstimateReport,
  int,
  issueSections,
  matchingSection,
  table,
  templateSection,
  totalsSection,
  workSection,
} from '../../src/cli/report';
import { analyze } from '../../src/core/model/analyze';
import type { TemplateLine } from '../../src/core/model/template';
import { templateOf } from '../helpers/gen-template';
import { motivatingContext, motivatingTemplate } from '../helpers/motivating';

const ctx = motivatingContext(await initSqlJs());
const MOTIVATING = analyze(motivatingTemplate(), ctx);

const line = (id: string, text: string, min = 0, max = 3): TemplateLine => ({ id, text, min, max });

/** A template with a limit, a typo, a criterion that does not parse, and a requirement nothing fills. */
const BROKEN = analyze(
  templateOf(
    [
      line('m', 'monster', 5, 5),
      line('t', 'trap', 0, 2),
      line('any', 'spell/trap', 1, 4),
      line('typo', 'level 4 monstr'),
    ],
    ['1x monster, at most 1x trap', '1x monster and', '1x level 4 monster, at most 5x monster'],
  ),
  ctx,
);

describe('int', () => {
  it('groups digits', () => {
    expect(int(0)).toBe('0');
    expect(int(658008)).toBe('658,008');
  });
});

describe('table', () => {
  it('pads columns to their widest cell, right-aligns the ones asked for, and trims line ends', () => {
    expect(
      table(
        [
          ['a', '1', 'x'],
          ['long', '22', ''],
        ],
        [1],
      ),
    ).toBe('  a      1  x\n  long  22');
  });
});

describe('formatDuration', () => {
  it('picks the unit that reads best', () => {
    expect(formatDuration(0.2)).toBe('under 1 ms');
    expect(formatDuration(12.4)).toBe('12 ms');
    expect(formatDuration(3_400)).toBe('3.4 s');
    expect(formatDuration(312_000)).toBe('5.2 min');
    expect(formatDuration(7.1 * 3_600_000)).toBe('7.1 h');
    expect(formatDuration(12 * 86_400_000)).toBe('12 days');
    expect(formatDuration(5e15)).toBe('57,870,370 days');
  });
});

describe('templateSection', () => {
  it('lists each line with its echo, database matches and range, then the remainder', () => {
    const text = templateSection(MOTIVATING, 'motivating.json');
    expect(text).toMatch(/^Template — motivating\.json: deck of 40, hand of 5$/m);
    expect(text).toMatch(/^ {2}line +description +understood as +matches +range$/m);
    expect(text).toMatch(/^ {2}A +\[Elemental HERO Stratos\] +Elemental HERO Stratos +1 +0-3$/m);
    expect(text).toMatch(/^ {2}\(remainder\) +card +Any card +22 +0\+$/m);
  });

  it('adds the chosen counts when it is given them', () => {
    const text = templateSection(MOTIVATING, 'm.json', [3, 3, 5, 3, 3, 7, 3, 13]);
    expect(text).toMatch(/matches +range +count$/m);
    expect(text).toMatch(/^ {2}level4 +level 4 monster +Level 4 · Monster +\d+ +2-3 +3$/m);
    expect(text).toMatch(/^ {2}\(remainder\) +card +Any card +22 +0\+ +13$/m);
  });

  it('shows a line that was not understood as such', () => {
    expect(templateSection(BROKEN, 'b.json')).toMatch(
      /^ {2}typo +level 4 monstr +\(not understood\) +- +0-3$/m,
    );
  });
});

describe('criteriaSection', () => {
  it('shows each criterion as written, then expanded', () => {
    const text = criteriaSection(MOTIVATING);
    expect(text).toMatch(/^ {2}c1 \(A, B and any monster\): 1x \[Elemental HERO Stratos\]/m);
    expect(text).toMatch(/^ {6}1\. 1x #40044918, 1x #32807846, 1x level 4 or lower monster$/m);
    expect(text).toMatch(/^ {2}judged as 2 distinct flat alternative\(s\)$/m);
  });

  it('marks a criterion that was not understood, and counts dropped alternatives', () => {
    expect(criteriaSection(BROKEN)).toMatch(/^ {2}c2: 1x monster and\n {6}\(not understood\)$/m);
    const dropped = analyze(templateOf([line('m', 'monster')], ['6x monster or 1x monster']), ctx);
    expect(criteriaSection(dropped)).toMatch(/^ {6}\(1 more need over 5 cards: never met\)$/m);
    expect(criteriaSection(analyze(templateOf([], []), ctx))).toMatch(/^ {2}\(none\)$/m);
  });
});

describe('matchingSection', () => {
  it('shows what fills each requirement, and the near misses with the line that would count', () => {
    const text = matchingSection(MOTIVATING);
    expect(text).toMatch(
      /^ {2}requirement +1x monster +\[Monster\] +filled by: A, monster, level4, fire-bw$/m,
    );
    expect(text).toMatch(
      /^ {2}requirement +1x level 4 or lower monster +\[.*\] +filled by: A, level4\n {6}near miss: monster — Level unstated; a `level 4 or lower monster` line would count\n {6}near miss: \(remainder\) — kind unstated; a `level 4 or lower monster` line would count$/m,
    );
    expect(text).toMatch(
      /^ {2}match nothing, so they cannot affect the odds: spell, normal-spell, \(remainder\)$/m,
    );
  });

  it('tells a range apart from the plain count it would otherwise read as', () => {
    const lines = [line('m', 'monster'), line('s', 'spell')];
    const plain = matchingSection(analyze(templateOf(lines, ['1x monster']), ctx));
    const ranged = matchingSection(analyze(templateOf(lines, ['1-2x monster']), ctx));
    expect(plain).toMatch(/^ {2}requirement +1x monster +\[Monster\] +filled by: m$/m);
    expect(ranged).toMatch(/^ {2}requirement +1-2x monster +\[Monster\] +filled by: m$/m);
    // The point of the row: the two criteria must not print the same thing.
    expect(ranged).not.toEqual(plain);
    expect(ranged).not.toMatch(/requirement +1x monster/);
  });

  it('writes each distinct count a requirement appears under, ranges included', () => {
    const many = analyze(
      templateOf([line('m', 'monster')], ['1-2x monster', '1x monster', '2x monster']),
      ctx,
    );
    // Ordered by lower bound, then by ceiling — the tighter of two `1x`s first,
    // which is the order the criteria editor's heading uses too.
    expect(matchingSection(many)).toMatch(/^ {2}requirement +1-2x \/ 1x \/ 2x monster/m);
  });

  it('writes a limit’s own count, so `no` and `at most 2x` do not print alike', () => {
    const lines = [line('m', 'monster'), line('t', 'trap')];
    const none = matchingSection(analyze(templateOf(lines, ['1x monster, no trap']), ctx));
    const some = matchingSection(analyze(templateOf(lines, ['1x monster, at most 2x trap']), ctx));
    expect(none).toMatch(/^ {2}limit +no trap +\[Trap\] +counts: t$/m);
    expect(some).toMatch(/^ {2}limit +at most 2x trap +\[Trap\] +counts: t$/m);
  });

  it('does not tell a generic line that it is not a card some line already is', () => {
    expect(matchingSection(MOTIVATING)).not.toMatch(/never counts as a named card/);
    // With no line for the card, it is the hint that matters — once, for all the lines it is true of.
    const absent = analyze(
      templateOf(
        [line('m', 'monster'), line('l4', 'level 4 monster')],
        ['1x [Elemental HERO Stratos]'],
      ),
      ctx,
    );
    expect(matchingSection(absent)).toMatch(
      /^ {2}requirement +1x #40044918 +\[Elemental HERO Stratos\] +filled by: \(no line\)\n {6}near miss: m, l4, \(remainder\) — a generic line never counts as a named card; a `#40044918` line would count$/m,
    );
  });

  it('shows what a limit counts, and what it ignores, line by line and in all', () => {
    const text = matchingSection(BROKEN);
    expect(text).toMatch(
      /^ {2}limit +at most 1x trap +\[Trap\] +counts: t\n {6}ignores: any \(1–4\), \(remainder\) \(\d+–\d+\) — \d+–\d+ cards in all$/m,
    );
  });

  it('says so when nothing is required or limited', () => {
    expect(matchingSection(analyze(templateOf([line('m', 'monster')], []), ctx))).toMatch(
      /^ {2}\(nothing is required or limited\)\n {2}match nothing, .*: m, \(remainder\)$/m,
    );
  });
});

describe('totalsSection', () => {
  it('reads like PRD §6.4: known monsters 7–14, known spells 0–13, unspecified 13–33', () => {
    const text = totalsSection(MOTIVATING);
    expect(text).toMatch(/^ {2}Known monsters +7–14 +A, monster, level4, fire-bw$/m);
    expect(text).toMatch(/^ {2}Known spells +0–13 +B, spell, normal-spell$/m);
    expect(text).toMatch(/^ {2}Known traps +0 +\(no line\)$/m);
    expect(text).toMatch(
      /^ {2}Unspecified +13–33 +what the lines \(7–27 cards\) leave of a deck of 40$/m,
    );
  });

  it('says so when the ranges cannot fill the deck', () => {
    const text = totalsSection(analyze(templateOf([line('m', 'monster', 41, 45)], []), ctx));
    expect(text).toMatch(/^ {2}Unspecified +- /m);
    expect(text).toMatch(/^ {2}the ranges cannot sum to the deck size$/m);
  });
});

describe('classesSection', () => {
  it('lists the classes with their ranges and member lines, the blank class first', () => {
    const text = classesSection(MOTIVATING);
    expect(text).toMatch(/^ {2}0 \(blank\) +0–50 +spell, normal-spell, \(remainder\)$/m);
    expect(text).toMatch(/^ {2}3 +5–8 +monster, fire-bw$/m);
  });

  it('shows an empty blank class, the limits left out, and when there are no classes to show', () => {
    const any = analyze(
      templateOf([line('m', 'monster')], ['1x card, at most 5x monster, no trap']),
      ctx,
    );
    const text = classesSection(any);
    expect(text).toMatch(/^ {2}0 \(blank\) +0 +\(empty\)$/m);
    expect(text).toMatch(
      /^ {2}the limit `at most 5x monster` holds of every hand and is left out: no hand holds more cards$/m,
    );
    expect(text).toMatch(
      /^ {2}the limit `no trap` holds of every hand and is left out: no line counts against it$/m,
    );
    expect(classesSection(BROKEN)).toMatch(/^ {2}\(not available until every error is fixed\)$/m);
  });
});

describe('workSection', () => {
  it('shows the four figures of the work', () => {
    const text = workSection(MOTIVATING);
    expect(text).toMatch(/^ {2}raw ratios +4,096$/m);
    expect(text).toMatch(/^ {2}class vectors +128$/m);
    expect(text).toMatch(/^ {2}terms per score +\d+ at a hand of 5$/m);
    expect(text).toMatch(/^ {2}estimated time +under 1 ms$/m);
  });

  it('rounds a count past 2^53, and leaves out what is not known', () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(`m${i}`, 'monster'));
    expect(workSection(analyze(templateOf(lines, ['1x monster']), ctx))).toMatch(
      /^ {2}raw ratios +about \d\.\d\d × 10\^17$/m,
    );
    expect(workSection(BROKEN)).toMatch(/^ {2}class vectors +-\n {2}terms per score +-$/m);
  });
});

describe('issueSections', () => {
  it('groups issues by severity, each named by where it belongs', () => {
    const [errors, warnings, notices] = issueSections(BROKEN, ['error', 'warning', 'notice']);
    expect(errors).toMatch(/^Errors\n {2}line "typo": .*monstr/);
    expect(errors).toMatch(/^ {2}criterion "c2": /m);
    expect(warnings).toMatch(/^Warnings\n {2}no line fills the requirement `level 4 monster`$/m);
    expect(warnings).toMatch(/^ {2}criterion "c3": can never be met/m);
    expect(notices).toMatch(/^Notices\n/);
    expect(notices).toMatch(/^ {2}a limit on `trap` ignores 30–35 cards /m);
  });

  it('leaves out a heading with nothing under it, and severities not asked for', () => {
    expect(issueSections(MOTIVATING, ['error', 'warning'])).toEqual([]);
    expect(issueSections(MOTIVATING, ['notice'])).toEqual([
      'Notices\n  line "fire-bw": `level 7 FIRE beast-warrior monster` matches no card in the database today — allowed: a line states what its cards are known to be, not which cards exist\n  criterion "c2": adds nothing: every hand that meets it already meets criterion "c1"',
    ]);
  });
});

describe('formatAnalysis', () => {
  it('prints every section, a blank line apart, ending in a newline', () => {
    const text = formatAnalysis(MOTIVATING, 'm.json');
    expect(text.split('\n\n').map((section) => section.split(/ —|\n/)[0])).toEqual([
      'Template',
      'Criteria',
      'Matching',
      'Totals',
      'Classes',
      'Work',
      'Notices',
    ]);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });
});

describe('formatEstimateReport', () => {
  it('prints what the estimate is an estimate of: the counts, the criteria, the matching', () => {
    const text = formatEstimateReport(MOTIVATING, 'm.json', [3, 3, 5, 3, 3, 7, 3]);
    expect(text.split('\n\n').map((section) => section.split(/ —|\n/)[0])).toEqual([
      'Template',
      'Criteria',
      'Matching',
      'Notices',
    ]);
    // The remainder's count is what the lines leave of the deck.
    expect(text).toMatch(/^ {2}\(remainder\) +card +Any card +22 +0\+ +13$/m);
  });
});
