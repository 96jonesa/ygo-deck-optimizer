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
import {
  lineLabels,
  MEMO_LIMIT,
  REMAINDER_LABEL,
  runDroppedLimits,
  runLimits,
  TemplateService,
} from '../../../src/main/services/templates';
import type { TemplateGroup } from '../../../src/shared/types';
import { ControllableLoader, immediateLoader, loadedCards } from '../../helpers/card-loader';
import { CODE, FIXTURE_ROWS } from '../../helpers/fixture-cards';
import {
  MOTIVATING_PATH,
  MOTIVATING_ROWS,
  motivatingTemplate,
  STRATOS,
} from '../../helpers/motivating';

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

describe('lineLabels', () => {
  /** The motivating template, resolved against the fixture index. */
  async function resolvedMotivating() {
    const { cards } = await readyServices();
    const ready = cards.ready();
    if (ready === null) throw new Error('not ready');
    const template = motivatingTemplate();
    const resolved = resolveTemplate(template, ready);
    if (!resolved.ok) throw new Error('expected the template to resolve');
    return { template, resolved: resolved.resolved };
  }

  it('calls a description line what the user typed, so they recognise their own words', async () => {
    const { template, resolved } = await resolvedMotivating();
    const labels = lineLabels(template, resolved);
    expect(labels.level4).toBe('level 4 monster');
    expect(labels['fire-bw']).toBe('level 7 FIRE beast-warrior monster');
  });

  it('keeps a `[Name]` description line exactly as it was typed, brackets and all', async () => {
    const { template, resolved } = await resolvedMotivating();
    expect(lineLabels(template, resolved).A).toBe('[Elemental HERO Stratos]');
  });

  it('calls a picker-chosen line by its card’s name, NOT the canonical `#passcode`', async () => {
    const { cards } = await readyServices();
    const ready = cards.ready();
    if (ready === null) throw new Error('not ready');
    const template = motivatingTemplate();
    const picked = {
      ...template,
      lines: template.lines.map((line) =>
        line.id === 'A'
          ? { id: 'A', card: { passcode: STRATOS, name: 'Elemental HERO Stratos' }, min: 0, max: 3 }
          : line,
      ),
    };
    const resolved = resolveTemplate(picked, ready);
    if (!resolved.ok) throw new Error('expected the template to resolve');
    // This is the text a canonical label would show, and nobody would know it.
    expect(resolved.resolved.lines.find((line) => line.id === 'A')?.text).toBe(`#${STRATOS}`);
    expect(lineLabels(picked, resolved.resolved).A).toBe('Elemental HERO Stratos');
  });

  it('calls the remainder what the template editor calls it', async () => {
    const { template, resolved } = await resolvedMotivating();
    expect(lineLabels(template, resolved).remainder).toBe(REMAINDER_LABEL);
  });

  it('falls back to the id rather than to nothing, so a chart is never headed by a blank', async () => {
    const { template, resolved } = await resolvedMotivating();
    const blanked = {
      ...template,
      lines: template.lines.map((line) => (line.id === 'spell' ? { ...line, text: '   ' } : line)),
    };
    expect(lineLabels(blanked, resolved).spell).toBe('spell');
    // A line the template no longer has at all keeps its id too.
    expect(lineLabels({ ...template, lines: [] }, resolved).level4).toBe('level4');
  });

  it('gives every line of the run a label', async () => {
    const { template, resolved } = await resolvedMotivating();
    const labels = lineLabels(template, resolved);
    expect(Object.keys(labels).sort()).toEqual(resolved.lines.map((line) => line.id).sort());
    expect(Object.values(labels).every((label) => label.trim() !== '')).toBe(true);
  });
});

describe('runLimits', () => {
  /** The motivating example with a limit added: `at most 1x spell`, which the remainder can hide. */
  const LIMITED = () => {
    const template = motivatingTemplate();
    return {
      ...template,
      criteria: [
        ...template.criteria,
        { id: 'c3', name: 'a monster and few spells', text: '1x monster and at most 1x spell' },
      ],
    };
  };

  async function analysisOf(template: ReturnType<typeof LIMITED>) {
    const { cards } = await readyServices();
    const ready = cards.ready();
    if (ready === null) throw new Error('not ready');
    const resolved = resolveTemplate(template, ready);
    if (!resolved.ok) throw new Error('expected the template to resolve');
    return {
      analysis: analyze(template, { cards: ready.cards, setnames: ready.setnames }),
      labels: lineLabels(template, resolved.resolved),
    };
  }

  it('is empty when the criteria carry no limit, so the footnote says nothing', async () => {
    const { analysis, labels } = await analysisOf(motivatingTemplate() as never);
    expect(runLimits(analysis, labels)).toEqual([]);
  });

  it('carries the counts a limit appears under and the cards it cannot see (PRD §6.3)', async () => {
    const { analysis, labels } = await analysisOf(LIMITED());
    const limits = runLimits(analysis, labels);
    expect(limits).toHaveLength(1);
    expect(limits[0]?.text).toBe('spell');
    expect(limits[0]?.counts).toEqual([1]);
    expect(limits[0]?.blindRange).not.toBeNull();
  });

  it('names the blind lines the way the rest of the results name them', async () => {
    const { analysis, labels } = await analysisOf(LIMITED());
    const blind = runLimits(analysis, labels)[0]?.blind ?? [];
    // The remainder is one of them, and it is called what the editor calls it.
    expect(blind.map((line) => line.label)).toContain(REMAINDER_LABEL);
    // A line the limit COUNTS is never listed as blind.
    expect(blind.map((line) => line.label)).not.toContain('spell');
  });

  it('is plain data: it crosses IPC as it is', async () => {
    const { analysis, labels } = await analysisOf(LIMITED());
    const limits = runLimits(analysis, labels);
    expect(structuredClone(limits)).toEqual(limits);
  });
});

describe('runDroppedLimits', () => {
  it('is empty for a template whose limits all bind', async () => {
    const { cards } = await readyServices();
    const ready = cards.ready();
    if (ready === null) throw new Error('not ready');
    const analysis = analyze(motivatingTemplate(), {
      cards: ready.cards,
      setnames: ready.setnames,
    });
    expect(runDroppedLimits(analysis)).toEqual([]);
  });

  it('passes on what the engine left out, without the compiled indices nobody would know', async () => {
    const analysis = {
      classes: {
        droppedLimits: [
          { criterion: 0, text: 'trap', n: 1, reason: 'counts-nothing' },
          { criterion: 1, text: 'trap', n: 1, reason: 'counts-nothing' },
        ],
      },
    } as unknown as Parameters<typeof runDroppedLimits>[0];
    expect(runDroppedLimits(analysis)).toEqual([
      { text: 'trap', n: 1, reason: 'counts-nothing' },
      { text: 'trap', n: 1, reason: 'counts-nothing' },
    ]);
  });

  it('is empty when the template did not compile far enough to have classes', async () => {
    expect(
      runDroppedLimits({ classes: null } as unknown as Parameters<typeof runDroppedLimits>[0]),
    ).toEqual([]);
  });
});
