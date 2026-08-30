import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TreeStore, NcduParser } from './tree.js';
import { runElevated, UserCancelled } from './elevate.js';
import { APP_DIR, LAST_SCAN_PATH, DATA_VOLUME, shQuote } from './util.js';

/** A scan is considered wedged after this long with no new items. macOS can
 *  block openat() forever on a cache directory whose file provider is not
 *  answering -- no scanner can avoid it, so we surface it instead. */
const STALL_MS = 25_000;
const FIRST_PASS_MS = 3_000;   // quick sweep for suspects
const CONFIRM_MS = 12_000;     // patience before condemning one
const MAX_SURVEY_DEPTH = 2;    // sandbox containers gate at <app>/Data
const MAX_SURVEY_PROBES = 600; // hard cap: a Mac has hundreds of containers
const MAX_CONFIRMS = 80;       // and confirming each one costs seconds

const execFileP = promisify(execFile);

/**
 * Where ncdu is actually blocked.
 *
 * The export stream only tells us how far output got, which lags far behind
 * the walk -- naming that path would point the user at the wrong folder. The
 * open directory handles of the live process are the truth.
 */
export async function ncduOpenDir() {
  try {
    const { stdout: pidOut } = await execFileP('pgrep', ['-x', 'ncdu'], { timeout: 3000 });
    const pid = pidOut.trim().split('\n')[0];
    if (!pid) return null;
    const { stdout } = await execFileP('lsof', ['-p', pid, '-Ftn'], { maxBuffer: 1 << 22, timeout: 5000 });
    // Only numbered descriptors are directories ncdu opened while walking;
    // 'cwd' and 'rtd' are inherited from whoever launched it.
    //
    // The deepest one is the *highest* fd, because ncdu opens each directory
    // as it descends. Path length is not a usable proxy: firmlinks mean the
    // scan root "/System/Volumes/Data" is a longer string than the far deeper
    // "/Users/rohitshidid" beneath it.
    let fd = null;
    let type = null;
    let best = -1;
    let deepest = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('f')) { fd = line.slice(1); type = null; }
      else if (line.startsWith('t')) type = line.slice(1);
      else if (line.startsWith('n') && type === 'DIR' && /^\d+$/.test(fd ?? '')) {
        const p = line.slice(1);
        const num = Number(fd);
        if (p.startsWith('/') && num > best) { best = num; deepest = p; }
      }
    }
    return deepest;
  } catch {
    return null;
  }
}

/**
 * The exact folder a wedged scan is blocked on.
 *
 * lsof gives us the deepest directory ncdu still holds open -- which is the
 * *parent* of whatever it is blocked opening, since the blocked handle does
 * not exist yet. So we probe that parent's children with short-lived, killable
 * `ls` processes and return the one that does not come back.
 */
export async function findBlockedChild(parent, alreadyExcluded = []) {
  const names = await lsDir(parent, FIRST_PASS_MS);
  // If we cannot even list the parent, the parent is the blocker.
  if (names === null) return (await lsDir(parent, CONFIRM_MS)) === null ? parent : null;

  const skip = new Set(alreadyExcluded);
  const queue = names.map((n) => `${parent}/${n}`).filter((p) => !skip.has(p));

  // First pass: cheap and parallel, but a scan saturating the disk can make an
  // ordinary directory look slow, so treat these only as suspects.
  const suspects = [];
  const deadline = Date.now() + 15_000;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined || Date.now() > deadline) return;
      if (await lsDir(next, FIRST_PASS_MS) === null) suspects.push(next);
    }
  }));

  // Second pass: re-probe each suspect alone, with a much longer patience.
  // A genuinely blocked folder never returns; a merely slow one does. Without
  // this we would tell the user to skip folders that are perfectly fine, and
  // silently drop them from their totals.
  for (const suspect of suspects) {
    if (await lsDir(suspect, CONFIRM_MS) === null) return suspect;
  }
  return null;
}

/**
 * Sweep common hotspots for every folder that blocks, in one pass.
 *
 * Discovering these one stall at a time means one interruption per folder, and
 * on a machine with several cloud-backed group containers that is a lot of
 * interruptions. This finds them together so the user is asked once.
 */
