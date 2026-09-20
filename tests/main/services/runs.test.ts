import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardService } from '../../../src/main/services/cards';
import { GRACEFUL_TIMEOUT_MS, RunService } from '../../../src/main/services/runs';
import { TemplateService } from '../../../src/main/services/templates';
import type { RunEvent, RunResult } from '../../../src/shared/types';
import { ControllableLoader, loadedCards } from '../../helpers/card-loader';
import { FAKE_COST, FakeWorkers, realResult } from '../../helpers/fake-worker';
import { FIXTURE_ROWS } from '../../helpers/fixture-cards';
import { MOTIVATING_ROWS, motivatingTemplate } from '../../helpers/motivating';

const SQL = await initSqlJs();
const ROWS = [...FIXTURE_ROWS, ...MOTIVATING_ROWS];

/** A `RunService` over real card and template services, `ready`, and a worker the test plays. */
async function harness(opts: { ready?: boolean; plateauDelta?: number } = {}) {
  const loader = new ControllableLoader();
  const cards = new CardService(loader.load, () => {});
  if (opts.ready !== false) {
    const loading = cards.reload('/fixture', { includePrerelease: true });
    loader.call(0).resolve(loadedCards(SQL, ROWS));
    await loading;
  }
  const workers = new FakeWorkers();
  const events: RunEvent[] = [];
  const runs: RunService = new RunService({
    templates: new TemplateService(cards, () => runs.cost()),
    spawn: workers.spawn,
    emit: (event) => events.push(event),
    ...(opts.plateauDelta === undefined ? {} : { plateauDelta: () => opts.plateauDelta as number }),
  });
  const start = (options?: unknown): number => {
    const started = runs.start(motivatingTemplate(), options);
    if (!started.ok) throw new Error(`expected the run to start, got ${started.reason}`);
    return started.runId;
  };
  const types = () => events.map((event) => `${event.runId}:${event.type}`);
  return { runs, cards, loader, workers, events, types, start };
}

