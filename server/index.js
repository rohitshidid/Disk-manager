import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { Scanner, ncduOpenDir, findBlockedChild, isPrivacyProtected, surveyBlockers } from './scanner.js';
import { FolderRefresher } from './refresh.js';
import { Quarantine } from './quarantine.js';
import { DupeFinder } from './dupes.js';
import { trashMany, eraseMany, USER_TRASH } from './dispose.js';
import { findJunk } from './junk.js';
import { assess } from './safety.js';
import { F_ERR } from './tree.js';
import { DATA_VOLUME, HOME, APP_DIR, canonical, underDataVolume, diskUsage, execFileAsync, formatBytes, nowIso, QUARANTINE_DIR } from './util.js';

/** Folders the user chose to skip because a scan wedged inside them. macOS
 *  can block openat() indefinitely on a cache whose provider is unresponsive,
 *  so these are remembered and reapplied to every later scan. */
const EXCLUDES_PATH = path.join(APP_DIR, 'excludes.json');
function loadExcludes() {
  try {
    const list = JSON.parse(fs.readFileSync(EXCLUDES_PATH, 'utf8'));
    return Array.isArray(list) ? list.filter(isSkippable) : [];
  } catch { return []; }
}

/**
 * Collapse a mostly-blocked directory into one entry.
 *
 * Without Full Disk Access essentially every ~/Library/Group Containers child
 * blocks, which would mean dozens of near-identical excludes. Those children
 * are unmeasurable either way, so naming the parent once loses nothing and
 * keeps both the skip list and ncdu's command line readable.
 */
