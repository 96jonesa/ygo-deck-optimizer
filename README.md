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
| M0 — de-risk spike (headless) | **Done**: M0a–M0f (scaffold, card data, descriptions, implication, criteria, Monte Carlo oracle + CLI `estimate`) |
| M1 — exact engine + optimizer (headless) | **Done**: M1a exact scorer, M1b compile + analyze, M1c optimizer + CLI `optimize` |
| M2 — app MVP | **In progress**: M2a main process (EDOPro probe, settings, card service, parse/analyze services, the IPC contract), M2b optimizer worker (a warm `worker_threads` thread, `run:start` / `run:cancel` / `run:confirm`, progress and results pushed on `run:event`), M2c shell + card picker (first-run setup, status bar, settings, the reusable card picker), M2d template editor (lines, copy ranges, groups, parse echo, remainder and derived totals), M2e criteria editor (criterion rows, nested OR expansion preview, filled-by / near-miss / limit readouts), M2f results (best ratio, ranked table with exact ties, plateau with a live δ, copies-vs-odds sweep charts, per-criterion breakdown, irrelevant lines, the limits footnote), range requirements (`1-2x monster`: a ceiling that binds the cards it does not take, so the range means "in addition to the rest"), `exactly nx` for a range whose ends agree, inline name completion in both editors (`[card]`, `{group}`, `"archetype"`), M2g files (`.ydk` deck import, template open/save with `cardSnapshot`, CSV/JSON export of a run) |
| M3 — polish | Not started |
| M4 — release | Not started |

### What the app does so far

A single window with a status bar — cards, databases, archetype names, conflicts, and
**Re-index** — over a workspace laid out as *template* and *criteria* on the left, *results* on
the right. With no EDOPro install found, a first-run panel explains what EDOPro is, why it is
needed, and that nothing is uploaded anywhere, then asks for the folder; a settings panel holds
the folder, the pre-release toggle and the plateau width.

**You can write a deck template.** Add lines — a named card through the keyboard-operable
picker, or a free-text description — and remove, reorder and edit them; set each line's copy
range, the deck size (40–60) and the run mode (below). Every edit is analysed (debounced,
newest-wins), and each line shows what the tool understood of it, how many cards in the database
match and a few of their names, with errors, warnings and notices marked at the line they are
about — a description that matches nothing is a **notice**, not a failure, because a line states
what its cards are known to be, not which cards exist. Below the lines sit the computed
remainder (`Unspecified cards: 13–33`), the derived totals by kind with the lines that make them
up, and a clear error when the ranges cannot sum to the deck size. Named **groups** — `starter`,
`brick` — are created, renamed, filled from the picker and used in any description as
`{starter}`. Load the motivating example, or clear it, and score it.

**Every input format is written down where you are typing it.** Each panel carries a collapsed
disclosure — *Syntax: describing cards* under the template's lines, *Syntax: writing criteria*
under the criteria, and short ones for the three runs, the file buttons and the two exports.
The content is data in `src/shared/syntax.ts`, and `tests/shared/syntax.test.ts` feeds **every**
row of it to `core`'s own parsers: an example that stops parsing, an error example whose message
drifts, or a card name that is not a real card fails the build. The split is by level and
nothing is written twice — the description language is explained once, in the template panel,
and the criteria disclosure points at it rather than repeating the half it shares.

**You do not have to remember how anything is spelled.** Typing an opening delimiter in any
description or criterion field — `[` for a card, `{` for a group, `"` for an archetype — opens a
list at the name being typed, walked with ↑/↓, taken with Enter or a click, dismissed with
Escape. Whether the caret is inside a name at all is read off the *lexer*, so a `]` inside a
quoted archetype and a quote inside a card name (`["A" Cell Breeding Device]`) are content, as
the parser says they are. What is offered, and how each row is written back, are decided in main
over `desc:complete`, under one rule: **every row inserts text that resolves to the row you
picked**. So a card name two records share goes in as its passcode rather than as an ambiguous
`[Name]`, and an archetype name that names two setcodes carries its code — `"Warrior"` alone is
a parse error on a real install (it is both `0x66` and `0x2066`), and completion turns that dead
end into the two rows that resolve it.

**You choose which game you are optimizing for.** Three run modes, beside the deck size:
**Going first** (a hand of 5), **Going second** (a hand of 6), and **Average**, which scores both
and ranks by their mean, weighted evenly. Each criterion says which hand it is judged for —
*going first*, *going second*, or *either hand*, which is what one says when it says nothing —
so a criterion that applies both ways is written once, and the editor files the criteria under
those three headings. Going first is the first heading plus the middle one; going second is the
middle one plus the last. A criterion the current mode does not judge stays editable and is
dimmed rather than hidden.

