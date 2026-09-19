import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  Analysis,
  AnalyzeTemplateResult,
  AppInfo,
  CardHit,
  CardState,
  CardStatus,
  RunEvent,
  Settings,
  Template,
  WorkdirHealth,
} from '../../shared/types';
import { type AnalysisView, NO_ANALYSIS, reduceAnalysis } from './model/analysis-view';
import { statusHeadline } from './model/card-status';
import type { CopyRange } from './model/copy-range';
import { IDLE_RUN, markCancelling, type RunView, reduceRun } from './model/run-state';
import { type SetupStage, setupStage } from './model/setup';
import {
  cardLines,
  EMPTY_TEMPLATE,
  withCardLine,
  withDeckSize,
  withDescriptionLine,
  withGroup,
  withGroupCard,
  withHandSize,
  withLineRange,
  withLineText,
  withMovedLine,
  withoutGroup,
  withoutGroupCard,
  withoutLine,
  withRenamedGroup,
} from './model/template-edit';

// The renderer's one store (TDD §3): what main has pushed, what the user is
// editing, and where the run stands. Everything derived is a selector, so the
// state holds one copy of each fact and no copy of any conclusion. Every
// template edit is one of `model/template-edit`'s pure functions, so the
// actions below are a name and a call.

/** Settings is a panel, not a tab: the workspace is where the work is. */
export type View = 'workspace' | 'settings';

export { EMPTY_TEMPLATE };

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

/** The named cards whose display fields are still to be resolved: those on lines, and those in groups. */
export function unknownPasscodes(template: Template, known: KnownCards): number[] {
  const wanted = [
    ...cardLines(template).map((line) => line.card.passcode),
    ...template.groups.flatMap((group) => group.cards.map((card) => card.passcode)),
  ];
  return [...new Set(wanted)].filter((passcode) => known[passcode] === undefined);
}

export interface AppState {
  /** Version, Electron, Node: the footer. `null` until `app:info` answers. */
  info: AppInfo | null;
  /** The card index as main last pushed it; `null` before the first push. */
  cards: CardStatus | null;
  /** `null` until `settings:get` answers. */
  settings: Settings | null;
  view: View;
  /** The template being edited. */
  template: Template;
  /** What main understood of it (TDD §9), and why it could not. */
  analysis: AnalysisView;
  /** The latest run. */
  run: RunView;
  /** Why `run:start` started nothing; empty when it did. */
  runFailure: string[];
  /** The probe of a folder the user just chose, until the card status speaks for itself. */
  probe: WorkdirHealth | null;
  /** Display fields of the named cards on the template's lines and in its groups. */
  known: KnownCards;
  /** There has been a usable index at some point in this window's life. */
  everReady: boolean;

  setInfo(info: AppInfo): void;
  setCards(status: CardStatus): void;
  setSettings(settings: Settings): void;
  setProbe(probe: WorkdirHealth | null): void;
  show(view: View): void;
  setTemplate(template: Template): void;
  /** A `template:analyze` reply that is not stale. */
  setAnalysis(result: AnalyzeTemplateResult): void;
  /** A card came back from the picker. */
  pickCard(card: CardHit): void;
  addDescriptionLine(): void;
  dropLine(id: string): void;
  setLineText(id: string, text: string): void;
  setLineRange(id: string, range: CopyRange): void;
  /** One place up (`by` -1) or down (`by` +1); a line at that end does not move. */
  moveLine(id: string, by: number): void;
  setDeckSize(size: number): void;
  setHandSize(size: number): void;
  addGroup(name: string): void;
  renameGroup(id: string, name: string): void;
  dropGroup(id: string): void;
  addGroupCard(id: string, card: CardHit): void;
  dropGroupCard(id: string, passcode: number): void;
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
  return createStore<AppState>()((set) => {
    /** A template edit: applied to the state as it is NOW, so two in one tick cannot collide. */
    const edit =
      <A extends unknown[]>(change: (template: Template, ...args: A) => Template) =>
      (...args: A) =>
        set((state) => {
          const template = change(state.template, ...args);
          return template === state.template ? {} : { template, runFailure: [] };
        });

    return {
      info: null,
      cards: null,
      settings: null,
      view: 'workspace',
      template: EMPTY_TEMPLATE,
      analysis: NO_ANALYSIS,
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
      setAnalysis: (result) =>
        set((state) => {
          const analysis = reduceAnalysis(state.analysis, result);
          // The same object when nothing moved, so `(s) => s.analysis` is stable.
          return analysis.analysis === state.analysis.analysis &&
            analysis.problem === state.analysis.problem
            ? {}
            : { analysis };
        }),
      pickCard: (card) =>
        set((state) => ({
          template: withCardLine(state.template, card),
          known: learnCards(state.known, [card]),
          runFailure: [],
        })),
      addDescriptionLine: edit(withDescriptionLine),
      dropLine: edit(withoutLine),
      setLineText: edit(withLineText),
      setLineRange: edit(withLineRange),
      moveLine: edit(withMovedLine),
      setDeckSize: edit(withDeckSize),
      setHandSize: edit(withHandSize),
      addGroup: edit(withGroup),
      renameGroup: edit(withRenamedGroup),
      dropGroup: edit(withoutGroup),
      addGroupCard: (id, card) =>
        set((state) => ({
          template: withGroupCard(state.template, id, card),
          known: learnCards(state.known, [card]),
          runFailure: [],
        })),
      dropGroupCard: edit(withoutGroupCard),
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
    };
  });
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

/** What main understood of the template on screen; `null` before the first reply. */
export function selectAnalysis(state: AppState): Analysis | null {
  return state.analysis.analysis;
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