function condenseBlockers(found) {
  const byParent = new Map();
  for (const p of found) {
    const dir = path.dirname(p);
    if (!byParent.has(dir)) byParent.set(dir, []);
    byParent.get(dir).push(p);
  }
  const collapsed = new Set();
  const out = [];
  for (const [parent, kids] of byParent) {
    if (kids.length < 5 || !isSkippable(parent)) continue;
    let subdirs = 0;
    try {
      subdirs = fs.readdirSync(parent, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    } catch { continue; }
    if (subdirs && kids.length / subdirs >= 0.6) { collapsed.add(parent); out.push(parent); }
  }
  for (const p of found) if (!collapsed.has(path.dirname(p))) out.push(p);
  return out;
}

/** An exclude must never be able to blank out the whole scan. Anything at or
 *  above a volume root would make every future scan come back empty. */
function isSkippable(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return false;
  const clean = p.replace(/\/+$/, '') || '/';
  const forbidden = new Set(['/', DATA_VOLUME, canonical(DATA_VOLUME), '/Users', '/System', '/System/Volumes']);
  if (forbidden.has(clean)) return false;
  // Also reject any ancestor of the data volume path.
  return !(DATA_VOLUME + '/').startsWith(clean + '/');
}
function saveExcludes(list) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(EXCLUDES_PATH, JSON.stringify(list, null, 2));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

/** Anything that can delete files should not be reachable from a random web
 *  page that resolves a hostname to 127.0.0.1. The token is minted per run and
 *  handed only to the page we serve ourselves. */
const TOKEN = crypto.randomBytes(24).toString('hex');

const scanner = new Scanner();
const dupes = new DupeFinder();
const refresher = new FolderRefresher();
const quarantine = await new Quarantine().init();
const markedNodes = new Set();
/**
 * Paths whose file is gone for good as far as this app is concerned -- moved
 * to the macOS Trash or erased outright. Unlike quarantined items these can
 * never come back on their own, so syncTree() must not un-mark them.
 *
 * Paths rather than node indices, because a per-folder refresh appends the
 * newly measured nodes and detaches the old ones: an index taken before it
 * would afterwards address a stale branch, and the subtraction would be
 * applied to a part of the tree nobody can see. A path survives the splice,
 * and resolving it again is one cached lookup.
 */
const gonePaths = new Set();
/**
 * What this run has handed to the macOS Trash.
 *
 * Deliberately in memory only. Finder owns these files now: the user can empty
 * the Trash, or put an item back, without telling us. A list that outlived the
 * process would start making promises about a Trash it no longer knows
 * anything about — so it is scoped to the session that created it, and says so.
 */
const trashedThisRun = [];
function recordTrashed(items) {
  for (const it of items) trashedThisRun.unshift({ ...it, at: nowIso() });
  if (trashedThisRun.length > 500) trashedThisRun.length = 500;
}

let lastSweep = [];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

/** Keep the tree's visible sizes in step with what is currently quarantined. */
function syncTree() {
  const tree = scanner.tree;
  if (!tree) return;
  const desired = new Set();
  for (const p of gonePaths) {
    const idx = tree.findByPath(p);
    if (idx > 0) desired.add(idx);
  }
  for (const e of quarantine.live()) {
    const idx = tree.findByPath(e.realPath);
    if (idx > 0) desired.add(idx);
  }
  for (const idx of markedNodes) {
    if (!desired.has(idx)) { tree.markDeleted(idx, false); markedNodes.delete(idx); }
  }
  for (const idx of desired) {
    if (!markedNodes.has(idx)) { tree.markDeleted(idx, true); markedNodes.add(idx); }
  }
}

/** Record that these paths have left the disk, so the tree stops counting
 *  them. Their bytes are already back -- unlike a quarantined item, there is
 *  nothing left to purge. */
function markGone(realPaths) {
  for (const p of realPaths) gonePaths.add(p);
  syncTree();
}

function nodeView(tree, idx, parentSize) {
  return {
    name: tree.name(idx),
    path: tree.displayPath(idx),
    realPath: tree.pathOf(idx),
    size: tree.subD[idx],
    apparent: tree.subA[idx],
    items: tree.subItems[idx],
    isDir: tree.isDir(idx),
    deleted: tree.isDeleted(idx),
    unreadable: (tree.flags[idx] & F_ERR) !== 0,
    mtime: tree.subMtime[idx] || null,
    ownMtime: tree.mtime[idx] || null,
    share: parentSize > 0 ? tree.subD[idx] / parentSize : 0,
  };
}

/**
 * Bounds on the "Last used" rollup.
 *
 * A directory's own atime records when its entry list was read, not when
 * anything inside it was opened, so what gets shown is the newest atime in the
 * whole subtree. Unlike the mtime rollup, that cannot come from the scan —
 * ncdu does not export atime — so it costs one `lstat` per descendant, which
 * is unbounded on something like `node_modules`.
 *
 * Hence three ceilings: a deadline for the whole listing, a stat budget for
 * the whole listing, and a cap on what any single folder may spend. A row that
 * hit one of them is returned as approximate and the UI marks it with a `~`.
 */
const ATIME_DEADLINE_MS = 4000;
const ATIME_TOTAL_STATS = 30_000;
const ATIME_ROW_STATS = 5_000;
const ATIME_CONCURRENCY = 32;

/**
 * Newest access time at or under `idx`.
 *
 * Descendants come from the tree, never from `readdir` — that is invariant 1,
 * and it also makes the walk itself free, since the scan already knows what is
 * in there. The only cost is the `lstat` calls.
 */
async function newestAtime(tree, idx, ctx) {
  const cap = Math.min(ATIME_ROW_STATS, ctx.budget);
  const paths = [];
  let approx = false;

  if (tree.isDir(idx)) {
    const stack = [idx];
    while (stack.length) {
      if (paths.length >= cap) { approx = true; break; }
      const i = stack.pop();
      paths.push(tree.pathOf(i));
      for (let c = tree.firstChild[i]; c !== -1; c = tree.nextSib[c]) {
        if (!tree.isDeleted(c)) stack.push(c);
      }
    }
  } else {
    paths.push(tree.pathOf(idx));
  }

  let newest = 0;
  let used = 0;
  for (let i = 0; i < paths.length; i += ATIME_CONCURRENCY) {
    if (Date.now() > ctx.deadline) { approx = true; break; }
    const chunk = paths.slice(i, i + ATIME_CONCURRENCY);
    const times = await Promise.all(chunk.map((p) => fsp.lstat(p).then((st) => st.atimeMs, () => 0)));
    used += chunk.length;
    for (const ms of times) {
      const secs = Math.floor(ms / 1000);
      if (secs > newest) newest = secs;
    }
  }
  return { atime: newest || null, approx, used };
}

/**
 * Last-used dates for the visible rows.
 *
 * The whole thing races a deadline. `lstat` has no timeout and a path whose
 * provider is unresponsive blocks forever, so the guarantee here is only that
 * the *listing* returns — a wedged stat is abandoned, not cancelled. Rows that
 * were never reached keep `atime: null`, which reads as "—".
 */
async function withAtimes(rows, idxs) {
  const tree = scanner.tree;
  for (const r of rows) { r.atime = null; r.atimeApprox = false; }
  if (!tree) return rows;

  const ctx = { deadline: Date.now() + ATIME_DEADLINE_MS, budget: ATIME_TOTAL_STATS };
  const work = (async () => {
    for (let k = 0; k < Math.min(rows.length, 600); k++) {
      if (Date.now() > ctx.deadline || ctx.budget <= 0) break;
      const res = await newestAtime(tree, idxs[k], ctx);
      rows[k].atime = res.atime;
      rows[k].atimeApprox = res.approx;
      ctx.budget -= res.used;
    }
  })();

  await Promise.race([work, new Promise((r) => setTimeout(r, ATIME_DEADLINE_MS))]);
  return rows;
}

/**
 * Work out what a wedged scan is stuck on, at most once per stall episode.
 *
 * This runs in the background and is never awaited: the diagnosis spawns
 * probe processes and can take seconds, while the UI polls state twice a
 * second. The answer simply appears on a later poll.
 */
function maybeDiagnoseStall() {
  if (!(scanner.status === 'scanning' && scanner.stalledMs())) {
    scanner.stallPath = null;
    scanner.stallPrivacy = false;
    scanner._diagnosedAt = 0;
    return;
  }
  const now = Date.now();
  if (scanner._diagnosing) return;
  if (scanner.stallPath && now - (scanner._diagnosedAt || 0) < 30_000) return;
  scanner._diagnosing = true;
  (async () => {
    const parent = await ncduOpenDir();
    if (!parent) return null;
    // If no child is confirmed blocked, report nothing rather than blaming the
    // folder ncdu simply happens to be inside.
    return findBlockedChild(parent, loadExcludes());
  })()
    .then((p) => {
      if (scanner.status === 'scanning' && scanner.stalledMs()) {
        scanner.stallPath = p;
        scanner.stallPrivacy = isPrivacyProtected(p);
        scanner._diagnosedAt = Date.now();
      }
    })
    .catch(() => {})
    .finally(() => { scanner._diagnosing = false; });
}

async function baseState() {
  // Only ask the OS where ncdu is sitting once a scan actually looks wedged.
  maybeDiagnoseStall();
  const disk = await diskUsage(DATA_VOLUME).catch(() => null);
  const q = quarantine.summary();
  return {
    scan: scanner.progress(),
    refresh: refresher.progress(),
    quarantine: q,
    disk: disk && {
      ...disk,
      availAfterPurge: disk.avail + q.reclaimable.bytes,
    },
    trashed: trashedThisRun,
    home: canonical(HOME),
    excludes: loadExcludes(),
    dataVolume: DATA_VOLUME,
    quarantineDir: canonical(QUARANTINE_DIR),
  };
}

/**
 * Disk usage of a directory tree, for paths the scan does not know about.
 *
 * Asynchronous on purpose. `du` on a freshly created `node_modules` can take
 * seconds, and this runs inside a request handler -- a synchronous version
 * stopped the whole server, including the poll that draws the progress bar,
 * for exactly as long as the measurement took.
 */
async function measureDir(p) {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', '-x', p], { maxBuffer: 1 << 20 });
    return Number(stdout.trim().split(/\s+/)[0]) * 1024 || 0;
  } catch {
    return 0;
  }
}

