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
  // Guard the app's own state -- deleting an ancestor of it would eat the bin.
  const appCanon = canonical(APP_DIR);
  if (p === appCanon || appCanon.startsWith(p + '/')) {
    return { level: 'blocked', reason: 'That path contains Disk Manager\'s own quarantine. Removing it would destroy your undo history.', confirm };
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

/** Quarantine must land on the same volume, or a "move" turns into a slow copy. */
export function sameVolume(a, b) {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}
