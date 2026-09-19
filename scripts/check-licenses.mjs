// License gate (TDD §17, PRD §4.4). The project is proprietary on the condition
// that no dependency forces otherwise, so CI fails on any installed package
// whose license is not on this ALLOWLIST. An allowlist, not a denylist: a
// denylist passes anything it has never heard of.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'Python-2.0',
  'WTFPL',
  'Unlicense',
]);

/** "A OR B" passes if either side does; "A AND B" needs both. Parentheses are only grouping here. */
export function isAllowed(expression) {
  const text = expression.replaceAll(/[()]/g, ' ').trim();
  if (text === '') return false;
  return text
    .split(/\s+OR\s+/i)
    .some((alternative) => alternative.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

function licenseOf(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === 'string') return license;
  if (license && typeof license.type === 'string') return license.type;
  if (Array.isArray(licenses)) return licenses.map((l) => l.type).join(' OR ');
  return '';
}

function* installedPackages(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('@')) {
      yield* installedPackages(full);
      continue;
    }
    const manifestPath = path.join(full, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        // Directories with a bare {"type": "module"} marker are not packages.
        if (typeof manifest.name === 'string') yield manifest;
      } catch {
        // An unreadable manifest is reported as unlicensed below.
        yield { name: full, version: '?' };
      }
    }
    yield* installedPackages(path.join(full, 'node_modules'));
  }
}

function main() {
  const offenders = [];
  let checked = 0;
  for (const manifest of installedPackages('node_modules')) {
    checked++;
    const license = licenseOf(manifest);
    if (!isAllowed(license))
      offenders.push(`${manifest.name}@${manifest.version}: ${license || '(no license field)'}`);
  }
  if (checked === 0) {
    console.error('check-licenses: no installed packages found — run npm ci first');
    process.exit(2);
  }
  if (offenders.length > 0) {
    console.error(`check-licenses: ${offenders.length} package(s) outside the allowlist:`);
    for (const line of [...new Set(offenders)].sort()) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`check-licenses: ${checked} installed packages, all on the allowlist`);
}

if (import.meta.filename === path.resolve(process.argv[1] ?? '')) main();