Both halves score the **same deck**: the classes of card the engine tells apart come from the
union of both criteria sets, so a ratio means one thing in both halves of an average and the
same thing in all three modes. Where a run scores both hands, every score on screen shows five
numbers — the average, and each hand's own probability and exact fraction — because the two
denominators differ, C(40,5) against C(40,6), and one fraction could only ever be one of them.

**You can write the success criteria, and see what they mean.** Criteria are added, removed,
reordered, named, tagged and edited as text in the criterion language (`1x [Ash Blossom], 1x
monster, at most 1x [Brick]`), each with the same live parse echo, marked error span and
canonical printed form the template's lines get. A criterion with alternatives — `1x A and 1x B and (1x C or 2x
D)` — shows the **flat alternatives it will actually be scored as**, so nested `or` is never a
guess, along with any alternative dropped for needing more cards than a hand holds. Criteria
carry their own notices: one that adds nothing because another already covers it, one that can
never be met, and one naming a card no line of the template has.

Under them are the two readouts the tool exists for. **Per requirement**: the lines that fill it
and — the point — the near misses, each with the dimension it leaves unsaid (`` `monster`:
Level unstated ``) and a one-click **split** that adds the line which *would* count, exactly as
`analyze` wrote it; once a line says it, the readout says which one instead of offering it
again. **Per limit**: the lines it counts and, stated plainly rather than assumed, the
under-specified cards it ignores with their total range (`at most 1x trap` ignores 13–33
unspecified cards) — a limit counts only cards a line is specific enough to be *known* to match.
A criterion with an error blocks a run exactly as a broken line does.

**And you can read the answer.** Run scores every valid ratio exactly, saying first what that
will cost (`128 class vectors over 4,096 raw ratios, about 12 ms`); a long search reports
done/total, percent, elapsed and ETA and can be **cancelled**, keeping what it scored and marking
it plainly as partial; a search over the time threshold asks before it starts. The best ratio
leads — the percentage, the exact fraction it is (`46,185 / 658,008`), and the copies per line,
with a range wherever a class is free to split. Then the **ranked table**, where equal scores are
exact ties and share one rank rather than being ordered by accident; the **plateau**, every ratio
within δ of the best as a range of copies per line ("2 or 3 copies are equally fine"), with δ
editable in percentage points beside it (measured on the average, over both hands); a **copies-vs-odds chart per line** — inline SVG, the
argmax marked, gaps where a count is impossible, each scaled to its own range and labelled with
it, and every figure printed under the chart so it can be quoted; the **per-criterion breakdown**
at the best ratio; and the lines **no criterion can see**, said as free only where the engine says
every count really does tie — where it does not, what each count costs is shown instead. Where a
criterion carries a limit, a quiet footnote says the number is exact under the tool's one
matching rule and names the cards that rule cannot see.

**Work outlives the app process.** At the top of the template panel, **Open…** and **Save…**
read and write a [template file](#template-files-and-decks); **Import a deck…** lists the decks in your EDOPro
install by name and turns one into lines — one line per distinct card, at the copies the deck
holds, with your criteria and groups left exactly as they were. A deck kept elsewhere goes
through **Choose a .ydk file…**. Under a finished run, **Export** writes the ranked table as CSV
or the whole result as JSON, in exact fractions rather than percentages.

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
| `1-2x monster`, `exactly 1x monster` | A requirement with a **ceiling**, counted after the other requirements have taken theirs: one or two monsters *besides* whatever else was asked for. A card matching a capped description counts unless another requirement consumed it, so the ceiling really binds. `exactly n` is sugar for `n-n`, parses to the same thing, and is what the printer writes back |
| `at most 1x [Brick]`, `no trap` | A **limit**: a count over the whole hand, not an assignment |

The `x` may be left out wherever only a term can start (`1-2 monster`, `at most 2 trap`); the
printer always writes it. `and` and `,` are the same and bind tighter than `or`; parentheses
group. There are two "or"s: `1x [C] or 2x [D]` chooses between terms, because a count (or
`at most`, `no`, `exactly`) follows, while
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

## Template files and decks

A **template file** is versioned JSON holding the lines, the groups, the criteria, the deck size
and the run. Three things in it are worth knowing.

**The stored AST is what runs.** Every line and criterion is written with its parsed form
(`desc` / `expr`) beside the text you typed. The text is kept for editing, and the AST is what
the engine judges — so a file survives a change to the grammar and to the install's archetype
names (an archetype is stored as its setcode, never as a name). If the text no longer reads as
the AST beside it, the file still *means* what it meant and the line says so; typing over the
text replaces the stored form.

**The run travels with the template.** `mode` is `first`, `second` or `average`, and every
criterion carries a `when` of `first`, `second` or `both` — written out in full, the default
included, because a field left to a default means whatever the default means next year. A file
written before modes existed has neither, and is read as the run it always was: a hand of five
is going first, a hand of six going second, and an untagged criterion is judged either way.
`hand.size` is the size the criteria are expanded at, which is the mode's larger hand; a file
whose `mode` and `hand.size` disagree is refused rather than read one way and run the other.

**`cardSnapshot` records every named card as it was.** Results depend on the card database only
through the cards a template names, so the file keeps their fields. Opening it on another
install compares the two and names any card that is missing or whose fields have moved, field by
field. Those are notices: this install's card data is what runs. (Choosing the *file's* card data
instead is not built — see the note in `src/main/services/files.ts`.)

**Importing a `.ydk` decklist** reads the `#main` section only and makes one line per distinct
card at the count the deck holds, with `min = max`, so the template starts as exactly the deck
you have; widen the copies you want to tune and run. A passcode is resolved through the card
index before counting, so an alternate-art printing lands on the card it is a reprint of and
merges with it rather than reading as "no such card" — two of the five decks on the machine this
was built against carry one. Anything a deck can say that a template cannot — a passcode no
database holds, more than three copies, a main deck outside 40–60 — is kept usable and named in
a warning.

