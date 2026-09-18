import { TYPE_MONSTER, TYPE_NORMAL } from '../../src/core/cards/constants';
import type { CardRecord } from '../../src/core/cards/record';
import { SetnameTable } from '../../src/core/cards/setnames';
import type { CardLookup, DescContext, GroupLookup } from '../../src/core/desc/context';
import { normalize } from '../../src/core/util/normalize';

/** A hand-built record; the defaults make an ordinary Level 4 EARTH Warrior Normal Monster. */
export function cardRecord(overrides: Partial<CardRecord> = {}): CardRecord {
  const code = overrides.code ?? 1;
  return {
    code,
    name: `Card ${code}`,
    limitCode: code,
    ot: 0x3,
    type: TYPE_MONSTER | TYPE_NORMAL,
    atk: 1000,
    def: 1000,
    level: 4,
    lscale: 0,
    rscale: 0,
    race: 0x1,
    raceHi: 0,
    attribute: 0x01,
    setcodes: [],
    ...overrides,
  };
}

/** A double for the slice of `CardIndex` that descriptions use. */
export class FakeCards implements CardLookup {
  constructor(private readonly records: readonly CardRecord[]) {}

  findByName(name: string): CardRecord[] {
    const needle = normalize(name.trim());
    return this.records.filter((card) => normalize(card.name) === needle);
  }

  get(code: number): CardRecord | undefined {
    return this.records.find((card) => card.code === code);
  }
}

/** A double for the template's groups, from `[id, name]` pairs. */
export class FakeGroups implements GroupLookup {
  constructor(private readonly entries: readonly (readonly [string, string])[]) {}

  idOf(name: string): string | undefined {
    return this.entries.find(([, n]) => normalize(n) === normalize(name))?.[0];
  }

  nameOf(id: string): string | undefined {
    return this.entries.find(([i]) => i === id)?.[1];
  }

  names(): string[] {
    return this.entries.map(([, name]) => name);
  }
}

/**
 * Archetype names with the traps of the examined install (TDD §4.5):
 * "Warrior" and "Magnet" each name two codes, `0x46` has two alternates, and
 * `0x155a` is a real entry whose name contains quotes and so cannot be written.
 */
export const STRINGS_CONF = [
  '!setname 0x46 Polymerization|Fusion',
  '!setname 0x64 Harpie',
  '!setname 0x66 Warrior',
  '!setname 0xdd Blue-Eyes',
  '!setname 0x115 Sky Striker',
  '!setname 0x534 Magnet',
  '!setname 0x1066 Magnet',
  '!setname 0x1115 Sky Striker Ace',
  '!setname 0x155a "V "/" V"',
  '!setname 0x2066 Warrior',
  '!setname 0x3066 Magnet Warrior',
].join('\n');

export const SETNAMES = SetnameTable.fromLayers([STRINGS_CONF]);

export const GROUPS = new FakeGroups([
  ['g-starters', 'Starters'],
  ['g-hand-traps', 'Hand Traps'],
]);

export function contextOf(cards: CardLookup, overrides: Partial<DescContext> = {}): DescContext {
  return { cards, setnames: SETNAMES, groups: GROUPS, ...overrides };
}
