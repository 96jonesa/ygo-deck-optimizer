import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { isMonster } from '../../../src/core/cards/record';
import {
  analyze,
  type CostModel,
  DEFAULT_COST,
  SAMPLE_SIZE,
} from '../../../src/core/model/analyze';
import { compileProblem, resolveTemplate } from '../../../src/core/model/compile';
import { CardService } from '../../../src/main/services/cards';
import { MEMO_LIMIT, TemplateService } from '../../../src/main/services/templates';
import type { TemplateGroup } from '../../../src/shared/types';
import { ControllableLoader, immediateLoader, loadedCards } from '../../helpers/card-loader';
import { CODE, FIXTURE_ROWS } from '../../helpers/fixture-cards';
import { MOTIVATING_PATH, MOTIVATING_ROWS, motivatingTemplate } from '../../helpers/motivating';

const SQL = await initSqlJs();
const ROWS = [...FIXTURE_ROWS, ...MOTIVATING_ROWS];

const STARTERS: TemplateGroup[] = [
  {
    id: 'g1',
    name: 'Starters',
    cards: [
      { passcode: CODE.harpy, name: 'Synthetic Harpy' },
      { passcode: CODE.quickSpell, name: 'Synthetic Quick Spell' },
    ],
  },
];

/** Both services, `ready` on the fixture plus the motivating example's cards. */
async function readyServices(setnames?: null, cost?: () => CostModel | undefined) {
  const cards = new CardService(
    immediateLoader(() =>
      setnames === null ? loadedCards(SQL, ROWS, null) : loadedCards(SQL, ROWS),
    ),
    () => {},
  );
  await cards.reload('/fixture', { includePrerelease: true });
  return { cards, templates: new TemplateService(cards, cost) };
}

