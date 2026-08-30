/**
 * Vendor ncdu, and the libraries it needs, into vendor/bin.
 *
 * Homebrew's ncdu links against Homebrew's own libncursesw and libzstd by
 * absolute path, so copying the binary alone produces something that runs on
 * exactly the machines that did not need it. This copies the dependency graph,
 * rewrites every non-system install name to @loader_path, and re-signs.
 *
 * The re-signing is not optional: install_name_tool rewrites the Mach-O, which
 * invalidates whatever signature it had, and arm64 macOS refuses to execute an
 * unsigned binary outright. An ad-hoc signature (`-`) is enough and needs no
 * developer account.
 *
 *   node build/bundle-ncdu.mjs [/path/to/ncdu]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_BIN = path.join(ROOT, 'vendor', 'bin');
const OUT_LIB = path.join(OUT_BIN, 'lib');

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

function which(name) {
  for (const p of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    const full = path.join(p, name);
    if (fs.existsSync(full)) return fs.realpathSync(full);
  }
  throw new Error(`${name} was not found. Install it first: brew install ${name}`);
}

/** Non-system libraries a Mach-O file loads. /usr/lib and /System are part of
 *  macOS and are never copied. */
function deps(file) {
  return sh('otool', ['-L', file])
    .split('\n').slice(1)
    .map((l) => l.trim().split(' ')[0])
    .filter((p) => p && !p.startsWith('/usr/lib/') && !p.startsWith('/System/'));
}

const copied = new Map();

/** Copy `src` into vendor/lib, recursively bringing in what it needs. */
function vendorLib(src) {
  const base = path.basename(src);
  if (copied.has(base)) return base;
  copied.set(base, true);
  const dest = path.join(OUT_LIB, base);
  fs.copyFileSync(fs.realpathSync(src), dest);
  fs.chmodSync(dest, 0o755);
  // A library's own id is what dependents record, so it has to be rewritten
  // too or the loader goes looking in Homebrew's prefix again.
  sh('install_name_tool', ['-id', `@loader_path/${base}`, dest]);
  for (const dep of deps(dest)) {
    if (path.basename(dep) === base) continue;
    const name = vendorLib(dep);
    sh('install_name_tool', ['-change', dep, `@loader_path/${name}`, dest]);
  }
  sign(dest);
  return base;
}

function sign(file) {
  sh('codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
}

const source = process.argv[2] || which('ncdu');
fs.rmSync(path.join(ROOT, 'vendor'), { recursive: true, force: true });
fs.mkdirSync(OUT_LIB, { recursive: true });

const dest = path.join(OUT_BIN, 'ncdu');
fs.copyFileSync(source, dest);
fs.chmodSync(dest, 0o755);

for (const dep of deps(dest)) {
  const name = vendorLib(dep);
  sh('install_name_tool', ['-change', dep, `@loader_path/lib/${name}`, dest]);
}
sign(dest);

const version = sh(dest, ['--version']).trim();
const arch = sh('lipo', ['-archs', dest]).trim();
console.log(`vendored ${version} (${arch}) from ${source}`);
console.log(`  ${dest}`);
for (const name of copied.keys()) console.log(`  ${path.join(OUT_LIB, name)}`);
