import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { CardIndex } from '../../../src/core/cards/index';
import { CardService, installLoader } from '../../../src/main/services/cards';
import type { CardStatus } from '../../../src/shared/types';
import { ControllableLoader, immediateLoader, loadedCards } from '../../helpers/card-loader';
import { SETNAMES, STRINGS_CONF } from '../../helpers/desc-context';
import { buildCdb, CODE, FIXTURE_ROWS, POPULATION } from '../../helpers/fixture-cards';
import { tempDirs } from '../../helpers/workdir';

const SQL = await initSqlJs();
const temp = tempDirs('ygo-cards-');

const PRERELEASE = { includePrerelease: true };

/** Installs that can be told apart by what they hold: `/alpha` has one card, `/beta` two. */
const ALPHA = [{ id: 101, name: 'Alpha Only' }];
const BETA = [
  { id: 201, name: 'Beta One' },
  { id: 202, name: 'Beta Two' },
];

const IDLE: CardStatus = {
  state: 'idle',
  workdir: null,
  databases: 0,
  skippedDatabases: 0,
  cards: 0,
  replacedRows: 0,
  conflicts: 0,
  setnames: null,
};

/** A service over a controllable loader, recording every status pushed. */
function controlled() {
  const loader = new ControllableLoader();
  const pushed: CardStatus[] = [];
  const service = new CardService(loader.load, (status) => pushed.push(status));
  return { loader, pushed, service };
}

/** A service that is `ready` on the whole fixture. */
async function readyService() {
  const pushed: CardStatus[] = [];
  const service = new CardService(
    immediateLoader(() => loadedCards(SQL)),
    (status) => pushed.push(status),
  );
  await service.reload('/fixture', PRERELEASE);
  return { pushed, service };
}

