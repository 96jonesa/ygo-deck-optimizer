import { describe, expect, it } from 'vitest';
import { EXAMPLE_TEMPLATE } from '../../../src/renderer/src/model/example-template';
import { IDLE_RUN } from '../../../src/renderer/src/model/run-state';
import { EMPTY_TEMPLATE, withCardLine } from '../../../src/renderer/src/model/template-edit';
import {
  type AppState,
  type AppStore,
  createAppStore,
  learnCards,
  selectAnalysis,
  selectCardState,
  selectCardsReady,
  selectRunBlocker,
  selectRunnable,
  selectRunSentence,
  selectShows,
  selectStage,
  selectStatusText,
  unknownPasscodes,
} from '../../../src/renderer/src/store';
import type { Analysis, CardHit, CardStatus, RunResult } from '../../../src/shared/types';

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

  it('asks about the cards in a GROUP too: their chips need a typeline as much as a line does', () => {
    const store = createAppStore();
    store.getState().addGroup('starter');
    store.getState().addGroupCard('g1', ASH);
    const { template } = store.getState();
    expect(unknownPasscodes(template, {})).toEqual([ASH.passcode]);
  });

  it('asks about a card only once when a line and a group both name it', () => {
    const store = createAppStore();
    store.getState().pickCard(ASH);
    store.getState().addGroup('starter');
    store.getState().addGroupCard('g1', ASH);
    expect(unknownPasscodes(store.getState().template, {})).toEqual([ASH.passcode]);
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

  describe('addDescriptionLine', () => {
    it('adds a line to the template being edited', () => {
      const store = createAppStore();
      store.getState().addDescriptionLine();
      expect(store.getState().template.lines).toMatchObject([{ text: '', min: 0, max: 3 }]);
    });

    it('gives two lines added in one tick two different ids', () => {
      // The edit is applied to the state as it is, not to a snapshot taken
      // before it: two clicks in one frame must not make two `line1`s.
      const store = createAppStore();
      store.getState().addDescriptionLine();
      store.getState().addDescriptionLine();
      const ids = store.getState().template.lines.map((line) => line.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('setLineText', () => {
    it('edits the line the user is typing into', () => {
      const store = createAppStore();
      store.getState().addDescriptionLine();
      store.getState().setLineText('line1', 'level 4 monster');
      expect(store.getState().template.lines[0]).toMatchObject({ text: 'level 4 monster' });
    });

    it('holds the template still when the edit changes nothing', () => {
      const store = createAppStore();
      store.getState().addDescriptionLine();
      const before = store.getState().template;
      store.getState().setLineText('nope', 'monster');
      expect(store.getState().template).toBe(before);
    });
  });

  describe('setLineRange', () => {
    it('sets the copy range of that line', () => {
      const store = createAppStore();
      store.getState().pickCard(ASH);
      store.getState().setLineRange('card1', { min: 1, max: 2 });
      expect(store.getState().template.lines[0]).toMatchObject({ min: 1, max: 2 });
    });
  });

  describe('moveLine', () => {
    it('reorders the lines', () => {
      const store = createAppStore();
      store.getState().pickCard(ASH);
      store.getState().pickCard(MAXX);
      store.getState().moveLine('card1', 1);
      expect(store.getState().template.lines.map((line) => line.id)).toEqual(['card2', 'card1']);
    });

    it('holds the template still at either end', () => {
      const store = createAppStore();
      store.getState().pickCard(ASH);
      const before = store.getState().template;
      store.getState().moveLine('card1', -1);
      store.getState().moveLine('card1', 1);
      expect(store.getState().template).toBe(before);
    });
  });

  describe('addSuggestedLine', () => {
    it('adds the near miss’s suggestion as a line, word for word', () => {
      const store = createAppStore();
      store.getState().addSuggestedLine('level 4 or lower monster');
      expect(store.getState().template.lines).toMatchObject([
        { id: 'line1', text: 'level 4 or lower monster' },
      ]);
    });

    it('leaves the template it was editing alone, rather than adding the line to it', () => {
      const store = createAppStore();
      store.getState().setTemplate(EXAMPLE_TEMPLATE);
      const before = store.getState().template.lines;
      store.getState().addSuggestedLine('level 4 or lower monster');
      expect(store.getState().template.lines).not.toBe(before);
      expect(before).toHaveLength(7);
      expect(EXAMPLE_TEMPLATE.lines).toHaveLength(7);
    });

    it('gives two suggestions taken in one tick two different ids', () => {
      const store = createAppStore();
      store.getState().addSuggestedLine('monster');
      store.getState().addSuggestedLine('spell');
      const ids = store.getState().template.lines.map((line) => line.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('addCriterion', () => {
    it('adds a criterion to the template being edited', () => {
      const store = createAppStore();
      store.getState().addCriterion();
      expect(store.getState().template.criteria).toEqual([{ id: 'c1', text: '' }]);
    });

    it('gives two criteria added in one tick two different ids', () => {
      const store = createAppStore();
      store.getState().addCriterion();
      store.getState().addCriterion();
      const ids = store.getState().template.criteria.map((criterion) => criterion.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('dropCriterion', () => {
    it('removes that criterion', () => {
      const store = createAppStore();
      store.getState().setTemplate(EXAMPLE_TEMPLATE);
      store.getState().dropCriterion('c1');
      expect(store.getState().template.criteria).toHaveLength(1);
    });

    it('holds the template still when there is no such criterion', () => {
      const store = createAppStore();
      store.getState().setTemplate(EXAMPLE_TEMPLATE);
      const before = store.getState().template;
      store.getState().dropCriterion('c9');
      expect(store.getState().template).toBe(before);
    });
  });

  describe('setCriterionText', () => {
    it('edits the criterion the user is typing into', () => {
      const store = createAppStore();
      store.getState().addCriterion();
      store.getState().setCriterionText('c1', '1x monster');
      expect(store.getState().template.criteria[0]).toMatchObject({ text: '1x monster' });
    });
  });

  describe('setCriterionName', () => {
    it('names the criterion', () => {
      const store = createAppStore();
      store.getState().addCriterion();
      store.getState().setCriterionName('c1', 'the good hand');
      expect(store.getState().template.criteria[0]).toMatchObject({ name: 'the good hand' });
    });

    it('holds the template still when the name is the one it has', () => {
      const store = createAppStore();
      store.getState().addCriterion();
      store.getState().setCriterionName('c1', 'x');
      const before = store.getState().template;
      store.getState().setCriterionName('c1', 'x');
      expect(store.getState().template).toBe(before);
    });
  });

  describe('moveCriterion', () => {
    it('moves a criterion down one place', () => {
      const store = createAppStore();
      store.getState().setTemplate(EXAMPLE_TEMPLATE);
      store.getState().moveCriterion('c1', 1);
      expect(store.getState().template.criteria.map((c) => c.id)).toEqual(['c2', 'c1']);
    });

    it('holds the template still at the end it cannot move past', () => {
      const store = createAppStore();
      store.getState().setTemplate(EXAMPLE_TEMPLATE);
      const before = store.getState().template;
      store.getState().moveCriterion('c1', -1);
      expect(store.getState().template).toBe(before);
    });
  });

  describe('setDeckSize', () => {
    it('sets the deck size', () => {
      const store = createAppStore();
      store.getState().setDeckSize(60);
      expect(store.getState().template.deckSize).toBe(60);
    });
  });

  describe('setHandSize', () => {
    it('sets the hand size', () => {
      const store = createAppStore();
      store.getState().setHandSize(6);
      expect(store.getState().template.hand).toEqual({ size: 6 });
    });
  });

  describe('setMode', () => {
    it('sets the mode, and the hand size that goes with it', () => {
      const store = createAppStore();
      store.getState().setMode('average');
      expect(store.getState().template).toMatchObject({ mode: 'average', hand: { size: 6 } });
      store.getState().setMode('first');
      expect(store.getState().template).toMatchObject({ mode: 'first', hand: { size: 5 } });
    });

    it('holds the template still when the mode is the one it has', () => {
      const store = createAppStore();
      store.getState().setMode('second');
      const before = store.getState().template;
      store.getState().setMode('second');
      expect(store.getState().template).toBe(before);
    });
  });

  describe('setCriterionWhen', () => {
    it('tags the criterion with the hand it is judged for', () => {
      const store = createAppStore();
      store.getState().addCriterion();
      store.getState().setCriterionWhen('c1', 'second');
      expect(store.getState().template.criteria[0]).toMatchObject({ when: 'second' });
    });

    it('holds the template still when the tag does not move', () => {
      const store = createAppStore();
      store.getState().addCriterion();
      const before = store.getState().template;
      store.getState().setCriterionWhen('c1', 'both');
      expect(store.getState().template).toBe(before);
    });
  });

  describe('addGroup', () => {
    it('adds a named group the descriptions can reach', () => {
      const store = createAppStore();
      store.getState().addGroup('starter');
      expect(store.getState().template.groups).toEqual([{ id: 'g1', name: 'starter', cards: [] }]);
    });

    it('holds the template still for a blank name', () => {
      const store = createAppStore();
      const before = store.getState().template;
      store.getState().addGroup('  ');
      expect(store.getState().template).toBe(before);
    });
  });

  describe('renameGroup', () => {
    it('renames it', () => {
      const store = createAppStore();
      store.getState().addGroup('starter');
      store.getState().renameGroup('g1', 'enabler');
      expect(store.getState().template.groups[0]?.name).toBe('enabler');
    });
  });

  describe('dropGroup', () => {
    it('removes it', () => {
      const store = createAppStore();
      store.getState().addGroup('starter');
      store.getState().dropGroup('g1');
      expect(store.getState().template.groups).toEqual([]);
    });
  });

  describe('addGroupCard', () => {
    it('adds the card to the group', () => {
      const store = createAppStore();
      store.getState().addGroup('starter');
      store.getState().addGroupCard('g1', ASH);
      expect(store.getState().template.groups[0]?.cards).toEqual([
        { passcode: ASH.passcode, name: ASH.name },
      ]);
    });

    it('remembers the typeline the picker showed, so the chip can be drawn', () => {
      const store = createAppStore();
      store.getState().addGroup('starter');
      store.getState().addGroupCard('g1', ASH);
      expect(store.getState().known[ASH.passcode]).toEqual(ASH);
    });
  });

  describe('dropGroupCard', () => {
    it('removes the card from the group', () => {
      const store = createAppStore();
      store.getState().addGroup('starter');
      store.getState().addGroupCard('g1', ASH);
      store.getState().dropGroupCard('g1', ASH.passcode);
      expect(store.getState().template.groups[0]?.cards).toEqual([]);
    });
  });

  describe('setAnalysis', () => {
    const analysis = { ok: true, deckSize: 40, lines: [] } as unknown as Analysis;

    it('holds what main understood of the template', () => {
      const store = createAppStore();
      store.getState().setAnalysis({ ok: true, analysis });
      expect(selectAnalysis(store.getState())).toBe(analysis);
    });

    it('keeps the analysis in hand through a re-index, and says why there is no newer one', () => {
      const store = createAppStore();
      store.getState().setAnalysis({ ok: true, analysis });
      store.getState().setAnalysis({
        ok: false,
        reason: 'not-ready',
        state: 'loading',
        message: 'the card data is still loading',
      });
      expect(selectAnalysis(store.getState())).toBe(analysis);
      expect(store.getState().analysis.problem).toBe('the card data is still loading');
    });

    it('holds the slot still when the same analysis arrives again', () => {
      const store = createAppStore();
      store.getState().setAnalysis({ ok: true, analysis });
      const before = store.getState().analysis;
      store.getState().setAnalysis({ ok: true, analysis });
      expect(store.getState().analysis).toBe(before);
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

describe('selectRunBlocker', () => {
  /** A store with an index, the example, and an analysis that found nothing wrong. */
  function runnable(): AppStore {
    const store = createAppStore();
    store.getState().setCards(status());
    store.getState().setTemplate(EXAMPLE_TEMPLATE);
    store.getState().setAnalysis({ ok: true, analysis: { ok: true } as Analysis });
    return store;
  }

  it('is nothing when there is an index, a template and an analysis without errors', () => {
    expect(selectRunBlocker(runnable().getState())).toBeNull();
    expect(selectRunnable(runnable().getState())).toBe(true);
  });

  it('refuses without a card index', () => {
    const store = createAppStore();
    store.getState().setTemplate(EXAMPLE_TEMPLATE);
    expect(selectRunBlocker(store.getState())).toBe('A run needs the card database.');
  });

  it('refuses a template the analysis found errors in', () => {
    const store = runnable();
    store.getState().setAnalysis({ ok: true, analysis: { ok: false } as Analysis });
    expect(selectRunBlocker(store.getState())).toContain('marked on the lines and criteria');
  });

  /**
   * The empty line or criterion case. `validateTemplate` refuses empty `text`,
   * so `template:analyze` answers `invalid` and `reduceAnalysis` KEEPS the
   * previous analysis — whose `ok` is about the previous template. Run must
   * not be live over it.
   */
  it('refuses while the latest analysis came back invalid, however well the last one went', () => {
    const store = runnable();
    store.getState().setAnalysis({
      ok: false,
      reason: 'invalid',
      message: 'this is not a well-formed template',
      errors: ['criteria[0] ("c1"): `text` must be non-empty text, not ""'],
    });
    expect(store.getState().analysis.analysis).toMatchObject({ ok: true });
    expect(selectRunnable(store.getState())).toBe(false);
    expect(selectRunBlocker(store.getState())).toContain('not complete yet');
  });

  it('refuses a template with no criterion, which no hand can pass', () => {
    const store = runnable();
    store.getState().setTemplate({ ...EXAMPLE_TEMPLATE, criteria: [] });
    expect(selectRunBlocker(store.getState())).toContain('at least one line and one criterion');
  });

  it('refuses a template with no lines', () => {
    const store = runnable();
    store.getState().setTemplate({ ...EXAMPLE_TEMPLATE, lines: [] });
    expect(selectRunBlocker(store.getState())).toContain('at least one line and one criterion');
  });

  it('does not refuse merely because nothing has been analysed yet', () => {
    const store = createAppStore();
    store.getState().setCards(status());
    store.getState().setTemplate(EXAMPLE_TEMPLATE);
    expect(selectRunnable(store.getState())).toBe(true);
  });
});

describe('selectRunSentence', () => {
  function runnable(): AppStore {
    const store = createAppStore();
    store.getState().setCards(status());
    store.getState().setTemplate(EXAMPLE_TEMPLATE);
    store.getState().setAnalysis({ ok: true, analysis: { ok: true } as Analysis });
    return store;
  }

  it('is the blocker’s own words whenever one stands, so Run and its sentence cannot disagree', () => {
    const store = createAppStore();
    store.getState().setTemplate(EXAMPLE_TEMPLATE);
    expect(selectRunSentence(store.getState())).toBe(selectRunBlocker(store.getState()));
    expect(selectRunnable(store.getState())).toBe(false);
  });

  it('says what the run would be once nothing blocks it', () => {
    const store = runnable();
    expect(selectRunSentence(store.getState())).toBe(
      'Ready to score: 7 lines, 2 criteria, deck of 40.',
    );
  });

  it('adds the size the analysis worked out, rather than working it out again', () => {
    const store = runnable();
    const work = {
      rawRatios: 4096,
      classVectors: 128,
      hands: null,
      estimatedMs: 12,
      cost: { perVectorUs: 0, perTermNs: 7 },
    };
    store.getState().setAnalysis({ ok: true, analysis: { ok: true, work } as unknown as Analysis });
    expect(selectRunSentence(store.getState())).toContain(
      '128 class vectors over 4,096 raw ratios',
    );
  });
});

describe('the selectors', () => {
  /** Every selector the components pass to `useStore`: a new object each call would re-render forever. */
  const selectors: ((state: AppState) => unknown)[] = [
    selectAnalysis,
    selectCardState,
    selectCardsReady,
    selectRunBlocker,
    selectRunnable,
    selectRunSentence,
    selectShows,
    selectStage,
    selectStatusText,
    (state) => state.cards,
    (state) => state.template,
    (state) => state.analysis,
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
