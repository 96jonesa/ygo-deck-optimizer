import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { validateTemplate } from '../../../src/core/model/template';
import { loadCardIndex, loadSetnames } from '../../../src/main/edopro/loader';
import { CardService } from '../../../src/main/services/cards';
import { DECK_DIR, DeckService } from '../../../src/main/services/decks';
import { immediateLoader, loadedCards } from '../../helpers/card-loader';
import { CODE, FIXTURE_ROWS, POPULATION } from '../../helpers/fixture-cards';
import { tempDirs } from '../../helpers/workdir';

const SQL = await initSqlJs();
const temp = tempDirs('ygo-decks-');

/** A `.ydk` file holding `main`, written the way EDOPro writes one. */
function ydkText(main: readonly number[]): string {
  return ['#created by pyrQ', '#main', ...main, '#extra', '!side', ''].join('\n');
}

/** 40 main-deck entries, `codes` first and fixture cards after. */
function deckOf(codes: readonly number[] = []): number[] {
  const main = [...codes];
  const taken = new Set(codes);
  const filler = POPULATION.filter((code) => !taken.has(code));
  for (let n = 0; main.length < 40; n++) main.push(filler[n % filler.length]!);
  return main;
}

/** An install holding `decks` (name → main-deck codes), and a ready `DeckService` over it. */
async function services(decks: Record<string, readonly number[]> = {}, hasFolder = true) {
  const files: Record<string, string> = { 'cards.cdb': 'unused' };
  if (hasFolder)
    for (const [name, main] of Object.entries(decks))
      files[path.join(DECK_DIR, `${name}.ydk`)] = ydkText(main);
  const workdir = temp.workdir(files);
  const cards = new CardService(
    immediateLoader(() => loadedCards(SQL, FIXTURE_ROWS)),
    () => {},
  );
  await cards.reload(workdir, { includePrerelease: true });
  const picks: (string | null)[] = [];
  const service = new DeckService({
    cards,
    workdir: () => workdir,
    pickFile: async () => picks.shift() ?? null,
  });
  return { service, workdir, cards, picks };
}

