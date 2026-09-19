import type {
  Analysis,
  CriterionAnalysis,
  LimitAnalysis,
  LineAnalysis,
  RequirementAnalysis,
} from '../../src/shared/types';

/**
 * Builders for the parts of an `Analysis` a renderer test cares about. The
 * readouts are checked against the REAL thing wherever the motivating example
 * produces it (see `motivating.ts`); these are for the shapes it does not —
 * a limit, a dropped alternative, an unfilled requirement — where writing the
 * template that provokes one would say less than the field it sets.
 */

/** An `Analysis` with only the fields one test cares about; the rest is the empty template's. */
export function analysisOf(over: Partial<Analysis> = {}): Analysis {
  return {
    ok: true,
    deckSize: 40,
    handSize: 5,
    lines: [],
    remainder: {
      id: 'remainder',
      canonical: 'card',
      echo: 'Any card',
      count: 12132,
      min: 0,
      max: null,
      range: { min: 0, max: 40 },
      issues: [],
    },
    groups: [],
    requirements: [],
    limits: [],
    criteria: [],
    issues: [],
    totals: {
      feasible: true,
      kinds: [],
      lines: { min: 0, max: 0 },
      remainder: { min: 0, max: 40 },
    },
    classes: null,
    work: {
      rawRatios: null,
      classVectors: null,
      hands: null,
      estimatedMs: null,
      cost: { perVectorUs: 0.05, perTermNs: 6 },
    },
    ...over,
  };
}

export function lineOf(id: string, over: Partial<LineAnalysis> = {}): LineAnalysis {
  return {
    id,
    text: id,
    min: 0,
    max: 3,
    parsed: { ok: true, canonical: id, echo: id },
    count: 1,
    samples: [],
    issues: [],
    ...over,
  };
}

export function criterionOf(id: string, over: Partial<CriterionAnalysis> = {}): CriterionAnalysis {
  return {
    id,
    text: `1x ${id}`,
    parsed: { ok: true, canonical: `1x ${id}` },
    alternatives: [`1x ${id}`],
    dropped: 0,
    subsumed: [],
    redundant: false,
    absentCards: [],
    issues: [],
    ...over,
  };
}

export function requirementOf(
  text: string,
  over: Partial<RequirementAnalysis> = {},
): RequirementAnalysis {
  return {
    text,
    echo: text,
    appearsIn: [{ criterion: 'c1', alternative: 0, n: 1 }],
    filledBy: [],
    nearMisses: [],
    bounded: false,
    ignored: [],
    ignoredRange: null,
    issues: [],
    ...over,
  };
}

export function limitOf(text: string, over: Partial<LimitAnalysis> = {}): LimitAnalysis {
  return {
    text,
    echo: text,
    appearsIn: [{ criterion: 'c1', alternative: 0, n: 1 }],
    counts: [],
    ignored: [],
    ignoredRange: null,
    countsNothing: true,
    issues: [],
    ...over,
  };
}
