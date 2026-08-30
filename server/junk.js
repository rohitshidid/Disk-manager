import path from 'node:path';
import { HOME, canonical } from './util.js';
import { F_DIR } from './tree.js';

const h = (p) => path.join(canonical(HOME), p);
const DAY = 86400;

/**
 * Known space sinks on a developer's Mac.
 *
 * `exact` rules point at one folder we can resolve directly. `byName` rules
 * sweep the tree for a folder name wherever it appears (node_modules is the
 * classic -- hundreds of copies scattered across projects). `risk` drives how
 * loudly the UI warns before anything moves.
 */
const EXACT = [
  { id: 'xcode-derived', label: 'Xcode DerivedData', risk: 'safe', why: 'Build intermediates. Xcode regenerates them on the next build.', path: h('Library/Developer/Xcode/DerivedData'), expand: true },
  { id: 'xcode-devsupport', label: 'iOS DeviceSupport symbols', risk: 'safe', why: 'Debug symbols for each iOS version you ever attached. Re-downloaded when needed.', path: h('Library/Developer/Xcode/iOS DeviceSupport'), expand: true },
  { id: 'xcode-archives', label: 'Xcode Archives', risk: 'caution', why: 'Past app builds. Delete only if you no longer need to re-submit or symbolicate them.', path: h('Library/Developer/Xcode/Archives'), expand: true },
  { id: 'simulators', label: 'iOS Simulator devices', risk: 'caution', why: 'Simulator disk images. Removing one resets that simulator to factory state.', path: h('Library/Developer/CoreSimulator/Devices'), expand: true },
  { id: 'sim-caches', label: 'CoreSimulator caches', risk: 'safe', why: 'Rebuilt automatically.', path: h('Library/Developer/CoreSimulator/Caches') },
  { id: 'user-caches', label: 'Application caches', risk: 'safe', why: 'Per-app caches. Apps rebuild them; some may load slower once.', path: h('Library/Caches'), expand: true },
  { id: 'sys-caches', label: 'System-wide caches', risk: 'caution', why: 'Shared caches outside your home folder.', path: '/Library/Caches', expand: true },
  { id: 'logs', label: 'Application logs', risk: 'safe', why: 'Diagnostic logs. Only worth keeping if you are debugging something right now.', path: h('Library/Logs'), expand: true },
  { id: 'ios-backups', label: 'iPhone / iPad backups', risk: 'danger', why: 'Full device backups. These are often tens of GB and are NOT recoverable from anywhere else.', path: h('Library/Application Support/MobileSync/Backup'), expand: true },
  { id: 'docker', label: 'Docker disk images', risk: 'caution', why: 'Container images and volumes. Deleting loses local containers and data volumes.', path: h('Library/Containers/com.docker.docker/Data/vms') },
  { id: 'trash', label: 'Trash', risk: 'safe', why: 'Already in the Trash.', path: h('.Trash'), expand: true },
  { id: 'npm-cache', label: 'npm cache', risk: 'safe', why: 'Re-downloaded on demand.', path: h('.npm/_cacache') },
  { id: 'pnpm-store', label: 'pnpm store', risk: 'caution', why: 'Shared package store. Existing pnpm projects need `pnpm install` again.', path: h('Library/pnpm/store') },
  { id: 'yarn-cache', label: 'Yarn cache', risk: 'safe', why: 'Re-downloaded on demand.', path: h('Library/Caches/Yarn') },
  { id: 'bun-cache', label: 'Bun install cache', risk: 'safe', why: 'Re-downloaded on demand.', path: h('.bun/install/cache') },
  { id: 'brew-cache', label: 'Homebrew downloads', risk: 'safe', why: 'Downloaded bottles. `brew` re-fetches them.', path: h('Library/Caches/Homebrew') },
  { id: 'gradle', label: 'Gradle caches', risk: 'safe', why: 'Re-downloaded on the next build.', path: h('.gradle/caches') },
  { id: 'maven', label: 'Maven repository', risk: 'safe', why: 'Re-downloaded on the next build.', path: h('.m2/repository') },
  { id: 'cargo', label: 'Cargo registry', risk: 'safe', why: 'Re-downloaded on the next build.', path: h('.cargo/registry') },
  { id: 'go-mod', label: 'Go module cache', risk: 'safe', why: 'Re-downloaded on the next build.', path: h('go/pkg/mod') },
  { id: 'pip-cache', label: 'pip cache', risk: 'safe', why: 'Re-downloaded on demand.', path: h('Library/Caches/pip') },
  { id: 'dotcache', label: '~/.cache', risk: 'safe', why: 'Generic tool cache directory.', path: h('.cache'), expand: true },
];