**Exporting a run** writes the ranked table as CSV (one row per class vector, a column per line)
or the whole result as JSON. Both carry **exact fractions, never percentages**: a spreadsheet
that divides `numerator` by `denominator` gets the number the app shows, and one that sorts on
`numerator` gets the order the app ranks by, ties included.

## Command-line harness

A development harness over `src/core` (`src/cli`, run through `tsx`). It is **not the
product** and is not shipped: it exists so the engine can be driven, and checked against real
card data, before there is an app around it.

```sh
npm run cli -- analyze  <template.json> --workdir <EDOPro dir> [--hand 5|6] [--json]
npm run cli -- estimate <template.json> --workdir <EDOPro dir> \
    [--samples 200000] [--seed 1] [--hand 5|6] [--ratio 3,3,5,2,0,7,3 | --at max|min]
npm run cli -- optimize <template.json> --workdir <EDOPro dir> \
    [--top 20] [--delta 0.5] [--sweep <lineId>] \
    [--mode first|second|average | --hand 5|6 | --blend 3:2] \
    [--threshold 60] [--force] [--json]
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
— verbatim, including its `level 7 FIRE beast-warrior monster` line, which matches no existing
card. That is allowed: a generic line states what its cards are known to be, not which cards
exist, so the tool notes it and carries on:

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
the command line is, `3` (`optimize` only) the run needs `--force`.

`optimize` scores **every** deck ratio the template allows, exactly, in one pass
(`src/core/opt`, [TDD §11](docs/TDD.md)), and answers the question the tool exists for. It walks
the class-total vectors — 128 for the example, standing for its 4,096 raw ratios, every one of
which ties exactly with its vector — and ranks them by exact integers, so equal scores are true
ties (broken by the smaller class vector, blank class first).

```sh
EDOPRO_WORKDIR=~/Applications/ProjectIgnis npm run -s cli -- optimize examples/motivating.json --top 8
```

| Section | Content |
| --- | --- |
| Card database … Notices | The analysis, as `analyze` prints it: what the numbers below are numbers *of* |
| Search | Class vectors scored of the exact total (counted up front), the raw ratios they stand for, the hand sizes, and the time estimate from a per-term cost **calibrated on this machine** at startup |
| Best ratio | `P(success) = 46,185 / 658,008 = 7.0189%`, then the ratio **in lines**: a count, or a range where a class total splits freely among its lines (`8 copies among monster, fire-bw — any split`) |
| Ranked | The top `--top` class vectors: percentage, exact fraction, the copies of each line that matters, the blank cards, and how many raw ratios tie in that vector |
| Plateau | How many class vectors and raw ratios are within `--delta` percentage points of the best — decided in exact integers — and the copies each line takes across them: "2 or 3 are equally fine" |
| Irrelevant lines | Lines no requirement or limit can see. Usually every count ties (`spell (0–7)`), said in one line instead of a table; when their copies can only come at the expense of cards that matter — the remainder past a point, always — the table is shown after all |
| Sweeps | For **every** line that matters, the best `P` with the line held at each count and everything else re-optimized, the best count starred. `--sweep <lineId>` adds that line in detail: the deck behind each count, and `P` with the other lines *held fixed* at the best ratio |
| Per criterion | The exact probability of each criterion by itself at the best ratio |

**The three modes.** `--mode` says which run this is, overriding the template's own:

| `--mode` | Hand | Criteria judged |
| --- | --- | --- |
| `first` | 5 | those tagged `first` or `both` |
| `second` | 6 | those tagged `second` or `both` |
| `average` | 5 and 6 | both of the above, weighted 1 : 1 |

`--hand 5` and `--hand 6` are the older spellings of the two single modes, and `--blend 3:2` is
the average with weights of its own — going first 60% of the time and second 40%. One of the
three at a time.

An average is resolved at a hand of 6 and ranked on the two hands' common denominator, in exact
integers. Its report shows **five numbers**: the average, and each hand's own probability and
exact fraction — the two denominators differ, C(40,5) against C(40,6), so neither fraction is
the other's and the mean is neither. `--json` prints the raw result — the value the app's
results views render — and nothing else.

Progress goes to stderr as for `estimate`. **The wall**: before scoring anything, the vector
count times the calibrated cost is compared with `--threshold` (default 60 s); over it,
`optimize` scores nothing and exits `3`, naming the estimate — a plausible 30-line template is
$`4.8 \times 10^{10}`$ vectors, about 23 days — and `--force` is the confirmation. Narrowing
ranges, not waiting, is the intended response.

The second example, [`examples/brick.json`](examples/brick.json), asks what the tool was first
asked: *how many copies of a card that bricks in multiples?* It is a Blue-Eyes shell around three
real cards — **Sage with Eyes of Blue** (the starter: its Normal Summon searches), **The White
Stone of Ancients** (the extender: it fetches a Blue-Eyes from the deck, which is why at least one
must be run), and **Blue-Eyes White Dragon** itself (the brick: a Level 8 Normal Monster that is
fine to hold once and dead in multiples) — plus `level 4 or lower monster` 6–10, `spell` 8–12 and
`trap` 3–8. Both criteria carry the limit `at most 1x [Blue-Eyes White Dragon]`, and one has a
nested `or`. The sweep over the `brick` line is the headline answer:

```sh
EDOPRO_WORKDIR=~/Applications/ProjectIgnis npm run -s cli -- optimize examples/brick.json --sweep brick
```

```
Sweep of `brick` — "held" keeps every other line at the best ratio, the remainder absorbing the difference
  copies  re-optimized  exact                  held  the deck that does it
  1 *         41.5744%  273,563 / 658,008  41.5744%  starter 3, extender 3, low-monsters 10, spells 12, traps 8
  2           41.3428%  272,039 / 658,008  41.3428%  starter 3, extender 3, low-monsters 10, spells 12, traps 8
  3           40.8933%  269,081 / 658,008  40.8933%  starter 3, extender 3, low-monsters 10, spells 12, traps 8