export async function surveyBlockers(roots, { deadlineMs = 240_000 } = {}) {
  const deadline = Date.now() + deadlineMs;
  const blocked = [];
  const suspects = [];

  // Walk a couple of levels down. Sandbox containers put the gated folder one
  // level below the app's own directory (~/Library/Containers/<app>/Data), so
  // probing only the immediate children would miss every one of them.
  const seen = new Set();
  let probes = 0;
  for (const root of roots) {
    if (probes >= MAX_SURVEY_PROBES || Date.now() > deadline) break;
    const rootNames = await lsDir(root, FIRST_PASS_MS);
    if (rootNames === null) { suspects.push(root); continue; }
    const queue = rootNames.map((n) => ({ path: `${root}/${n}`, depth: 1 }));
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined || Date.now() > deadline) return;
        if (probes >= MAX_SURVEY_PROBES) return;
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        probes++;
        try { if (!(await fsp.lstat(item.path)).isDirectory()) continue; } catch { continue; }
        const names = await lsDir(item.path, FIRST_PASS_MS);
        if (names === null) { suspects.push(item.path); continue; }
        if (item.depth < MAX_SURVEY_DEPTH) {
          for (const n of names) queue.push({ path: `${item.path}/${n}`, depth: item.depth + 1 });
        }
      }
    }));
  }

  // Confirm the suspects. These probes spend their time blocked in a syscall
  // rather than doing work, so running them together costs nothing and keeps
  // a machine with thirty gated containers from taking six minutes.
  const pending = suspects.slice(0, MAX_CONFIRMS);
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (;;) {
      const suspect = pending.shift();
      if (suspect === undefined || Date.now() > deadline) return;
      if (await lsDir(suspect, CONFIRM_MS) === null) blocked.push(suspect);
    }
  }));
  blocked.sort();
  return { blocked, truncated: suspects.length > MAX_CONFIRMS || probes >= MAX_SURVEY_PROBES };
}

/**
 * List a directory in a killable subprocess.
 *
 * Never use fs.readdir here: on a folder macOS is withholding consent for, it
 * blocks forever with no timeout, which would wedge the very request that is
 * trying to explain the wedge. Returns null if the listing did not come back.
 */
function lsDir(dir, ms) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn('/bin/ls', ['-1f', dir], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    let out = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(null); }, ms);
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve([]);
      resolve(out.split('\n').filter((n) => n && n !== '.' && n !== '..'));
    });
  });
}

/** Folders macOS gates behind a privacy consent prompt. A process without
 *  that consent can block indefinitely instead of getting an error. */
const TCC_PROTECTED = [
  'Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Movies',
  'Library/Mail', 'Library/Messages', 'Library/Safari', 'Library/CloudStorage',
];

export function isPrivacyProtected(p) {
  if (!p) return false;
  return TCC_PROTECTED.some((f) => p.endsWith('/' + f) || p.includes('/' + f + '/'));
}

function findNcdu() {
  // The desktop build ships its own copy inside the .app bundle, so a user who
  // has never heard of Homebrew still gets a working scan. It wins over
  // anything installed, which also keeps the packaged app on a version it was
  // actually tested against.
  if (process.env.DM_NCDU && fs.existsSync(process.env.DM_NCDU)) return process.env.DM_NCDU;
  for (const p of ['/opt/homebrew/bin/ncdu', '/usr/local/bin/ncdu', '/usr/bin/ncdu']) {
    if (fs.existsSync(p)) return p;
  }
  try { return execFileSync('which', ['ncdu']).toString().trim(); } catch { return 'ncdu'; }
}
export const NCDU = findNcdu();

/** ncdu's command line. `-x` stays on one filesystem, `-e` records mtimes and
 *  read errors, `-0` keeps it quiet while it walks. */
export function ncduArgs({ root, outFile, excludes = [] }) {
  const args = ['-x', '-e', '-0'];
  for (const pattern of excludes) args.push('--exclude', pattern);
  args.push('-o', outFile, root);
  return args;
}

/**
 * Wrap ncdu in a shell loop that polls for a cancel sentinel.
 *
 * A root-owned ncdu cannot be signalled by this process, so Cancel is a file
 * the wrapper watches for rather than a signal we send. The same wrapper runs
 * for the unprivileged case, so there is only one code path to reason about.
 */
