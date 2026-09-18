import { normalize } from '../util/normalize';

/** `std::stoi(value, 0, 16)`: optional `0x`, then as many hex digits as there are. */
const HEX_PREFIX = /^(?:0[xX])?([0-9a-fA-F]+)/;
const INT_MAX = 0x7fffffff;

/**
 * The `!setname` entries of one `strings.conf`, keyed by setcode (TDD §4.5).
 * Follows the client's parser (`gframe/data_manager.cpp:229-266`): the line is
 * cut at the first `\r`; lines not starting with `!` are ignored;
 * `!setname <hex> <rest of line>` is single-space delimited, so the name may
 * contain spaces; a later line overrides an earlier one with the same key.
 * Malformed lines are skipped silently — this never throws.
 *
 * One deliberate difference: a line with no name (`!setname 0x46`) is skipped,
 * where the client's `erase(0, npos + 1)` leaves the hex text as the name.
 */
export function parseStringsConf(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const raw of text.split('\n')) {
    const cr = raw.indexOf('\r');
    const line = cr < 0 ? raw : raw.slice(0, cr);
    if (!line.startsWith('!setname ')) continue;
    const rest = line.slice('!setname '.length);
    const space = rest.indexOf(' ');
    if (space < 0) continue;
    const digits = HEX_PREFIX.exec(rest.slice(0, space))?.[1];
    if (digits === undefined) continue;
    const code = Number.parseInt(digits, 16);
    if (code > INT_MAX) continue; // stoi throws out_of_range; the client skips the line
    const name = rest.slice(space + 1);
    if (name === '') continue;
    names.set(code, name);
  }
  return names;
}

/**
 * Archetype names, layered as EDOPro layers them: `config/strings.conf`, then
 * `expansions/strings.conf`, then each repository's, a later file overriding
 * a same-key entry. Layering is required for correctness (TDD §4.5): an
 * override also withdraws the name it replaces.
 */
export class SetnameTable {
  private readonly alternates = new Map<number, string[]>();
  private readonly byName = new Map<string, number[]>();

  private constructor(names: Map<number, string>) {
    for (const [code, name] of [...names].sort(([a], [b]) => a - b)) {
      const alternates = name
        .split('|')
        .map((alternate) => alternate.trim())
        .filter((alternate) => alternate !== '');
      if (alternates.length === 0) continue;
      this.alternates.set(code, alternates);
      for (const key of new Set(alternates.map(normalize))) {
        const codes = this.byName.get(key);
        if (codes === undefined) this.byName.set(key, [code]);
        else codes.push(code);
      }
    }
  }

  static fromLayers(texts: string[]): SetnameTable {
    const merged = new Map<number, string>();
    for (const text of texts)
      for (const [code, name] of parseStringsConf(text)) merged.set(code, name);
    return new SetnameTable(merged);
  }

  /**
   * Every setcode one of whose `|`-separated alternates equals `name` after
   * normalization, ascending. Empty means unknown; more than one means the
   * name is ambiguous, which the caller reports with the candidates.
   */
  lookup(name: string): number[] {
    return [...(this.byName.get(normalize(name.trim())) ?? [])];
  }

  /** The display name of `code`: the first alternate of its entry. */
  nameOf(code: number): string | undefined {
    return this.alternates.get(code)?.[0];
  }

  /** Every alternate of `code`'s entry, in file order; empty if unknown. */
  alternatesOf(code: number): string[] {
    return [...(this.alternates.get(code) ?? [])];
  }

  get size(): number {
    return this.alternates.size;
  }
}