describe('CardService', () => {
  it('starts idle, holding nothing, and pushes nothing until something changes', () => {
    const { pushed, service } = controlled();
    expect(service.status()).toEqual(IDLE);
    expect(service.ready()).toBeNull();
    expect(pushed).toEqual([]);
  });

  it('goes idle → loading → ready, pushing each change, and status() is the last push', async () => {
    const { loader, pushed, service } = controlled();
    const done = service.reload('/fixture', PRERELEASE);
    expect(pushed).toEqual([{ ...IDLE, state: 'loading', workdir: '/fixture' }]);
    expect(service.ready()).toBeNull();

    loader.call(0).resolve(loadedCards(SQL));
    await done;
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toEqual({
      state: 'ready',
      workdir: '/fixture',
      databases: 1,
      skippedDatabases: 0,
      cards: POPULATION.length,
      replacedRows: 0,
      conflicts: 0,
      setnames: SETNAMES.size,
    });
    expect(service.status()).toEqual(pushed[1]);
    expect(service.ready()?.cards.get(CODE.harpy)?.name).toBe('Synthetic Harpy');
  });

  describe('racing loads', () => {
    it('a stale load that finishes LAST does not clobber the newer one', async () => {
      const { loader, pushed, service } = controlled();
      const first = service.reload('/alpha', PRERELEASE);
      const second = service.reload('/beta', PRERELEASE);

      loader.call(1).resolve(loadedCards(SQL, BETA));
      await second;
      loader.call(0).resolve(loadedCards(SQL, ALPHA));
      await first;

      expect(service.status()).toMatchObject({ state: 'ready', workdir: '/beta', cards: 2 });
      expect(service.search('alpha')).toEqual([]);
      expect(service.search('beta')).toHaveLength(2);
      expect(pushed.map((status) => `${status.state} ${status.workdir}`)).toEqual([
        'loading /alpha',
        'loading /beta',
        'ready /beta',
      ]);
    });

    it('a stale load that finishes FIRST is dropped: still loading, nothing pushed for it', async () => {
      const { loader, pushed, service } = controlled();
      const first = service.reload('/alpha', PRERELEASE);
      const second = service.reload('/beta', PRERELEASE);

      loader.call(0).resolve(loadedCards(SQL, ALPHA));
      await first;
      expect(service.status()).toMatchObject({ state: 'loading', workdir: '/beta', cards: 0 });
      expect(service.ready()).toBeNull();

      loader.call(1).resolve(loadedCards(SQL, BETA));
      await second;
      expect(service.status()).toMatchObject({ state: 'ready', workdir: '/beta', cards: 2 });
      expect(pushed.filter((status) => status.state === 'ready')).toHaveLength(1);
    });

    it('a change of OPTIONS while loading supersedes the load, even in the same folder', async () => {
      const { loader, service } = controlled();
      const first = service.reload('/fixture', { includePrerelease: true });
      const second = service.reload('/fixture', { includePrerelease: false });
      expect(loader.calls.map((call) => call.opts)).toEqual([
        { includePrerelease: true },
        { includePrerelease: false },
      ]);

      loader.call(1).resolve(loadedCards(SQL, BETA));
      await second;
      loader.call(0).resolve(loadedCards(SQL, ALPHA));
      await first;
      expect(service.status().cards).toBe(2);
    });

    it('a stale FAILURE does not turn a good index into an error', async () => {
      const { loader, service } = controlled();
      const first = service.reload('/alpha', PRERELEASE);
      const second = service.reload('/beta', PRERELEASE);
      loader.call(1).resolve(loadedCards(SQL, BETA));
      await second;
      loader.call(0).reject(new Error('alpha went away'));
      await first;
      expect(service.status()).toMatchObject({ state: 'ready', workdir: '/beta' });
      expect(service.status().error).toBeUndefined();
    });

    it('clearing the folder while loading drops the load', async () => {
      const { loader, service } = controlled();
      const first = service.reload('/alpha', PRERELEASE);
      await service.reload(null, PRERELEASE);
      loader.call(0).resolve(loadedCards(SQL, ALPHA));
      await first;
      expect(service.status()).toEqual(IDLE);
    });
  });

  describe('the match memo', () => {
    it('is kept while the index stays, so analyses share it', async () => {
      const { service } = await readyService();
      service.ready()?.memo.set('key', { count: 1, samples: ['x'] });
      await service.reload('/fixture', PRERELEASE);
      expect(service.ready()?.memo.get('key')).toEqual({ count: 1, samples: ['x'] });
    });

    it('is cleared on every successful reload: the cards it was about are gone', async () => {
      const { service } = await readyService();
      service.ready()?.memo.set('key', { count: 1, samples: ['x'] });
      await service.reindex();
      expect(service.ready()?.memo.size).toBe(0);

      service.ready()?.memo.set('key', { count: 1, samples: ['x'] });
      await service.reload('/elsewhere', PRERELEASE);
      expect(service.ready()?.memo.size).toBe(0);
    });
  });

  describe('status', () => {
    it('reports no archetype names as null, not zero', async () => {
      const service = new CardService(
        immediateLoader(() => loadedCards(SQL, FIXTURE_ROWS, null)),
        () => {},
      );
      await service.reload('/fixture', PRERELEASE);
      expect(service.status()).toMatchObject({ state: 'ready', setnames: null });
    });

    it('returns a copy: mutating it changes nothing', async () => {
      const { service } = await readyService();
      service.status().cards = -1;
      expect(service.status().cards).toBe(POPULATION.length);
    });
  });

  describe('reload', () => {
    it('does nothing when nothing changed and the index is ready: no load, no push', async () => {
      const { loader, pushed, service } = controlled();
      const done = service.reload('/fixture', PRERELEASE);
      loader.call(0).resolve(loadedCards(SQL));
      await done;
      const before = pushed.length;

      await service.reload('/fixture', { includePrerelease: true });
      expect(loader.calls).toHaveLength(1);
      expect(pushed).toHaveLength(before);
    });

    it('loads again when the folder changed', async () => {
      const { loader, service } = controlled();
      const first = service.reload('/alpha', PRERELEASE);
      loader.call(0).resolve(loadedCards(SQL, ALPHA));
      await first;
      const second = service.reload('/beta', PRERELEASE);
      loader.call(1).resolve(loadedCards(SQL, BETA));
      await second;
      expect(loader.calls.map((call) => call.workdir)).toEqual(['/alpha', '/beta']);
      expect(service.status()).toMatchObject({ workdir: '/beta', cards: 2 });
    });

    it('loads again when only the pre-release option changed', async () => {
      const { loader, service } = controlled();
      const first = service.reload('/fixture', { includePrerelease: true });
      loader.call(0).resolve(loadedCards(SQL));
      await first;
      const second = service.reload('/fixture', { includePrerelease: false });
      expect(loader.calls).toHaveLength(2);
      loader.call(1).resolve(loadedCards(SQL));
      await second;
    });

    it('joins a load of the same folder and options already under way, rather than start another', async () => {
      const { loader, pushed, service } = controlled();
      const first = service.reload('/fixture', PRERELEASE);
      const second = service.reload('/fixture', PRERELEASE);
      expect(loader.calls).toHaveLength(1);
      loader.call(0).resolve(loadedCards(SQL));
      await Promise.all([first, second]);
      expect(pushed.map((status) => status.state)).toEqual(['loading', 'ready']);
    });

    it('reports a failed load as an error — pushed — and holds no index', async () => {
      const { loader, pushed, service } = controlled();
      const done = service.reload('/fixture', PRERELEASE);
      loader.call(0).reject(new Error('disk on fire'));
      await done;
      expect(pushed.at(-1)).toEqual({
        ...IDLE,
        state: 'error',
        workdir: '/fixture',
        error: 'disk on fire',
      });
      expect(service.status()).toEqual(pushed.at(-1));
      expect(service.ready()).toBeNull();
    });

    it('reports a loader that throws before it returns a promise the same way', async () => {
      const service = new CardService(
        () => {
          throw new Error('no sql.js');
        },
        () => {},
      );
      await service.reload('/fixture', PRERELEASE);
      expect(service.status()).toMatchObject({ state: 'error', error: 'no sql.js' });
    });

    it('reports a folder with no database as an error, naming the folder', async () => {
      const { loader, pushed, service } = controlled();
      const done = service.reload('/nothing', PRERELEASE);
      loader.call(0).resolve({ cards: CardIndex.empty(), setnames: null });
      await done;
      expect(service.status().state).toBe('error');
      expect(service.status().error).toContain('/nothing');
      expect(service.status().error).toContain('no card database');
      expect(pushed.at(-1)?.state).toBe('error');
      expect(service.ready()).toBeNull();
    });

    it('accepts a database that holds no cards: it loaded, and the count says so', async () => {
      const { loader, service } = controlled();
      const done = service.reload('/hollow', PRERELEASE);
      loader.call(0).resolve(loadedCards(SQL, []));
      await done;
      expect(service.status()).toMatchObject({ state: 'ready', databases: 1, cards: 0 });
    });

    it('tries again after an error, even when nothing changed', async () => {
      const { loader, service } = controlled();
      const first = service.reload('/fixture', PRERELEASE);
      loader.call(0).reject(new Error('not mounted yet'));
      await first;
      const second = service.reload('/fixture', PRERELEASE);
      loader.call(1).resolve(loadedCards(SQL));
      await second;
      expect(service.status()).toMatchObject({ state: 'ready', cards: POPULATION.length });
      expect(service.status().error).toBeUndefined();
    });

    it('goes idle, with a push, when the folder is cleared — and only once', async () => {
      const { pushed, service } = await readyService();
      await service.reload(null, PRERELEASE);
      expect(service.status()).toEqual(IDLE);
      expect(service.ready()).toBeNull();
      const before = pushed.length;
      await service.reload(null, PRERELEASE);
      expect(pushed).toHaveLength(before);
    });

    it('holds no index while loading, even when it had one', async () => {
      const { loader, service } = controlled();
      const first = service.reload('/alpha', PRERELEASE);
      loader.call(0).resolve(loadedCards(SQL, ALPHA));
      await first;
      void service.reload('/beta', PRERELEASE);
      expect(service.ready()).toBeNull();
      expect(service.search('alpha')).toEqual([]);
      expect(service.get([101])).toEqual([]);
    });
  });

  describe('reindex', () => {
    it('loads the same folder and options again although nothing changed', async () => {
      const { loader, pushed, service } = controlled();
      const first = service.reload('/fixture', { includePrerelease: false });
      loader.call(0).resolve(loadedCards(SQL, ALPHA));
      await first;

      const again = service.reindex();
      expect(loader.calls).toHaveLength(2);
      expect(loader.call(1)).toMatchObject({
        workdir: '/fixture',
        opts: { includePrerelease: false },
      });
      loader.call(1).resolve(loadedCards(SQL, BETA));
      await again;
      expect(service.status().cards).toBe(2);
      expect(pushed.map((status) => status.state)).toEqual([
        'loading',
        'ready',
        'loading',
        'ready',
      ]);
    });

    it('does nothing when no folder is set', async () => {
      const { loader, pushed, service } = controlled();
      await service.reindex();
      expect(loader.calls).toEqual([]);
      expect(pushed).toEqual([]);
    });
  });

  describe('search', () => {
    it('returns passcode, name and typeline, ranked as the index ranks', async () => {
      const { service } = await readyService();
      expect(service.search('synthetic har')).toEqual([
        {
          passcode: CODE.harpy,
          name: 'Synthetic Harpy',
          typeline: 'Level 4 · WIND · Winged Beast · Normal Monster',
        },
      ]);
      expect(service.search('cyber')).toEqual([
        {
          passcode: CODE.treatedAsHarpy,
          name: 'Synthetic Cyber Harpy',
          typeline: 'Level 4 · WIND · Winged Beast · Effect Monster',
        },
      ]);
      expect(service.search('quick')[0]?.typeline).toBe('Quick-Play Spell');
    });

    it('tells two cards of one name apart by their typeline', async () => {
      const { service } = await readyService();
      const soldiers = service.search('synthetic ritual soldier');
      expect(soldiers.map((hit) => hit.passcode).sort()).toEqual(
        [CODE.ritualSoldier, CODE.sameNameDifferentCard].sort(),
      );
      expect(new Set(soldiers.map((hit) => hit.typeline)).size).toBe(2);
    });

    it('honours the limit, defaults it to 20, and caps it at 50', async () => {
      const many = Array.from({ length: 60 }, (_, i) => ({ id: 1000 + i, name: `Common ${i}` }));
      const service = new CardService(
        immediateLoader(() => loadedCards(SQL, many)),
        () => {},
      );
      await service.reload('/many', PRERELEASE);
      expect(service.search('common', 3)).toHaveLength(3);
      expect(service.search('common')).toHaveLength(20);
      expect(service.search('common', 1000)).toHaveLength(50);
      expect(service.search('common', 0)).toEqual([]);
      expect(service.search('common', Number.NaN)).toHaveLength(20);
    });

    it('returns nothing before there is an index', () => {
      expect(controlled().service.search('synthetic')).toEqual([]);
    });
  });

  describe('get', () => {
    it('returns the display and snapshot fields, in the order asked for', async () => {
      const { service } = await readyService();
      expect(service.get([CODE.counterTrap, CODE.treatedAsHarpy])).toEqual([
        {
          passcode: CODE.counterTrap,
          name: 'Synthetic Counter Trap',
          typeline: 'Counter Trap',
          limitCode: CODE.counterTrap,
          snapshot: {
            type: 0x100004,
            attribute: 0,
            race: 0,
            level: 0,
            atk: 0,
            def: 0,
            setcodes: [],
          },
        },
        {
          passcode: CODE.treatedAsHarpy,
          name: 'Synthetic Cyber Harpy',
          typeline: 'Level 4 · WIND · Winged Beast · Effect Monster',
          // Counts against the card it is treated as, whose setcodes it reports (TDD §4.1, §4.3).
          limitCode: CODE.harpy,
          snapshot: {
            type: 0x21,
            attribute: 0x08,
            race: 0x200,
            level: 4,
            atk: 1800,
            def: 1300,
            setcodes: [0x64],
          },
        },
      ]);
    });

    it('leaves out a passcode the index lacks — a collapsed alternate artwork included', async () => {
      const { service } = await readyService();
      const found = service.get([CODE.nearAltArt, CODE.harpy, 12345, CODE.xyzMonster]);
      expect(found.map((info) => info.passcode)).toEqual([CODE.harpy]);
    });

    it('hands out copies of the setcodes, not the index’s own arrays', async () => {
      const { service } = await readyService();
      service.get([CODE.harpy])[0]?.snapshot.setcodes.push(0xffff);
      expect(service.get([CODE.harpy])[0]?.snapshot.setcodes).toEqual([0x64]);
    });

    it('returns nothing before there is an index', () => {
      expect(controlled().service.get([CODE.harpy])).toEqual([]);
    });
  });
});

