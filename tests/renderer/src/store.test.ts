import { describe, expect, it } from 'vitest';
import { EXAMPLE_TEMPLATE } from '../../../src/renderer/src/model/example-template';
import { IDLE_RUN } from '../../../src/renderer/src/model/run-state';
import {
  type AppState,
  type AppStore,
  cardLines,
  createAppStore,
  EMPTY_TEMPLATE,
  learnCards,
  nextLineId,
  selectCardState,
  selectCardsReady,
  selectShows,
  selectStage,
  selectStatusText,
  unknownPasscodes,
  withCardLine,
  withoutLine,
} from '../../../src/renderer/src/store';
import type { CardHit, CardStatus, RunResult, Template } from '../../../src/shared/types';

const ASH: CardHit = {
  passcode: 14558127,
  name: 'Ash Blossom & Joyous Spring',
  typeline: 'Level 3 · FIRE · Zombie · Tuner Effect Monster',
};
const MAXX: CardHit = {
  passcode: 23434538,
  name: 'Maxx "C"',
  typeline: 'Level 2 · EARTH · Beast · Effect Monster',
};

function status(over: Partial<CardStatus> = {}): CardStatus {
  return {
    state: 'ready',
    workdir: '/edopro',
    databases: 20,
    skippedDatabases: 0,
    cards: 12132,
    replacedRows: 821,
    conflicts: 0,
    setnames: 805,
    ...over,
  };
}

/** A result is only ever read back here, so the fields the store does not touch are stubbed. */
function runResult(): RunResult {
  return {
    status: 'done',
    partial: false,
    done: 128,
    total: 128,
    elapsedMs: 1,
    lines: [],
    best: { blend: { num: 1, den: 2 }, parts: [] },
  } as unknown as RunResult;
}

function lineIds(template: Template): string[] {
  return template.lines.map((line) => line.id);
}

describe('withCardLine', () => {
  it('adds the picked card as a line of its own', () => {
    const template = withCardLine(EMPTY_TEMPLATE, ASH);
    expect(template.lines).toHaveLength(1);
    expect(template.lines[0]).toMatchObject({ card: { passcode: ASH.passcode, name: ASH.name } });
  });

  it('gives the new line a copy range a deck allows', () => {
    const [line] = withCardLine(EMPTY_TEMPLATE, ASH).lines;
    expect(line).toMatchObject({ min: 0, max: 3 });
  });

  it('does not add the same card twice — two lines for one card is a template error', () => {
    const once = withCardLine(EMPTY_TEMPLATE, ASH);
    expect(withCardLine(once, ASH)).toBe(once);
  });

  it('leaves the template it was given alone', () => {
    const before = EMPTY_TEMPLATE.lines.length;
    withCardLine(EMPTY_TEMPLATE, ASH);
    expect(EMPTY_TEMPLATE.lines).toHaveLength(before);
  });

  it('keeps every other part of the template', () => {
    const template = withCardLine(EXAMPLE_TEMPLATE, ASH);
    expect(template.criteria).toBe(EXAMPLE_TEMPLATE.criteria);
    expect(template.deckSize).toBe(EXAMPLE_TEMPLATE.deckSize);
    expect(template.lines).toHaveLength(EXAMPLE_TEMPLATE.lines.length + 1);
  });
});

describe('withoutLine', () => {
  it('removes the line with that id', () => {
    const two = withCardLine(withCardLine(EMPTY_TEMPLATE, ASH), MAXX);
    const [first] = lineIds(two);
    expect(lineIds(withoutLine(two, first!))).toEqual(lineIds(two).slice(1));
  });

  it('leaves the template alone when the id is not there', () => {
    const one = withCardLine(EMPTY_TEMPLATE, ASH);
    expect(withoutLine(one, 'nope')).toBe(one);
  });
});

describe('nextLineId', () => {
  it('does not collide with a line that is already there', () => {
    const two = withCardLine(withCardLine(EMPTY_TEMPLATE, ASH), MAXX);
    expect(lineIds(two)).not.toContain(nextLineId(two));
  });

  it('does not collide with the ids of a loaded template either', () => {
    expect(lineIds(EXAMPLE_TEMPLATE)).not.toContain(nextLineId(EXAMPLE_TEMPLATE));
  });

  it('fills a gap left by a removal rather than growing forever', () => {
    const two = withCardLine(withCardLine(EMPTY_TEMPLATE, ASH), MAXX);
    const [first] = lineIds(two);
    const one = withoutLine(two, first!);
    expect(nextLineId(one)).toBe(first);
  });
});

describe('cardLines', () => {
  it('is the lines that name a card, not the ones that describe cards', () => {
    const mixed = withCardLine(EXAMPLE_TEMPLATE, ASH);
    expect(cardLines(mixed).map((line) => line.card.passcode)).toEqual([ASH.passcode]);
  });

  it('is empty for a template of descriptions alone', () => {
    expect(cardLines(EXAMPLE_TEMPLATE)).toEqual([]);
  });
});

