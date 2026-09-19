# Installing

| Status | Author | Date | Tracking | Related |
| --- | --- | --- | --- | --- |
| Current | Andy (with Claude) | 2026-09-19 | [YGO-8](https://linear.app/ygo-deck-optimizer/issue/YGO-8) | [PRD](./PRD.md) · [TDD](./TDD.md) |

The app is **not distributed to anyone** (PRD §13, F2). It is built for Andy's own use, so it is unsigned and there is no updater. Everything below is about getting a double-clickable app onto a Mac you own.

## What you need

- **macOS on Apple Silicon.** The only target built today is `arm64`; a Windows build is configured but unbuilt.
- **[EDOPro](https://projectignis.github.io/) installed.** The app reads its card databases and archetype names straight from that folder and never copies or uploads them. On first run it looks in `~/ProjectIgnis`, `~/Applications/ProjectIgnis` and `/Applications/ProjectIgnis`; if none of those is it, the app asks.

## Getting it

### From a release

Releases live on this repository, which is private — so you can download them while signed in to GitHub, and nobody else can. Take the `.dmg` from the [latest release](https://github.com/96jonesa/ygo-deck-optimizer/releases), open it, and drag the app to `/Applications`.

**The first launch needs a right-click.** A DMG downloaded through a browser carries macOS's quarantine flag, and the app is unsigned, so double-clicking it produces *"cannot be opened because the developer cannot be verified"*. Right-click the app → **Open** → **Open**. macOS remembers the choice; every later launch is an ordinary double-click. If you would rather do it from a terminal:

```sh
xattr -d com.apple.quarantine "/Applications/YGO Deck Optimizer.app"
```

This is the one cost of not paying for a Developer ID, and it disappears the day the app is signed.

### Building it yourself

A build you make locally has no quarantine flag and just opens.

```sh
npm ci
npm run package:mac      # → dist/YGO Deck Optimizer-<version>-arm64.dmg, and dist/mac-arm64/*.app
```

Use **npm 11 or newer** if you change dependencies (`npx npm@11 install …`); `npm ci` itself works on any npm. See the README.

### Cutting a release

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds on a macOS runner and attaches the DMG to the release. The tag must match `version` in `package.json` (a `-preview` style suffix on the tag is allowed). Running the workflow by hand instead leaves the DMG as a workflow artifact, which is a safe dry run.

## Where it keeps things

| What | Where |
| --- | --- |
| Settings (EDOPro folder, pre-release toggle, plateau width) | `~/Library/Application Support/ygo-deck-optimizer/settings.json` |
| Card data | Read from your EDOPro folder. Nothing is copied or cached |
| Templates | Wherever you save them — plain JSON |

To start over, quit the app and delete that `settings.json`; the next launch re-runs first-time setup.

## If something is wrong

- **"cannot be opened because the developer cannot be verified"** — the quarantine flag; see above.
- **The app opens but finds no cards** — point it at your EDOPro folder with *Choose EDOPro folder…*. The folder is the one containing `cards.cdb` and/or `expansions/` and `repositories/`.
- **"archetype names unavailable"** — the install has no `config/strings.conf`. Everything works except descriptions that name an archetype.
- **Anything else** — run it from a terminal to see its log:
  ```sh
  YGO_DEBUG=1 "/Applications/YGO Deck Optimizer.app/Contents/MacOS/YGO Deck Optimizer"
  ```