describe('TemplateService', () => {
  describe('parseDescription', () => {
    it('returns the AST, the canonical text, the echo, the match count and samples', async () => {
      const { templates } = await readyServices();
      expect(templates.parseDescription('Level 8 monsters', [])).toEqual({
        ok: true,
        desc: { anyOf: [{ t: 'clause', clause: { kinds: ['monster'], level: [8] } }] },
        canonical: 'level 8 monster',
        echo: 'Level 8 · Monster',
        count: 4,
        samples: [
          'Synthetic Fire Beast-Warrior',
          'Synthetic Ritual Soldier',
          'Synthetic Ritual Soldier',
          'Synthetic Vanilla Dragon',
        ],
      });
    });

    it('counts against the whole index but names only the first few', async () => {
      const { cards, templates } = await readyServices();
      const parsed = templates.parseDescription('monster', []);
      if (!parsed.ok) throw new Error('expected a parse');
      expect(parsed.count).toBe(cards.ready()?.cards.count((card) => isMonster(card.type)));
      expect(parsed.count).toBeGreaterThan(SAMPLE_SIZE);
      expect(parsed.samples).toHaveLength(SAMPLE_SIZE);
    });

    it('resolves a {group} through the groups it is given', async () => {
      const { templates } = await readyServices();
      expect(templates.parseDescription('{starters}', STARTERS)).toMatchObject({
        ok: true,
        canonical: '{Starters}',
        echo: 'Starters',
        count: 2,
        samples: ['Synthetic Harpy', 'Synthetic Quick Spell'],
      });
      expect(templates.parseDescription('{starters}', [])).toMatchObject({
        ok: false,
        reason: 'parse',
      });
    });

    it('resolves a [Card Name] and an "Archetype" through the index and its setnames', async () => {
      const { templates } = await readyServices();
      expect(templates.parseDescription('[synthetic harpy]', [])).toMatchObject({
        ok: true,
        canonical: `#${CODE.harpy}`,
        echo: 'Synthetic Harpy',
        count: 1,
      });
      expect(templates.parseDescription('"Harpie"', [])).toMatchObject({
        ok: true,
        canonical: '"Harpie":0x64 card',
        count: 2,
      });
    });

    it('cannot resolve an archetype name without a strings.conf, and says so as a parse error', async () => {
      const { templates } = await readyServices(null);
      const parsed = templates.parseDescription('"Harpie"', []);
      expect(parsed).toMatchObject({ ok: false, reason: 'parse', span: { start: 0, end: 8 } });
    });

    it('returns a parse error as a message and the span it is about', async () => {
      const { templates } = await readyServices();
      const parsed = templates.parseDescription('level 4 monstr', []);
      expect(parsed).toMatchObject({ ok: false, reason: 'parse', span: { start: 8, end: 14 } });
      if (parsed.ok || parsed.reason !== 'parse') throw new Error('expected a parse error');
      expect(parsed.message).toContain('monstr');
    });

    it('matches nothing, and says zero, for a description no card meets', async () => {
      const { templates } = await readyServices();
      expect(templates.parseDescription('level 7 FIRE beast-warrior monster', [])).toMatchObject({
        ok: true,
        count: 0,
        samples: [],
      });
    });

    it('is not-ready, with the state, before there is an index', async () => {
      const cards = new CardService(new ControllableLoader().load, () => {});
      const templates = new TemplateService(cards);
      expect(templates.parseDescription('monster', [])).toEqual({
        ok: false,
        reason: 'not-ready',
        state: 'idle',
        message: 'no EDOPro folder is set, so there is no card data yet',
      });

      void cards.reload('/fixture', { includePrerelease: true });
      expect(templates.parseDescription('monster', [])).toEqual({
        ok: false,
        reason: 'not-ready',
        state: 'loading',
        message: 'the card data is still loading',
      });
    });

    it('is not-ready, with the reason, after a failed load', async () => {
      const loader = new ControllableLoader();
      const cards = new CardService(loader.load, () => {});
      const done = cards.reload('/fixture', { includePrerelease: true });
      loader.call(0).reject(new Error('disk on fire'));
      await done;
      expect(new TemplateService(cards).parseDescription('monster', [])).toEqual({
        ok: false,
        reason: 'not-ready',
        state: 'error',
        message: 'the card data failed to load: disk on fire',
      });
    });

    it('answers a malformed request with `invalid`, never an exception', async () => {
      const { templates } = await readyServices();
      const bad: [unknown, unknown][] = [
        [7, []],
        [undefined, []],
        ['monster', 'groups'],
        ['monster', [{ id: 'g1', name: 'No cards' }]],
        ['monster', [{ id: 'g1', name: 'Starters', cards: [{ passcode: '1' }] }]],
        ['monster', [null]],
      ];
      for (const [text, groups] of bad) {
        const parsed = templates.parseDescription(text, groups);
        expect(parsed).toMatchObject({ ok: false, reason: 'invalid' });
      }
    });
  });

  describe('analyzeTemplate', () => {
    it('returns what `analyze` returns for the same template and index', async () => {
      const { cards, templates } = await readyServices();
      const ready = cards.ready();
      if (ready === null) throw new Error('not ready');
      const expected = analyze(motivatingTemplate(), {
        cards: ready.cards,
        setnames: ready.setnames,
      });
      const result = templates.analyzeTemplate(JSON.parse(readFileSync(MOTIVATING_PATH, 'utf8')));
      expect(result).toEqual({ ok: true, analysis: expected });
      expect(expected.ok).toBe(true);
      expect(expected.classes?.classes).toHaveLength(5);
    });

    it('is a plain JSON value: it survives structured cloning unchanged', async () => {
      const { templates } = await readyServices();
      const result = templates.analyzeTemplate(motivatingTemplate());
      expect(structuredClone(result)).toEqual(result);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });

    it('fills the card service’s memo, and analyzes the same with it as without', async () => {
      const { cards, templates } = await readyServices();
      expect(cards.ready()?.memo.size).toBe(0);
      const cold = templates.analyzeTemplate(motivatingTemplate());
      expect(cards.ready()?.memo.size).toBeGreaterThan(0);
      expect(templates.analyzeTemplate(motivatingTemplate())).toEqual(cold);
    });

    it('empties a memo that has grown past its limit, rather than let a long session grow it for ever', async () => {
      const { cards, templates } = await readyServices();
      const memo = cards.ready()?.memo;
      if (memo === undefined) throw new Error('not ready');
      for (let i = 0; i <= MEMO_LIMIT; i++) memo.set(`stale ${i}`, { count: 0, samples: [] });
      templates.analyzeTemplate(motivatingTemplate());
      expect(memo.size).toBeLessThan(MEMO_LIMIT);
      expect(memo.has('stale 0')).toBe(false);
    });

    it('returns an Analysis with errors — still `ok: true` — for a template that is well-formed but wrong', async () => {
      const { templates } = await readyServices();
      const template = motivatingTemplate();
      template.lines[2] = { id: 'typo', text: 'level 4 monstr', min: 0, max: 3 };
      const result = templates.analyzeTemplate(template);
      if (!result.ok) throw new Error('expected an analysis');
      expect(result.analysis.ok).toBe(false);
      expect(result.analysis.lines[2]?.parsed.ok).toBe(false);
    });

    it('answers a structurally invalid template with `invalid` and every problem, never an exception', async () => {
      const { templates } = await readyServices();
      expect(templates.analyzeTemplate({ version: 1, deckSize: 40 })).toMatchObject({
        ok: false,
        reason: 'invalid',
        message: 'this is not a well-formed template',
      });
      const result = templates.analyzeTemplate({ version: 1, deckSize: 40 });
      if (result.ok || result.reason !== 'invalid') throw new Error('expected invalid');
      expect(result.errors.length).toBeGreaterThan(1);

      for (const junk of [null, undefined, 'text', 7, [], { version: 2 }])
        expect(templates.analyzeTemplate(junk)).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('is not-ready before there is an index — checked before the template is', () => {
      const cards = new CardService(new ControllableLoader().load, () => {});
      const templates = new TemplateService(cards);
      expect(templates.analyzeTemplate(motivatingTemplate())).toEqual({
        ok: false,
        reason: 'not-ready',
        state: 'idle',
        message: 'no EDOPro folder is set, so there is no card data yet',
      });
      expect(templates.analyzeTemplate(null)).toMatchObject({ reason: 'not-ready' });
    });

    it('estimates at the cost it is given, asked for anew each time — and at the default until there is one', async () => {
      let cost: CostModel | undefined;
      const { templates } = await readyServices(undefined, () => cost);
      const work = () => {
        const result = templates.analyzeTemplate(motivatingTemplate());
        if (!result.ok) throw new Error('expected an analysis');
        return result.analysis.work;
      };
      const before = work();
      expect(before.cost).toEqual(DEFAULT_COST);

      // What a worker calibrates, some time after the service was built.
      cost = { perVectorUs: 5, perTermNs: 700 };
      const after = work();
      expect(after.cost).toEqual(cost);
      expect(after.estimatedMs).toBeGreaterThan((before.estimatedMs ?? Number.NaN) * 50);
    });
  });

  describe('compileTemplate', () => {
    it('returns the analysis, the compiled problem and the criteria — what a run is made of', async () => {
      const { cards, templates } = await readyServices();
      const ready = cards.ready();
      if (ready === null) throw new Error('not ready');
      const resolved = resolveTemplate(motivatingTemplate(), ready);
      if (!resolved.ok) throw new Error('expected the template to resolve');

      const result = templates.compileTemplate(JSON.parse(readFileSync(MOTIVATING_PATH, 'utf8')));
      if (!result.ok) throw new Error(`expected a compiled template, got ${result.reason}`);
      expect(result.analysis.ok).toBe(true);
      expect(result.compiled).toEqual(compileProblem(resolved.resolved));
      expect(result.compiled.classes).toHaveLength(5);
      expect(result.criteria).toEqual([
        {
          id: 'c1',
          name: 'A, B and any monster',
          alternatives: resolved.resolved.criteria[0]?.alternatives,
        },
        {
          id: 'c2',
          name: 'A, B and a low-Level monster',
          alternatives: resolved.resolved.criteria[1]?.alternatives,
        },
      ]);
    });

    it('is plain data: what it returns can be posted to a worker as it is', async () => {
      const { templates } = await readyServices();
      const result = templates.compileTemplate(motivatingTemplate());
      expect(structuredClone(result)).toEqual(result);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });

    it('carries the same analysis `analyzeTemplate` gives, at the same cost', async () => {
      const cost = { perVectorUs: 5, perTermNs: 700 };
      const { templates } = await readyServices(undefined, () => cost);
      const compiled = templates.compileTemplate(motivatingTemplate());
      const analyzed = templates.analyzeTemplate(motivatingTemplate());
      if (!compiled.ok || !analyzed.ok) throw new Error('expected both to succeed');
      expect(compiled.analysis).toEqual(analyzed.analysis);
      expect(compiled.analysis.work.cost).toEqual(cost);
    });

    it('refuses a template with errors, handing back the analysis that says where', async () => {
      const { templates } = await readyServices();
      const template = motivatingTemplate();
      template.lines[2] = { id: 'typo', text: 'level 4 monstr', min: 0, max: 3 };
      const result = templates.compileTemplate(template);
      if (result.ok || result.reason !== 'template-errors') throw new Error('expected errors');
      expect(result.analysis.ok).toBe(false);
      expect(result.analysis.lines[2]?.parsed.ok).toBe(false);
    });

    it('refuses a template whose ranges cannot fill the deck', async () => {
      const { templates } = await readyServices();
      const template = motivatingTemplate();
      template.remainder = { min: 0, max: 1 };
      expect(templates.compileTemplate(template)).toMatchObject({
        ok: false,
        reason: 'template-errors',
        analysis: { ok: false, totals: { feasible: false } },
      });
    });

    it('answers a structurally invalid template with `invalid`, never an exception', async () => {
      const { templates } = await readyServices();
      for (const junk of [null, undefined, 'text', 7, [], { version: 2 }])
        expect(templates.compileTemplate(junk)).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('is not-ready before there is an index, in the shape `analyzeTemplate` uses', () => {
      const cards = new CardService(new ControllableLoader().load, () => {});
      const templates = new TemplateService(cards);
      expect(templates.compileTemplate(motivatingTemplate())).toEqual(
        templates.analyzeTemplate(motivatingTemplate()),
      );
      expect(templates.compileTemplate(null)).toMatchObject({ reason: 'not-ready', state: 'idle' });
    });
  });
});