export function cancelWrapper(args, cancelFile) {
  return [
    `${shQuote(NCDU)} ${args.map(shQuote).join(' ')} &`,
    'NCPID=$!',
    `while kill -0 "$NCPID" 2>/dev/null; do`,
    `  if [ -f ${shQuote(cancelFile)} ]; then kill -TERM "$NCPID" 2>/dev/null || true; fi`,
    '  sleep 1',
    'done',
    'wait "$NCPID" 2>/dev/null || true',
    'exit 0',
  ].join('\n');
}

/**
 * Start ncdu and resolve when it has finished, elevated or not.
 *
 * ncdu exits non-zero whenever it met a directory it could not read, which on
 * any real Mac is most runs. The export is still complete and usable, so only
 * a missing export file is treated as a failure.
 */
export function runNcdu({ args, outFile, cancelFile, elevated = false, prompt, onChild }) {
  if (elevated) return runElevated(cancelWrapper(args, cancelFile), { prompt });
  return new Promise((resolve, reject) => {
    const child = spawn(NCDU, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    onChild?.(child);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      onChild?.(null);
      if (code !== 0 && !fs.existsSync(outFile)) reject(new Error(stderr.trim() || `ncdu exited with ${code}`));
      else resolve();
    });
  });
}

/**
 * Read newly-appended bytes of an export into the parser until `isDone()`.
 *
 * The export is tailed rather than piped because an elevated child cannot
 * stream through a pipe we own, and one code path then serves both cases.
 * `onGrow` fires on every read that returned bytes -- that, not the item
 * counter, is the liveness signal a stall detector wants.
 */
export async function tailExport(file, parser, isDone, { finalOnly = false, onGrow } = {}) {
  let offset = parser._tailOffset ?? 0;
  const buf = Buffer.allocUnsafe(1 << 20);
  for (;;) {
    let fh;
    try { fh = await fsp.open(file, 'r'); } catch { if (isDone()) break; await sleep(200); continue; }
    try {
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        onGrow?.();
        parser.write(Buffer.from(buf.subarray(0, bytesRead)));
      }
    } finally { await fh.close(); }
    parser._tailOffset = offset;
    if (finalOnly || isDone()) break;
    await sleep(200);
  }
  parser._tailOffset = offset;
}

/**
 * Runs ncdu and stream-parses its export while it is still being written.
 *
 * ncdu flushes its JSON as it walks, so tailing the export file gives live
 * progress for both the plain and the elevated run -- and the same code path
 * serves both, since an elevated child can't stream through a pipe we own.
 */
export class Scanner {
  constructor() {
    this.reset();
  }

  reset() {
    this.status = 'idle';       // idle | scanning | ready | error | cancelled
    this.root = DATA_VOLUME;
    this.elevated = false;
    this.items = 0;
    this.bytes = 0;
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
    this.tree = null;
    this._child = null;
    this._cancel = false;
    this._parser = null;
    this._partial = null;
    this._lastChangeAt = null;
    this._lastItems = 0;
    this.excludes = [];
  }

  /** Path the scan is sitting on, for the stall warning. */
  currentPath() {
    if (!this._parser || !this._partial) return null;
    const idx = this._parser.currentDir();
    return idx >= 0 ? this._partial.pathOf(idx) : null;
  }

  stalledMs() {
    if (this.status !== 'scanning' || !this._lastChangeAt) return 0;
    const ms = Date.now() - this._lastChangeAt;
    return ms > STALL_MS ? ms : 0;
  }

  progress() {
    return {
      status: this.status,
      root: this.root,
      elevated: this.elevated,
      items: this.items,
      bytes: this.bytes,
      elapsedMs: this.startedAt ? (this.finishedAt ?? Date.now()) - this.startedAt : 0,
      error: this.error,
      readErrors: this.tree?.readErrors ?? 0,
      truncated: this.tree?.truncated ?? false,
      stalledMs: this.stalledMs(),
      stalledAt: this.stalledMs() ? (this.stallPath ?? this.currentPath()) : null,
      stalledPrivacy: this.stalledMs() ? !!this.stallPrivacy : false,
      excludes: this.excludes,
      totalBytes: this.tree && this.status === 'ready' ? this.tree.subD[0] : 0,
      totalItems: this.tree && this.status === 'ready' ? this.tree.subItems[0] : 0,
      scannedAt: this.tree?.scannedAt ?? null,
      hasCachedScan: fs.existsSync(LAST_SCAN_PATH),
    };
  }