function resultOf(event: RunEvent | undefined): RunResult {
  if (event?.type !== 'result') throw new Error(`expected a result event, got ${event?.type}`);
  return event.result;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RunService', () => {
  it('runs from `started` through progress to the result, every event under the run’s id', async () => {
    const { workers, events, types, start } = await harness();
    const runId = start();
    expect(types()).toEqual([`${runId}:started`]);

    const worker = workers.worker(0);
    worker.ready();
    worker.progress(runId, 40);
    worker.progress(runId, 90);
    worker.answer(0);
    expect(types()).toEqual([
      `${runId}:started`,
      `${runId}:progress`,
      `${runId}:progress`,
      // The search's own closing report.
      `${runId}:progress`,
      `${runId}:result`,
    ]);
    expect(events[1]).toEqual({
      runId,
      type: 'progress',
      progress: { done: 40, total: 128, elapsedMs: 40, etaMs: 1 },
    });
    expect(resultOf(events.at(-1)).best.blend).toEqual({ num: 46_185, den: 658_008 });
  });

  /**
   * The worker is given no card data (TDD §3), so it can only echo the line
   * ids; main compiled the template and knows what each line is CALLED. A
   * result that reached the renderer with `line3` in it could not answer the
   * question the sweep chart exists to answer (PRD §5.6).
   */
  it('puts the NAME of every line back on the result the worker sends', async () => {
    const { workers, events, start } = await harness();
    start();
    workers.worker(0).answer(0);
    const result = resultOf(events.at(-1));
    const labels = Object.fromEntries(result.lines.map((line) => [line.id, line.label]));
    expect(labels).toEqual({
      A: '[Elemental HERO Stratos]',
      B: '[Reinforcement of the Army]',
      monster: 'monster',
      level4: 'level 4 monster',
      'fire-bw': 'level 7 FIRE beast-warrior monster',
      spell: 'spell',
      'normal-spell': 'normal spell',
      remainder: 'Unspecified cards',
    });
  });

  /**
   * PRD §6.3's footnote qualifies a NUMBER, so it travels with that number.
   * The motivating example carries no limit, and the result says so rather
   * than the renderer having to ask an analysis that has since moved on.
   */
  it('attaches what the criteria limited, so the honesty footnote is the run’s own', async () => {
    const { workers, events, start } = await harness();
    start();
    workers.worker(0).answer(0);
    const result = resultOf(events.at(-1));
    expect(result.criterionLimits).toEqual([]);
    expect(result.droppedLimits).toEqual([]);
  });

  it('attaches the limits a limited run DID carry, so the footnote can name them', async () => {
    const { workers, events, runs } = await harness();
    const template = motivatingTemplate();
    const started = runs.start({
      ...template,
      criteria: [...template.criteria, { id: 'c3', text: '1x monster and at most 1x spell' }],
    });
    if (!started.ok) throw new Error(`expected the run to start, got ${started.reason}`);
    workers.worker(0).answer(0);
    const result = resultOf(events.at(-1));
    expect(result.criterionLimits.map((limit) => limit.text)).toEqual(['spell']);
    expect(result.criterionLimits[0]?.counts).toEqual([1]);
    // The remainder can hold spells nobody said were spells: that is the footnote.
    expect(result.criterionLimits[0]?.blindRange).not.toBeNull();
    expect(result.criterionLimits[0]?.blind.map((line) => line.label)).toContain(
      'Unspecified cards',
    );
  });

  it('labels a cancelled run’s partial result too: it is read exactly like a whole one', async () => {
    const { workers, events, start, runs } = await harness();
    const runId = start();
    const worker = workers.worker(0);
    const whole = realResult(worker.request(0));
    if (whole.status !== 'done') throw new Error('expected a scored result');
    const stopping = runs.cancel(runId, { graceful: true });
    worker.result(runId, { ...whole, status: 'cancelled', partial: true });
    await stopping;
    const event = events.at(-1);
    if (event?.type !== 'cancelled' || event.result === null)
      throw new Error(`expected a cancelled result, got ${event?.type}`);
    expect(event.result.lines.map((line) => line.label)).toContain('level 4 monster');
    expect(event.result.criterionLimits).toEqual([]);
  });

  it('ends every run in exactly one terminal event: what the worker says after it is dropped', async () => {
    const { workers, events, start, runs } = await harness();
    const runId = start();
    const worker = workers.worker(0);
    worker.answer(0);
    const before = events.length;

    worker.progress(runId, 100);
    worker.answer(0);
    worker.send({ type: 'error', runId, message: 'late' });
    expect(events).toHaveLength(before);
    expect(await runs.cancel(runId)).toEqual({ ok: false, reason: 'not-active' });
  });

  it('cancels the run before it when a new one starts, and forwards nothing more of the old one', async () => {
    const { workers, events, types, start } = await harness();
    const first = start();
    const old = workers.worker(0);
    old.progress(first, 10);

    const second = start();
    expect(second).not.toBe(first);
    expect(old.terminated).toBe(true);
    expect(types()).toEqual([
      `${first}:started`,
      `${first}:progress`,
      `${first}:cancelled`,
      `${second}:started`,
    ]);
    expect(events[2]).toEqual({ runId: first, type: 'cancelled', result: null });

    // What the old thread still had in flight when it was terminated — and its exit.
    const before = events.length;
    old.progress(first, 20);
    old.result(first, realResult(old.request(0)));
    old.send({ type: 'error', runId: first, message: 'late' });
    old.exit(1);
    expect(events).toHaveLength(before);

    // The new run is on a new thread, undisturbed.
    const fresh = workers.worker(1);
    expect(fresh.posted).toHaveLength(1);
    expect(fresh.request(0).runId).toBe(second);
    fresh.answer(0);
    expect(events.at(-1)).toMatchObject({ runId: second, type: 'result' });
  });

  it('drops an event of another run even when it comes from the current worker', async () => {
    const { workers, events, start } = await harness();
    const first = start({ confirmThresholdMs: 0 });
    const worker = workers.worker(0);
    worker.answer(0);
    // Superseded while it waited: the warm worker is kept, so the old run's id can still arrive on it.
    const second = start();
    expect(workers.spawned).toHaveLength(1);
    const before = events.length;

    worker.progress(first, 5);
    worker.result(first, realResult({ ...worker.request(0), options: { force: true } }));
    expect(events).toHaveLength(before);
    worker.progress(second, 5);
    expect(events.at(-1)).toMatchObject({ runId: second, type: 'progress' });
  });

  it('asks before a long run, and runs it once confirmed', async () => {
    const { runs, workers, events, types, start } = await harness();
    const runId = start({ confirmThresholdMs: 0 });
    const worker = workers.worker(0);
    worker.answer(0);
    expect(types()).toEqual([`${runId}:started`, `${runId}:needs-confirmation`]);
    expect(events[1]).toMatchObject({
      confirmation: { reason: 'estimate', total: 128, thresholdMs: 0, cost: FAKE_COST },
    });
    expect(events[1]).not.toHaveProperty('confirmation.status');

    expect(runs.confirm(runId)).toEqual({ ok: true });
    expect(worker.posted).toHaveLength(2);
    // The same run, the same problem, the same flag — and `force`.
    expect(worker.request(1)).toEqual({
      ...worker.request(0),
      options: { ...worker.request(0).options, force: true },
    });
    expect(worker.request(1).cancelFlag).toBe(worker.request(0).cancelFlag);
    expect(worker.request(0).options.force).toBeUndefined();

    worker.answer(1);
    expect(events.at(-1)).toMatchObject({ runId, type: 'result', result: { status: 'done' } });
    // Once is enough: the run is over.
    expect(runs.confirm(runId)).toEqual({ ok: false, reason: 'not-active' });
  });

  it('keeps ONE warm worker across runs, so the scorer is calibrated once', async () => {
    const { workers, start } = await harness();
    start();
    workers.worker(0).answer(0);
    start();
    workers.worker(0).answer(1);
    start({ confirmThresholdMs: 0 });
    workers.worker(0).answer(2);
    // Superseding a run that only waits to be confirmed costs no thread either.
    start();
    expect(workers.spawned).toHaveLength(1);
    expect(workers.worker(0).terminated).toBe(false);
    expect(workers.worker(0).posted).toHaveLength(4);
  });

  it('spawns lazily — no worker before the first run — and again after a terminate', async () => {
    const { runs, workers, start } = await harness();
    expect(workers.spawned).toHaveLength(0);
    const first = start();
    expect(workers.spawned).toHaveLength(1);
    await runs.cancel(first);
    expect(workers.worker(0).terminated).toBe(true);
    expect(workers.spawned).toHaveLength(1);

    const second = start();
    expect(workers.spawned).toHaveLength(2);
    expect(workers.worker(1).request(0).runId).toBe(second);
    expect(workers.worker(0).posted).toHaveLength(1);
  });

  it('turns a worker crash into an `error` event, clears the run, and starts over on a new thread', async () => {
    const { runs, workers, events, types, start } = await harness();
    const first = start();
    workers.worker(0).crash(new Error('out of memory'));
    expect(events.at(-1)).toEqual({ runId: first, type: 'error', message: 'out of memory' });
    expect(await runs.cancel(first)).toEqual({ ok: false, reason: 'not-active' });
    // The `exit` that follows a crash adds nothing.
    workers.worker(0).exit(1);
    expect(types()).toEqual([`${first}:started`, `${first}:error`]);

    const second = start();
    expect(workers.spawned).toHaveLength(2);
    workers.worker(1).answer(0);
    expect(events.at(-1)).toMatchObject({ runId: second, type: 'result' });
  });

  it('turns an exit nobody asked for into an `error` event, and clears the run', async () => {
    const { runs, workers, events, start } = await harness();
    const runId = start();
    workers.worker(0).exit(134);
    expect(events.at(-1)).toEqual({
      runId,
      type: 'error',
      message: 'the optimizer worker exited unexpectedly (code 134)',
    });
    expect(runs.confirm(runId)).toEqual({ ok: false, reason: 'not-active' });
    start();
    expect(workers.spawned).toHaveLength(2);
  });

  it('replaces an idle worker that died, without an event: there was no run to fail', async () => {
    const { workers, events, start } = await harness();
    start();
    workers.worker(0).answer(0);
    const before = events.length;
    workers.worker(0).exit(1);
    expect(events).toHaveLength(before);
    start();
    expect(workers.spawned).toHaveLength(2);
  });

  it('forwards the worker’s own error for the run, and keeps the worker: it caught it', async () => {
    const { workers, events, start } = await harness();
    const runId = start();
    workers.worker(0).send({ type: 'error', runId, message: 'the breakdown failed' });
    expect(events.at(-1)).toEqual({ runId, type: 'error', message: 'the breakdown failed' });
    start();
    expect(workers.spawned).toHaveLength(1);
  });

  it.each([
    ['infeasible', { status: 'infeasible', total: 0, message: 'no deck fits' }],
    ['error', { status: 'error', message: 'topK is a positive whole number, not 0' }],
  ] as const)('reports a search that came back `%s` as an `error` event', async (_, result) => {
    const { workers, events, start } = await harness();
    const runId = start();
    workers.worker(0).result(runId, result);
    expect(events.at(-1)).toEqual({ runId, type: 'error', message: result.message });
  });

  it('is not disturbed by a card reload mid-run: the problem is plain numbers by then', async () => {
    const { cards, loader, workers, events, start, runs } = await harness();
    const runId = start();
    void cards.reload('/elsewhere', { includePrerelease: true });
    expect(cards.ready()).toBeNull();

    workers.worker(0).progress(runId, 64);
    workers.worker(0).answer(0);
    expect(resultOf(events.at(-1)).best.blend).toEqual({ num: 46_185, den: 658_008 });
    // Only a NEW run needs the cards.
    expect(runs.start(motivatingTemplate())).toMatchObject({ ok: false, reason: 'not-ready' });
    loader.call(1).resolve(loadedCards(SQL, ROWS));
  });

  describe('start', () => {
    it('hands the worker plain data: the compiled problem, the criteria, the options, a clear flag', async () => {
      const { cards, workers, start } = await harness();
      const runId = start();
      const request = workers.worker(0).request(0);
      const compiled = new TemplateService(cards).compileTemplate(motivatingTemplate());
      if (!compiled.ok) throw new Error('expected the template to compile');
      expect(request).toMatchObject({
        type: 'run',
        runId,
        compiled: compiled.compiled,
        criteria: compiled.criteria,
      });
      expect(request.cancelFlag).toBeInstanceOf(SharedArrayBuffer);
      expect(workers.worker(0).flag(0)).toBe(0);
      const { cancelFlag: _flag, ...plain } = request;
      expect(JSON.parse(JSON.stringify(plain))).toEqual(plain);
    });

    it('holds the result to the UI’s caps by default — and says so in the result', async () => {
      const { workers, events, start } = await harness();
      start();
      // No width either, without a setting to take it from: the search has its own default.
      expect(workers.worker(0).request(0).options).toEqual({ topK: 200, plateauCap: 500 });
      workers.worker(0).answer(0);
      expect(resultOf(events.at(-1)).limits).toEqual({ topK: 200, plateauCap: 500 });
    });

    it('applies the plateau cap: a wide plateau arrives truncated, its size still exact', async () => {
      const { workers, events, start } = await harness();
      start({ plateauCap: 10, plateauDelta: { num: 1, den: 1 } });
      workers.worker(0).answer(0);
      const result = resultOf(events.at(-1));
      expect(result.plateau.vectors).toHaveLength(10);
      expect(result.plateau).toMatchObject({ truncated: true, size: 128 });
      expect(result.limits).toEqual({ topK: 200, plateauCap: 10 });
    });

    it('passes the renderer’s options on, clamped to what may cross IPC', async () => {
      const { workers, start } = await harness();
      start({
        topK: 5000,
        plateauCap: 1_000_000,
        plateauDelta: { num: 1, den: 100 },
        confirmThresholdMs: 5000,
        progressIntervalMs: 250,
        force: true,
      });
      expect(workers.worker(0).request(0).options).toEqual({
        topK: 1000,
        plateauCap: 10_000,
        plateauDelta: { num: 1, den: 100 },
        confirmThresholdMs: 5000,
        progressIntervalMs: 250,
        force: true,
      });
    });

    it('takes the plateau’s width from the settings when the request names none', async () => {
      const { workers, start } = await harness({ plateauDelta: 0.0125 });
      start();
      expect(workers.worker(0).request(0).options.plateauDelta).toEqual({ num: 1, den: 80 });
      // (A new run supersedes the last, which costs its thread: this one is on the next.)
      start({ plateauDelta: { num: 1, den: 3 } });
      expect(workers.worker(1).request(0).options.plateauDelta).toEqual({ num: 1, den: 3 });
    });

    it('says in `started` how much there is to do, as the analysis has it', async () => {
      const { events, start } = await harness();
      const runId = start();
      expect(events[0]).toMatchObject({ runId, type: 'started', total: 128 });
      const [started] = events;
      expect(started?.type === 'started' && started.estimatedMs).toBeGreaterThan(0);
    });

    it('numbers the runs: a new id each time', async () => {
      const { start } = await harness();
      const ids = [start(), start(), start()];
      expect(new Set(ids).size).toBe(3);
    });

    it('is not-ready before there is an index: no worker, no event', async () => {
      const { runs, workers, events } = await harness({ ready: false });
      expect(runs.start(motivatingTemplate())).toEqual({
        ok: false,
        reason: 'not-ready',
        state: 'idle',
        message: 'no EDOPro folder is set, so there is no card data yet',
      });
      expect(workers.spawned).toHaveLength(0);
      expect(events).toEqual([]);
    });

    it('answers a structurally invalid template with `invalid`: no worker, no event', async () => {
      const { runs, workers, events } = await harness();
      for (const junk of [null, undefined, 'text', { version: 1, deckSize: 40 }])
        expect(runs.start(junk)).toMatchObject({ ok: false, reason: 'invalid' });
      expect(workers.spawned).toHaveLength(0);
      expect(events).toEqual([]);
    });

    it.each([
      ['not an object', 'fast'],
      ['a list', []],
      ['a fractional topK', { topK: 1.5 }],
      ['a zero plateauCap', { plateauCap: 0 }],
      ['a negative threshold', { confirmThresholdMs: -1 }],
      ['a NaN interval', { progressIntervalMs: Number.NaN }],
      ['a plateauDelta that is a number', { plateauDelta: 0.005 }],
      ['a plateauDelta over zero', { plateauDelta: { num: 1, den: 0 } }],
      ['a force that is not a boolean', { force: 'yes' }],
    ])(
      'answers malformed options — %s — with `invalid`, and starts nothing',
      async (_, options) => {
        const { runs, workers, events } = await harness();
        const result = runs.start(motivatingTemplate(), options);
        expect(result).toMatchObject({ ok: false, reason: 'invalid' });
        expect(!result.ok && result.reason === 'invalid' && result.errors.length).toBeGreaterThan(
          0,
        );
        expect(workers.spawned).toHaveLength(0);
        expect(events).toEqual([]);
      },
    );

    it('does not pass on what it does not know: an option of the search that is not the renderer’s to set', async () => {
      const { workers, start } = await harness();
      start({ checkEvery: 1, now: 'never', cost: { perVectorUs: 0, perTermNs: 0 } });
      expect(Object.keys(workers.worker(0).request(0).options).sort()).toEqual([
        'plateauCap',
        'topK',
      ]);
    });

    it('refuses a template with errors, with the analysis that says where — and leaves a running run alone', async () => {
      const { runs, workers, events, start } = await harness();
      const running = start();
      const before = events.length;
      const template = motivatingTemplate();
      template.lines[2] = { id: 'typo', text: 'level 4 monstr', min: 0, max: 3 };

      const result = runs.start(template);
      if (result.ok || result.reason !== 'template-errors') throw new Error('expected errors');
      expect(result.analysis.ok).toBe(false);
      expect(events).toHaveLength(before);
      expect(workers.worker(0).terminated).toBe(false);
      workers.worker(0).answer(0);
      expect(events.at(-1)).toMatchObject({ runId: running, type: 'result' });
    });
  });

  describe('cancel', () => {
    it('gracefully: raises the run’s flag, leaves the thread alone, and forwards the partial result as `cancelled`', async () => {
      const { runs, workers, events, start } = await harness();
      const runId = start();
      const worker = workers.worker(0);
      worker.progress(runId, 30);

      let settled = false;
      const cancelling = runs.cancel(runId, { graceful: true }).then((result) => {
        settled = true;
        return result;
      });
      expect(worker.flag(0)).toBe(1);
      expect(worker.terminated).toBe(false);
      // Nothing is said until the worker has stopped: the partial result is the event.
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(events.at(-1)?.type).toBe('progress');

      const whole = realResult(worker.request(0));
      if (whole.status !== 'done') throw new Error('expected a scored result');
      worker.result(runId, { ...whole, status: 'cancelled', partial: true, done: 30 });
      expect(await cancelling).toEqual({ ok: true });
      expect(events.at(-1)).toMatchObject({
        runId,
        type: 'cancelled',
        result: { status: 'cancelled', partial: true, done: 30, limits: { plateauCap: 500 } },
      });
      // The thread is still warm for the next run.
      start();
      expect(workers.spawned).toHaveLength(1);
    });

    it('gracefully, too late: a search that finished anyway is a `result`, not a cancellation', async () => {
      const { runs, workers, events, start } = await harness();
      const runId = start();
      const cancelling = runs.cancel(runId, { graceful: true });
      workers.worker(0).answer(0);
      expect(await cancelling).toEqual({ ok: true });
      expect(events.at(-1)).toMatchObject({ runId, type: 'result', result: { status: 'done' } });
    });

    it('gracefully, with a deadline: a worker that does not stop in time is abandoned', async () => {
      vi.useFakeTimers();
      const { runs, workers, events, start } = await harness();
      const runId = start();
      const cancelling = runs.cancel(runId, { graceful: true });
      vi.advanceTimersByTime(GRACEFUL_TIMEOUT_MS - 1);
      expect(workers.worker(0).terminated).toBe(false);
      vi.advanceTimersByTime(1);
      expect(workers.worker(0).terminated).toBe(true);
      expect(await cancelling).toEqual({ ok: true });
      expect(events.at(-1)).toEqual({ runId, type: 'cancelled', result: null });
    });

    it('gracefully, in time: the deadline is forgotten with the run', async () => {
      vi.useFakeTimers();
      const { runs, workers, events, start } = await harness();
      const first = start();
      const cancelling = runs.cancel(first, { graceful: true });
      workers.worker(0).answer(0);
      await cancelling;
      expect(vi.getTimerCount()).toBe(0);
      const second = start();
      vi.advanceTimersByTime(GRACEFUL_TIMEOUT_MS * 2);
      expect(workers.worker(0).terminated).toBe(false);
      expect(events.at(-1)).toEqual(expect.objectContaining({ runId: second, type: 'started' }));
    });

    it('hard: terminates the thread and says `cancelled` itself, with no result', async () => {
      const { runs, workers, events, start } = await harness();
      const runId = start();
      expect(await runs.cancel(runId)).toEqual({ ok: true });
      expect(workers.worker(0).terminated).toBe(true);
      // The flag is for a graceful stop only.
      expect(workers.worker(0).flag(0)).toBe(0);
      expect(events.at(-1)).toEqual({ runId, type: 'cancelled', result: null });
      workers.worker(0).exit(1);
      expect(events.at(-1)).toEqual({ runId, type: 'cancelled', result: null });
    });

    it('hard, after a graceful one that is still pending: abandons the run, and both calls settle', async () => {
      const { runs, workers, events, start } = await harness();
      const runId = start();
      const graceful = runs.cancel(runId, { graceful: true });
      expect(await runs.cancel(runId)).toEqual({ ok: true });
      expect(await graceful).toEqual({ ok: true });
      expect(workers.worker(0).terminated).toBe(true);
      expect(events.filter((event) => event.type === 'cancelled')).toHaveLength(1);
    });

    it('gives every run a flag of its own: a stop of the last run cannot stop the next', async () => {
      const { runs, workers, start } = await harness();
      const first = start();
      const cancelling = runs.cancel(first, { graceful: true });
      const whole = realResult(workers.worker(0).request(0));
      if (whole.status !== 'done') throw new Error('expected a scored result');
      workers.worker(0).result(first, { ...whole, status: 'cancelled', partial: true });
      await cancelling;

      start();
      expect(workers.worker(0).flag(0)).toBe(1);
      expect(workers.worker(0).flag(1)).toBe(0);
      expect(workers.worker(0).request(1).cancelFlag).not.toBe(
        workers.worker(0).request(0).cancelFlag,
      );
    });

    it('of a run that waits to be confirmed: ends it at once, either way, and keeps the worker', async () => {
      for (const graceful of [true, false]) {
        const { runs, workers, events, start } = await harness();
        const runId = start({ confirmThresholdMs: 0 });
        workers.worker(0).answer(0);
        expect(await runs.cancel(runId, { graceful })).toEqual({ ok: true });
        expect(events.at(-1)).toEqual({ runId, type: 'cancelled', result: null });
        expect(workers.worker(0).terminated).toBe(false);
        expect(runs.confirm(runId)).toEqual({ ok: false, reason: 'not-active' });
      }
    });

    it('is `not-active` for a run that is over, was superseded, or never was', async () => {
      const { runs, workers, events, start } = await harness();
      expect(await runs.cancel(1)).toEqual({ ok: false, reason: 'not-active' });
      const first = start();
      const second = start();
      const before = events.length;
      expect(await runs.cancel(first, { graceful: true })).toEqual({
        ok: false,
        reason: 'not-active',
      });
      expect(await runs.cancel(second + 1)).toEqual({ ok: false, reason: 'not-active' });
      expect(await runs.cancel('1')).toEqual({ ok: false, reason: 'invalid' });
      // None of which touched the run that IS active.
      expect(events).toHaveLength(before);
      expect(workers.worker(1).terminated).toBe(false);
      expect(workers.worker(1).flag(0)).toBe(0);
    });
  });

  describe('confirm', () => {
    it('is `not-active` unless that run is waiting to be confirmed', async () => {
      const { runs, workers, start } = await harness();
      expect(runs.confirm(1)).toEqual({ ok: false, reason: 'not-active' });
      const runId = start();
      // Running, not waiting.
      expect(runs.confirm(runId)).toEqual({ ok: false, reason: 'not-active' });
      expect(runs.confirm(runId + 1)).toEqual({ ok: false, reason: 'not-active' });
      expect(runs.confirm(null)).toEqual({ ok: false, reason: 'invalid' });
      expect(workers.worker(0).posted).toHaveLength(1);
    });

    it('leaves the run active while it waits: `needs-confirmation` is a question, not an ending', async () => {
      const { runs, workers, events, start } = await harness();
      const runId = start({ confirmThresholdMs: 0 });
      workers.worker(0).answer(0);
      expect(events.at(-1)?.type).toBe('needs-confirmation');
      expect(events.filter((event) => event.type === 'result')).toEqual([]);
      expect(runs.confirm(runId)).toEqual({ ok: true });
      // Confirmed, it is a running run again: progress flows, and it can be stopped.
      workers.worker(0).progress(runId, 3);
      expect(events.at(-1)).toMatchObject({ runId, type: 'progress' });
      void runs.cancel(runId, { graceful: true });
      expect(workers.worker(0).flag(1)).toBe(1);
    });
  });

  // `results:export` writes the file from main's own copy of the result, not
  // from one that has crossed IPC to the renderer and back (TDD §3), so the
  // service keeps the last run that scored anything — and only that one, since
  // there is no run history in v1 (TDD §13).
  describe('result', () => {
    it('is the last run that scored something, partial results included', async () => {
      const { runs, workers, start } = await harness();
      expect(runs.result(1)).toBeNull();

      const first = start();
      const worker = workers.worker(0);
      worker.result(first, realResult(worker.request(0)));
      expect(runs.result(first)?.best.blend.num).toBeGreaterThan(0);

      const second = start();
      // A run under way has not scored anything yet, and the last one still stands.
      expect(runs.result(second)).toBeNull();
      expect(runs.result(first)).not.toBeNull();

      const whole = realResult(worker.request(1));
      if (whole.status !== 'done') throw new Error('expected a scored result');
      worker.result(second, { ...whole, status: 'cancelled', partial: true, done: 7 });
      expect(runs.result(second)).toMatchObject({ partial: true, done: 7 });
      // One at a time: the run before is gone.
      expect(runs.result(first)).toBeNull();
    });

    it('is null for a run that was abandoned before it scored anything', async () => {
      const { runs, start } = await harness();
      const runId = start();
      await runs.cancel(runId);
      expect(runs.result(runId)).toBeNull();
    });
  });

  describe('cost', () => {
    it('is unknown until a worker has calibrated, then what it said — and outlives the worker', async () => {
      const { runs, workers, start } = await harness();
      expect(runs.cost()).toBeUndefined();
      const runId = start();
      expect(runs.cost()).toBeUndefined();
      workers.worker(0).ready();
      expect(runs.cost()).toEqual(FAKE_COST);
      await runs.cancel(runId);
      expect(runs.cost()).toEqual(FAKE_COST);
    });

    it('reaches the analysis: the estimate a template shows is at the calibrated cost', async () => {
      const { runs, cards, workers, start } = await harness();
      const templates = new TemplateService(cards, () => runs.cost());
      const costOf = () => {
        const result = templates.analyzeTemplate(motivatingTemplate());
        if (!result.ok) throw new Error('expected an analysis');
        return result.analysis.work.cost;
      };
      expect(costOf()).not.toEqual(FAKE_COST);
      start();
      workers.worker(0).ready();
      expect(costOf()).toEqual(FAKE_COST);
    });

    it('ignores a `ready` from a worker it has let go of', async () => {
      const { runs, workers, start } = await harness();
      await runs.cancel(start());
      workers.worker(0).ready({ perVectorUs: 99, perTermNs: 99 });
      expect(runs.cost()).toBeUndefined();
    });
  });
});
