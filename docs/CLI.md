# Command-line harness

The engine without the window: `estimate` (Monte Carlo) and `optimize` (exact) over a template
file. Commands run from the repository root. See the [user guide](GUIDE.md) for what templates
and criteria mean.


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
(`src/core/model/analyze.ts`, the Analysis API of [TDD §9](TDD.md)) — the same value the
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
| Errors, Warnings, Notices | Each named by the line, group or criterion it belongs to: a description that matches no card, two lines naming the same card, ranges that cannot sum to the deck size; a requirement no line fills, a criterion that can never be met or names a card the template lacks; a criterion another already covers, a limit that ignores under-specified cards |

`estimate` loads the install's card databases and `strings.conf` layers, resolves a template
file ([TDD §14](TDD.md)), and estimates the odds of a successful opening hand **at one
deck ratio** by Monte Carlo (`src/core/prob/montecarlo.ts`). `--workdir` falls back to
`$EDOPRO_WORKDIR`. `--ratio` gives the copies of each line in template order — the remainder is
whatever is left of the deck — and must respect every line's range; without it every line sits
at its `max` (`--at max`). The same `--seed` always gives the same estimate.

The example is the PRD's motivating template, [`examples/motivating.json`](../examples/motivating.json)
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
(`src/core/opt`, [TDD §11](TDD.md)), and answers the question the tool exists for. It walks
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
| Best ratio | `P(success) = 46,185 / 658,008 = 7.0189%`, then the ratio **in lines**: a count, or a range where a class total splits freely among its lines (`8 copies among monster, fire-bw — any split`). Weighted, the headline is `expected weight per hand` with `P(success)` under it |
| Ranked | The top `--top` class vectors: percentage, exact fraction, the copies of each line that matters, the blank cards, and how many raw ratios tie in that vector |
| Plateau | How many class vectors and raw ratios are within `--delta` percentage points of the best — decided in exact integers — and the copies each line takes across them: "2 or 3 are equally fine" |
| Irrelevant lines | Lines no requirement or limit can see. Usually every count ties (`spell (0–7)`), said in one line instead of a table; when their copies can only come at the expense of cards that matter — the remainder past a point, always — the table is shown after all |
| Sweeps | For **every** line that matters, the best `P` with the line held at each count and everything else re-optimized, the best count starred. `--sweep <lineId>` adds that line in detail: the deck behind each count, and `P` with the other lines *held fixed* at the best ratio |
| Per criterion | The exact probability of each criterion by itself at the best ratio; weighted, its weight beside it, and `any of them` is P(any) rather than the weighted headline |

**The three modes.** `--mode` says which run this is, overriding the template's own:

| `--mode` | Hand | Criteria judged |
| --- | --- | --- |
| `first` | 5 | those tagged `first` or `both` |
| `second` | 6 | those tagged `second` or `both` |
| `average` | 5 and 6 | both of the above, weighted 1 : 1 |

`--hand 5` and `--hand 6` are the older spellings of the two single modes, and `--blend 3:2` is
the average with weights of its own — going first 60% of the time and second 40%. One of the
three at a time.

**Weighting.** `--weighted` and `--unweighted` override the template's own switch, so the same
file gives both answers one command apart; the report then heads its columns `weight` and
`P(success)` rather than `P`.

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

The second example, [`examples/brick.json`](../examples/brick.json), asks what the tool was first
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

The fourth example, [`examples/drawing.json`](../examples/drawing.json), is the draw-card one: three
Pot of Extravagance (a once-per-turn draw-2), three Upstart Goblin (a draw-1), three Ash Blossom you
play for other reasons — and two criteria, one of which you would **stop** for.

```sh
EDOPRO_WORKDIR=~/Applications/ProjectIgnis npm run -s cli -- optimize examples/drawing.json --top 1
```

```
Best ratio — P(success) = 4,094,621,599,770 / 12,816,627,183,360 = 31.9477%
  a hand of 5, nothing drawn: 12.4412% (81,864 / 658,008)
  a hand of 5, 1 card drawn: 5.6377% (1,298,385 / 23,030,280)
  a hand of 5, 2 cards drawn: 8.0402% (62,957,292 / 783,029,520)
  a hand of 5, 3 cards drawn: 4.5870% (592,645,131 / 12,919,987,080)
  a hand of 5, 4 cards drawn: 1.1320% (4,680,322,578 / 413,439,586,560)
  a hand of 5, 5 cards drawn: 0.1095% (7,017,699,222 / 6,408,313,591,680)

  pot       0: 28.2864%   1: 29.6649%   2: 30.8803%   3: 31.9477% *
  upstart   0: 29.5591%   1: 30.3230%   2: 31.1184%   3: 31.9477% *
```

Six **prefix lengths**, six exact fractions, and they **sum** to the headline — one part per length
the draw cards can reach, each over its own $`\binom{N}{\ell}`$, which is why there is no single
fraction that says all of it. A part is named by what it DREW and not by its prefix: `prefix` is how
deep into the deck the hand read, so `prefix − H` is the draw and the part at `prefix = H` drew
nothing. (A prefix length is not a hand size either — two compositions of the same depth can leave
different hands, since a draw-2 and two draw-1s both reach 7 from 5.) The first criterion is "a starter and no dead hand trap", and it is marked
`stop`: an opening that already meets it keeps the hand instead of digging into an Ash Blossom that
breaks the limit. **That flag alone is worth 1.44 percentage points** — 31.9477% against 30.5060%
with it off — and it is the whole case for having it. 144 class vectors, scored in about 6 ms.

The third example, [`examples/first-and-second.json`](../examples/first-and-second.json), is the
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

The fifth example, [`examples/going-second.json`](../examples/going-second.json), fills all three
fields of one going-second criterion — `1x level 4 monster` in the opening 5, `1x trap` drawn, `at
most 1x level 8 monster` in the whole hand — on one pinned deck of three Level 4s, three Level 8s,
eight traps and 26 other cards:

```sh
EDOPRO_WORKDIR=~/Applications/ProjectIgnis npm run -s cli -- optimize examples/going-second.json --top 1
```

It scores **1,548,888 / 23,030,280 = 6.7254%**, over the $`6 \cdot \binom{40}{6}`$ orderings of
which card was drawn for turn. The opening and whole-hand fields alone score 7,464,666 over the
same denominator, and the opening field alone 7,773,885 — which is
$`1 - \binom{37}{5} / \binom{40}{5}`$ exactly, a question about the first five cards and nothing
else. `tests/core/model/compile.test.ts` pins all three.

The Monte Carlo engine is the project's independent oracle (TDD §10.4): it draws concrete cards
tagged with their line and assigns them to requirement slots by brute force, sharing no code
with the exact engine (`src/core/prob/scorer.ts`), which is tested against it. With `EDOPRO_WORKDIR` set,
`tests/cli/realdata.test.ts` runs this command on the example against the real install and
checks the estimate against the exact value (46,185 / 658,008 ≈ 0.0702), computed in the test
by an independent route.
