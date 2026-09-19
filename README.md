# ygo-deck-optimizer

A concept-aware hypergeometric deck-ratio optimizer for Yu-Gi-Oh!.

Write a deck template once — lines that are a card name or a description such as
`level 4 monster`, each with a min/max copy count — plus one or more opening-hand
success criteria. The tool scores every valid ratio with **exact** probabilities
and reports the best ratios, the near-optimal plateau, and a copies-vs-odds sweep
for every line.

It is a desktop app (Electron, macOS and Windows) that reads card data from your
own [EDOPro](https://projectignis.github.io/) install. No game engine, no replays:
combinatorial probability plus a card-database lookup layer.

## Status

| Milestone | State |
| --- | --- |
| Docs: [PRD](docs/PRD.md), [TDD](docs/TDD.md) | Done |
| M0 — de-risk spike (headless) | **Done (in review)**: M0a–M0f (scaffold, card data, descriptions, implication, criteria, Monte Carlo oracle + CLI `estimate`) |
| M1 — exact engine + optimizer (headless) | **In progress**: M1a exact scorer, M1b compile + analyze |
| M2 — app MVP | Not started |
| M3 — polish | Not started |
| M4 — release | Not started |

Today the app opens an empty window that proves the main ↔ preload ↔ renderer
bridge; what is computed so far is reachable only through the
[command-line harness](#command-line-harness).

## Description language

A description says which cards a template line or a criterion means
(`src/core/desc`: `parse`, `print`, `echo`, `evaluate`). By example:

| Text | Means |
| --- | --- |
| `level 4 monster`, `level 4 or lower`, `level 1-4`, `level 3/4` | Level; `or lower` reaches down to 0, `or higher` up to 13 |
| `FIRE/WATER Beast-Warrior monster` | `/` lists values **within one dimension**: FIRE *or* WATER, and Beast-Warrior |
| `level 4 monster or normal spell` | `or` separates **whole descriptions** — the second says nothing about Level |
| `non-tuner`, `non-FIRE`, `non-Warrior/Dragon` | Negation of one flag, or of a whole value list; true of every Spell and Trap |
| `ATK 1500 or less`, `2000 or more DEF`, `ATK 1000-2000`, `ATK ?` | A range never matches a `?` stat |
| `quick-play spell`, `counter`, `continuous`, `normal/field spell` | Sub-kinds; `counter` implies Trap, `continuous` alone is Spell or Trap |
| `normal monster` / `normal spell` | `normal` and `ritual` are read by the kind word; alone they are an error ("normal what?") |
| `"Sky Striker" spell`, `"Warrior":0x2066` | Archetype, by exact name. Names can be ambiguous ("Warrior" is two codes), so a `:0xCODE` suffix picks one; canonical text always carries it |
| `[Nibiru, the Primal Being]`, `#27204311`, `{hand traps}` | A card by name or passcode, a group — always delimited, always a whole alternative |

Case, hyphens and spacing do not matter (`beast warrior` = `Beast-Warrior` =
`beastwarrior`); parentheses group alternatives. Errors come back as a message
plus the span of the text they are about, never as an exception.
`tests/core/desc/realdata.test.ts` checks all of this against a real install
when `EDOPRO_WORKDIR` is set (see below).

## How matching works

A line's cards are known only to the specificity the line states: `monster` means "some
monsters", not particular ones. So a line fills a requirement, or counts against a limit, only
when its description **logically implies** the requirement's (`src/core/desc`: `implies`).

| Line | Requirement | Matches? |
| --- | --- | --- |
| `level 4 FIRE monster` | `level 4 or lower monster` | Yes — every such card is one |
| `monster` | `level 4 or lower monster` | **No** — some monsters are, but the line does not say these are |
| `"Magnet Warrior":0x3066 card` | `"Magnet":0x1066 card` | Yes — a sub-archetype belongs to its archetype |

The card pool is never consulted, except that a named card (`#27204311`) or group is fully
known and matches whatever its record satisfies. Real-data soundness check: `EDOPRO_WORKDIR`.

## Success criteria

A hand succeeds if it meets any one criterion (`src/core/criteria`: `parseCriterion`,
`printCriterion`, `expand`, `subsumes`). A criterion combines two kinds of term:

| Term | Means |
| --- | --- |
| `2x level 4 monster` (or `2×`) | A **requirement**: two *distinct* drawn cards, each filling it. `1x [A], 1x [B], 1x monster` needs three cards |
| `at most 1x [Brick]`, `no trap` | A **limit**: a count over the whole hand, not an assignment |

`and` and `,` are the same and bind tighter than `or`; parentheses group. There are two "or"s:
`1x [C] or 2x [D]` chooses between terms, because a count (or `at most`, `no`) follows, while
`1x [C] or [E]` is **one** slot either card fills — the same as `1x ([C] or [E])`, the form the
printer always uses. Nesting is surface syntax: `1x [A] and 1x [B] and (1x [C] or 2x [D])` expands
to the flat alternatives `(A, B, C)` and `(A, B, 2× D)`, all the engine sees (at most 256 of them).

## Exact probabilities

Adjacent ratios differ by well under a percentage point — less than the noise of any affordable
sample — so decks are ranked by **exact** odds (`src/core/prob`: `binomial`, `matcher`,
`success-set`, `scorer`). Whether a hand succeeds depends only on how many cards of each class
it holds (decided by Hall's condition, no search), so the successful hand compositions are found
once per problem and every candidate deck is then a short sum of products of binomials.
`createScorer(problem, H).score(classTotals)` returns `{ num, den }`: two exact integers — every
numerator is at most $`\binom{60}{6} = 50{,}063{,}860`$, far below $`2^{53}`$, so there is no
rounding, no BigInt and no epsilon; two decks tie iff their numerators are equal (`compareScores`
ranks a going-first / going-second blend the same way). The Monte Carlo engine below shares no code
with any of this and is the cross-check: the two must agree within five standard errors on generated
problems at real deck sizes, and the scorer must match a count of every hand of small decks exactly.

## Command-line harness

A development harness over `src/core` (`src/cli`, run through `tsx`). It is **not the
product** and is not shipped: it exists so the engine can be driven, and checked against real
card data, before there is an app around it.

```sh
npm run cli -- analyze  <template.json> --workdir <EDOPro dir> [--hand 5|6] [--json]
npm run cli -- estimate <template.json> --workdir <EDOPro dir> \
    [--samples 200000] [--seed 1] [--hand 5|6] [--ratio 3,3,5,2,0,7,3 | --at max|min]
```

`analyze` prints everything the tool understands of a template **before anything is scored**
(`src/core/model/analyze.ts`, the Analysis API of [TDD §9](docs/TDD.md)) — the same value the
app will recompute on every edit. It scores nothing and lists nothing: ratios and class vectors
are counted in closed form, so it stays instant when there are $`10^{17}`$ of them. `--json`
prints the raw `Analysis` value and nothing else. It exits `1` when the template has errors, and
prints the whole report either way — a line that does not parse costs only what needed it.

```sh
EDOPRO_WORKDIR=~/Applications/ProjectIgnis npm run -s cli -- analyze examples/motivating.json
```

| Section | Content |
| --- | --- |
| Card database, Template, Criteria | As for `estimate`, below, without the chosen counts; a line or criterion that was not understood says so |
| Matching | Per requirement, the lines that fill it, then the **near misses** — lines that could hold such a card but do not say so — each with what is unstated and the line that *would* count: ``near miss: monster — Level unstated; a `level 4 or lower monster` line would count``. Per limit, the lines it counts and the under-specified lines it **ignores**, with how many cards they can hold. Last, the lines that match nothing and so cannot affect the odds |
| Totals | Read-only totals by kind, from the lines that *imply* the kind: `Known monsters 7–14`, `Known spells 0–13`, and `Unspecified 13–33` — what the lines leave of the deck |
| Classes | What `compileProblem` hands the engine: lines the criteria cannot tell apart are merged into one class whose range is the sum of theirs, and lines that match nothing form the blank class. The example's seven lines and remainder are five classes |
| Work | Raw ratios (4,096), class vectors an exhaustive run would score (128), products summed per score, and the time that comes to |
| Errors, Warnings, Notices | Each named by the line, group or criterion it belongs to: a description that matches no card, a named card over three copies, lines that share a copy limit (Harpie Lady and Harpie Lady 1) and together exceed it, ranges that cannot sum to the deck size; a requirement no line fills, a criterion that can never be met or names a card the template lacks; a criterion another already covers, a limit that ignores under-specified cards |

`estimate` loads the install's card databases and `strings.conf` layers, resolves a template
file ([TDD §14](docs/TDD.md)), and estimates the odds of a successful opening hand **at one
deck ratio** by Monte Carlo (`src/core/prob/montecarlo.ts`). `--workdir` falls back to
`$EDOPRO_WORKDIR`. `--ratio` gives the copies of each line in template order — the remainder is
whatever is left of the deck — and must respect every line's range; without it every line sits
at its `max` (`--at max`). The same `--seed` always gives the same estimate.

The example is the PRD's motivating template, [`examples/motivating.json`](examples/motivating.json)
— with Level 8 where the PRD first wrote Level 7, because no Level 7 FIRE Beast-Warrior exists
and a line that matches no card is an error:

```sh
EDOPRO_WORKDIR=~/Applications/ProjectIgnis npm run -s cli -- estimate examples/motivating.json --samples 1000000
```

What the output means, top to bottom (all of it on stdout):

| Section | Content |
| --- | --- |
| Card database | Databases loaded and skipped, cards in the Main Deck population, `replacedRows` (rows a later database updated — a delta repository doing its job), `conflicts` (ids on which two repositories disagree — the one figure worth worrying about), and how many archetype names were found, or that no `strings.conf` was |
| Template | Each line as written, the parse echo ("understood as"), how many cards in the database match it, its range, and the count chosen for this estimate; the remainder last |
| Criteria | Each criterion as written and the flat alternatives it expands to; a hand succeeds if it meets any one |
| Matching | For every distinct requirement or limit description, the lines that fill it (or that it counts), and its near misses, as in `analyze`. This is where `monster` visibly does **not** fill `level 4 or lower monster`, and where lines that match nothing — and so cannot affect the odds — are listed |
| Warnings, Notices | As in `analyze`: a requirement no line fills, a criterion that can never be met, a picker-chosen card missing from the database; a criterion another already covers |
| `P(success) = 0.0701  (95% CI 0.0696–0.0706, 1,000,000 samples, seed 1)` | The estimate, its 95% **Wilson score** interval, then the hit count and the standard error |

Progress (`done / total`, percent, elapsed, ETA) goes to **stderr**, one plain line per report,
so stdout can be piped and a log file stays readable. Exit codes: `0` success, `1` the template
or the card data is at fault (every problem is listed, each naming its line or criterion), `2`
the command line is.

The Monte Carlo engine is the project's independent oracle (TDD §10.4): it draws concrete cards
tagged with their line and assigns them to requirement slots by brute force, sharing no code
with the exact engine (`src/core/prob/scorer.ts`), which is tested against it. With `EDOPRO_WORKDIR` set,
`tests/cli/realdata.test.ts` runs this command on the example against the real install and
checks the estimate against the exact value (46,185 / 658,008 ≈ 0.0702), computed in the test
by an independent route.

## Development

Requires Node 22.

```sh
npm ci              # install exactly what the lockfile says
npm run dev         # launch the app with hot reload
npm test            # vitest
npm run typecheck   # whole project, then src/core alone under its purity tsconfig
npm run lint        # biome: lint + format check  (npm run format to fix)
npm run build       # electron-vite production build into out/
npm run check:licenses
```

### Real-data tests

`tests/core/cards/realdata.test.ts` checks `src/core/cards` against real card
data. It is skipped unless one of these is set, so CI never runs it — run it
locally before touching `src/core/cards`:

| Variable | Points at | Asserts |
| --- | --- | --- |
| `BABELCDB_PATH` | `cards.cdb` in a checkout of [BabelCDB](https://github.com/ProjectIgnis/BabelCDB) at `47fc046` | Population size, row decoding, the three kinds of `alias`, the pre-release layers beside it |
| `EDOPRO_WORKDIR` | An EDOPro install directory | Layered `strings.conf` archetype names; Type and Attribute names against the client's own |

```sh
BABELCDB_PATH=~/repos/deps/babelcdb/cards.cdb EDOPRO_WORKDIR=~/Applications/ProjectIgnis npm test
```

### Layout

| Path | What lives there |
| --- | --- |
| `src/core/` | Everything that can be *wrong*: card data, descriptions, implication, probability, optimizer. Pure TypeScript — no Electron, no Node built-ins, no DOM |
| `src/main/` | Electron main process: window, CSP, IPC handlers, filesystem. `src/main/edopro/loader.ts` walks an EDOPro install (no Electron import, so the CLI shares it) |
| `src/preload/` | The typed `window.api` bridge (emitted as CommonJS — see `electron.vite.config.ts`) |
| `src/renderer/` | React UI; sandboxed, talks only through `window.api` |
| `src/shared/` | IPC channel names and payload types |
| `src/cli/` | Development harness (`npm run cli`), not shipped |
| `examples/` | Example templates; `motivating.json` is the PRD's motivating example |
| `tests/` | Mirrors `src/` |
| `scripts/` | `check-licenses.mjs` |

`src/core` purity is enforced twice: `tsconfig.core.json` compiles it with no DOM
lib and no Node types, and a Biome `noRestrictedImports` override bans Electron,
Node built-ins, and the app layers from inside it.

### Adding or upgrading dependencies

Use **npm 11 or newer** for anything that changes the dependency tree
(`npx npm@11 install --save-dev <pkg>`). npm 10.9's resolver crashes on this tree
(`Cannot read properties of null (reading 'edgesOut')`). `npm ci` from the
lockfile works on any npm, which is what CI and day-to-day installs use.

Every new dependency must pass `npm run check:licenses`: the project is
proprietary on the condition that nothing in the tree is copyleft, and CI fails
on any license outside the allowlist in `scripts/check-licenses.mjs`.

## License

Proprietary — all rights reserved. See [LICENSE](LICENSE).
