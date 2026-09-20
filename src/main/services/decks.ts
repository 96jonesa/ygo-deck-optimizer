import * as nodeFs from 'node:fs';
import path from 'node:path';
import { parseYdk, templateFromDeck } from '../../core/model/ydk';
import type { DeckImportResult, DeckListResult, FileFailure, NotReady } from '../../shared/types';
import type { CardSource } from './templates';

// Reading the user's `.ydk` decklists (PRD §9). EDOPro keeps them in
// `<workdir>/deck/`, and the app already knows the workdir, so the common path
// is a LIST OF NAMES rather than a file dialog — a dialog stays for decks kept
// elsewhere. Node only: the parsing and the template-building are `core`'s
// (`core/model/ydk.ts`), and the filesystem is all that is left here.

/** Where EDOPro keeps decks, relative to the install. */
export const DECK_DIR = 'deck';
export const DECK_EXTENSION = '.ydk';

/** The slice of `node:fs` this uses; injectable so a test never touches a real install. */
export interface DeckFs {
  existsSync(target: string): boolean;
  readdirSync(dir: string): string[];
  readFileSync(file: string, encoding: 'utf8'): string;
}

export interface DeckServiceDeps {
  /** `CardService` satisfies it: the index a passcode is resolved through. */
  cards: CardSource;
  /** The install, or `null` when none is set; read per call, since the setting can change. */
  workdir(): string | null;
  /** The system's open-file dialog; `null` when it is cancelled. */
  pickFile(): Promise<string | null>;
  fs?: DeckFs;
}

function failed(error: unknown): FileFailure {
  return {
    ok: false,
    reason: 'read',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The install's decks, and one of them as a template.
 *
 * A deck is named by the renderer, never located by it (TDD §3): `import`
 * takes a name and checks it against the names `list` gave, so nothing the
 * renderer sends can reach outside the `deck/` folder — the check is the
 * containment, not a string test on the name.
 */
export class DeckService {
  private readonly fs: DeckFs;

  constructor(private readonly deps: DeckServiceDeps) {
    this.fs = deps.fs ?? nodeFs;
  }

  /** The deck names in `<workdir>/deck/`, extension stripped, sorted. Empty when there is no folder. */
  list(): DeckListResult {
    const ready = this.deps.cards.ready();
    if (ready === null) return this.notReady();
    const dir = this.deckDir();
    if (dir === null || !this.fs.existsSync(dir)) return { ok: true, decks: [] };
    try {
      const decks = this.fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith(DECK_EXTENSION))
        .map((name) => name.slice(0, -DECK_EXTENSION.length))
        .sort((a, b) => a.localeCompare(b));
      return { ok: true, decks };
    } catch (failure) {
      return failed(failure);
    }
  }

  /**
   * One deck as a template. `name` names a deck of `list`'s; without one, the
   * user picks a file. What the decklist MEANS — which card a passcode is,
   * what a count above three does, what the deck size becomes — is
   * `templateFromDeck`'s, in `core`, so this is a read and a lookup.
   */
  async import(request: unknown): Promise<DeckImportResult> {
    const ready = this.deps.cards.ready();
    if (ready === null) return this.notReady();

    const asked = typeof request === 'object' && request !== null ? request : {};
    const name = (asked as { name?: unknown }).name;
    if (name !== undefined && typeof name !== 'string')
      return {
        ok: false,
        reason: 'invalid',
        message: 'a deck is named',
        errors: ['`name` must be text'],
      };

    let file: string;
    let label: string;
    if (name === undefined) {
      const picked = await this.deps.pickFile();
      if (picked === null) return { ok: false, reason: 'cancelled' };
      file = picked;
      label = path.basename(picked, DECK_EXTENSION);
    } else {
      const listed = this.list();
      // The renderer may send anything; only a name the folder really holds is
      // turned into a path, so `../../etc/passwd` resolves to no deck at all.
      if (!listed.ok) return listed;
      if (!listed.decks.includes(name))
        return {
          ok: false,
          reason: 'read',
          message: `there is no deck called ${JSON.stringify(name)}`,
        };
      file = path.join(this.deckDir()!, `${name}${DECK_EXTENSION}`);
      label = name;
    }

    let text: string;
    try {
      text = this.fs.readFileSync(file, 'utf8');
    } catch (failure) {
      return failed(failure);
    }

    const { main } = parseYdk(text);
    if (main.length === 0)
      return { ok: false, reason: 'read', message: `${label} has no main deck to import` };
    const imported = templateFromDeck(main, ready.cards);
    return {
      ok: true,
      template: imported.template,
      deck: { name: label, mainSize: imported.mainSize, distinct: imported.distinct },
      warnings: imported.warnings,
    };
  }

  private deckDir(): string | null {
    const workdir = this.deps.workdir();
    return workdir === null ? null : path.join(workdir, DECK_DIR);
  }

  private notReady(): NotReady {
    const { state, error } = this.deps.cards.status();
    return {
      ok: false,
      reason: 'not-ready',
      state,
      message:
        state === 'loading'
          ? 'the card data is still loading'
          : state === 'error'
            ? `the card data failed to load: ${error ?? 'unknown error'}`
            : 'no EDOPro folder is set, so there are no decks to list',
    };
  }
}
