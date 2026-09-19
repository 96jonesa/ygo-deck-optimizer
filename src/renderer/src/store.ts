import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AppInfo,
  CardHit,
  CardState,
  CardStatus,
  RunEvent,
  Settings,
  Template,
  TemplateCard,
  TemplateLine,
  WorkdirHealth,
} from '../../shared/types';
import { statusHeadline } from './model/card-status';
import { IDLE_RUN, markCancelling, type RunView, reduceRun } from './model/run-state';
import { type SetupStage, setupStage } from './model/setup';

// The renderer's one store (TDD §3): what main has pushed, what the user is
// editing, and where the run stands. Everything derived is a selector, so the
// state holds one copy of each fact and no copy of any conclusion.

/** Settings is a panel, not a tab: the workspace is where the work is. */
export type View = 'workspace' | 'settings';

export const EMPTY_TEMPLATE: Template = {
  version: 1,
  deckSize: 40,
  hand: { size: 5 },
  groups: [],
  lines: [],
  remainder: { min: 0, max: null },
  criteria: [],
};

/** The copy range a card line starts at: anything from none to a full three. */
const CARD_LINE_MIN = 0;
const CARD_LINE_MAX = 3;
const CARD_LINE_PREFIX = 'card';

/** An id no line of `template` has, `card1` upwards: a removal frees its number again. */
export function nextLineId(template: Template): string {
  const taken = new Set(template.lines.map((line) => line.id));
  for (let n = 1; ; n++) {
    const id = `${CARD_LINE_PREFIX}${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * The picked card as a line of its own. A card already on a line is not added
 * again — two lines for one card is a `duplicate-card` error (TDD §9) — and
 * the template comes back unchanged, so nothing re-renders.
 */
export function withCardLine(template: Template, card: CardHit): Template {
  const already = template.lines.some(
    (line) => 'card' in line && line.card.passcode === card.passcode,
  );
  if (already) return template;
  return {
    ...template,
    lines: [
      ...template.lines,
      {
        id: nextLineId(template),
        card: { passcode: card.passcode, name: card.name },
        min: CARD_LINE_MIN,
        max: CARD_LINE_MAX,
      },
    ],
  };
}

/** Without the line of that id; unchanged — the same object — when there is none. */
export function withoutLine(template: Template, id: string): Template {
  const lines = template.lines.filter((line) => line.id !== id);
  return lines.length === template.lines.length ? template : { ...template, lines };
}

/** A line that names one card, as opposed to one that describes a kind of card. */
export type CardLine = Extract<TemplateLine, { card: TemplateCard }>;

export function isCardLine(line: TemplateLine): line is CardLine {
  return 'card' in line;
}

export function cardLines(template: Template): CardLine[] {
  return template.lines.filter(isCardLine);
}

/**
 * The display fields of the named cards, by passcode. A template file keeps a
 * card's passcode and name (TDD §14) but not its typeline, so what a chip
 * needs is either what the picker just showed or what `cards:get` resolves.
 */
export type KnownCards = Readonly<Record<number, CardHit>>;

/** `known` plus `cards`; the same object when it already said exactly that. */
export function learnCards(known: KnownCards, cards: readonly CardHit[]): KnownCards {
  const news = cards.filter((card) => {
    const had = known[card.passcode];
    return had === undefined || had.name !== card.name || had.typeline !== card.typeline;
  });
  if (news.length === 0) return known;
  const next = { ...known };
  for (const card of news) next[card.passcode] = card;
  return next;
}

/** The named cards whose display fields are still to be resolved. */
export function unknownPasscodes(template: Template, known: KnownCards): number[] {
  return cardLines(template)
    .map((line) => line.card.passcode)
    .filter((passcode) => known[passcode] === undefined);
}

export interface AppState {
  /** Version, Electron, Node: the footer. `null` until `app:info` answers. */
  info: AppInfo | null;
  /** The card index as main last pushed it; `null` before the first push. */
  cards: CardStatus | null;
  /** `null` until `settings:get` answers. */
  settings: Settings | null;
  view: View;
  /** The template being edited. M2d and M2e edit it in place; M2c only adds card lines. */
  template: Template;
  /** The latest run. */
  run: RunView;
  /** Why `run:start` started nothing; empty when it did. */
  runFailure: string[];
  /** The probe of a folder the user just chose, until the card status speaks for itself. */
  probe: WorkdirHealth | null;
  /** Display fields of the named cards on the template's lines. */
  known: KnownCards;
  /** There has been a usable index at some point in this window's life. */
  everReady: boolean;

  setInfo(info: AppInfo): void;
  setCards(status: CardStatus): void;
  setSettings(settings: Settings): void;
  setProbe(probe: WorkdirHealth | null): void;
  show(view: View): void;
  setTemplate(template: Template): void;
  /** A card came back from the picker. */
  pickCard(card: CardHit): void;
  dropLine(id: string): void;
  /** What `cards:get` resolved about named cards the display did not know. */
  learn(cards: readonly CardHit[]): void;
  setRunFailure(lines: string[]): void;
  applyRunEvent(event: RunEvent): void;
  /** Cancel was pressed: say so until the partial result arrives. */
  cancelling(): void;
}

export type AppStore = StoreApi<AppState>;

/** One per window; a test makes its own, so no two tests share a store. */
export function createAppStore(): AppStore {
  return createStore<AppState>()((set) => ({
    info: null,
    cards: null,
    settings: null,
    view: 'workspace',
    template: EMPTY_TEMPLATE,
    run: IDLE_RUN,
    runFailure: [],
    probe: null,
    known: {},
    everReady: false,

    setInfo: (info) => set({ info }),
    // A probe that said yes is superseded by the status of the load it caused;
    // one that said no is not — no load followed it, so nothing else says why.
    setCards: (cards) =>
      set((state) => ({
        cards,
        probe: state.probe?.ok ? null : state.probe,
        everReady: state.everReady || cards.state === 'ready',
      })),
    setSettings: (settings) => set({ settings }),
    setProbe: (probe) => set({ probe }),
    show: (view) => set({ view }),
    setTemplate: (template) => set({ template, runFailure: [] }),
    pickCard: (card) =>
      set((state) => ({
        template: withCardLine(state.template, card),
        known: learnCards(state.known, [card]),
      })),
    dropLine: (id) => set((state) => ({ template: withoutLine(state.template, id) })),
    learn: (cards) => set((state) => ({ known: learnCards(state.known, cards) })),
    setRunFailure: (runFailure) => set({ runFailure }),
    applyRunEvent: (event) =>
      set((state) => {
        const run = reduceRun(state.run, event);
        // Unchanged: a stale run's event, which must not clear the failure either.
        if (run === state.run) return { run };
        return { run, runFailure: [] };
      }),
    cancelling: () => set((state) => ({ run: markCancelling(state.run) })),
  }));
}

export const appStore = createAppStore();

/** The store as a hook. Selectors must return a stable value: see the tests. */
export function useApp<U>(selector: (state: AppState) => U): U {
  return useStore(appStore, selector);
}

// --- selectors -------------------------------------------------------------
// Each returns a primitive or something already in the state: a selector that
// built a fresh object would re-render for ever (zustand 5 compares by
// identity), which is why the tests check that calling one twice is stable.

export function selectCardState(state: AppState): CardState {
  return state.cards?.state ?? 'idle';
}

export function selectCardsReady(state: AppState): boolean {
  return state.cards?.state === 'ready';
}

export function selectStage(state: AppState): SetupStage {
  return setupStage(state.cards);
}

export function selectStatusText(state: AppState): string {
  return state.cards === null ? 'Starting…' : statusHeadline(state.cards);
}

/** What the main region is. */
export type Shows = 'settings' | 'workspace' | 'setup';

/**
 * The workspace needs an index, so setup stands in its place until there is
 * one — but once there has been, a RELOAD does not take it away again: a
 * re-index is 68 ms (TDD §13) and throwing the editors off screen for it
 * would lose what the user was looking at. A reload that FAILS does go back
 * to setup, since that is a state only the user can get out of.
 */
export function selectShows(state: AppState): Shows {
  if (state.view === 'settings') return 'settings';
  const stage = selectStage(state);
  if (stage === 'ready') return 'workspace';
  return stage === 'loading' && state.everReady ? 'workspace' : 'setup';
}
