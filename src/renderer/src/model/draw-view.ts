import type { Analysis, DrawSpec, Issue, IssueCode, Template } from '../../../shared/types';
import { parseCount } from './copy-range';

// Draw cards on screen (PRD §5.7): the marker a line carries, the flag a
// criterion carries, and the three things a reader has to be TOLD rather than
// left to infer — that drawing can lower the odds, that the number is a floor
// rather than a forecast, and that past a certain size the editor stops
// counting the work while the run still does it.
//
// Every judgement here is `analyze`'s. What the renderer contributes is where a
// sentence goes, and the routing is by ISSUE CODE — `analyze`'s own
// classification — never by reading the message, which is the one way this file
// could start disagreeing with the engine.

/**
 * How many cards one copy may draw. Written out rather than imported, as
 * everything else in the renderer is (TDD §3); a test holds them equal to
 * `DRAW_CARDS_MAX`.
 */
export const DRAW_MIN = 1;
export const DRAW_MAX = 6;

/**
 * What a line freshly marked as a draw card draws. One: the cheapest thing to
 * build — the prefix, and with it the cost, grows with `n` — and the number is
 * the next thing the user types anyway.
 */
export const DRAW_NEW_N = 1;

/** A draw marker as the editor holds it: `oncePerTurn` is a plain boolean here, a checkbox's state. */
export interface DrawDraft {
  n: number;
  oncePerTurn?: boolean;
}

/**
 * How many cards the field says, after it was typed into. An unreadable field
 * leaves it as it was and anything out of range is clamped — the rule
 * `commitDeckSize` and `commitWeight` follow. Zero clamps UP rather than
 * clearing the marker: a card that draws none is not a draw card, and saying so
 * is the checkbox's job, not the number's.
 */
export function commitDrawN(text: string, current: number): number {
  const value = parseCount(text);
  if (value === null) return current;
  return Math.min(Math.max(value, DRAW_MIN), DRAW_MAX);
}

/**
 * Whether any line of the template draws. A fact about the template on screen
 * and not a judgement about it, which is why it is read here and not waited for
 * from `analyze`: the controls have to appear on the keystroke that asked for
 * them, and a refused template has no `classes` to read draw-ness out of.
 */
export function templateDraws(template: Template): boolean {
  return template.lines.some((line) => line.draw !== undefined);
}

/** `Draws 2 cards · only the first copy is played`: the marker, under the row it is on. */
export function drawLineText(draw: DrawSpec): string {
  const head = `Draws ${draw.n} card${draw.n === 1 ? '' : 's'}`;
  return draw.oncePerTurn === true ? `${head} · only the first copy is played` : head;
}

export interface DrawReadout {
  /** The opening hand, and the hand the draws build: `analyze`'s two numbers. */
  hand: string;
  /** The prefix lengths a run will score, and that their fractions SUM; `null` when unknown. */
  lengths: string | null;
}

