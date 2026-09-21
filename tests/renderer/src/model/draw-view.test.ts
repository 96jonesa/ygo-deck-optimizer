import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../../../src/core/model/analyze';
import { DRAW_CARDS_MAX } from '../../../../src/core/model/template';
import {
  commitDrawN,
  DRAW_MAX,
  DRAW_MIN,
  DRAW_NEW_N,
  drawingIssues,
  drawLineText,
  drawReadout,
  refusalIssues,
  STOP_LABEL,
  STOP_MOMENT_NOTE,
  stopIssues,
  stopStateNote,
  templateDraws,
} from '../../../../src/renderer/src/model/draw-view';
import { EMPTY_TEMPLATE, withLineDraw } from '../../../../src/renderer/src/model/template-edit';
import { DRAW_REFERENCE } from '../../../../src/shared/syntax';
import type { Analysis, Issue, IssueCode, Template } from '../../../../src/shared/types';
import { motivatingContext, motivatingTemplate } from '../../../helpers/motivating';

const ctx = motivatingContext(await initSqlJs());

/**
 * The motivating example with `normal-spell` made a draw card: the smallest
 * real drawing template there is, and the one every readout below is read off.
 * `analyze` is the authority for every judgement here, so these tests analyse
 * for real rather than hand-writing an `Analysis` the engine would not produce.
 */
function drawing(
  draw: { n: number; oncePerTurn?: boolean } = { n: 2, oncePerTurn: true },
  copies = { min: 0, max: 1 },
): Template {
  const base = motivatingTemplate();
  const template: Template = {
    ...base,
    lines: base.lines.map((line) => (line.id === 'normal-spell' ? { ...line, ...copies } : line)),
  };
  return withLineDraw(template, 'normal-spell', draw);
}

/**
 * A drawing template big enough that `analyze` declines to build its success set
 * (`ANALYZE_DRAW_WORK`) — thirteen classes and three copies of a draw-2, which
 * is 4.2 million compositions against the 1.5 million an edit will pay for. It
 * is still far under `MAX_DRAW_WORK`, so **the template still runs**, which is
 * the whole point of the readouts below.
 */
function tooBigToCount(): Template {
  const base = motivatingTemplate();
  const levels = Array.from({ length: 8 }, (_, at) => `level ${at + 1} monster`);
  const template: Template = {
    ...base,
    lines: [
      ...base.lines.map((line) =>
        line.id === 'normal-spell' ? { ...line, min: 0, max: 3 } : line,
      ),
      ...levels.map((text, at) => ({ id: `x${at}`, text, min: 0, max: 2 })),
    ],
    criteria: [
      ...base.criteria.map((criterion) => ({ ...criterion, stop: true as const })),
      ...levels.map((text, at) => ({ id: `cx${at}`, text: `1x ${text}`, stop: true as const })),
    ],
  };
  return withLineDraw(template, 'normal-spell', { n: 2 });
}

const codesOf = (issues: readonly Issue[]): IssueCode[] => issues.map((issue) => issue.code);

describe('DRAW_MIN and DRAW_MAX', () => {
  it('are the bounds `core` enforces, written out because the renderer takes no core code', () => {
    expect(DRAW_MIN).toBe(1);
    expect(DRAW_MAX).toBe(DRAW_CARDS_MAX);
  });

  it('starts a freshly marked line inside them', () => {
    expect(DRAW_NEW_N).toBeGreaterThanOrEqual(DRAW_MIN);
    expect(DRAW_NEW_N).toBeLessThanOrEqual(DRAW_MAX);
  });
});