describe('installLoader', () => {
  it('loads an install’s databases and strings.conf layers through the loader’s walk', async () => {
    const workdir = temp.workdir({
      'cards.cdb': buildCdb(SQL, FIXTURE_ROWS),
      'config/strings.conf': STRINGS_CONF,
    });
    const loaded = await installLoader(async () => SQL)(workdir, PRERELEASE);
    expect(loaded.cards.status.cards).toBe(POPULATION.length);
    expect(loaded.setnames?.size).toBe(SETNAMES.size);
  });

  it('passes the pre-release option on', async () => {
    const workdir = temp.workdir({ 'cards.cdb': buildCdb(SQL, FIXTURE_ROWS) });
    const loaded = await installLoader(async () => SQL)(workdir, { includePrerelease: false });
    expect(loaded.cards.get(CODE.prerelease)).toBeUndefined();
    expect(loaded.cards.status.cards).toBe(POPULATION.length - 1);
  });

  it('has no setnames when the install has no strings.conf', async () => {
    const workdir = temp.workdir({ 'cards.cdb': buildCdb(SQL, FIXTURE_ROWS) });
    expect((await installLoader(async () => SQL)(workdir, PRERELEASE)).setnames).toBeNull();
  });

  it('initialises sql.js once, however many loads there are', async () => {
    const workdir = temp.workdir({ 'cards.cdb': buildCdb(SQL, FIXTURE_ROWS) });
    let inits = 0;
    const load = installLoader(async () => {
      inits++;
      return SQL;
    });
    await load(workdir, PRERELEASE);
    await load(workdir, PRERELEASE);
    expect(inits).toBe(1);
  });

  it('rejects when sql.js cannot be initialised, and tries again next time', async () => {
    const workdir = temp.workdir({ 'cards.cdb': buildCdb(SQL, FIXTURE_ROWS) });
    let attempts = 0;
    const load = installLoader(async () => {
      if (attempts++ === 0) throw new Error('wasm missing');
      return SQL;
    });
    await expect(load(workdir, PRERELEASE)).rejects.toThrow('wasm missing');
    expect((await load(workdir, PRERELEASE)).cards.status.cards).toBe(POPULATION.length);
  });

  it('end to end with the service: a real folder becomes a ready index', async () => {
    const workdir = temp.workdir({
      'cards.cdb': buildCdb(SQL, FIXTURE_ROWS),
      'config/strings.conf': STRINGS_CONF,
    });
    const service = new CardService(
      installLoader(async () => SQL),
      () => {},
    );
    await service.reload(workdir, PRERELEASE);
    expect(service.status()).toMatchObject({
      state: 'ready',
      workdir,
      databases: 1,
      cards: POPULATION.length,
      setnames: SETNAMES.size,
    });

    await service.reload(temp.dir(), PRERELEASE);
    expect(service.status()).toMatchObject({ state: 'error', cards: 0 });
  });
});
