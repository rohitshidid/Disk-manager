import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { TreeStore, NcduParser } from './tree.js';
import { ncduArgs, runNcdu, tailExport } from './scanner.js';
import { UserCancelled } from './elevate.js';
import { APP_DIR, canonical } from './util.js';

/** Its own export file, never `last-scan.json`: the cached full scan has to
 *  survive a refresh, or reopening the app would reload one folder instead of
 *  the volume. Its own sentinel too, so cancelling a refresh cannot reach in
 *  and stop a full scan that happens to be running. */
const REFRESH_EXPORT = path.join(APP_DIR, 'refresh-scan.json');
const REFRESH_CANCEL = path.join(APP_DIR, '.refresh-cancel');

/** A refresh with nothing arriving for this long is reported as stalled. The
 *  cause is the same one a full scan hits -- macOS withholding privacy consent
 *  makes `openat()` wait forever -- but the fix here is simply Cancel, so this
 *  does not repeat the scanner's diagnosis machinery. */
const STALL_MS = 20_000;

/**
 * Re-scan one folder and splice it back into the tree.
 *
 * The whole point is to avoid a full rescan: measuring `~/Projects` again
 * takes seconds where the volume takes minutes, and every ancestor total, the
 * treemap and the status bar still end up correct because `spliceSubtree()`
 * carries the difference up to the root.
 *
 * It runs ncdu exactly the way the full scan does -- same flags, same skip
 * list, same cancellable wrapper -- so a folder measures the same whether it
 * arrived through a refresh or through a scan of the whole volume.
 */
export class FolderRefresher {
  constructor() { this.reset(); }

  reset() {
    this.status = 'idle';   // idle | running | ready | error | cancelled
    this.path = null;
    this.items = 0;
    this.bytes = 0;
    this.startedAt = null;
    this.finishedAt = null;
    this.error = null;
    this.sizeBefore = 0;
    this.sizeAfter = 0;
    this._cancel = false;
    this._child = null;
    this._lastChangeAt = null;
  }

  stalledMs() {
    if (this.status !== 'running' || !this._lastChangeAt) return 0;
    const ms = Date.now() - this._lastChangeAt;
    return ms > STALL_MS ? ms : 0;
  }

  progress() {
    return {
      status: this.status,
      path: this.path,
      items: this.items,
      bytes: this.bytes,
      elapsedMs: this.startedAt ? (this.finishedAt ?? Date.now()) - this.startedAt : 0,
      stalledMs: this.stalledMs(),
      sizeBefore: this.sizeBefore,
      sizeAfter: this.sizeAfter,
      delta: this.sizeAfter - this.sizeBefore,
      error: this.error,
    };
  }

  cancel() {
    this._cancel = true;
    try { fs.writeFileSync(REFRESH_CANCEL, ''); } catch {}
    if (this._child) { try { this._child.kill('SIGTERM'); } catch {} }
  }

  /**
   * Measure `target` again and put the result back into `tree`.
   *
   * Resolves to the new node index, or throws. Everything the caller has to do
   * afterwards -- dropping stale indices, re-deriving the bin marks -- belongs
   * to whoever owns those sets, not here.
   */
  async start(tree, { path: target, elevated = false, excludes = [] } = {}) {
    if (this.status === 'running') throw new Error('A refresh is already running.');
    if (!tree || !tree.n) throw new Error('Nothing has been scanned yet.');

    const idx = tree.findByPath(target);
    if (idx < 0) throw new Error(`${target} is not part of the current scan.`);
    if (idx === 0) throw new Error('This is the scan root — use Scan disk to measure the whole volume again.');
    if (!tree.isDir(idx)) throw new Error('Only folders can be refreshed.');

    const real = tree.pathOf(idx);
    this.reset();
    this.status = 'running';
    this.path = canonical(real);
    this.sizeBefore = tree.subD[idx];
    this.startedAt = Date.now();
    this._lastChangeAt = Date.now();

    await fsp.mkdir(APP_DIR, { recursive: true });
    await fsp.rm(REFRESH_CANCEL, { force: true }).catch(() => {});
    await fsp.rm(REFRESH_EXPORT, { force: true }).catch(() => {});
    // Pre-created world-readable so an elevated ncdu's export can still be
    // tailed: ncdu opens with O_TRUNC, which keeps the existing mode.
    await fsp.writeFile(REFRESH_EXPORT, '', { mode: 0o666 });

    const args = ncduArgs({ root: real, outFile: REFRESH_EXPORT, excludes });
    const run = runNcdu({
      args, outFile: REFRESH_EXPORT, cancelFile: REFRESH_CANCEL, elevated,
      prompt: `Disk Manager needs administrator access to measure ${this.path} completely.`,
      onChild: (c) => { this._child = c; },
    });

    const sub = new TreeStore(1 << 12);
    const parser = new NcduParser(sub, {
      onProgress: ({ items, bytes }) => { this.items = items; this.bytes = bytes; },
    });

    let done = false;
    const runner = run.then(() => { done = true; }, (err) => { done = true; throw err; });

    try {
      await tailExport(REFRESH_EXPORT, parser, () => done || this._cancel, {
        onGrow: () => { this._lastChangeAt = Date.now(); },
      });
      await runner;
      if (this._cancel) {
        this.status = 'cancelled';
        return -1;
      }
      await tailExport(REFRESH_EXPORT, parser, () => true, { finalOnly: true });
      parser.end();
      if (!sub.n) throw new Error(`${this.path} could not be read — it may have been moved or deleted since the scan.`);
      sub.aggregate();

      // Re-resolve: nothing above can have moved while we were measuring, but
      // reading the index again keeps this honest if that ever changes.
      const at = tree.findByPath(real);
      if (at < 1) throw new Error(`${this.path} is no longer part of the current scan.`);
      const newIdx = tree.spliceSubtree(at, sub);
      if (newIdx < 0) throw new Error('The refreshed folder could not be merged back into the tree.');

      this.sizeAfter = tree.subD[newIdx];
      this.items = parser.count;
      this.status = 'ready';
      return newIdx;
    } catch (err) {
      this.status = err instanceof UserCancelled ? 'cancelled' : 'error';
      this.error = err.message;
      if (this.status === 'error') throw err;
      return -1;
    } finally {
      this.finishedAt = Date.now();
      this._child = null;
      // A refresh of something like ~/Library can leave tens of megabytes of
      // export behind, and nothing reads it after the splice.
      await fsp.rm(REFRESH_EXPORT, { force: true }).catch(() => {});
      await fsp.rm(REFRESH_CANCEL, { force: true }).catch(() => {});
    }
  }
}