```

One copy is best, and each further copy costs a quarter to half a percentage point — so the
second copy sits inside the 0.5-point plateau and the third does not. The run scores 7,200 class
vectors in about 10 ms (roughly 700,000 vectors a second at 161 terms a score).

The third example, [`examples/first-and-second.json`](examples/first-and-second.json), is the
one where the three modes **disagree**: a starter you combo off going first, a second breaker a
sixth card makes reachable going second, and a body-and-trap criterion that counts either way.

```sh
for m in first second average; do
  EDOPRO_WORKDIR=~/Applications/ProjectIgnis \
    npm run -s cli -- optimize examples/first-and-second.json --mode $m --top 1
done
```

| Mode | starter | engine | breaker | trap | Best |
| --- | --- | --- | --- | --- | --- |
| going first | 3 | 18 | 6–11 | 8 | 527,097 / 658,008 = 80.1050% |
| going second | 0–3 | 14–17 | 15 | 8 | 3,632,237 / 3,838,380 = 94.6294% |
| average | 3 | 16 | 13 | 8 | 39,766,530 / 46,060,560 = 86.3353% |

A range is a class whose lines this mode's criteria cannot tell apart — going second, the
starter is just another low-Level monster, so any split of the 17 between them scores the same.

Three modes, three ratios. The average's deck scores 518,046 / 658,008 going first and
3,605,820 / 3,838,380 going second, and 39,766,530 / 46,060,560 is exactly their mean — the mean
**on that deck**, not of the two modes at their own optima, which is a higher number no single
deck reaches. `tests/core/model/realdata.test.ts` pins all of it.

**Each mode is compiled to the criteria it judges.** Going first builds its classes from the
criteria tagged *first* or *both* and nothing else, so it is exactly the problem it would have
been had the going-second criteria never been written: 4 classes and 305 class vectors here,
against the average's 5 and 1,399. The average judges every criterion, so its partition is the
union of both sets — which it must be, for one class vector to mean one deck to both of its
halves.

Narrowing never moves a probability; it widens the *answer*. Going first, no criterion mentions
`spell`, so the `breaker` line and the unspecified cards are one class: the best ratio comes back
as "11 copies among breaker, (remainder) — any split" rather than pinning a number that was never
load-bearing. Six raw ratios tie for the best going first, four going second, one on the average.

It also decides what is runnable. A template with fifteen going-first criteria and fifteen
going-second ones tells 16 classes apart in each single mode and 31 together: both single modes
run, and only the average is refused for passing the engine's limit of 30.

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
npm run package:mac # a double-clickable app in dist/ (see docs/INSTALL.md)
```