/** `5 and 7`, `5, 7 and 9`: a list a sentence can hold. */
function listOf(values: readonly number[]): string {
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

/**
 * What the template's draw cards do, in two sentences — `null` for a template
 * that draws nothing, which is every template written before this existed.
 *
 * The hand sizes are `analyze`'s `handSize` and `judgedHand`, and the prefix
 * lengths are the parts `createScorers` actually built (`work.hands`). The
 * renderer computes no prefix and no hand size: it could only get them wrong in
 * a way nothing would catch, since the two would still look consistent.
 */
export function drawReadout(template: Template, analysis: Analysis | null): DrawReadout | null {
  if (!templateDraws(template)) return null;
  const drawing = template.lines.filter((line) => line.draw !== undefined).length;
  if (analysis === null)
    return {
      hand: `${drawing === 1 ? 'One line draws' : `${drawing} lines draw`} cards, so the hand is no longer a fixed size.`,
      lengths: null,
    };
  const hand = `An opening of ${analysis.handSize} cards, and the draws build a hand of up to ${analysis.judgedHand} — the criteria judge whatever hand you end up with.`;
  const { hands } = analysis.work;
  // `classes` is null while any line or criterion is still broken, and then
  // there is nothing to say about lengths — as opposed to the case below, where
  // the analysis DECLINED to count them and the run will score them anyway.
  if (analysis.classes === null) return { hand, lengths: null };
  if (hands === null)
    return {
      hand,
      lengths:
        'The prefix lengths are not counted on every edit at this many draw cards; the run itself still scores them all.',
    };
  const lengths = [
    ...new Set(hands.flatMap((part) => (part.prefix === undefined ? [] : [part.prefix]))),
  ].sort((a, b) => a - b);
  if (lengths.length === 0) return { hand, lengths: null };
  return {
    hand,
    lengths: `Scored at ${lengths.length} prefix length${lengths.length === 1 ? '' : 's'} — ${listOf(lengths)} cards deep — and the fractions ADD UP to one score.`,
  };
}

/**
 * The template-level notices the TEMPLATE panel owns: that the number is a
 * lower bound, and that the work was too large to count on a keystroke. Both
 * are about the lines that draw, which is where they are read.
 */
const TEMPLATE_DRAW_CODES: ReadonlySet<IssueCode> = new Set<IssueCode>([
  'drawing-is-a-lower-bound',
  'work-not-counted',
]);

/**
 * The notice the CRITERIA panel owns. `drawing-can-fail` is the one whose
 * remedy is a criterion's own checkbox — "mark such a criterion stop here" — so
 * it belongs beside the checkboxes and not beside the lines.
 */
const CRITERIA_DRAW_CODES: ReadonlySet<IssueCode> = new Set<IssueCode>(['drawing-can-fail']);

export function drawingIssues(analysis: Analysis | null): Issue[] {
  return (analysis?.issues ?? []).filter((issue) => TEMPLATE_DRAW_CODES.has(issue.code));
}

export function stopIssues(analysis: Analysis | null): Issue[] {
  return (analysis?.issues ?? []).filter((issue) => CRITERIA_DRAW_CODES.has(issue.code));
}

/**
 * Why the engine will not score this template at all.
 *
 * Every refusal of PRD §5.7 — the deck running out, the prefix cap, the build
 * cap, `then` beside draw cards — reaches the analysis as a `compile` error, and
 * each one already carries the exact figure and the remedies. A refusal message
 * is code that runs only when someone is already stuck, so it is shown WHOLE and
 * where the lines are, rather than joined into the one grey line the deck-size
 * errors share.
 */
export function refusalIssues(analysis: Analysis | null): Issue[] {
  return (analysis?.issues ?? []).filter(
    (issue) => issue.code === 'compile' && issue.severity === 'error',
  );
}

// --- the stop flag ---------------------------------------------------------

/** What the checkbox is called. Ticked is the state that STOPS: the reference says so, and a test holds it. */
export const STOP_LABEL = 'Stop here';

/**
 * THE CORRECTION THE NAME INVITES A READER TO MISS. "Stop here" reads as though
 * it picked which criteria may be counted, and it does not: it picks the
 * MOMENT. In whichever window the hand lands, every criterion is judged.
 */
export const STOP_MOMENT_NOTE =
  'It picks the MOMENT, not the criteria. Whichever way a hand stopped or drew, every criterion is judged on the hand it has — a hand that stopped on a criterion worth 1 is still worth the 9 it also holds, and a criterion you ticked is still judged after drawing when your opening did not stop you. Going second, a hand that stopped drew only the card for turn: that one card is what the drawn-cards field is judged on, and the six cards are the whole hand.';

/** What ticking the box, or leaving it, actually says — Andy's two sentences (PRD §5.7). */
export function stopStateNote(stop: boolean): string {
  return stop
    ? 'You would stop for this: an opening hand that already meets it activates no draw card, and you keep the hand you had.'
    : 'You draw regardless — you are willing to lose this by drawing.';
}
