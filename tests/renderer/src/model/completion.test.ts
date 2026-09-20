import { describe, expect, it } from 'vitest';
import {
  activeCompletion,
  applyCompletion,
  type CompletionState,
  clampPopupLeft,
  completionFits,
  completionShows,
  EMPTY_COMPLETION,
  reduceCompletion,
  siteKey,
} from '../../../../src/renderer/src/model/completion';
import type { CompletionOption, CompletionSite } from '../../../../src/shared/types';

// The inline completion's state, as a reducer over what the caret and main do
// to it. There is no jsdom (TDD §3): everything the popup does that could be
// wrong is decided here and driven from the component.

function site(
  kind: CompletionSite['kind'],
  prefix: string,
  start: number,
  end: number,
  closed = false,
): CompletionSite {
  return { kind, prefix, start, end, closed };
}

function option(label: string, insert: string): CompletionOption {
  return { label, detail: '', insert, key: insert, ambiguous: false };
}

const ASH = site('card', 'Ash', 3, 7);
const OPTIONS = [
  option('Ash Blossom & Joyous Spring', '[Ash Blossom & Joyous Spring]'),
  option('Ashoka Pillar', '[Ashoka Pillar]'),
];

/** The text a site was read from: `1x [Ash`-shaped, with the caret at the site's end. */
function sourceOf(at: CompletionSite): { text: string; caret: number } {
  return { text: `1x ${at.prefix}`, caret: at.end };
}

/** A `site` event, with the text and caret main was asked about. */
function sited(
  at: CompletionSite | null,
  source = at === null ? { text: '', caret: 0 } : sourceOf(at),
) {
  return { type: 'site', site: at, ...source } as const;
}

/** The caret sitting in `at` with `options` already answered: a popup on screen. */
function showing(at: CompletionSite, options: CompletionOption[], active = -1): CompletionState {
  const seen = reduceCompletion(EMPTY_COMPLETION, sited(at));
  const answered = reduceCompletion(seen, { type: 'options', key: siteKey(at)!, options });
  return active < 0 ? answered : { ...answered, open: true, active };
}

describe('siteKey', () => {
  it('is the kind and what was typed: what the options are an answer to', () => {
    expect(siteKey(ASH)).toBe('card:Ash');
  });

  // The same name typed in two places has the same options: only the span
  // differs, and the span is not something main is asked about.
  it('does not depend on where in the text the name is', () => {
    expect(siteKey(site('card', 'Ash', 30, 34))).toBe(siteKey(ASH));
  });

  it('tells the three kinds of name apart', () => {
    expect(siteKey(site('group', 'Ash', 3, 7))).not.toBe(siteKey(ASH));
    expect(siteKey(site('archetype', 'Ash', 3, 7))).not.toBe(siteKey(ASH));
  });

  it('is null for no site', () => {
    expect(siteKey(null)).toBeNull();
  });
});

describe('reduceCompletion', () => {
  describe('site', () => {
    it('opens on a site and remembers the span a pick would replace', () => {
      const state = reduceCompletion(EMPTY_COMPLETION, sited(ASH));
      expect(state).toMatchObject({ site: ASH, open: true, active: -1 });
    });

    it('closes when the caret leaves every name', () => {
      const state = reduceCompletion(showing(ASH, OPTIONS, 1), sited(null));
      expect(state).toMatchObject({ site: null, open: false, active: -1 });
    });

    it('keeps the rows on screen between two keystrokes rather than blinking them away', () => {
      const state = reduceCompletion(showing(ASH, OPTIONS), sited(site('card', 'Ash ', 3, 8)));
      expect(state.options).toEqual(OPTIONS);
      // …but `answered` still says which name they are about.
      expect(completionShows(state)).toBe(false);
    });

    it('is the same state when the caret has not moved, so nothing re-renders', () => {
      const state = showing(ASH, OPTIONS, 1);
      expect(reduceCompletion(state, sited({ ...ASH }))).toBe(state);
    });

    // A site is a pair of OFFSETS, so the same name in a new place is a new
    // site: taking the old one would make a pick cut the text elsewhere.
    it('takes the new span when the same name has moved', () => {
      const state = reduceCompletion(showing(ASH, OPTIONS), {
        type: 'site',
        site: site('card', 'Ash', 10, 14),
        text: 'and 1x Ash',
        caret: 14,
      });
      expect(state.site).toEqual(site('card', 'Ash', 10, 14));
    });

    it('takes the active row off a list that is about to be answered again', () => {
      const state = reduceCompletion(showing(ASH, OPTIONS, 1), sited(site('card', 'Ashb', 3, 8)));
      expect(state.active).toBe(-1);
    });
  });

  describe('options', () => {
    it('shows what came back for the name being typed', () => {
      const state = showing(ASH, OPTIONS);
      expect(state.options).toEqual(OPTIONS);
      expect(completionShows(state)).toBe(true);
    });

    it('drops an answer to a name that is no longer being typed', () => {
      const seen = reduceCompletion(EMPTY_COMPLETION, sited(ASH));
      const stale = reduceCompletion(seen, { type: 'options', key: 'card:As', options: OPTIONS });
      expect(stale).toBe(seen);
    });

    it('drops an answer that arrives after the caret has left every name', () => {
      const gone = reduceCompletion(EMPTY_COMPLETION, sited(null));
      expect(reduceCompletion(gone, { type: 'options', key: 'card:Ash', options: OPTIONS })).toBe(
        gone,
      );
    });

    it('pulls the active row back into a list that came back shorter', () => {
      const state = reduceCompletion(showing(ASH, OPTIONS, 1), {
        type: 'options',
        key: siteKey(ASH)!,
        options: OPTIONS.slice(0, 1),
      });
      expect(state.active).toBe(0);
    });
  });

  describe('move', () => {
    it('walks the rows and opens a list Escape had closed', () => {
      const closed = reduceCompletion(showing(ASH, OPTIONS), { type: 'close' });
      expect(reduceCompletion(closed, { type: 'move', by: 1 })).toMatchObject({
        open: true,
        active: 0,
      });
    });

    it('does nothing with no rows to move through', () => {
      const empty = showing(ASH, []);
      expect(reduceCompletion(empty, { type: 'move', by: 1 })).toBe(empty);
    });
  });

  describe('close', () => {
    it('hides the popup and keeps what was typed', () => {
      const state = reduceCompletion(showing(ASH, OPTIONS, 1), { type: 'close' });
      expect(state).toMatchObject({ site: ASH, open: false, active: -1 });
      expect(state.options).toEqual(OPTIONS);
    });

    // Walking the caret through the name changes what has been typed BEFORE
    // it, so keying the dismissal on the name would throw the list that was
    // just dismissed straight back up — found by driving the built app.
    it('stays shut while the text does not change, however the caret moves', () => {
      const closed = reduceCompletion(showing(ASH, OPTIONS), { type: 'close' });
      const back = reduceCompletion(closed, {
        type: 'site',
        site: site('card', 'As', 3, 6),
        text: '1x Ash',
        caret: 6,
      });
      expect(back.open).toBe(false);
    });

    it('comes back for the next character typed', () => {
      const closed = reduceCompletion(showing(ASH, OPTIONS), { type: 'close' });
      const typed = reduceCompletion(closed, sited(site('card', 'Ashb', 3, 8)));
      expect(typed.open).toBe(true);
    });

    it('stays back once it has come back, even if the text is typed away again', () => {
      const closed = reduceCompletion(showing(ASH, OPTIONS), { type: 'close' });
      const typed = reduceCompletion(closed, sited(site('card', 'Ashb', 3, 8)));
      expect(reduceCompletion(typed, sited(ASH)).open).toBe(true);
    });
  });

  describe('reset', () => {
    it('is an empty completion again, which is what a pick leaves behind', () => {
      expect(reduceCompletion(showing(ASH, OPTIONS, 1), { type: 'reset' })).toEqual(
        EMPTY_COMPLETION,
      );
    });
  });
});

