# Development

Building and running YGO Deck Optimizer from source. The [user guide](GUIDE.md) covers what the
app does; the design is in the [PRD](PRD.md) and [TDD](TDD.md).


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
npm run package:win # the Windows installer — run this ON Windows; neither cross-compiles
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
| `examples/` | Example templates; `motivating.json` is the PRD's motivating example, `first-and-second.json` the one where the three run modes disagree, `drawing.json` the one with draw cards, `going-second.json` the one using all three fields of a going-second criterion |
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

Every new dependency must pass `npm run check:licenses`: CI fails on any license
outside the allowlist in `scripts/check-licenses.mjs`, which admits only
permissive licenses — all compatible with the AGPL, and deliberately narrower
than it requires. The packaged app ships the licenses of the third-party
packages bundled into it as `THIRD_PARTY_NOTICES.md` (`npm run notices`, run by
`package:mac` and `package:win`).
