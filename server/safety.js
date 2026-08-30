import fs from 'node:fs';
import path from 'node:path';
import { canonical, HOME, APP_DIR, formatBytes } from './util.js';

/** Paths that are never deletable, no matter what the UI asks for. */
const NEVER_EXACT = new Set([
  '/', '/System', '/usr', '/bin', '/sbin', '/etc', '/var', '/tmp', '/private',
  '/dev', '/Library', '/Applications', '/Users', '/Volumes', '/opt', '/cores',
  '/home', '/net', '/.vol', '/Network', HOME,
]);

/** SIP-protected or boot-critical trees. */
const NEVER_PREFIX = [
  '/System/', '/bin/', '/sbin/', '/dev/', '/.vol/', '/Network/',
  '/usr/bin/', '/usr/lib/', '/usr/libexec/', '/usr/sbin/', '/usr/share/', '/usr/standalone/',
  '/private/etc/', '/private/var/db/', '/private/var/vm/', '/private/var/root/',
  '/Library/Apple/', '/Library/Security/', '/Library/Keychains/', '/Library/LaunchDaemons/',
];

/** Deletable, but not from a user's home -- demands an explicit confirmation. */
const OUTSIDE_HOME_OK = ['/Users/', '/Volumes/'];

const BIG_BYTES = 1024 ** 3;     // 1 GiB
const MANY_ITEMS = 10_000;

/**
 * Decide whether a path may be quarantined.
 * Returns { level: 'blocked'|'danger'|'caution'|'ok', reason, confirm[] }.
 */
export function assess(realPath, { size = 0, items = 0 } = {}) {
  const p = canonical(realPath).replace(/\/+$/, '') || '/';
  const confirm = [];

  if (!path.isAbsolute(p)) return { level: 'blocked', reason: 'Not an absolute path.', confirm };
  if (NEVER_EXACT.has(p)) return { level: 'blocked', reason: `${p} is a system root and can never be removed.`, confirm };
  for (const pre of NEVER_PREFIX) {
    if (p.startsWith(pre)) {
      return { level: 'blocked', reason: `${pre} is protected by macOS System Integrity Protection; deleting inside it would not work and could break the OS.`, confirm };
    }
  }
  // Guard the app's own state, in both directions.
  //
  // Above: deleting an ancestor of the quarantine eats the bin and the
  // manifest with it, and every undo the user still had.
  //
  // Inside: a quarantined item selected in Explore and sent to the bin would
  // be renamed *within* the quarantine, leaving the manifest pointing at a
  // path that no longer exists -- a restore that reports the copy as gone,
  // for an item sitting right there. The bin's own Restore, Trash and Purge
  // work from the manifest and do not come through here, so they are
  // unaffected: this only refuses the routes that treat it as ordinary disk.
  const appCanon = canonical(APP_DIR);
  if (p === appCanon || appCanon.startsWith(p + '/')) {
    return { level: 'blocked', reason: 'That path contains Disk Manager\'s own quarantine. Removing it would destroy your undo history.', confirm };
  }
  if (p.startsWith(appCanon + '/')) {
    return { level: 'blocked', reason: 'That is inside Disk Manager\'s own quarantine. Use the Bin tab to restore or purge it.', confirm };
  }
  if (p === canonical(HOME) || canonical(HOME).startsWith(p + '/')) {
    return { level: 'blocked', reason: 'That path contains your home folder.', confirm };
  }

  let level = 'ok';
  const outsideHome = !OUTSIDE_HOME_OK.some((pre) => p.startsWith(pre));
  if (outsideHome) {
    level = 'danger';
    confirm.push(`${p} is outside your home folder. Other apps or the system may depend on it.`);
  }
  if (size >= BIG_BYTES) {
    if (level === 'ok') level = 'caution';
    confirm.push(`This frees ${formatBytes(size)} — double-check it is not something you still need.`);
  }
  if (items >= MANY_ITEMS) {
    if (level === 'ok') level = 'caution';
    confirm.push(`It contains ${items.toLocaleString()} files.`);
  }
  return { level, reason: '', confirm };
}

/**
 * Locations macOS refuses to let an unconsented process *modify*, whatever the
 * POSIX permissions say.
 *
 * This is a different list from `scanner.js`'s `TCC_PROTECTED`, which is about
 * reading: those folders hang an unconsented `openat()` forever. These refuse
 * writes, immediately and with `EPERM`. The overlap is only partial — an app
 * container lists fine at the top level but cannot be moved, while `~/Desktop`
 * does both — so conflating them would mislabel each.
 *
 * Verified here: a directory created by this user, inside
 * `~/Library/Containers`, owned by this user, with a writable parent, still
 * could not be renamed, trashed or removed. `mv` reported `Operation not
 * permitted`.
 */
const APP_DATA_ROOTS = [
  path.join(HOME, 'Library', 'Containers'),
  path.join(HOME, 'Library', 'Group Containers'),
];
const PRIVACY_DIRS = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Movies']
  .map((d) => path.join(HOME, d));

/**
 * Why macOS will refuse to move or delete this path, or null if it won't.
 *
 * Callers use this to skip the elevated retry as well as to explain
 * themselves: this is a privacy consent, not a permission, so root does not
 * help and asking for it only spends an admin prompt on a guaranteed refusal.
 */
export function privacyRefusal(realPath) {
  const p = canonical(realPath).replace(/\/+$/, '');
  const under = (root) => p === root || p.startsWith(root + '/');

  if (APP_DATA_ROOTS.some(under)) {
    return 'macOS will not let Disk Manager touch another app\'s container folder without '
      + 'Full Disk Access. Grant it to your terminal and try again — running as admin does not '
      + 'help, because this is a privacy consent rather than a file permission.';
  }
  const dir = PRIVACY_DIRS.find(under);
  if (dir) {
    return `macOS gates ${canonical(dir)} behind a privacy consent that Disk Manager does not have. `
      + 'Grant Full Disk Access to your terminal and try again — running as admin does not help.';
  }
  return null;
}

/** Quarantine must land on the same volume, or a "move" turns into a slow copy. */
export function sameVolume(a, b) {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}

/**
 * Screen a batch of removal targets before anything touches the disk.
 *
 * Shared by all three removal paths -- quarantine, macOS Trash and permanent
 * erase -- so a path one of them refuses is refused by every one of them.
 * Nesting is collapsed here too: moving or erasing a parent takes its children
 * with it, so a nested target would only fail later as "no longer exists".
 */
export function screenTargets(targets, { force = false } = {}) {
  const rejected = [];
  const ordered = [...targets].sort((a, b) => a.realPath.length - b.realPath.length);
  const outermost = [];
  for (const t of ordered) {
    if (outermost.some((k) => t.realPath.startsWith(k.realPath + '/'))) continue;
    outermost.push(t);
  }

  const kept = [];
  for (const t of outermost) {
    const verdict = assess(t.realPath, { size: t.dsize, items: t.items });
    if (verdict.level === 'blocked') {
      rejected.push({ path: canonical(t.realPath), reason: verdict.reason });
      continue;
    }
    if ((verdict.level === 'danger' || verdict.level === 'caution') && !force) {
      rejected.push({ path: canonical(t.realPath), reason: 'Needs confirmation.', confirm: verdict.confirm, level: verdict.level });
      continue;
    }
    if (!fs.existsSync(t.realPath)) {
      rejected.push({ path: canonical(t.realPath), reason: 'No longer exists on disk (the scan may be stale).' });
      continue;
    }
    kept.push(t);
  }
  return { kept, rejected };
}
