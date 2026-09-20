import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  compileProblem,
  handSizesForMode,
  type ResolveContext,
  resolveTemplate,
} from '../../../src/core/model/compile';
import { modeOf } from '../../../src/core/model/template';
import { optimize } from '../../../src/core/opt/optimizer';
import { CardService } from '../../../src/main/services/cards';
import { DeckService } from '../../../src/main/services/decks';
import { csvCell, FileService, resultCsv, resultJson } from '../../../src/main/services/files';
import type { RunResult, Template } from '../../../src/shared/types';
import { immediateLoader, loadedCards } from '../../helpers/card-loader';
import { FakeDialogs } from '../../helpers/fake-dialogs';
import { FIXTURE_ROWS, POPULATION } from '../../helpers/fixture-cards';
import { MOTIVATING_ROWS, motivatingTemplate, STRATOS } from '../../helpers/motivating';
import { motivatingResult } from '../../helpers/motivating-run';
import { tempDirs } from '../../helpers/workdir';

const SQL = await initSqlJs();
const temp = tempDirs('ygo-files-');
const RESULT = motivatingResult(SQL);

/** 40 main-deck entries, `codes` first and the fixture's cards after. */
function deckOf(codes: readonly number[]): number[] {
  const main = [...codes];
  const taken = new Set(codes);
  const filler = POPULATION.filter((code) => !taken.has(code));
  for (let n = 0; main.length < 40; n++) main.push(filler[n % filler.length]!);
  return main;
}

/** A `FileService` over ready cards, a played dialog pair, and a run that finished. */
async function services(result: RunResult | null = RESULT) {
  const cards = new CardService(
    immediateLoader(() => loadedCards(SQL, [...FIXTURE_ROWS, ...MOTIVATING_ROWS])),
    () => {},
  );
  await cards.reload('/fixture', { includePrerelease: true });
  const dialogs = new FakeDialogs();
  const files = new FileService({
    cards,
    dialogs,
    runs: { result: (runId) => (runId === 1 ? result : null) },
  });
  return { files, dialogs, cards, dir: temp.dir() };
}