describe('completionShows', () => {
  it('is false before the rows for the name being typed have come back', () => {
    const seen = reduceCompletion(EMPTY_COMPLETION, sited(ASH));
    expect(completionShows(seen)).toBe(false);
  });

  it('is false when nothing matches, so an empty popup never appears', () => {
    expect(completionShows(showing(ASH, []))).toBe(false);
  });

  it('is false while the popup is closed', () => {
    expect(completionShows(reduceCompletion(showing(ASH, OPTIONS), { type: 'close' }))).toBe(false);
  });

  it('is true for an open, answered, non-empty list', () => {
    expect(completionShows(showing(ASH, OPTIONS))).toBe(true);
  });
});

describe('activeCompletion', () => {
  it('is the row Enter would take', () => {
    expect(activeCompletion(showing(ASH, OPTIONS, 1))).toEqual(OPTIONS[1]);
  });

  it('is null with no active row', () => {
    expect(activeCompletion(showing(ASH, OPTIONS))).toBeNull();
  });
});

describe('completionFits', () => {
  // Between a keystroke and main's answer, the site on screen is one
  // keystroke old, and its offsets would cut the new text in the wrong place.
  it('is true for the very text and caret the site was read from', () => {
    expect(completionFits(showing(ASH, OPTIONS), '1x Ash', 7)).toBe(true);
  });

  it('is false once another character has been typed', () => {
    expect(completionFits(showing(ASH, OPTIONS), '1x Ashb', 7)).toBe(false);
  });

  it('is false once the caret has moved', () => {
    expect(completionFits(showing(ASH, OPTIONS), '1x Ash', 6)).toBe(false);
  });

  it('is false with no site at all', () => {
    expect(completionFits(EMPTY_COMPLETION, '', 0)).toBe(false);
  });
});

describe('applyCompletion', () => {
  it('writes the name in place of what was typed and leaves the caret after it', () => {
    expect(applyCompletion('1x [Ash', ASH, '[Ash Blossom & Joyous Spring]')).toEqual({
      text: '1x [Ash Blossom & Joyous Spring]',
      caret: 32,
    });
  });

  it('keeps what follows the name', () => {
    expect(applyCompletion('1x [Ash and 1x monster', ASH, '[Ash Blossom]')).toEqual({
      text: '1x [Ash Blossom] and 1x monster',
      caret: 16,
    });
  });

  it('eats the closing delimiter of a name already closed, rather than doubling it', () => {
    expect(
      applyCompletion('1x [Ash] monster', site('card', 'Ash', 3, 8, true), '[Ash Blossom]'),
    ).toEqual({ text: '1x [Ash Blossom] monster', caret: 16 });
  });

  it('writes an ambiguous archetype with its code', () => {
    expect(
      applyCompletion('1x "War monster', site('archetype', 'War', 3, 7), '"Warrior":0x2066'),
    ).toEqual({ text: '1x "Warrior":0x2066 monster', caret: 19 });
  });
});

describe('clampPopupLeft', () => {
  it('puts the popup where the name starts', () => {
    expect(clampPopupLeft(40, 200, 600)).toBe(40);
  });

  it('pulls it back so its right edge stays inside the field', () => {
    expect(clampPopupLeft(500, 200, 600)).toBe(400);
  });

  it('never pushes it off the left', () => {
    expect(clampPopupLeft(-20, 200, 600)).toBe(0);
    expect(clampPopupLeft(40, 900, 600)).toBe(0);
  });
});
