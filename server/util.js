import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

export const execFileAsync = promisify(execFile);

/** The macOS data volume. On modern macOS `/` is a sealed read-only system
 *  volume; everything a user can actually delete lives here and is surfaced
 *  at `/Users`, `/Applications`, ... through firmlinks. */
export const DATA_VOLUME = '/System/Volumes/Data';

export const HOME = os.homedir();
export const APP_DIR = path.join(HOME, 'Library', 'Application Support', 'DiskManager');
export const QUARANTINE_DIR = path.join(APP_DIR, 'quarantine');
export const MANIFEST_PATH = path.join(APP_DIR, 'manifest.json');
export const LAST_SCAN_PATH = path.join(APP_DIR, 'last-scan.json');

/** macOS keeps /var, /tmp and /etc as symlinks into /private. Resolve those
 *  so a path from the user and a path from ncdu compare equal. */
export function normalizePath(p) {
  if (typeof p !== 'string' || !p) return p;
  for (const link of ['/var', '/tmp', '/etc']) {
    if (p === link || p.startsWith(link + '/')) return '/private' + p;
  }
  return p;
}

/** Strip the data-volume prefix so paths read the way the user thinks of them:
 *  /System/Volumes/Data/Users/me -> /Users/me */
export function canonical(p) {
  if (p === DATA_VOLUME) return '/';
  if (p.startsWith(DATA_VOLUME + '/')) return p.slice(DATA_VOLUME.length);
  return p;
}

/** Inverse of canonical(), for the scan rooted at the data volume. */
export function underDataVolume(p) {
  if (p.startsWith(DATA_VOLUME)) return p;
  if (p === '/') return DATA_VOLUME;
  return DATA_VOLUME + p;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0;
  n = Math.abs(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const s = n < 10 && i > 0 ? n.toFixed(1) : Math.round(n).toString();
  return (neg ? '-' : '') + s + ' ' + units[i];
}

/** Free / used space for the volume containing `target`. */
export async function diskUsage(target = DATA_VOLUME) {
  const { stdout } = await execFileAsync('df', ['-k', target]);
  const line = stdout.trim().split('\n').pop();
  const cols = line.split(/\s+/);
  // Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted
  const size = Number(cols[1]) * 1024;
  const used = Number(cols[2]) * 1024;
  const avail = Number(cols[3]) * 1024;
  return { volume: target, size, used, avail };
}

export function nowIso() { return new Date().toISOString(); }

export function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/** Escape a value for safe interpolation into a /bin/sh single-quoted string. */
export function shQuote(s) {
  return "'" + String(s).replaceAll("'", `'\\''`) + "'";
}
