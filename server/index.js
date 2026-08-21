import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

import { Scanner, ncduOpenDir, findBlockedChild, isPrivacyProtected, surveyBlockers } from './scanner.js';
import { Quarantine } from './quarantine.js';
import { DupeFinder } from './dupes.js';
import { findJunk } from './junk.js';
import { assess } from './safety.js';
import { F_ERR } from './tree.js';
import { DATA_VOLUME, HOME, APP_DIR, canonical, underDataVolume, diskUsage, formatBytes, QUARANTINE_DIR } from './util.js';

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
const quarantine = await new Quarantine().init();
const markedNodes = new Set();
let scanPromise = null;
let lastSweep = [];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
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
    mtime: tree.mtime[idx] || null,
    share: parentSize > 0 ? tree.subD[idx] / parentSize : 0,
  };
}

/** Last-used dates for the visible rows. Bounded by a deadline: a path whose
 *  provider is unresponsive must not be able to hang the whole listing. */
async function withAtimes(rows) {
  const work = Promise.all(rows.slice(0, 600).map(async (r) => {
    try { r.atime = Math.floor((await fsp.lstat(r.realPath)).atimeMs / 1000); } catch { r.atime = null; }
  }));
  await Promise.race([work, new Promise((r) => setTimeout(r, 3000))]);
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
    quarantine: q,
    disk: disk && {
      ...disk,
      availAfterPurge: disk.avail + q.reclaimable.bytes,
    },
    home: canonical(HOME),
    excludes: loadExcludes(),
    dataVolume: DATA_VOLUME,
    quarantineDir: canonical(QUARANTINE_DIR),
  };
}

/** Disk usage of a directory tree, for paths the scan does not know about. */
function measureDir(p) {
  try {
    const out = execFileSync('du', ['-sk', '-x', p], { maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(out.toString().trim().split(/\s+/)[0]) * 1024 || 0;
  } catch {
    return 0;
  }
}

/** Turn the client's list of paths into delete targets with real sizes. */
function resolveTargets(paths) {
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
        targets.push({
          realPath: p,
          dsize: isDir ? measureDir(p) : st.blocks * 512,
          asize: isDir ? measureDir(p) : st.size,
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
    scanPromise = scanner
      .start({ root, elevated: !!body.elevated, excludes: loadExcludes() })
      .then(() => { syncTree(); })
      .catch((err) => { scanner.status = 'error'; scanner.error = err.message; });
    json(res, 202, await baseState());
  },

  'POST /api/scan/cached': async (_req, res) => {
    markedNodes.clear();
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
      scanPromise = scanner
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

  'POST /api/excludes': async (req, res, body) => {
    saveExcludes(Array.isArray(body.excludes) ? body.excludes : []);
    json(res, 200, { excludes: loadExcludes() });
  },

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
    const rows = kids.slice(0, LIMIT).map((c) => nodeView(tree, c, size));
    await withAtimes(rows);

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
      if (tree.isDeleted(i)) continue;
      if (dirsOnly && !tree.isDir(i)) continue;
      if (tree.subD[i] < minSize) continue;
      if (cutoff && (!tree.mtime[i] || tree.mtime[i] > cutoff)) continue;
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
    const { targets, unknown } = resolveTargets(body.paths || []);
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
    const { targets, unknown } = resolveTargets(body.paths || []);
    const result = await quarantine.deleteMany(targets, { force: !!body.force });
    syncTree();
    json(res, 200, { ...result, rejected: [...result.rejected, ...unknown], state: await baseState() });
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
    syncTree();
    json(res, 200, { ...r, state: await baseState() });
  },

  /** Open the Full Disk Access pane so the user can grant consent. */
  'POST /api/privacy-settings': async (_req, res) => {
    spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'], { stdio: 'ignore' }).unref();
    json(res, 200, { ok: true });
  },

  'POST /api/reveal': async (req, res, body) => {
    const p = body.path;
    if (typeof p === 'string' && fs.existsSync(p)) spawn('open', ['-R', p], { stdio: 'ignore' }).unref();
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