describe('csvCell', () => {
  it('quotes only what has to be quoted, and doubles an inner quote', () => {
    expect(csvCell('Ash Blossom')).toBe('Ash Blossom');
    expect(csvCell(42)).toBe('42');
    expect(csvCell('Nibiru, the Primal Being')).toBe('"Nibiru, the Primal Being"');
    expect(csvCell('Maxx "C"')).toBe('"Maxx ""C"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });
});

describe('resultCsv', () => {
  const csv = resultCsv(RESULT);
  const rows = csv.trimEnd().split('\n');

  it('heads the table with the fraction, never a percentage', () => {
    expect(rows[0]).toBe(
      [
        'rank',
        'numerator',
        'denominator',
        'successNumerator',
        'rawRatios',
        ...RESULT.lines.map((l) => l.label),
      ].join(','),
    );
    expect(csv).not.toContain('%');
  });

  it('writes one row per kept vector, with the counts of each line', () => {
    expect(rows).toHaveLength(RESULT.ranked.length + 1);
    const best = rows[1]!.split(',');
    expect(best.slice(0, 5)).toEqual([
      '1',
      String(RESULT.best.blend.num),
      String(RESULT.best.blend.den),
      String(RESULT.best.success.num),
      String(RESULT.best.rawRatios),
    ]);
    // An unweighted run ranked by the probability, so the two numerators agree.
    expect(best[1]).toBe(best[3]);
    expect(best.slice(5).map(Number)).toEqual(RESULT.rankedRatios[0]!.example);
  });

  it('gives exactly tied vectors one rank, as the table on screen does', () => {
    const ranks = rows.slice(1).map((row) => Number(row.split(',')[0]));
    const nums = RESULT.ranked.map((vector) => vector.blend.num);
    // A rank repeats exactly where the numerator repeats: the tie is a fact
    // about the numbers, so it survives the export.
    nums.forEach((num, at) => {
      if (at > 0) expect(ranks[at] === ranks[at - 1]).toBe(num === nums[at - 1]);
    });
  });

  it('ends with a newline, so a file never runs two rows together', () => {
    expect(csv.endsWith('\n')).toBe(true);
  });
});

describe('resultJson', () => {
  it('writes the whole result under a version of its own, and reads back as itself', () => {
    const parsed = JSON.parse(resultJson(7, RESULT));
    expect(parsed).toEqual({ version: 1, runId: 7, result: JSON.parse(JSON.stringify(RESULT)) });
  });
});

describe('FileService', () => {
  describe('saveTemplate', () => {
    it('writes the AST beside every text, and a snapshot of every named card', async () => {
      const { files, dialogs, dir } = await services();
      const file = path.join(dir, 'saved.json');
      dialogs.willSave(file);
      const saved = await files.saveTemplate(motivatingTemplate());
      expect(saved).toEqual({ ok: true, path: file, warnings: [] });
      const written = JSON.parse(readFileSync(file, 'utf8')) as Template;
      expect(written.lines.every((line) => 'card' in line || line.desc !== undefined)).toBe(true);
      expect(written.criteria.every((criterion) => criterion.expr !== undefined)).toBe(true);
      expect(Object.keys(written.cardSnapshot ?? {})).toContain(String(STRATOS));
    });

    it('writes nothing when the dialog is cancelled', async () => {
      const { files } = await services();
      expect(await files.saveTemplate(motivatingTemplate())).toEqual({
        ok: false,
        reason: 'cancelled',
      });
    });

    it('refuses a template that is not one, without showing a dialog', async () => {
      const { files, dialogs } = await services();
      const saved = await files.saveTemplate({ version: 9 });
      expect(saved).toMatchObject({ ok: false, reason: 'invalid' });
      expect(dialogs.saved).toEqual([]);
    });

    it('reports a write that fails rather than throwing', async () => {
      const { files, dialogs, dir } = await services();
      dialogs.willSave(path.join(dir, 'no', 'such', 'folder', 'x.json'));
      expect(await files.saveTemplate(motivatingTemplate())).toMatchObject({
        ok: false,
        reason: 'write',
      });
    });
  });

  describe('openTemplate', () => {
    it('reads back what `saveTemplate` wrote, unchanged', async () => {
      const { files, dialogs, dir } = await services();
      const file = path.join(dir, 'round-trip.json');
      dialogs.willSave(file);
      await files.saveTemplate(motivatingTemplate());
      const written = JSON.parse(readFileSync(file, 'utf8'));

      dialogs.willOpen(file);
      const opened = await files.openTemplate();
      expect(opened).toEqual({ ok: true, template: written, path: file, notices: [] });
    });

    it('is cancellable', async () => {
      const { files } = await services();
      expect(await files.openTemplate()).toEqual({ ok: false, reason: 'cancelled' });
    });

    it('says a file is not JSON, naming it', async () => {
      const { files, dialogs, dir } = await services();
      const file = path.join(dir, 'broken.json');
      writeFileSync(file, '{ not json');
      dialogs.willOpen(file);
      const opened = await files.openTemplate();
      expect(opened).toMatchObject({ ok: false, reason: 'invalid' });
      if (opened.ok || opened.reason !== 'invalid') throw new Error('expected invalid');
      expect(opened.message).toBe('broken.json is not JSON');
    });

    it('carries every structural error of a file that is not a template', async () => {
      const { files, dialogs, dir } = await services();
      const file = path.join(dir, 'wrong.json');
      writeFileSync(file, JSON.stringify({ version: 1 }));
      dialogs.willOpen(file);
      const opened = await files.openTemplate();
      if (opened.ok || opened.reason !== 'invalid') throw new Error('expected invalid');
      expect(opened.errors.length).toBeGreaterThan(1);
    });

    // A stored AST is what the engine judges, so an unreadable one must not
    // reach `implies` — it is caught at the file, not at the box model.
    it('refuses a file whose stored AST is not one', async () => {
      const { files, dialogs, dir } = await services();
      const file = path.join(dir, 'bad-ast.json');
      writeFileSync(
        file,
        JSON.stringify({
          ...motivatingTemplate(),
          lines: [
            {
              id: 'l1',
              text: 'monster',
              desc: { anyOf: [{ t: 'clause', clause: { level: ['four'] } }] },
              min: 0,
              max: 3,
            },
          ],
        }),
      );
      dialogs.willOpen(file);
      const opened = await files.openTemplate();
      if (opened.ok || opened.reason !== 'invalid') throw new Error('expected invalid');
      expect(opened.errors[0]).toContain('`level[0]`');
    });

    it('reports what this install says about the cards the file recorded', async () => {
      const { files, dialogs, dir } = await services();
      const file = path.join(dir, 'moved.json');
      const template = motivatingTemplate();
      writeFileSync(
        file,
        JSON.stringify({
          ...template,
          cardSnapshot: {
            [String(STRATOS)]: {
              type: 1,
              attribute: 1,
              race: 1,
              level: 9,
              atk: 0,
              def: 0,
              setcodes: [],
            },
          },
        }),
      );
      dialogs.willOpen(file);
      const opened = await files.openTemplate();
      if (!opened.ok) throw new Error('expected an open');
      expect(opened.notices).toHaveLength(1);
      expect(opened.notices[0]).toContain('level 9 → 4');
    });
  });

  describe('exportResults', () => {
    it('writes the CSV of the last run', async () => {
      const { files, dialogs, dir } = await services();
      const file = path.join(dir, 'out.csv');
      dialogs.willSave(file);
      expect(await files.exportResults({ runId: 1, format: 'csv' })).toEqual({
        ok: true,
        path: file,
      });
      expect(readFileSync(file, 'utf8')).toBe(resultCsv(RESULT));
    });

    it('writes the JSON of the last run', async () => {
      const { files, dialogs, dir } = await services();
      const file = path.join(dir, 'out.json');
      dialogs.willSave(file);
      await files.exportResults({ runId: 1, format: 'json' });
      expect(readFileSync(file, 'utf8')).toBe(resultJson(1, RESULT));
    });

    it('offers a name and a filter that match the format asked for', async () => {
      const { files, dialogs, dir } = await services();
      dialogs.willSave(path.join(dir, 'a.csv'), path.join(dir, 'b.json'));
      await files.exportResults({ runId: 1, format: 'csv' });
      await files.exportResults({ runId: 1, format: 'json' });
      expect(dialogs.saved.map((options) => options.defaultPath)).toEqual([
        'results.csv',
        'results.json',
      ]);
      expect(dialogs.saved.map((options) => options.filters[0]!.extensions)).toEqual([
        ['csv'],
        ['json'],
      ]);
    });

    it('refuses a run that is not the last one to have finished', async () => {
      const { files, dialogs } = await services();
      expect(await files.exportResults({ runId: 2, format: 'csv' })).toMatchObject({
        ok: false,
        reason: 'no-run',
      });
      expect(dialogs.saved).toEqual([]);
    });

    it('refuses a malformed request, listing what is wrong with it', async () => {
      const { files } = await services();
      const bad = await files.exportResults({ runId: 'one', format: 'xml' });
      if (bad.ok || bad.reason !== 'invalid') throw new Error('expected invalid');
      expect(bad.errors).toHaveLength(2);
    });

    it('is cancellable, and writes nothing then', async () => {
      const { files } = await services();
      expect(await files.exportResults({ runId: 1, format: 'csv' })).toEqual({
        ok: false,
        reason: 'cancelled',
      });
    });
  });

  it('answers not-ready for every file operation while there is no card index', async () => {
    const cards = new CardService(
      immediateLoader(() => loadedCards(SQL)),
      () => {},
    );
    const files = new FileService({
      cards,
      dialogs: new FakeDialogs(),
      runs: { result: () => null },
    });
    expect(await files.openTemplate()).toMatchObject({ ok: false, reason: 'not-ready' });
    expect(await files.saveTemplate(motivatingTemplate())).toMatchObject({
      ok: false,
      reason: 'not-ready',
    });
  });
});

/**
 * The whole of M2g in one line of use: a decklist becomes a template, the
 * template becomes a file, the file becomes a template again — and the numbers
 * do not move. An integration test, so it is exempt from the unit structure.
 */
describe('a deck imported, saved and opened again', () => {
  /** The exact probability of the template's one ratio: what must not move. */
  function numeratorOf(template: Template, cards: ResolveContext) {
    const resolved = resolveTemplate(template, cards);
    if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
    const compiled = compileProblem(resolved.resolved);
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const run = optimize(compiled);
    if (run.status !== 'done') throw new Error(`expected a whole run, got ${run.status}`);
    return run.best.blend;
  }

  it('gives back the same template and the same exact numerator', async () => {
    const workdir = temp.workdir({
      'cards.cdb': 'unused',
      [path.join('deck', 'Imported.ydk')]: ['#main', ...deckOf([STRATOS, STRATOS]), ''].join('\n'),
    });
    const cards = new CardService(
      immediateLoader(() => loadedCards(SQL, [...FIXTURE_ROWS, ...MOTIVATING_ROWS])),
      () => {},
    );
    await cards.reload(workdir, { includePrerelease: true });
    const dialogs = new FakeDialogs();
    const decks = new DeckService({ cards, workdir: () => workdir, pickFile: async () => null });
    const files = new FileService({ cards, dialogs, runs: { result: () => null } });

    const imported = await decks.import({ name: 'Imported' });
    if (!imported.ok) throw new Error(JSON.stringify(imported));
    expect(imported.deck).toMatchObject({ name: 'Imported', mainSize: 40 });
    // A decklist states no criteria (PRD §9), so the run needs one to be about.
    const template: Template = {
      ...imported.template,
      criteria: [{ id: 'c1', text: `1x #${STRATOS}` }],
    };

    const ready = cards.ready();
    if (ready === null) throw new Error('expected a card index');
    const before = numeratorOf(template, ready);

    const file = path.join(temp.dir(), 'imported.json');
    dialogs.willSave(file);
    const saved = await files.saveTemplate(template);
    expect(saved).toMatchObject({ ok: true, warnings: [] });

    dialogs.willOpen(file);
    const opened = await files.openTemplate();
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    expect(opened.notices).toEqual([]);

    // Identical but for what the file adds: the authoritative ASTs and the
    // snapshot. Saving the reopened template again changes nothing at all.
    expect(opened.template.lines).toEqual(template.lines);
    expect(opened.template.criteria[0]).toMatchObject({ id: 'c1', text: `1x #${STRATOS}` });
    dialogs.willSave(file);
    await files.saveTemplate(opened.template);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(opened.template);

    expect(numeratorOf(opened.template, ready)).toEqual(before);
  });
});

/**
 * A template with a MODE and tagged criteria, saved and opened again (PRD
 * §5.5). The tags and the mode are the run itself — they say which hands are
 * scored and which criteria judge each — so a file that lost either would open
 * as a different run. The check is the one that matters: the same exact
 * numerator, not merely a template that looks the same.
 */
describe('a template with a mode and tagged criteria, saved and opened again', () => {
  /** The exact blended fraction of the template's one ratio, in its own mode. */
  function blendOf(template: Template, cards: ResolveContext) {
    const mode = modeOf(template);
    const resolved = resolveTemplate(template, cards);
    if (!resolved.ok) throw new Error(resolved.errors.join('\n'));
    const compiled = compileProblem(resolved.resolved, {
      handSizes: handSizesForMode(resolved.resolved, mode),
    });
    if (!compiled.ok) throw new Error(compiled.errors.join('\n'));
    const run = optimize(compiled, { force: true });
    if (run.status !== 'done') throw new Error(`expected a whole run, got ${run.status}`);
    return { blend: run.best.blend, parts: run.best.score.parts };
  }

  it('runs to the identical exact numerator, part by part', async () => {
    const { files, dialogs, cards, dir } = await services();
    const ready = cards.ready();
    if (ready === null) throw new Error('expected a card index');

    const template: Template = {
      ...motivatingTemplate(),
      mode: 'average',
      hand: { size: 6 },
      criteria: [
        { id: 'c1', text: `1x #${STRATOS}`, when: 'first' },
        { id: 'c2', text: '1x monster', when: 'second' },
        { id: 'c3', text: '1x spell', when: 'both' },
      ],
    };
    const before = blendOf(template, ready);
    // The two hands really are judged differently, so a lost tag would show.
    expect(before.parts).toHaveLength(2);
    expect(before.parts[0]!.num).not.toBe(before.parts[1]!.num);

    const file = path.join(dir, 'tagged.json');
    dialogs.willSave(file);
    expect(await files.saveTemplate(template)).toMatchObject({ ok: true });

    dialogs.willOpen(file);
    const opened = await files.openTemplate();
    if (!opened.ok) throw new Error(JSON.stringify(opened));

    expect(opened.template.mode).toBe('average');
    expect(opened.template.hand).toEqual({ size: 6 });
    expect(opened.template.criteria.map((criterion) => criterion.when)).toEqual([
      'first',
      'second',
      'both',
    ]);
    expect(blendOf(opened.template, ready)).toEqual(before);
  });

  it('opens a file that predates modes as the run it always was', async () => {
    const { files, dialogs, cards, dir } = await services();
    const ready = cards.ready();
    if (ready === null) throw new Error('expected a card index');

    // Written by hand, with no `mode` and no `when`: a hand of five has always
    // meant going first, and an untagged criterion has always been judged.
    const file = path.join(dir, 'old.json');
    const old: Template = motivatingTemplate();
    writeFileSync(file, JSON.stringify(old));
    dialogs.willOpen(file);
    const opened = await files.openTemplate();
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    expect('mode' in opened.template).toBe(false);
    expect(modeOf(opened.template)).toBe('first');
    expect(blendOf(opened.template, ready)).toEqual(blendOf(old, ready));
  });
});