describe('commitDrawN', () => {
  it('takes a number in range', () => {
    expect(commitDrawN('3', 1)).toBe(3);
  });

  it('leaves the value as it was when the field cannot be read', () => {
    expect(commitDrawN('', 2)).toBe(2);
    expect(commitDrawN('two', 2)).toBe(2);
  });

  /** A card that draws none is not a draw card, so 0 clamps up rather than clearing the marker. */
  it('clamps to the bounds rather than storing a number core would refuse', () => {
    expect(commitDrawN('0', 2)).toBe(DRAW_MIN);
    expect(commitDrawN('99', 2)).toBe(DRAW_MAX);
  });

  /**
   * A minus sign is unreadable rather than out of range (`parseCount`), so the
   * value stays as it was — a field is `-` for a keystroke in the middle of an
   * edit, and the arrow keys step through it.
   */
  it('treats a negative field as unreadable, not as a number to clamp', () => {
    expect(commitDrawN('-4', 2)).toBe(2);
  });
});

describe('templateDraws', () => {
  it('is false for a template no line of which draws', () => {
    expect(templateDraws(motivatingTemplate())).toBe(false);
    expect(templateDraws(EMPTY_TEMPLATE)).toBe(false);
  });

  it('is true as soon as one line carries the marker', () => {
    expect(templateDraws(drawing())).toBe(true);
  });
});

describe('drawLineText', () => {
  it('says how many a copy draws', () => {
    expect(drawLineText({ n: 1 })).toBe('Draws 1 card');
    expect(drawLineText({ n: 3 })).toBe('Draws 3 cards');
  });

  /**
   * Once-per-turn is what a hard once-per-turn card really does, and it changes
   * the arithmetic: the second copy sits in hand and is judged like any other
   * card. So the row says it rather than leaving it to the checkbox.
   */
  it('says when only the first copy is played', () => {
    expect(drawLineText({ n: 2, oncePerTurn: true })).toBe(
      'Draws 2 cards · only the first copy is played',
    );
  });
});

describe('drawReadout', () => {
  it('is nothing at all for a template that does not draw', () => {
    expect(drawReadout(motivatingTemplate(), analyze(motivatingTemplate(), ctx))).toBeNull();
  });

  /**
   * The opening hand and the largest hand the criteria are judged against are
   * `analyze`'s own two numbers (`handSize`, `judgedHand`) — the renderer works
   * out neither the prefix nor the hand a draw card builds.
   */
  it('reads the opening hand and the hand the draws build off the analysis', () => {
    const template = drawing();
    const analysis = analyze(template, ctx);
    const readout = drawReadout(template, analysis)!;
    expect(analysis.judgedHand).toBe(6);
    expect(readout.hand).toBe(
      'An opening of 5 cards, and the draws build a hand of up to 6 — the criteria judge whatever hand you end up with.',
    );
  });

  /** One part per prefix length, which is what the run reports one fraction each for. */
  it('names the prefix lengths the run will score, off `work.hands`', () => {
    const template = drawing();
    const analysis = analyze(template, ctx);
    const prefixes = [
      ...new Set((analysis.work.hands ?? []).map((hand) => hand.prefix)),
    ] as number[];
    expect(prefixes).toEqual([5, 7]);
    expect(drawReadout(template, analysis)!.lengths).toBe(
      'Scored at 2 prefix lengths — 5 and 7 cards deep — and the fractions ADD UP to one score.',
    );
  });

  /**
   * Past `ANALYZE_DRAW_WORK` the analysis declines to count the work and the
   * lengths are not known — but the TEMPLATE STILL RUNS, so the readout says
   * that rather than showing a blank where the lengths were.
   */
  it('says the lengths are not counted when the analysis declined to build them', () => {
    const template = tooBigToCount();
    const analysis = analyze(template, ctx);
    expect(analysis.work.hands).toBeNull();
    // And the template STILL RUNS: the vectors were counted, only the terms were not.
    expect(analysis.work.classVectors).not.toBeNull();
    expect(analysis.ok).toBe(true);
    const readout = drawReadout(template, analysis)!;
    expect(readout.lengths).toBe(
      'The prefix lengths are not counted on every edit at this many draw cards; the run itself still scores them all.',
    );
  });

  it('says only what the template alone can say before the first analysis', () => {
    const readout = drawReadout(drawing(), null)!;
    expect(readout.hand).toBe('One line draws cards, so the hand is no longer a fixed size.');
    expect(readout.lengths).toBeNull();
  });
});

