import { describe, expect, it } from 'vitest';
import { parseStringsConf, SetnameTable } from '../../../src/core/cards/setnames';

// The Magnet Warrior reassignment of TDD §4.5, with the lines spelled as the
// install's config/strings.conf and the delta repository's strings.conf spell them.
const BASE = [
  '#setnames',
  '!setname 0x46 Polymerization|Fusion',
  '!setname 0x66 Warrior',
  '!setname 0x1066 Symphonic Warrior',
  '!setname 0x2066 Magnet Warrior',
  '!setname 0x534 Magnet',
].join('\n');

const DELTA = [
  '!setname 0x1066 Magnet',
  '!setname 0x2066 Warrior',
  '!setname 0x3066 Magnet Warrior',
  '!setname 0xb066 Magnet Warrior Sigma',
].join('\n');

describe('parseStringsConf', () => {
  it('reads !setname lines keyed by their hex code', () => {
    expect(parseStringsConf('!setname 0x1066 Symphonic Warrior')).toEqual(
      new Map([[0x1066, 'Symphonic Warrior']]),
    );
  });

  it('keeps the rest of the line as the name, spaces and pipes included', () => {
    const names = parseStringsConf(
      '!setname 0x46 Polymerization|Fusion\n!setname 0xf9 True Draco|True King',
    );
    expect(names.get(0x46)).toBe('Polymerization|Fusion');
    expect(names.get(0xf9)).toBe('True Draco|True King');
  });

  it('ignores lines that do not start with !', () => {
    const text = [
      '#comment',
      '',
      ' !setname 0x1 Indented',
      'setname 0x2 Bare',
      '!setname 0x3 Kept',
    ];
    expect([...parseStringsConf(text.join('\n')).keys()]).toEqual([0x3]);
  });

  it('ignores the other ! sections', () => {
    const text = ['!system 1020 Warrior', '!victory 0x10 Exodia', '!counter 0x1 Spell Counter'];
    expect(parseStringsConf(text.join('\n')).size).toBe(0);
  });

  it('cuts each line at the first carriage return', () => {
    const names = parseStringsConf('!setname 0x1 Alpha\r\n!setname 0x2 Beta\rjunk\r\n');
    expect(names).toEqual(
      new Map([
        [0x1, 'Alpha'],
        [0x2, 'Beta'],
      ]),
    );
  });

  it('lets a later line override an earlier one with the same key', () => {
    expect(parseStringsConf('!setname 0x1 Old\n!setname 0x1 New').get(0x1)).toBe('New');
  });

  it('parses the code as std::stoi(…, 16) does: optional 0x, any case, trailing junk ignored', () => {
    const names = parseStringsConf(
      ['!setname 10 Bare Hex', '!setname 0XaB Upper', '!setname 0x12zz Junk Tail'].join('\n'),
    );
    expect(names).toEqual(
      new Map([
        [0x10, 'Bare Hex'],
        [0xab, 'Upper'],
        [0x12, 'Junk Tail'],
      ]),
    );
  });

  it.each([
    ['no code or name', '!setname'],
    ['no name', '!setname 0x46'],
    ['an empty name', '!setname 0x46 '],
    ['a non-hex code', '!setname zz Name'],
    ['a doubled space, which makes the code empty', '!setname  0x46 Name'],
    ['a tab delimiter', '!setname\t0x46\tName'],
    ['a code beyond INT_MAX', '!setname 0x80000000 Name'],
    ['a different section with the same prefix', '!setnames 0x46 Name'],
  ])('skips a line with %s', (_, line) => {
    expect(parseStringsConf(`${line}\n!setname 0x1 Kept`)).toEqual(new Map([[0x1, 'Kept']]));
  });

  it('never throws, whatever it is given', () => {
    for (const text of [
      '',
      '\n\n',
      '!',
      '! ',
      '!setname',
      '\r',
      '!setname \r 0x1 A',
      '!setname 0x1'.repeat(3),
    ])
      expect(() => parseStringsConf(text)).not.toThrow();
  });
});