const BY_NAME = [
  { id: 'node_modules', label: 'node_modules folders', risk: 'caution', name: 'node_modules', why: 'Installed dependencies. Restored with `npm install` — but that needs network access and the project\'s lockfile.', skipNested: true },
  { id: 'next-build', label: 'Next.js build caches', risk: 'safe', name: '.next', why: 'Rebuilt by the next `next build`.' },
  { id: 'pycache', label: '__pycache__ folders', risk: 'safe', name: '__pycache__', why: 'Python bytecode caches, regenerated automatically.' },
  { id: 'pytest', label: 'pytest caches', risk: 'safe', name: '.pytest_cache', why: 'Regenerated on the next test run.' },
  { id: 'turbo', label: 'Turborepo caches', risk: 'safe', name: '.turbo', why: 'Rebuilt on the next task run.' },
  { id: 'venv', label: 'Python virtualenvs', risk: 'caution', name: '.venv', why: 'Recreated with `python -m venv` plus a reinstall of requirements.' },
];

/**
 * Sweep the scanned tree for junk. One pass over every node, matching cheap
 * name comparisons first and only building path strings for real candidates.
 */
export function findJunk(tree, { minSize = 1024 * 1024 } = {}) {
  if (!tree || !tree.n) return { categories: [], total: 0 };
  // Collect (rule, node) hits first. A __pycache__ inside a flagged .venv is
  // a hit for both rules, and counting it twice would overstate the total and
  // queue a delete that must fail -- so nested hits are dropped below.
  const hits = [];
  const seen = new Set();
  const push = (rule, idx) => {
    if (tree.isDeleted(idx) || tree.isStale(idx)) return;
    if (seen.has(idx)) return;
    if (tree.subD[idx] < minSize) return;
    seen.add(idx);
    hits.push({ rule, idx });
  };

  // Exact-path rules resolve in one lookup each.
  for (const rule of EXACT) {
    const idx = tree.findByPath(rule.path);
    if (idx < 0) continue;
    if (rule.expand) {
      for (const c of tree.children(idx)) push(rule, c);
    } else {
      push(rule, idx);
    }
  }

  // Name rules need the full sweep.
  const nameRules = new Map();
  for (const r of BY_NAME) nameRules.set(r.name, r);
  const homeReal = tree.findByPath(canonical(HOME));
  for (let i = 1; i < tree.n; i++) {
    // Skip the branches a per-folder refresh detached: they are still in the
    // arrays but no longer part of the tree, and counting them would double
    // every hit inside a refreshed folder.
    if (tree.isStale(i)) continue;
    if (!(tree.flags[i] & F_DIR)) continue;
    for (const [name, rule] of nameRules) {
      if (!tree.nameIs(i, name)) continue;
      if (rule.skipNested) {
        let anc = tree.parent[i], nested = false;
        while (anc > 0) {
          if (tree.nameIs(anc, name)) { nested = true; break; }
          anc = tree.parent[anc];
        }
        if (nested) break;
      }
      push(rule, i);
      break;
    }
  }

  // Downloads that have sat untouched for three months.
  const dl = tree.findByPath(h('Downloads'));
  if (dl >= 0) {
    const cutoff = Math.floor(Date.now() / 1000) - 90 * DAY;
    const rule = { id: 'old-downloads', label: 'Downloads older than 90 days', risk: 'caution', why: 'Untouched for three months. Check the list before removing — downloads are not always re-downloadable.' };
    for (const c of tree.children(dl)) {
      if (tree.subMtime[c] && tree.subMtime[c] < cutoff) push(rule, c);
    }
  }

  // Drop any hit that lives inside another hit.
  const kept = hits.filter(({ idx }) => {
    for (let anc = tree.parent[idx]; anc > 0; anc = tree.parent[anc]) {
      if (seen.has(anc)) return false;
    }
    return true;
  });

  const buckets = new Map();
  for (const { rule, idx } of kept) {
    if (!buckets.has(rule.id)) buckets.set(rule.id, { ...rule, items: [], size: 0 });
    const b = buckets.get(rule.id);
    b.items.push({
      path: tree.displayPath(idx),
      realPath: tree.pathOf(idx),
      name: tree.name(idx),
      size: tree.subD[idx],
      items: tree.subItems[idx],
      mtime: tree.subMtime[idx],
      isDir: tree.isDir(idx),
    });
    b.size += tree.subD[idx];
  }

  const categories = [...buckets.values()]
    .map((b) => ({
      id: b.id, label: b.label, why: b.why, risk: b.risk,
      size: b.size, count: b.items.length,
      items: b.items.sort((a, z) => z.size - a.size).slice(0, 200),
    }))
    .sort((a, z) => z.size - a.size);

  return {
    categories,
    total: categories.reduce((a, c) => a + c.size, 0),
    homeScanned: homeReal >= 0,
  };
}