describe('drawingIssues', () => {
  /**
   * The two notices the TEMPLATE panel owns, routed by `analyze`'s own codes —
   * never by reading the message. The lower bound is on every drawing template.
   */
  it('takes the lower-bound notice, which every drawing template carries', () => {
    expect(codesOf(drawingIssues(analyze(drawing(), ctx)))).toContain('drawing-is-a-lower-bound');
  });

  it('takes the work notice when the analysis declined to count the build', () => {
    const analysis = analyze(tooBigToCount(), ctx);
    expect(codesOf(drawingIssues(analysis))).toContain('work-not-counted');
    const notice = drawingIssues(analysis).find((issue) => issue.code === 'work-not-counted')!;
    expect(notice.message).toContain('The run itself is unaffected');
  });

  /**
   * `drawing-can-fail` belongs beside the checkbox that fixes it, not here — so
   * the template it IS emitted for is the one this has to be checked against.
   */
  it('leaves the criteria their own notice', () => {
    const base = drawing();
    const canFail: Template = {
      ...base,
      criteria: [...base.criteria, { id: 'c3', text: '1x monster and no spell' }],
    };
    expect(codesOf(stopIssues(analyze(canFail, ctx)))).toEqual(['drawing-can-fail']);
    expect(codesOf(drawingIssues(analyze(canFail, ctx)))).not.toContain('drawing-can-fail');
  });

  it('is empty for a template that does not draw, and for no analysis at all', () => {
    expect(drawingIssues(analyze(motivatingTemplate(), ctx))).toEqual([]);
    expect(drawingIssues(null)).toEqual([]);
  });
});

describe('stopIssues', () => {
  /**
   * The motivating example's criteria hold no limit and no ceiling, so nothing
   * can be broken by drawing: `analyze` says so by NOT emitting the notice, and
   * the readout is therefore empty rather than warning about nothing.
   */
  it('is empty where nothing counts the whole hand', () => {
    expect(stopIssues(analyze(drawing(), ctx))).toEqual([]);
  });

  /**
   * A limit is a census over the whole hand, so drawing into it is fatal. `no
   * spell` and not `no trap`: nothing in the motivating example is known to be a
   * trap, so that limit would hold of every hand and the engine would drop it —
   * and rightly emit nothing.
   */
  it('carries the can-fail notice where a criterion counts the whole hand', () => {
    const base = drawing();
    const template: Template = {
      ...base,
      criteria: [...base.criteria, { id: 'c3', text: '1x monster and no spell' }],
    };
    const analysis = analyze(template, ctx);
    expect(codesOf(stopIssues(analysis))).toEqual(['drawing-can-fail']);
    expect(stopIssues(analysis)[0]!.message).toContain('"stop here"');
  });

  /** A requirement with a CEILING counts the hand the same way, and is caught the same way. */
  it('carries it for a range requirement too, whose ceiling a surplus card breaks', () => {
    const base = drawing();
    const template: Template = {
      ...base,
      criteria: [...base.criteria, { id: 'c3', text: '1-2x monster' }],
    };
    expect(codesOf(stopIssues(analyze(template, ctx)))).toEqual(['drawing-can-fail']);
  });

  it('is empty for no analysis at all', () => {
    expect(stopIssues(null)).toEqual([]);
  });
});