describe('DeckService', () => {
  describe('list', () => {
    it('names the decks in the install, without their extension, sorted', async () => {
      const { service } = await services({ Zebra: deckOf(), Alpha: deckOf() });
      expect(service.list()).toEqual({ ok: true, decks: ['Alpha', 'Zebra'] });
    });

    it('lists nothing, rather than failing, when the install has no deck folder', async () => {
      const { service } = await services({}, false);
      expect(service.list()).toEqual({ ok: true, decks: [] });
    });

    it('says the card data is not ready rather than guessing', async () => {
      const cards = new CardService(
        immediateLoader(() => loadedCards(SQL)),
        () => {},
      );
      const service = new DeckService({
        cards,
        workdir: () => null,
        pickFile: async () => null,
      });
      expect(service.list()).toMatchObject({ ok: false, reason: 'not-ready', state: 'idle' });
    });
  });

  describe('import', () => {
    it('reads a named deck as one line per distinct card', async () => {
      const { service } = await services({ Combo: deckOf([CODE.harpy, CODE.harpy]) });
      const imported = await service.import({ name: 'Combo' });
      expect(imported).toMatchObject({
        ok: true,
        deck: { name: 'Combo', mainSize: 40 },
        warnings: [],
      });
      if (!imported.ok) throw new Error('expected an import');
      expect(imported.template.lines[0]).toMatchObject({
        card: { passcode: CODE.harpy },
        min: 2,
        max: 2,
      });
      expect(imported.deck.distinct).toBe(imported.template.lines.length);
    });

    it('resolves an alternate-art passcode through the index', async () => {
      const { service } = await services({ Reprint: deckOf([CODE.nearAltArt]) });
      const imported = await service.import({ name: 'Reprint' });
      if (!imported.ok) throw new Error('expected an import');
      expect(imported.template.lines[0]).toMatchObject({
        card: { passcode: CODE.vanillaDragon, name: 'Synthetic Vanilla Dragon' },
      });
    });

    // The name crosses IPC, so it is anything until it is checked against the
    // names the folder really holds — which is the containment, not a test on
    // the string. A path never leaves main (TDD §3).
    it('refuses a name the folder does not hold, traversal included', async () => {
      const { service, workdir } = await services({ Combo: deckOf() });
      writeFileSync(path.join(workdir, 'secret.ydk'), ydkText(deckOf()));
      for (const name of ['../secret', 'Nope', '..\\secret', '/etc/hosts'])
        expect(await service.import({ name })).toEqual({
          ok: false,
          reason: 'read',
          message: `there is no deck called ${JSON.stringify(name)}`,
        });
    });

    it('refuses a name that is not text', async () => {
      const { service } = await services({ Combo: deckOf() });
      expect(await service.import({ name: 7 })).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('opens a file dialog when no name is given, and takes the cancel for an answer', async () => {
      const { service, workdir, picks } = await services({ Combo: deckOf([CODE.harpy]) });
      expect(await service.import({})).toEqual({ ok: false, reason: 'cancelled' });
      picks.push(path.join(workdir, DECK_DIR, 'Combo.ydk'));
      const imported = await service.import(undefined);
      expect(imported).toMatchObject({ ok: true, deck: { name: 'Combo' } });
    });

    it('says so when a deck has no main deck at all', async () => {
      const { service, workdir } = await services({ Extra: [] });
      writeFileSync(path.join(workdir, DECK_DIR, 'Extra.ydk'), '#created by x\n#extra\n1\n!side\n');
      expect(await service.import({ name: 'Extra' })).toEqual({
        ok: false,
        reason: 'read',
        message: 'Extra has no main deck to import',
      });
    });

    it('carries the import warnings, each naming its card', async () => {
      // Four of one card is NOT among them: no copy limit is enforced (PRD §5.1).
      const { service } = await services({
        Odd: deckOf([CODE.harpy, CODE.harpy, CODE.harpy, CODE.harpy, 99999999]),
      });
      const imported = await service.import({ name: 'Odd' });
      if (!imported.ok) throw new Error('expected an import');
      expect(imported.warnings).toEqual([
        '#99999999 is not in the card database; its line is named after the passcode and fills only a requirement that names it',
      ]);
    });

    it('reports a file that cannot be read rather than throwing', async () => {
      const { service, workdir, picks } = await services();
      picks.push(path.join(workdir, 'no-such-file.ydk'));
      expect(await service.import(undefined)).toMatchObject({ ok: false, reason: 'read' });
    });

    it('leaves the install alone: nothing under the deck folder is written', async () => {
      const { service, workdir } = await services({ Combo: deckOf() });
      const before = readdirSync(path.join(workdir, DECK_DIR)).sort();
      const text = readFileSync(path.join(workdir, DECK_DIR, 'Combo.ydk'), 'utf8');
      await service.import({ name: 'Combo' });
      expect(readdirSync(path.join(workdir, DECK_DIR)).sort()).toEqual(before);
      expect(readFileSync(path.join(workdir, DECK_DIR, 'Combo.ydk'), 'utf8')).toBe(text);
    });
  });
});

// Opt-in, against the real install (TDD §15.1): EDOPRO_WORKDIR=/path npm test.
// READ ONLY — nothing here writes anywhere near the install.
const EDOPRO_WORKDIR = process.env.EDOPRO_WORKDIR;

describe.skipIf(!EDOPRO_WORKDIR)('every deck in a real install', async () => {
  const cards = new CardService(
    async (workdir) => ({
      cards: loadCardIndex(workdir, SQL),
      setnames: loadSetnames(workdir),
    }),
    () => {},
  );
  await cards.reload(EDOPRO_WORKDIR ?? '', { includePrerelease: true });
  const service = new DeckService({
    cards,
    workdir: () => EDOPRO_WORKDIR ?? null,
    pickFile: async () => null,
  });

  it('imports every one of them, and says what each became', async () => {
    const listed = service.list();
    if (!listed.ok) throw new Error(listed.message);
    expect(listed.decks.length).toBeGreaterThan(0);

    const rows: string[] = [];
    for (const name of listed.decks) {
      const imported = await service.import({ name });
      if (!imported.ok) throw new Error(`${name}: ${JSON.stringify(imported)}`);
      const { mainSize, distinct } = imported.deck;
      rows.push(
        `${name} | main ${mainSize} | distinct ${distinct} | lines ${imported.template.lines.length} | ${
          imported.warnings.length === 0 ? 'no warnings' : imported.warnings.join(' / ')
        }`,
      );
      // A deck EDOPro saved is legal, so nothing should need a warning — and a
      // passcode the index cannot answer for is the failure TDD §19 predicted.
      expect(imported.warnings).toEqual([]);
      expect(imported.template.lines.every((line) => 'card' in line)).toBe(true);
      expect(imported.template.lines.reduce((sum, line) => sum + line.min, 0)).toBe(mainSize);
      expect(validateTemplate(imported.template).ok).toBe(true);
    }
    console.log(`decks in ${EDOPRO_WORKDIR}:\n  ${rows.join('\n  ')}`);
  });

  it('names Harpie’s Feather Duster in the decks that carry its alternate art', async () => {
    const listed = service.list();
    if (!listed.ok) throw new Error(listed.message);
    const carrying: string[] = [];
    for (const name of listed.decks) {
      const file = readFileSync(path.join(EDOPRO_WORKDIR!, DECK_DIR, `${name}.ydk`), 'utf8');
      if (!file.split(/\r?\n/).includes('18144507')) continue;
      carrying.push(name);
      const imported = await service.import({ name });
      if (!imported.ok) throw new Error(name);
      expect(imported.template.lines).toContainEqual(
        expect.objectContaining({
          card: { passcode: 18144506, name: "Harpie's Feather Duster" },
        }),
      );
    }
    expect(carrying.length).toBeGreaterThan(0);
    console.log(`decks carrying the alternate-art 18144507: ${carrying.join(', ')}`);
  });
});