describe('learnCards', () => {
  it('remembers a card by its passcode', () => {
    expect(learnCards({}, [ASH])).toEqual({ [ASH.passcode]: ASH });
  });

  it('gives back the same map when it learns nothing new, so nothing re-renders', () => {
    const known = learnCards({}, [ASH, MAXX]);
    expect(learnCards(known, [ASH])).toBe(known);
  });

  it('replaces what it knew when the card database says otherwise', () => {
    const renamed = { ...ASH, typeline: 'Level 3 · FIRE · Zombie · Effect Monster' };
    expect(learnCards(learnCards({}, [ASH]), [renamed])[ASH.passcode]).toEqual(renamed);
  });
});

describe('unknownPasscodes', () => {
  it('is the named cards whose display fields are not in hand yet', () => {
    const template = withCardLine(EMPTY_TEMPLATE, ASH);
    expect(unknownPasscodes(template, {})).toEqual([ASH.passcode]);
    expect(unknownPasscodes(template, learnCards({}, [ASH]))).toEqual([]);
  });

  it('is empty for a template with no named cards', () => {
    expect(unknownPasscodes(EXAMPLE_TEMPLATE, {})).toEqual([]);
  });
});

describe('selectCardState', () => {
  it('is idle before the first status arrives', () => {
    expect(selectCardState(createAppStore().getState())).toBe('idle');
  });

  it('follows the pushed status', () => {
    const store = createAppStore();
    store.getState().setCards(status({ state: 'loading' }));
    expect(selectCardState(store.getState())).toBe('loading');
  });
});

describe('selectCardsReady', () => {
  it('is true only with an index to search', () => {
    const store = createAppStore();
    expect(selectCardsReady(store.getState())).toBe(false);
    store.getState().setCards(status({ state: 'error', error: 'boom' }));
    expect(selectCardsReady(store.getState())).toBe(false);
    store.getState().setCards(status());
    expect(selectCardsReady(store.getState())).toBe(true);
  });
});

describe('selectStage', () => {
  it('waits before the first status, then follows it', () => {
    const store = createAppStore();
    expect(selectStage(store.getState())).toBe('loading');
    store.getState().setCards(status({ state: 'idle', workdir: null }));
    expect(selectStage(store.getState())).toBe('choose');
    store.getState().setCards(status());
    expect(selectStage(store.getState())).toBe('ready');
  });
});

describe('selectShows', () => {
  function shows(...statuses: CardStatus[]): string {
    const store = createAppStore();
    for (const next of statuses) store.getState().setCards(next);
    return selectShows(store.getState());
  }

  it('shows setup until there is an index, then the workspace', () => {
    expect(selectShows(createAppStore().getState())).toBe('setup');
    expect(shows(status({ state: 'idle', workdir: null }))).toBe('setup');
    expect(shows(status({ state: 'loading' }))).toBe('setup');
    expect(shows(status())).toBe('workspace');
  });

  it('keeps the workspace through a re-index: the work is not thrown away for 68 ms', () => {
    expect(shows(status(), status({ state: 'loading' }))).toBe('workspace');
  });

  it('goes back to setup when a reload FAILS, because that needs an answer', () => {
    expect(shows(status(), status({ state: 'error', error: 'the folder is gone' }))).toBe('setup');
    expect(shows(status(), status({ state: 'idle', workdir: null }))).toBe('setup');
  });

  it('shows settings over anything else, in every card state', () => {
    const store = createAppStore();
    store.getState().show('settings');
    expect(selectShows(store.getState())).toBe('settings');
    store.getState().setCards(status());
    expect(selectShows(store.getState())).toBe('settings');
  });
});

describe('selectStatusText', () => {
  it('is a line about the card index', () => {
    const store = createAppStore();
    store.getState().setCards(status());
    expect(selectStatusText(store.getState())).toContain('12,132');
  });

  it('says so before the first status arrives', () => {
    expect(selectStatusText(createAppStore().getState())).not.toBe('');
  });
});