describe('SetnameTable', () => {
  it('resolves "Magnet Warrior" to the right code only when the delta layer is applied', () => {
    expect(SetnameTable.fromLayers([BASE]).lookup('Magnet Warrior')).toEqual([0x2066]);
    const layered = SetnameTable.fromLayers([BASE, DELTA]);
    expect(layered.lookup('Magnet Warrior')).toEqual([0x3066]);
    expect(layered.nameOf(0x1066)).toBe('Magnet');
    expect(layered.nameOf(0x2066)).toBe('Warrior');
  });

  describe('fromLayers', () => {
    it('lets a later layer override a same-key entry', () => {
      const table = SetnameTable.fromLayers(['!setname 0x1 Old', '!setname 0x1 New']);
      expect(table.nameOf(0x1)).toBe('New');
    });

    it('withdraws the overridden name, alternates included', () => {
      const table = SetnameTable.fromLayers(['!setname 0x1 Old|Elder', '!setname 0x1 New']);
      expect(table.lookup('Old')).toEqual([]);
      expect(table.lookup('Elder')).toEqual([]);
      expect(table.lookup('New')).toEqual([0x1]);
    });

    it('keeps entries that no later layer mentions', () => {
      const table = SetnameTable.fromLayers([
        '!setname 0x1 One\n!setname 0x2 Two',
        '!setname 0x2 Deux',
      ]);
      expect(table.nameOf(0x1)).toBe('One');
      expect(table.size).toBe(2);
    });

    it('accepts no layers', () => {
      const table = SetnameTable.fromLayers([]);
      expect(table.size).toBe(0);
      expect(table.lookup('anything')).toEqual([]);
    });
  });

  describe('lookup', () => {
    const table = SetnameTable.fromLayers([BASE, DELTA]);

    it('resolves every |-separated alternate to the code', () => {
      expect(table.lookup('Polymerization')).toEqual([0x46]);
      expect(table.lookup('Fusion')).toEqual([0x46]);
    });

    it('does not resolve the unsplit entry', () => {
      expect(table.lookup('Polymerization|Fusion')).toEqual([]);
    });

    it('matches exactly after normalization: case, diacritics and outer whitespace', () => {
      expect(table.lookup('  mAgNeT wArRiOr ')).toEqual([0x3066]);
      expect(SetnameTable.fromLayers(['!setname 0x1 Doré']).lookup('dore')).toEqual([0x1]);
    });

    it('does not match substrings or prefixes', () => {
      expect(table.lookup('Magn')).toEqual([]);
      expect(table.lookup('Polymerization Fusion')).toEqual([]);
    });

    it('returns every matching code, ascending, so callers can detect ambiguity', () => {
      expect(table.lookup('Warrior')).toEqual([0x66, 0x2066]);
      expect(table.lookup('Magnet')).toEqual([0x534, 0x1066]);
    });

    it('lists a code once even if two of its alternates normalize alike', () => {
      expect(SetnameTable.fromLayers(['!setname 0x1 Doré|Dore']).lookup('dore')).toEqual([0x1]);
    });

    it('returns an empty list for an unknown or blank name', () => {
      expect(table.lookup('Nonexistent')).toEqual([]);
      expect(table.lookup('')).toEqual([]);
    });

    it('returns a fresh array each time', () => {
      table.lookup('Fusion').push(0xdead);
      expect(table.lookup('Fusion')).toEqual([0x46]);
    });
  });

  describe('nameOf', () => {
    const table = SetnameTable.fromLayers([BASE]);

    it('returns the first alternate as the display name', () => {
      expect(table.nameOf(0x46)).toBe('Polymerization');
      expect(table.nameOf(0x1066)).toBe('Symphonic Warrior');
    });

    it('returns undefined for an unknown code', () => {
      expect(table.nameOf(0xfff)).toBeUndefined();
    });
  });

  describe('alternatesOf', () => {
    const table = SetnameTable.fromLayers([BASE]);

    it('returns every alternate in file order', () => {
      expect(table.alternatesOf(0x46)).toEqual(['Polymerization', 'Fusion']);
      expect(table.alternatesOf(0x66)).toEqual(['Warrior']);
    });

    it('drops empty alternates', () => {
      expect(SetnameTable.fromLayers(['!setname 0x1 A||B|']).alternatesOf(0x1)).toEqual(['A', 'B']);
    });

    it('returns an empty list for an unknown code', () => {
      expect(table.alternatesOf(0xfff)).toEqual([]);
    });
  });

  describe('size', () => {
    it('counts distinct codes', () => {
      expect(SetnameTable.fromLayers([BASE, DELTA]).size).toBe(7);
    });
  });
});
