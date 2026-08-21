import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {
  APP_DIR, QUARANTINE_DIR, MANIFEST_PATH, uid, nowIso, shQuote, canonical,
} from './util.js';
import { runElevated } from './elevate.js';
import { screenTargets, sameVolume, privacyRefusal } from './safety.js';
import { trashPaths } from './dispose.js';

const EMPTY = { version: 1, entries: {}, undoStack: [], redoStack: [] };

/**
 * Reversible deletion.
 *
 * Nothing is ever unlinked on delete. Items are *renamed* into a quarantine
 * folder on the same volume -- instant regardless of size, and exactly
 * reversible -- and the original location is recorded in a manifest that
 * survives restarts. Space is only actually reclaimed when the user purges,
 * which is the one irreversible action in the app.
 */
export class Quarantine {
  constructor() {
    this.state = structuredClone(EMPTY);
    this.loaded = false;
  }

  async init() {
    await fs.mkdir(QUARANTINE_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(MANIFEST_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = { ...structuredClone(EMPTY), ...parsed };
    } catch {
      this.state = structuredClone(EMPTY);
    }
    this.loaded = true;
    await this._reconcile();
    return this;
  }

  /** Drop manifest entries whose quarantined copy vanished (user cleaned it
   *  out by hand), so the UI never promises an undo it cannot deliver. */
  async _reconcile() {
    let changed = false;
    for (const [id, e] of Object.entries(this.state.entries)) {
      if (e.state !== 'quarantined') continue;
      if (!fsSync.existsSync(e.quarantinePath)) {
        e.state = 'missing';
        this._detach(id);
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async save() {
    await fs.mkdir(APP_DIR, { recursive: true });
    const tmp = MANIFEST_PATH + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
    await fs.rename(tmp, MANIFEST_PATH);
  }

  /** Remove an entry id from the undo/redo stacks, dropping empty operations. */
  _detach(id) {
    for (const key of ['undoStack', 'redoStack']) {
      this.state[key] = this.state[key]
        .map((op) => ({ ...op, entryIds: op.entryIds.filter((x) => x !== id) }))
        .filter((op) => op.entryIds.length > 0);
    }
  }

  live() {
    return Object.values(this.state.entries).filter((e) => e.state === 'quarantined');
  }

  /** What the user sees in the footer: how much a purge would hand back. */
  reclaimable() {
    const items = this.live();
    return {
      count: items.length,
      bytes: items.reduce((a, e) => a + (e.dsize || 0), 0),
      files: items.reduce((a, e) => a + (e.items || 0) + 1, 0),
    };
  }

  summary() {
    return {
      reclaimable: this.reclaimable(),
      entries: this.live()
        .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
        .map((e) => ({
          id: e.id, path: e.displayPath, name: path.basename(e.displayPath),
          isDir: e.isDir, dsize: e.dsize, items: e.items,
          deletedAt: e.deletedAt, neededRoot: e.neededRoot,
        })),
      canUndo: this.state.undoStack.length > 0,
      canRedo: this.state.redoStack.length > 0,
      undoLabel: describe(this.state.undoStack.at(-1), this.state.entries),
      redoLabel: describe(this.state.redoStack.at(-1), this.state.entries),
    };
  }

  /**
   * Quarantine a batch of paths as a single undoable operation.
   * `targets` = [{ realPath, dsize, asize, items, isDir }]
   */
  async deleteMany(targets, { force = false } = {}) {
    const rejected = [];
    const moves = [];
    const entries = [];

    const screened = screenTargets(targets, { force });
    rejected.push(...screened.rejected);

    for (const t of screened.kept) {
      if (!sameVolume(path.dirname(t.realPath), QUARANTINE_DIR)) {
        rejected.push({ path: canonical(t.realPath), reason: 'On a different volume than the quarantine folder, so it cannot be moved instantly. Delete it from that volume directly.' });
        continue;
      }

      const id = uid();
      const holder = path.join(QUARANTINE_DIR, id);
      const dest = path.join(holder, path.basename(t.realPath));
      entries.push({
        id,
        displayPath: canonical(t.realPath),
        realPath: t.realPath,
        quarantinePath: dest,
        holder,
        isDir: !!t.isDir,
        dsize: t.dsize || 0,
        asize: t.asize || 0,
        items: t.items || 0,
        deletedAt: nowIso(),
        neededRoot: false,
        state: 'quarantined',
      });
      moves.push({ from: t.realPath, to: dest, holder, id });
    }

    if (!moves.length) return { moved: [], rejected, ...this.summary() };

    const result = await performMoves(moves, `Disk Manager needs administrator access to move ${moves.length} item(s) to the quarantine folder.`);

    const moved = [];
    for (const e of entries) {
      const r = result.byId.get(e.id);
      if (r?.ok) { e.neededRoot = !!r.elevated; this.state.entries[e.id] = e; moved.push(e); }
      else rejected.push({ path: e.displayPath, reason: r?.error || 'Move failed.', privacy: !!r?.privacy });
    }

    if (moved.length) {
      this.state.undoStack.push({ id: uid(), type: 'delete', at: nowIso(), entryIds: moved.map((e) => e.id) });
      this.state.redoStack = [];
      await this.save();
    }
    return { moved: moved.map((e) => e.displayPath), rejected, ...this.summary() };
  }

  async undo() {
    const op = this.state.undoStack.pop();
    if (!op) return { ok: false, message: 'Nothing to undo.', ...this.summary() };
    const res = await this._restoreEntries(op.entryIds);
    if (!res.restored.length) {
      this.state.undoStack.push(op);
      await this.save();
      return { ok: false, message: res.failed[0]?.reason || 'Undo failed.', failed: res.failed, ...this.summary() };
    }
    this.state.redoStack.push(op);
    await this.save();
    return { ok: true, restored: res.restored, failed: res.failed, ...this.summary() };
  }

  async redo() {
    const op = this.state.redoStack.pop();
    if (!op) return { ok: false, message: 'Nothing to redo.', ...this.summary() };
    const moves = [];
    for (const id of op.entryIds) {
      const e = this.state.entries[id];
      if (!e || e.state !== 'restored') continue;
      if (!fsSync.existsSync(e.restoredTo || e.realPath)) continue;
      moves.push({ from: e.restoredTo || e.realPath, to: e.quarantinePath, holder: e.holder, id });
    }
    if (!moves.length) {
      await this.save();
      return { ok: false, message: 'Nothing left to redo — those items are gone from their original location.', ...this.summary() };
    }
    const result = await performMoves(moves, `Disk Manager needs administrator access to re-delete ${moves.length} item(s).`);
    const redone = [];
    const failed = [];
    for (const m of moves) {
      const e = this.state.entries[m.id];
      const r = result.byId.get(m.id);
      if (r?.ok) { e.state = 'quarantined'; delete e.restoredTo; redone.push(e.displayPath); }
      else failed.push({ path: e.displayPath, reason: r?.error || 'Move failed.', privacy: !!r?.privacy });
    }
    this.state.undoStack.push(op);
    await this.save();
    return { ok: redone.length > 0, redone, failed, ...this.summary() };
  }

  /** Restore one item straight from the bin (outside the undo stack). */
  async restore(ids) {
    const res = await this._restoreEntries(ids);
    for (const id of ids) this._detach(id);
    await this.save();
    return { ok: res.restored.length > 0, ...res, ...this.summary() };
  }

  async _restoreEntries(ids) {
    const moves = [];
    const failed = [];
    for (const id of ids) {
      const e = this.state.entries[id];
      if (!e) { failed.push({ path: id, reason: 'Unknown item.' }); continue; }
      if (e.state !== 'quarantined') { failed.push({ path: e.displayPath, reason: `Already ${e.state}.` }); continue; }
      if (!fsSync.existsSync(e.quarantinePath)) {
        e.state = 'missing';
        failed.push({ path: e.displayPath, reason: 'The quarantined copy is gone — it may have been purged.' });
        continue;
      }
      let dest = e.realPath;
      if (fsSync.existsSync(dest)) {
        // Something new took the name. Never clobber it.
        const ext = path.extname(dest);
        const stem = dest.slice(0, dest.length - ext.length);
        dest = `${stem} (restored ${new Date().toISOString().slice(0, 19).replaceAll(':', '-')})${ext}`;
      }
      moves.push({ from: e.quarantinePath, to: dest, holder: path.dirname(dest), id, restore: true });
    }
    if (!moves.length) return { restored: [], failed };

    const result = await performMoves(moves, `Disk Manager needs administrator access to restore ${moves.length} item(s).`);
    const restored = [];
    for (const m of moves) {
      const e = this.state.entries[m.id];
      const r = result.byId.get(m.id);
      if (r?.ok) {
        e.state = 'restored';
        e.restoredTo = m.to;
        restored.push({ path: e.displayPath, restoredTo: canonical(m.to) });
        await fs.rm(e.holder, { recursive: true, force: true }).catch(() => {});
      } else {
        failed.push({ path: e.displayPath, reason: r?.error || 'Restore failed.', privacy: !!r?.privacy });
      }
    }
    return { restored, failed };
  }

  /**
   * Hand quarantined items over to the macOS Trash.
   *
   * The item leaves this app's custody: undo and restore stop applying, and
   * Finder's "Put Back" takes over. That is the point -- it is how you get
   * something out of an app-private folder and into the one place on the Mac
   * you already know how to empty.
   */
  async trash(ids) {
    const targets = (ids?.length ? ids : this.live().map((e) => e.id))
      .map((id) => this.state.entries[id])
      .filter((e) => e && e.state === 'quarantined');
    if (!targets.length) return { ok: false, message: 'Nothing to move to the Trash.', ...this.summary() };

    const results = await trashPaths(targets.map((e) => e.quarantinePath));
    const trashed = [];
    const failed = [];
    for (const [i, e] of targets.entries()) {
      if (!results[i]) { failed.push({ path: e.displayPath, reason: 'macOS refused to move this to the Trash.' }); continue; }
      e.state = 'trashed';
      e.trashedAt = nowIso();
      this._detach(e.id);
      trashed.push(e);
      // The holder is now an empty wrapper directory; the item itself is safe
      // in the Trash, so dropping it loses nothing.
      await fs.rm(e.holder, { recursive: true, force: true }).catch(() => {});
    }
    await this.save();
    return {
      ok: trashed.length > 0,
      trashed: trashed.map((e) => e.displayPath),
      realPaths: trashed.map((e) => e.realPath),
      moved: trashed.map((e) => ({
        path: e.displayPath, realPath: e.realPath, dsize: e.dsize || 0, isDir: !!e.isDir,
      })),
      bytes: trashed.reduce((a, e) => a + (e.dsize || 0), 0),
      failed,
      ...this.summary(),
    };
  }

  /** The only irreversible action in the app. */
  async purge(ids) {
    const targets = (ids?.length ? ids : this.live().map((e) => e.id))
      .map((id) => this.state.entries[id])
      .filter((e) => e && e.state === 'quarantined');
    if (!targets.length) return { ok: false, message: 'Nothing to purge.', ...this.summary() };

    const freed = targets.reduce((a, e) => a + (e.dsize || 0), 0);
    const stubborn = [];
    for (const e of targets) {
      try { await fs.rm(e.holder, { recursive: true, force: true }); }
      catch { stubborn.push(e); }
    }
    if (stubborn.length) {
      const script = stubborn.map((e) => `/bin/rm -rf ${shQuote(e.holder)}`).join('\n');
      await runElevated(script, { prompt: `Disk Manager needs administrator access to permanently delete ${stubborn.length} item(s).` });
    }
    for (const e of targets) {
      e.state = 'purged';
      e.purgedAt = nowIso();
      this._detach(e.id);
    }
    await this.save();
    return { ok: true, purged: targets.length, freed, realPaths: targets.map((e) => e.realPath), ...this.summary() };
  }
}

function describe(op, entries) {
  if (!op) return null;
  const names = op.entryIds.map((id) => entries[id]?.displayPath).filter(Boolean);
  if (!names.length) return null;
  const base = path.basename(names[0]);
  return names.length === 1 ? `Delete “${base}”` : `Delete ${names.length} items`;
}

/**
 * Move a batch, unprivileged where possible and with a single admin prompt for
 * whatever is left. One prompt per batch, never one per file.
 */
async function performMoves(moves, prompt) {
  const byId = new Map();
  const needsRoot = [];

  for (const m of moves) {
    try {
      await fs.mkdir(m.holder, { recursive: true });
      await fs.rename(m.from, m.to);
      byId.set(m.id, { ok: true, elevated: false });
    } catch (err) {
      if (err.code === 'EXDEV') {
        byId.set(m.id, { ok: false, error: 'Source and quarantine are on different volumes.' });
      } else if (err.code === 'ENOENT') {
        byId.set(m.id, { ok: false, error: 'Path no longer exists.' });
      } else if (['EACCES', 'EPERM', 'EROFS'].includes(err.code)) {
        // EPERM that POSIX cannot account for — a writable parent we still may
        // not move out of — is a TCC refusal, and root cannot lift it. An
        // unwritable parent is an ordinary permission problem, so let it
        // through to the elevated batch as before.
        let parentWritable = false;
        try { fsSync.accessSync(path.dirname(m.from), fsSync.constants.W_OK); parentWritable = true; } catch {}
        const privacy = parentWritable ? privacyRefusal(m.from) : null;
        if (privacy) byId.set(m.id, { ok: false, error: privacy, privacy: true });
        else needsRoot.push(m);
      } else {
        byId.set(m.id, { ok: false, error: `${err.code || ''} ${err.message}`.trim() });
      }
    }
  }

  if (needsRoot.length) {
    const script = needsRoot
      .map((m) => `/bin/mkdir -p ${shQuote(m.holder)}\n/bin/mv -f ${shQuote(m.from)} ${shQuote(m.to)}`)
      .join('\n');
    try {
      await runElevated(script, { prompt });
      for (const m of needsRoot) byId.set(m.id, { ok: true, elevated: true });
    } catch (err) {
      for (const m of needsRoot) byId.set(m.id, { ok: false, error: err.message });
    }
  }
  return { byId };
}