describe('refusalIssues', () => {
  it('is empty for a template the engine will build', () => {
    expect(refusalIssues(analyze(drawing(), ctx))).toEqual([]);
    expect(refusalIssues(null)).toEqual([]);
  });

  /**
   * And it is the `compile` code alone, not every template-level error: the
   * ranges not summing to the deck size is an ERROR of the same severity, and
   * it belongs in the totals line where the totals are, not under a heading
   * that says the engine refused to build.
   */
  it('leaves the deck-size error to the totals, and takes only the refusal', () => {
    const base = drawing({ n: 6 }, { min: 6, max: 6 });
    const infeasible: Template = { ...base, remainder: { min: 39, max: null } };
    const analysis = analyze(infeasible, ctx);
    const errors = analysis.issues.filter((issue) => issue.severity === 'error');
    expect(errors.map((issue) => issue.code).sort()).toEqual(['compile', 'infeasible']);
    expect(codesOf(refusalIssues(analysis))).toEqual(['compile']);
  });

  /**
   * The refusals of PRD §5.7 reach the analysis as `compile` errors, and each
   * already carries its own remedies. They are read where the lines are, not
   * squashed into the totals line with the deck-size errors.
   */
  it('carries the deck-out refusal, with the remedy the engine wrote', () => {
    const analysis = analyze(drawing({ n: 6 }, { min: 6, max: 6 }), ctx);
    const messages = refusalIssues(analysis).map((issue) => issue.message);
    expect(messages.join(' ')).toContain('the deck would run out');
    expect(codesOf(refusalIssues(analysis))).toEqual(['compile']);
  });

  it('carries the prefix refusal, which names the bound it broke', () => {
    const analysis = analyze(drawing({ n: 4 }, { min: 3, max: 3 }), ctx);
    const messages = refusalIssues(analysis).map((issue) => issue.message);
    expect(messages.join(' ')).toMatch(/cards deep, and the engine scores at most 16/);
  });
});

describe('the stop control’s words', () => {
  /**
   * THE TRAP THE NAME SETS. "Stop here" invites the reading that the flag picks
   * WHICH CRITERIA are read, and it does not: it picks the MOMENT. Whichever way
   * the hand stopped or drew, every criterion is judged on the hand it has — a
   * hand that stopped on a weight-1 criterion is still worth the weight-9 one it
   * also holds. This test is that correction, stated rather than commented.
   */
  it('says the flag picks the moment and not the criteria', () => {
    expect(STOP_MOMENT_NOTE).toContain('the MOMENT, not the criteria');
    expect(STOP_MOMENT_NOTE).toContain('every criterion is judged');
    expect(STOP_MOMENT_NOTE).toContain('still judged after drawing');
  });

  /**
   * And the polarity, which the executable reference already fixed: TICKED is
   * the one that stops. A box labelled "Stop here" that stopped when unticked
   * would be the one mistake this whole readout exists to prevent.
   */
  it('ticks the box for the state that stops, matching the in-app reference', () => {
    const row = DRAW_REFERENCE.rows.find((candidate) => candidate.label.includes('Stop here'))!;
    expect(row.means).toContain('Unticked — the default — you draw regardless');
    expect(row.means).toContain('Ticked, an opening hand that already meets this criterion stops');
    expect(STOP_LABEL).toBe('Stop here');
    expect(stopStateNote(true)).toContain('stop');
    expect(stopStateNote(false)).toContain('willing to lose this by drawing');
  });

  it('gives each state its own sentence, and they are not the same sentence', () => {
    expect(stopStateNote(true)).not.toBe(stopStateNote(false));
  });
});

/** The readouts must never assume an analysis that resolved; a broken one is the usual case mid-edit. */
describe('an analysis that never got as far as the classes', () => {
  /** A line mid-typing: the text does not parse, so nothing compiles and there are no classes. */
  const broken = (): Analysis => {
    const base = drawing();
    return analyze(
      {
        ...base,
        lines: base.lines.map((line) => (line.id === 'spell' ? { ...line, text: 'level' } : line)),
      },
      ctx,
    );
  };

  it('still answers, without throwing', () => {
    const analysis = broken();
    expect(analysis.classes).toBeNull();
    expect(() => drawReadout(drawing(), analysis)).not.toThrow();
    expect(drawingIssues(analysis)).toEqual([]);
    // The hand is still worth saying; the lengths are unknown rather than uncounted.
    expect(drawReadout(drawing(), analysis)!.hand).toContain('An opening of 5 cards');
    expect(drawReadout(drawing(), analysis)!.lengths).toBeNull();
  });
});
