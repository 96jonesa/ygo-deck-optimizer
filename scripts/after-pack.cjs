// electron-builder `afterPack` hook: put Electron's and Chromium's own licenses
// inside the macOS app, before it is signed (TDD §17).
//
// On Windows electron-builder already keeps both — it renames the distribution's
// `LICENSE` to `LICENSE.electron.txt` and leaves `LICENSES.chromium.html` beside
// the executable. On macOS it unpacks ONLY `Electron.app` from the distribution
// zip, and both files sit at the zip's root, outside the bundle — so every macOS
// build shipped Chromium's binaries without Chromium's notices, while the docs
// claimed electron-builder shipped them. This copies them into
// `Contents/Resources`, under the same names the Windows build uses.
//
// Runs after packing and BEFORE signing, so the signature covers both files; the
// release workflow's `codesign --verify --deep --strict` gate would fail otherwise.
const { execFileSync } = require('node:child_process');
const { copyFileSync, existsSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { downloadArtifact } = require('@electron/get');
  const { Arch } = require('builder-util');
  const version = require('electron/package.json').version;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resources = path.join(app, 'Contents', 'Resources');

  // Electron's MIT license: the npm package carries the distribution's own copy.
  copyFileSync(require.resolve('electron/LICENSE'), path.join(resources, 'LICENSE.electron.txt'));

  // Chromium's licenses live only in the distribution zip, which electron-builder
  // has just unpacked — so this is a cache hit, not a second download.
  const zip = await downloadArtifact({
    version,
    platform: 'darwin',
    arch: Arch[context.arch],
    artifactName: 'electron',
  });
  execFileSync('unzip', ['-o', '-q', '-j', zip, 'LICENSES.chromium.html', '-d', resources]);
  for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html'])
    if (!existsSync(path.join(resources, file)))
      throw new Error(`after-pack: ${file} was not placed in ${resources}`);
};