### Running the app

`npm run dev` (hot reload), or `npm run build` and then `npx electron .` for the built app.

On first run the app looks for an EDOPro install where one conventionally lives —
`~/ProjectIgnis`, `~/Applications/ProjectIgnis`, `/Applications/ProjectIgnis` on macOS;
`C:\ProjectIgnis`, `C:\Games\ProjectIgnis` on Windows — and uses the first folder that holds a
non-empty card database. If it finds none, **Choose EDOPro folder…** asks; a folder is checked
before it is saved, and a missing `strings.conf` is reported (archetype names are then
unavailable) without being refused. **Re-index** reads the folder again after an EDOPro update.

Settings live in `settings.json` under Electron's user-data folder —
`~/Library/Application Support/ygo-deck-optimizer/` on macOS, `%APPDATA%\ygo-deck-optimizer\` on
Windows:

```json
{ "version": 1, "workdir": "/Users/me/Applications/ProjectIgnis", "includePrerelease": true, "plateauDelta": 0.005 }
```

Delete the file to run first-run detection again. `--user-data-dir=<dir>` points the app at a
throwaway folder instead, and `YGO_DEBUG=1` prints one line to stderr per change of the card
index's status:

```sh
YGO_DEBUG=1 npx electron . --user-data-dir=/tmp/ygo-scratch
# [cards] loading workdir=/Users/me/Applications/ProjectIgnis
# [cards] ready workdir=/Users/me/Applications/ProjectIgnis databases=20 skipped=0 cards=12132 replacedRows=821 conflicts=0 setnames=805
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
| `src/main/` | Electron main process. Only `index.ts` imports Electron (a Biome `noRestrictedImports` rule keeps it so): it wires the window, the CSP and the dialogs into `app.ts` (startup: IPC registered **once**, first-run detection, the initial load, status pushes) and `ipc.ts` (the handlers), which take everything by injection and are tested without Electron |
| `src/main/edopro/` | `loader.ts` walks an EDOPro install (no Electron import, so the CLI shares it); `probe.ts` says whether a folder is one, and where to look for one |
| `src/main/services/` | `cards.ts` owns the card index, the archetype names and the analysis memo behind an `idle → loading → ready / error` state machine whose every change is pushed; `templates.ts` parses descriptions and analyzes templates over it; `files.ts` reads and writes template files and exports a run; `decks.ts` lists and imports the install's `.ydk` decklists; `runs.ts` hosts the optimizer thread; `typeline.ts` writes `Level 4 · WIND · Warrior · Effect Monster` |
| `src/main/store/` | `settings.ts`: versioned `settings.json`, loaded tolerantly, written write-then-rename |
| `src/worker/` | The optimizer's `worker_threads` thread, bundled through electron-vite's `?nodeWorker` import. Imports `src/core` only — a run arrives compiled, as plain numbers. `optimizer.worker.ts` is the thread's entry; `session.ts` is what a message does (calibrate once, search, report progress, stop gracefully on a shared-memory flag), tested without a thread; `protocol.ts` types the messages |
| `src/preload/` | The typed `window.api` bridge (emitted as CommonJS — see `electron.vite.config.ts`) |
| `src/renderer/` | React UI; sandboxed, talks only through `window.api`. Logic worth testing lives in pure functions under `src/renderer/src/model/` |
| `src/shared/` | The IPC contract: channel names and `RendererApi` (`ipc.ts`), payload types (`types.ts`); and the in-app syntax reference (`syntax.ts`), which imports nothing at runtime because the renderer bundles it |
| `src/cli/` | Development harness (`npm run cli`), not shipped |
| `examples/` | Example templates; `motivating.json` is the PRD's motivating example, `first-and-second.json` the one where the three run modes disagree |
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