describe('createAppStore', () => {
  it('starts on the workspace with an empty template and no run', () => {
    const state = createAppStore().getState();
    expect(state.view).toBe('workspace');
    expect(state.template).toBe(EMPTY_TEMPLATE);
    expect(state.run).toBe(IDLE_RUN);
    expect(state.cards).toBeNull();
    expect(state.settings).toBeNull();
  });

  describe('setCards', () => {
    it('holds the latest pushed status', () => {
      const store = createAppStore();
      store.getState().setCards(status({ state: 'loading' }));
      store.getState().setCards(status());
      expect(store.getState().cards).toEqual(status());
    });

    it('clears a stale probe readout once the index speaks for itself', () => {
      const store = createAppStore();
      store.getState().setProbe({
        ok: true,
        path: '/edopro',
        databases: 20,
        stringsConf: 1,
        problems: [],
        notes: [],
      });
      store.getState().setCards(status());
      expect(store.getState().probe).toBeNull();
    });

    it('keeps a REJECTED probe readout, which the status cannot explain', () => {
      const store = createAppStore();
      const rejected = {
        ok: false,
        path: '/downloads',
        databases: 0,
        stringsConf: 0,
        problems: ['no card database found'],
        notes: [],
      };
      store.getState().setProbe(rejected);
      store.getState().setCards(status({ state: 'idle', workdir: null }));
      expect(store.getState().probe).toBe(rejected);
    });
  });

  describe('show', () => {
    it('routes between the workspace and settings', () => {
      const store = createAppStore();
      store.getState().show('settings');
      expect(store.getState().view).toBe('settings');
      store.getState().show('workspace');
      expect(store.getState().view).toBe('workspace');
    });
  });

  describe('pickCard', () => {
    it('adds the card to the template being edited', () => {
      const store = createAppStore();
      store.getState().pickCard(ASH);
      expect(store.getState().template.lines).toHaveLength(1);
    });

    it('does not add one card twice', () => {
      const store = createAppStore();
      store.getState().pickCard(ASH);
      const after = store.getState().template;
      store.getState().pickCard(ASH);
      expect(store.getState().template).toBe(after);
    });

    it('remembers the typeline the picker showed, which the template file does not keep', () => {
      const store = createAppStore();
      store.getState().pickCard(ASH);
      expect(store.getState().known[ASH.passcode]).toEqual(ASH);
    });
  });

  describe('learn', () => {
    it('takes the display fields main resolved for a named card', () => {
      const store = createAppStore();
      store.getState().learn([ASH, MAXX]);
      expect(Object.keys(store.getState().known)).toHaveLength(2);
    });

    it('holds the map still when there is nothing new, so no effect loops', () => {
      const store = createAppStore();
      store.getState().learn([ASH]);
      const known = store.getState().known;
      store.getState().learn([ASH]);
      expect(store.getState().known).toBe(known);
    });
  });

  describe('dropLine', () => {
    it('removes a line the picker added', () => {
      const store = createAppStore();
      store.getState().pickCard(ASH);
      const [line] = store.getState().template.lines;
      store.getState().dropLine(line!.id);
      expect(store.getState().template.lines).toEqual([]);
    });
  });

  describe('setTemplate', () => {
    it('replaces the template whole, as loading the example does', () => {
      const store = createAppStore();
      store.getState().pickCard(ASH);
      store.getState().setTemplate(EXAMPLE_TEMPLATE);
      expect(store.getState().template).toBe(EXAMPLE_TEMPLATE);
    });

    it('drops the run failure the previous template earned', () => {
      const store = createAppStore();
      store.getState().setRunFailure(['The template has errors; nothing was run.']);
      store.getState().setTemplate(EXAMPLE_TEMPLATE);
      expect(store.getState().runFailure).toEqual([]);
    });
  });

  describe('applyRunEvent', () => {
    it('reduces the run events into the view', () => {
      const store = createAppStore();
      store.getState().applyRunEvent({ runId: 1, type: 'started', total: 128, estimatedMs: 1 });
      expect(store.getState().run).toMatchObject({ phase: 'running', runId: 1 });
      store.getState().applyRunEvent({ runId: 1, type: 'result', result: runResult() });
      expect(store.getState().run.phase).toBe('done');
    });

    it('drops an event of a run older than the one on screen', () => {
      const store = createAppStore();
      store.getState().applyRunEvent({ runId: 2, type: 'started', total: 4, estimatedMs: 1 });
      const showing = store.getState().run;
      store.getState().applyRunEvent({ runId: 1, type: 'error', message: 'stale' });
      expect(store.getState().run).toBe(showing);
    });

    it('clears the failure of a previous start when a run does start', () => {
      const store = createAppStore();
      store.getState().setRunFailure(['The template has errors; nothing was run.']);
      store.getState().applyRunEvent({ runId: 1, type: 'started', total: 4, estimatedMs: 1 });
      expect(store.getState().runFailure).toEqual([]);
    });
  });

  describe('cancelling', () => {
    it('says a graceful stop was asked for, until the partial result arrives', () => {
      const store = createAppStore();
      store.getState().applyRunEvent({ runId: 1, type: 'started', total: 4, estimatedMs: 1 });
      store.getState().cancelling();
      expect(store.getState().run).toMatchObject({ phase: 'running', cancelling: true });
    });

    it('leaves a run that is not running alone', () => {
      const store = createAppStore();
      const idle = store.getState().run;
      store.getState().cancelling();
      expect(store.getState().run).toBe(idle);
    });
  });
});

describe('the selectors', () => {
  /** Every selector the components pass to `useStore`: a new object each call would re-render forever. */
  const selectors: ((state: AppState) => unknown)[] = [
    selectCardState,
    selectCardsReady,
    selectShows,
    selectStage,
    selectStatusText,
    (state) => state.cards,
    (state) => state.template,
    (state) => state.run,
    (state) => state.settings,
    (state) => state.view,
    (state) => state.known,
  ];

  function ready(): AppStore {
    const store = createAppStore();
    store.getState().setCards(status());
    store.getState().setTemplate(EXAMPLE_TEMPLATE);
    return store;
  }

  it('give the same value twice for an unchanged state', () => {
    const state = ready().getState();
    for (const select of selectors) expect(select(state)).toBe(select(state));
  });
});
