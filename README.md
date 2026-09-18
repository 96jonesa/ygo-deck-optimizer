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
| M0 — de-risk spike (headless) | **In progress**: M0a scaffold |
| M1 — exact engine + optimizer (headless) | Not started |
| M2 — app MVP | Not started |
| M3 — polish | Not started |
| M4 — release | Not started |

Today the app opens an empty window that proves the main ↔ preload ↔ renderer
bridge; nothing is computed yet.

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

### Layout

| Path | What lives there |
| --- | --- |
| `src/core/` | Everything that can be *wrong*: card data, descriptions, implication, probability, optimizer. Pure TypeScript — no Electron, no Node built-ins, no DOM |
| `src/main/` | Electron main process: window, CSP, IPC handlers, filesystem |
| `src/preload/` | The typed `window.api` bridge (emitted as CommonJS — see `electron.vite.config.ts`) |
| `src/renderer/` | React UI; sandboxed, talks only through `window.api` |
| `src/shared/` | IPC channel names and payload types |
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
