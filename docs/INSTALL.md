# Installing

| Status | Author | Date | Tracking | Related |
| --- | --- | --- | --- | --- |
| Current | Andy (with Claude) | 2026-09-19 | [YGO-8](https://linear.app/ygo-deck-optimizer/issue/YGO-8) | [PRD](./PRD.md) · [TDD](./TDD.md) |

The app is **not distributed to anyone** (PRD §13, F2). It is built for Andy's own use, so it is unsigned and there is no updater. Everything below is about getting a double-clickable app onto a machine you own.

## What you need

- **macOS on Apple Silicon**, or **Windows on x64**. Both are built and attached to every release. The Mac build is `arm64` only and **will not run on an Intel Mac**.
- **[EDOPro](https://projectignis.github.io/) installed.** The app reads its card databases and archetype names straight from that folder and never copies or uploads them. On first run it looks in `~/ProjectIgnis`, `~/Applications/ProjectIgnis` and `/Applications/ProjectIgnis` on macOS, and `C:\ProjectIgnis` and `C:\Games\ProjectIgnis` on Windows; if none of those is it, the app asks.

## Getting it

### From a release

Releases live on this repository, which is private — so you can download them while signed in to GitHub, and nobody else can. Take the file for your platform from the [latest release](https://github.com/96jonesa/ygo-deck-optimizer/releases):

| Platform | File | What to do with it |
| --- | --- | --- |
| macOS, Apple Silicon | `…-arm64.dmg` | Open it and drag the app to `/Applications` |
| Windows, x64 | `…-Setup-….exe` | Run it; it asks where to install |

**Both platforms warn once, because the app is unsigned.** That is the single cost of not buying a signing certificate, and it goes away the day one is bought.

#### macOS: the first launch needs a right-click A DMG downloaded through a browser carries macOS's quarantine flag, and the app is unsigned, so double-clicking it produces *"cannot be opened because the developer cannot be verified"*. Right-click the app → **Open** → **Open**. macOS remembers the choice; every later launch is an ordinary double-click. If you would rather do it from a terminal:

```sh
xattr -d com.apple.quarantine "/Applications/YGO Deck Optimizer.app"
```

#### Windows: SmartScreen needs one click

An unsigned installer downloaded through a browser makes Windows show a blue *"Windows protected your PC"* panel with only a **Don't run** button. Click **More info**, then **Run anyway**. It appears once per downloaded file.

### Building it yourself

A build you make locally has no quarantine flag and just opens.

```sh
npm ci
npm run package:mac      # → dist/YGO Deck Optimizer-<version>-arm64.dmg, and dist/mac-arm64/*.app
npm run package:win      # → dist/YGO Deck Optimizer-Setup-<version>.exe   (run this ON Windows)
```

Each platform builds its own installer; neither cross-compiles the other.

Use **npm 11 or newer** if you change dependencies (`npx npm@11 install …`); `npm ci` itself works on any npm. See the README.

### Cutting a release

```sh
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` then creates the release once on a Linux runner — checking first that the tag matches `version` in `package.json`, a `-preview` style suffix aside — and builds the two installers in parallel on a macOS and a Windows runner, each uploading its own. Creating the release in its own job is what stops the two builds racing to create it.

Running the workflow **by hand** instead builds both and leaves them as workflow artifacts without touching any release, which is the safe dry run. `fail-fast` is off, so one platform failing still tells you whether the other worked.

## Where it keeps things

| What | Where |
| --- | --- |
| Settings (EDOPro folder, pre-release toggle, plateau width) | macOS `~/Library/Application Support/ygo-deck-optimizer/settings.json`; Windows `%APPDATA%\ygo-deck-optimizer\settings.json` |
| Card data | Read from your EDOPro folder. Nothing is copied or cached |
| Templates | Wherever you save them — plain JSON |

To start over, quit the app and delete that `settings.json`; the next launch re-runs first-time setup.

## If something is wrong

- **"cannot be opened because the developer cannot be verified"** (macOS) — the quarantine flag; see above.
- **"Windows protected your PC"** — SmartScreen on an unsigned installer; **More info** → **Run anyway**.
- **The Mac app will not open at all** — check you are on Apple Silicon. There is no Intel build.
- **The app opens but finds no cards** — point it at your EDOPro folder with *Choose EDOPro folder…*. The folder is the one containing `cards.cdb` and/or `expansions/` and `repositories/`.
- **"archetype names unavailable"** — the install has no `config/strings.conf`. Everything works except descriptions that name an archetype.
- **Anything else** — run it from a terminal to see its log:
  ```sh
  # macOS
  YGO_DEBUG=1 "/Applications/YGO Deck Optimizer.app/Contents/MacOS/YGO Deck Optimizer"
  ```
  ```powershell
  # Windows
  $env:YGO_DEBUG=1; & "$env:LOCALAPPDATA\Programs\ygo-deck-optimizer\YGO Deck Optimizer.exe"
  ```