  cancel() {
    this._cancel = true;
    // The unprivileged child we can signal directly; a root-owned ncdu is
    // stopped by the wrapper script, which polls for this sentinel file.
    try { fs.writeFileSync(this._cancelFile ?? CANCEL_FILE, ''); } catch {}
    if (this._child) { try { this._child.kill('SIGTERM'); } catch {} }
  }

  async start({ root = DATA_VOLUME, elevated = false, excludes = [] } = {}) {
    if (this.status === 'scanning') throw new Error('A scan is already running.');
    this.reset();
    this.status = 'scanning';
    this.root = root;
    this.elevated = elevated;
    this.excludes = excludes;
    this.startedAt = Date.now();
    this._lastChangeAt = Date.now();
    this._cancelFile = CANCEL_FILE;
    await fsp.rm(CANCEL_FILE, { force: true }).catch(() => {});

    await fsp.mkdir(APP_DIR, { recursive: true });
    await fsp.rm(LAST_SCAN_PATH, { force: true });
    // Pre-create world-readable so we can tail an export written by root:
    // ncdu opens with O_TRUNC, which keeps the existing mode.
    await fsp.writeFile(LAST_SCAN_PATH, '', { mode: 0o666 });

    const args = ncduArgs({ root, outFile: LAST_SCAN_PATH, excludes });
    const run = runNcdu({
      args, outFile: LAST_SCAN_PATH, cancelFile: CANCEL_FILE, elevated,
      prompt: `Disk Manager needs administrator access to scan ${root} completely. Without it, folders owned by other users or by the system are skipped.`,
      onChild: (c) => { this._child = c; },
    });

    const tree = new TreeStore(1 << 18);
    const parser = new NcduParser(tree, {
      onProgress: ({ items, bytes }) => {
        this.items = items;
        this.bytes = bytes;
        if (items !== this._lastItems) { this._lastItems = items; this._lastChangeAt = Date.now(); }
      },
    });
    this._parser = parser;
    this._partial = tree;

    let done = false;
    const runner = run.then(() => { done = true; }, (err) => { done = true; throw err; });

    try {
      await this._tail(LAST_SCAN_PATH, parser, () => done || this._cancel);
      await runner;
      if (this._cancel) { this.status = 'cancelled'; this.finishedAt = Date.now(); return this.progress(); }
      // Drain anything written between the last poll and process exit.
      await this._tail(LAST_SCAN_PATH, parser, () => true, true);
      parser.end();
      tree.aggregate();
      tree.scannedAt = new Date().toISOString();
      tree.rootPath = root;
      this.tree = tree;
      this.items = parser.count;
      this.status = 'ready';
    } catch (err) {
      this.status = err instanceof UserCancelled ? 'cancelled' : 'error';
      this.error = err.message;
    } finally {
      this.finishedAt = Date.now();
    }
    return this.progress();
  }

  /** Tail the export, treating any growth in it as proof the scan is alive.
   *  That is the real liveness signal: the item counter only ticks every 20k
   *  items, so a slow region of very large files would otherwise be
   *  indistinguishable from a folder that blocks forever. */
  _tail(file, parser, isDone, finalOnly = false) {
    return tailExport(file, parser, isDone, {
      finalOnly,
      onGrow: () => { this._lastChangeAt = Date.now(); },
    });
  }

  /** Re-parse the export from the previous run -- far faster than rescanning. */
  async loadCached() {
    if (!fs.existsSync(LAST_SCAN_PATH)) throw new Error('No previous scan is saved.');
    this.reset();
    this.status = 'scanning';
    this.startedAt = Date.now();
    const tree = new TreeStore(1 << 18);
    const parser = new NcduParser(tree, {
      onProgress: ({ items, bytes }) => { this.items = items; this.bytes = bytes; },
    });
    try {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(LAST_SCAN_PATH);
        rs.on('data', (c) => parser.write(c));
        rs.on('end', resolve);
        rs.on('error', reject);
      });
      parser.end();
      tree.aggregate();
      const st = await fsp.stat(LAST_SCAN_PATH);
      tree.scannedAt = st.mtime.toISOString();
      tree.rootPath = tree.n ? tree.name(0) : DATA_VOLUME;
      this.root = tree.rootPath;
      this.tree = tree;
      this.items = parser.count;
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
    } finally {
      this.finishedAt = Date.now();
    }
    return this.progress();
  }
}

const CANCEL_FILE = path.join(APP_DIR, '.scan-cancel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