/** Turn the client's list of paths into delete targets with real sizes. */
async function resolveTargets(paths) {
  const tree = scanner.tree;
  const targets = [];
  const unknown = [];
  for (const p of paths) {
    const idx = tree ? tree.findByPath(p) : -1;
    if (idx > 0) {
      targets.push({
        realPath: tree.pathOf(idx), dsize: tree.subD[idx], asize: tree.subA[idx],
        items: tree.subItems[idx], isDir: tree.isDir(idx),
      });
    } else {
      // Not in the scan -- created or renamed since. Measure it directly, or
      // the reclaim total would report zero for a whole directory tree.
      try {
        const st = fs.lstatSync(p);
        const isDir = st.isDirectory();
        const measured = isDir ? await measureDir(p) : 0;
        targets.push({
          realPath: p,
          dsize: isDir ? measured : st.blocks * 512,
          asize: isDir ? measured : st.size,
          items: 0,
          isDir,
        });
      } catch { unknown.push({ path: p, reason: 'Not found on disk.' }); }
    }
  }
  return { targets, unknown };
}

const routes = {
  'GET /api/state': async (_req, res) => json(res, 200, await baseState()),

  'POST /api/scan': async (req, res, body) => {
    if (scanner.status === 'scanning') return json(res, 409, { error: 'A scan is already running.' });
    const root = body.root || DATA_VOLUME;
    markedNodes.clear();
    gonePaths.clear();
    scanner
      .start({ root, elevated: !!body.elevated, excludes: loadExcludes() })
      .then(() => { syncTree(); })
      .catch((err) => { scanner.status = 'error'; scanner.error = err.message; });
    json(res, 202, await baseState());
  },

  'POST /api/scan/cached': async (_req, res) => {
    markedNodes.clear();
    gonePaths.clear();
    await scanner.loadCached();
    syncTree();
    json(res, 200, await baseState());
  },

  'POST /api/scan/cancel': async (_req, res) => { scanner.cancel(); json(res, 200, { ok: true }); },

  /** Remember a folder to skip, then start a fresh scan without it. */
  'POST /api/scan/skip': async (req, res, body) => {
    const p = body.path;
    if (typeof p !== 'string' || !p) return json(res, 400, { error: 'No path given.' });
    if (!isSkippable(p)) {
      return json(res, 400, { error: `${p} is the scan root — excluding it would leave nothing to scan.` });
    }
    // lsof reports firmlinked paths (/Users/...) while ncdu walks the volume
    // path (/System/Volumes/Data/Users/...). Register both so the exclude bites.
    const list = loadExcludes();
    for (const form of new Set([p, canonical(p), underDataVolume(canonical(p))])) {
      if (form && isSkippable(form) && !list.includes(form)) list.push(form);
    }
    saveExcludes(list);
    scanner.cancel();
    // Wait for the wrapper to actually reap ncdu; starting while the previous
    // scan is still winding down would reject, and an uncaught rejection here
    // would take the whole server down.
    (async () => {
      for (let i = 0; i < 60 && scanner.status === 'scanning'; i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      markedNodes.clear();
      gonePaths.clear();
      scanner
        .start({ root: body.root || DATA_VOLUME, elevated: !!body.elevated, excludes: list })
        .then(() => { syncTree(); })
        .catch((err) => { scanner.status = 'error'; scanner.error = err.message; });
    })();
    json(res, 202, { ok: true, excludes: list });
  },

  /**
   * Find every folder that blocks, in one sweep.
   *
   * This only reports; it does not change the skip list. When macOS is gating
   * dozens of folders, skipping them all would leave large holes in the
   * totals, and the user should be told to grant access instead of having
   * that decision made for them.
   */
  'POST /api/scan/find-blockers': async (_req, res) => {
    const home = canonical(HOME);
    const roots = [
      home,
      path.join(home, 'Library'),
      path.join(home, 'Library', 'Group Containers'),
      path.join(home, 'Library', 'Containers'),
    ];
    const { blocked, truncated } = await surveyBlockers(roots);
    const found = condenseBlockers(blocked);
    lastSweep = found;
    json(res, 200, {
      found: found.map((p) => ({ path: canonical(p), privacy: isPrivacyProtected(p) })),
      truncated,
      recommendFullDiskAccess: found.length > 25 || truncated,
      applied: false,
    });
  },

  /** Commit the folders the last sweep found to the skip list. */
  'POST /api/scan/apply-blockers': async (_req, res) => {
    const list = loadExcludes();
    let added = 0;
    for (const p of lastSweep) {
      for (const form of new Set([p, canonical(p), underDataVolume(canonical(p))])) {
        if (form && isSkippable(form) && !list.includes(form)) { list.push(form); added++; }
      }
    }
    saveExcludes(list);
    json(res, 200, { added, excludes: loadExcludes() });
  },

  /**
   * Overwrite the skip list.
   *
   * Every entry here is a hole in the totals, so this is the one place a user
   * can see them all and take one back out. `rescan` is offered because a
   * removed exclude changes nothing until the volume is measured again.
   */
  'POST /api/excludes': async (req, res, body) => {
    saveExcludes(Array.isArray(body.excludes) ? body.excludes.filter(isSkippable) : []);
    const list = loadExcludes();
    if (body.rescan && scanner.status !== 'scanning') {
      markedNodes.clear();
      gonePaths.clear();
      scanner
        .start({ root: DATA_VOLUME, elevated: !!body.elevated, excludes: list })
        .then(() => { syncTree(); })
        .catch((err) => { scanner.status = 'error'; scanner.error = err.message; });
    }
    json(res, 200, { excludes: list, rescanning: !!body.rescan });
  },

  /**
   * Re-measure one folder and splice the result into the live tree.
   *
   * The alternative is a full rescan, which on this volume is minutes; a
   * folder is seconds. Every ancestor total, the treemap and the status bar
   * still come out right, because `spliceSubtree()` carries the difference up
   * to the root.
   */
  'POST /api/refresh': async (req, res, body) => {
    const tree = scanner.tree;
    if (!tree) return json(res, 409, { error: 'Nothing scanned yet.' });
    if (scanner.status === 'scanning') return json(res, 409, { error: 'A full scan is already running.' });
    if (refresher.status === 'running') return json(res, 409, { error: 'A refresh is already running.' });
    const target = body.path;
    if (typeof target !== 'string' || !target) return json(res, 400, { error: 'No path given.' });
    const idx = tree.findByPath(target);
    if (idx < 0) return json(res, 404, { error: `${target} is not in the current scan.` });
    // Every rejection has to be answered here, before start() is called.
    // FolderRefresher validates too, but it throws before it has touched its
    // own state, so a refusal raised in there would leave `progress()`
    // reporting whatever the *previous* refresh did -- and a client polling
    // for completion would read that stale `ready` as this refresh finishing.
    if (idx === 0) return json(res, 400, { error: 'This is the scan root — use Scan disk to measure the whole volume again.' });
    if (!tree.isDir(idx)) return json(res, 400, { error: 'Only folders can be refreshed.' });
    // A folder sitting in the bin has had its bytes subtracted from every
    // ancestor already. Re-measuring it would splice a delta on top of that
    // subtraction and leave the totals doubly wrong, and the answer would be
    // meaningless anyway: the folder is not where the user is looking at it.
    if (tree.isDeleted(idx)) {
      return json(res, 409, { error: 'That folder is in the bin. Restore it first, or refresh its parent.' });
    }

    refresher
      .start(tree, { path: target, elevated: !!body.elevated, excludes: loadExcludes() })
      .then(() => {
        // Marks inside the replaced branch are now stale indices; syncTree()
        // drops them (harmlessly -- a detached node bubbles into nothing) and
        // re-derives the live ones from the manifest.
        syncTree();
      })
      .catch((err) => {
        // start() records its own failures; this is the belt-and-braces case
        // where something threw before it could, so that a poll can never see
        // an older run's `ready` and call this refresh a success.
        if (refresher.status !== 'error' && refresher.status !== 'cancelled') {
          refresher.status = 'error';
          refresher.error = err.message;
        }
      });

    json(res, 202, { ok: true, refresh: refresher.progress() });
  },

  'POST /api/refresh/cancel': async (_req, res) => { refresher.cancel(); json(res, 200, { ok: true }); },

  'GET /api/dir': async (req, res, _b, url) => {
    const tree = scanner.tree;
    if (!tree) return json(res, 409, { error: 'Nothing scanned yet.' });
    const target = url.searchParams.get('path') || tree.displayPath(0);
    const idx = tree.findByPath(target);
    if (idx < 0) return json(res, 404, { error: `${target} is not in the current scan.` });
    if (!tree.isDir(idx)) return json(res, 400, { error: 'Not a directory.' });

    const size = tree.subD[idx];
    const kids = tree.children(idx)
      .filter((c) => !tree.isDeleted(c))
      .sort((a, b) => tree.subD[b] - tree.subD[a]);
    const LIMIT = 1000;
    const shown = kids.slice(0, LIMIT);
    const rows = shown.map((c) => nodeView(tree, c, size));
    await withAtimes(rows, shown);

    const crumbs = [];
    for (let cur = idx; cur >= 0; cur = tree.parent[cur]) {
      crumbs.push({ name: cur === 0 ? tree.displayPath(0) : tree.name(cur), path: tree.displayPath(cur) });
      if (cur === 0) break;
    }
    json(res, 200, {
      node: nodeView(tree, idx, tree.subD[0]),
      children: rows,
      truncated: kids.length > LIMIT ? kids.length - LIMIT : 0,
      crumbs: crumbs.reverse(),
      rootPath: tree.displayPath(0),
    });
  },

  'GET /api/search': async (req, res, _b, url) => {
    const tree = scanner.tree;
    if (!tree) return json(res, 409, { error: 'Nothing scanned yet.' });
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const minSize = Number(url.searchParams.get('min') || 0);
    const olderDays = Number(url.searchParams.get('olderDays') || 0);
    const dirsOnly = url.searchParams.get('dirsOnly') === '1';
    if (!q && !minSize && !olderDays) return json(res, 200, { results: [] });
    const cutoff = olderDays ? Math.floor(Date.now() / 1000) - olderDays * 86400 : 0;

    const hits = [];
    for (let i = 1; i < tree.n; i++) {
      // A refresh leaves the branch it replaced in the arrays, unlinked from
      // the root. Anything walking by index rather than by child links has to
      // step over it, or the same folder is reported twice at two sizes.
      if (tree.isStale(i)) continue;
      if (tree.isDeleted(i)) continue;
      if (dirsOnly && !tree.isDir(i)) continue;
      if (tree.subD[i] < minSize) continue;
      if (cutoff && (!tree.subMtime[i] || tree.subMtime[i] > cutoff)) continue;
      if (q && !tree.name(i).toLowerCase().includes(q)) continue;
      hits.push(i);
      if (hits.length > 20000) break;
    }
    hits.sort((a, b) => tree.subD[b] - tree.subD[a]);
    const rows = hits.slice(0, 300).map((i) => nodeView(tree, i, tree.subD[0]));
    json(res, 200, { results: rows, total: hits.length });
  },

  'GET /api/junk': async (_req, res) => {
    const tree = scanner.tree;
    if (!tree) return json(res, 409, { error: 'Nothing scanned yet.' });
    json(res, 200, findJunk(tree));
  },

  'POST /api/dupes': async (req, res, body) => {
    const tree = scanner.tree;
    if (!tree) return json(res, 409, { error: 'Nothing scanned yet.' });
    if (dupes.status === 'running') return json(res, 409, { error: 'Already running.' });
    dupes.start(tree, {
      rootPath: body.rootPath || canonical(HOME),
      minSize: Number(body.minSize) || 1024 * 1024,
    });
    json(res, 202, dupes.progress());
  },
  'GET /api/dupes': async (_req, res) => json(res, 200, dupes.progress()),
  'POST /api/dupes/cancel': async (_req, res) => { dupes.cancel(); json(res, 200, { ok: true }); },

  'POST /api/assess': async (req, res, body) => {
    const { targets, unknown } = await resolveTargets(body.paths || []);
    const verdicts = targets.map((t) => ({
      path: canonical(t.realPath), size: t.dsize, items: t.items,
      ...assess(t.realPath, { size: t.dsize, items: t.items }),
    }));
    json(res, 200, {
      verdicts, unknown,
      totalSize: targets.reduce((a, t) => a + t.dsize, 0),
      totalItems: targets.reduce((a, t) => a + t.items + 1, 0),
    });
  },

  'POST /api/delete': async (req, res, body) => {
    const { targets, unknown } = await resolveTargets(body.paths || []);
    const result = await quarantine.deleteMany(targets, { force: !!body.force });
    syncTree();
    json(res, 200, { ...result, rejected: [...result.rejected, ...unknown], state: await baseState() });
  },

  /**
   * Move a batch to the macOS Trash.
   *
   * Unlike /api/delete this does not stage anything in the quarantine: the
   * items go straight to Finder's Trash, which is where the user expects to
   * find and empty them. There is no undo on this side of the handover, so the
   * bytes are already reclaimed and nothing is added to the purge total.
   */
  'POST /api/trash': async (req, res, body) => {
    const { targets, unknown } = await resolveTargets(body.paths || []);
    const result = await trashMany(targets, { force: !!body.force });
    markGone(result.moved.map((m) => m.realPath));
    recordTrashed(result.moved);
    json(res, 200, {
      moved: result.moved.map((m) => m.path), bytes: result.bytes,
      rejected: [...result.rejected, ...unknown], state: await baseState(),
    });
  },

  /** Erase a batch outright — no Trash, no bin. Irreversible. */
  'POST /api/erase': async (req, res, body) => {
    const { targets, unknown } = await resolveTargets(body.paths || []);
    const result = await eraseMany(targets, { force: !!body.force });
    markGone(result.erased.map((m) => m.realPath));
    json(res, 200, {
      erased: result.erased.map((m) => m.path), bytes: result.bytes,
      rejected: [...result.rejected, ...unknown], state: await baseState(),
    });
  },

  /** Hand bin items over to the macOS Trash — they leave this app's custody. */
  'POST /api/bin/trash': async (req, res, body) => {
    const r = await quarantine.trash(body.ids || []);
    // These leave quarantine.live(), so without this syncTree() would decide
    // they were never deleted and hand their bytes back to the tree totals.
    markGone(r.realPaths || []);
    recordTrashed(r.moved || []);
    json(res, 200, { ...r, state: await baseState() });
  },

  'POST /api/undo': async (_req, res) => {
    const r = await quarantine.undo();
    syncTree();
    json(res, 200, { ...r, state: await baseState() });
  },
  'POST /api/redo': async (_req, res) => {
    const r = await quarantine.redo();
    syncTree();
    json(res, 200, { ...r, state: await baseState() });
  },
  'POST /api/restore': async (req, res, body) => {
    const r = await quarantine.restore(body.ids || []);
    syncTree();
    json(res, 200, { ...r, state: await baseState() });
  },
  'POST /api/purge': async (req, res, body) => {
    const r = await quarantine.purge(body.ids || []);
    markGone(r.realPaths || []);
    json(res, 200, { ...r, state: await baseState() });
  },

  /** Open the Full Disk Access pane so the user can grant consent. */
  'POST /api/privacy-settings': async (_req, res) => {
    spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], { stdio: 'ignore' }).unref();
    json(res, 200, { ok: true });
  },

  /** Open the Trash in Finder, so the record has somewhere to point. */
  'POST /api/open-trash': async (_req, res) => {
    spawn('open', [USER_TRASH], { stdio: 'ignore' }).unref();
    json(res, 200, { ok: true });
  },

  /**
   * Quick Look a path, the way the space bar does in Finder.
   *
   * `qlmanage -p` is the supported way in. It is spawned detached and never
   * awaited: the process lives as long as the preview window does, which is
   * the user's business, not the request's.
   */
  'POST /api/quicklook': async (req, res, body) => {
    const p = body.path;
    if (typeof p !== 'string' || !fs.existsSync(p)) return json(res, 404, { error: 'Not found on disk.' });
    spawn('qlmanage', ['-p', p], { stdio: 'ignore', detached: true }).unref();
    json(res, 200, { ok: true });
  },

  'POST /api/reveal': async (req, res, body) => {
    const p = body.path;
    if (typeof p !== 'string' || !fs.existsSync(p)) return json(res, 404, { error: 'Not found on disk — the scan may be stale.' });
    spawn('open', ['-R', p], { stdio: 'ignore' }).unref();
    json(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (req.headers['x-dm-token'] !== TOKEN) return json(res, 401, { error: 'Bad or missing token. Reload the page.' });
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return json(res, 404, { error: 'No such endpoint.' });
    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(res, 400, { error: 'Bad JSON.' }); } }
    }
    try { await handler(req, res, body, url); }
    catch (err) { if (!res.headersSent) json(res, 500, { error: err.message }); }
    return;
  }

  // Static files
  let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) { res.writeHead(404).end('Not found'); return; }
  let content = await fsp.readFile(full);
  if (file === 'index.html') content = Buffer.from(content.toString().replace('__TOKEN__', TOKEN));
  res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(content);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});

const basePort = Number(process.env.PORT) || 4173;
function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) return listen(port + 1, attempt + 1);
    console.error(err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${port}/`;
    // The desktop build does not know the port in advance -- the server walks
    // up from 4173 until it finds a free one -- so it is announced on stdout
    // in a form a parent process can match. Gated, because a person reading
    // the terminal should not have to look at it.
    if (process.env.DM_ANNOUNCE === '1') console.log(`DM_READY ${url}`);
    const q = quarantine.reclaimable();
    console.log(`\n  Disk Manager  →  ${url}\n`);
    console.log(`  scan root      ${DATA_VOLUME}  (the volume holding your real data)`);
    console.log(`  quarantine     ${QUARANTINE_DIR}`);
    if (q.count) console.log(`  in quarantine  ${q.count} item(s), ${formatBytes(q.bytes)} reclaimable on purge`);
    console.log('\n  Press Ctrl-C to stop.\n');
    if (process.argv.includes('--open')) spawn('open', [url], { stdio: 'ignore' }).unref();
  });
}
listen(basePort);
