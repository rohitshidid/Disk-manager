import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HOME, uid, shQuote, canonical, nowIso } from './util.js';
import { runElevated } from './elevate.js';
import { screenTargets, privacyRefusal } from './safety.js';

/**
 * Removal paths that leave the app's control.
 *
 * The quarantine in `quarantine.js` is the reversible option: an item is
 * renamed aside and this app keeps the receipt. The two here hand the item to
 * somebody else instead --
 *
 *   trashMany()  the macOS Trash, where Finder owns it and you empty it
 *   eraseMany()  nowhere; the bytes are gone
 *
 * -- so neither is undoable from inside Disk Manager, and both go through the
 * same `screenTargets()` gate the quarantine uses.
 */

export const USER_TRASH = path.join(HOME, '.Trash');

/**
 * The system's own "move to Trash".
 *
 * `NSFileManager -trashItemAtURL:` is the only correct way to do this. Moving
 * files into `~/.Trash` by hand looks the same until it isn't: the system
 * picks a *different* trash for anything on another volume
 * (`/Volumes/X/.Trashes/<uid>`), resolves name collisions the way Finder
 * expects, and records the put-back location so Finder's "Put Back" works.
 *
 * It is reached through one `osascript -l JavaScript` process for the whole
 * batch. Paths go in through a JSON file rather than argv -- a few thousand
 * long paths would otherwise blow past ARG_MAX -- and the verdicts come back
 * through another, as a 0/1 per input path.
 */
const JXA_HELPER = `ObjC.import('Foundation');
function run(argv) {
  const fm = $.NSFileManager.defaultManager;
  const raw = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null));
  const paths = JSON.parse(raw);
  const out = [];
  for (const p of paths) {
    let ok = false;
    try { ok = !!fm.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(p), null, null); }
    catch (e) { ok = false; }
    out.push(ok ? 1 : 0);
  }
  $.NSString.alloc.initWithUTF8String(JSON.stringify(out))
    .writeToFileAtomicallyEncodingError(argv[1], true, $.NSUTF8StringEncoding, null);
  return '';
}`;

/**
 * Run the batch through NSFileManager. Returns a parallel array of booleans.
 *
 * This does **no** safety screening -- it will trash whatever it is handed.
 * `trashMany()` is the entry point for anything coming from the UI; this is
 * exported only for items already inside the quarantine, which the user has
 * by definition already chosen to delete and which `assess()` blocks by name
 * because they sit under the app's own directory.
 */
export async function trashPaths(paths) {
  if (!paths.length) return [];
  const stem = path.join(os.tmpdir(), `diskmanager-trash-${uid()}`);
  const script = `${stem}.js`;
  const inFile = `${stem}.in.json`;
  const outFile = `${stem}.out.json`;
  try {
    await fs.writeFile(script, JXA_HELPER, { mode: 0o600 });
    await fs.writeFile(inFile, JSON.stringify(paths));
    await new Promise((resolve) => {
      // Never rejects: a helper that dies leaves outFile absent, which reads
      // back as "nothing was trashed" and falls through to the elevated path.
      execFile('osascript', ['-l', 'JavaScript', script, inFile, outFile],
        { maxBuffer: 1 << 22 }, () => resolve());
    });
    const verdicts = JSON.parse(await fs.readFile(outFile, 'utf8'));
    return paths.map((_, i) => verdicts[i] === 1);
  } catch {
    return paths.map(() => false);
  } finally {
    for (const f of [script, inFile, outFile]) await fs.rm(f, { force: true }).catch(() => {});
  }
}

/** A trash destination that will not clobber something already sitting there. */
function trashDest(src) {
  const base = path.basename(src);
  const dest = path.join(USER_TRASH, base);
  if (!fsSync.existsSync(dest)) return dest;
  const ext = path.extname(base);
  const stamp = nowIso().slice(0, 19).replaceAll(':', '-');
  return path.join(USER_TRASH, `${base.slice(0, base.length - ext.length)} ${stamp}${ext}`);
}

/**
 * Move a batch to the macOS Trash.
 *
 * `targets` = [{ realPath, dsize, asize, items, isDir }], the same shape the
 * quarantine takes. Anything NSFileManager refuses because the parent
 * directory is not ours is retried as root in a single batch -- one prompt,
 * never one per file -- and chowned back so Finder can empty it later without
 * asking again.
 */
export async function trashMany(targets, { force = false } = {}) {
  const { kept, rejected } = screenTargets(targets, { force });
  if (!kept.length) return { moved: [], rejected, bytes: 0 };

  const results = await trashPaths(kept.map((t) => t.realPath));
  const moved = kept.filter((_, i) => results[i]);
  const failed = kept.filter((_, i) => !results[i]);

  // NSFileManager does not tell us *why* it declined -- its NSError does not
  // survive the JXA bridge, and asking for it segfaults osascript -- so the
  // reason is worked out here instead.
  //
  // Order matters, and this order is the one that holds in both directions.
  //
  // An unwritable parent is a plain permission problem, and root does fix it —
  // including inside a folder that also happens to be privacy-gated, so that
  // case must be tried before the privacy explanation is offered.
  //
  // What is left is a path POSIX says we may move and macOS refused anyway.
  // That is the signature of a TCC refusal: an app container is owned by the
  // user, in a user-owned parent, and still cannot be moved. Retrying it as
  // root would spend an admin prompt on a refusal root was never going to lift.
  const needsRoot = [];
  for (const t of failed) {
    if (!writable(path.dirname(t.realPath))) { needsRoot.push(t); continue; }
    const privacy = privacyRefusal(t.realPath);
    if (privacy) { rejected.push({ path: canonical(t.realPath), reason: privacy, privacy: true }); continue; }
    rejected.push({ path: canonical(t.realPath), reason: 'macOS refused to move this to the Trash. It may be open in another app, or on a volume with no Trash.' });
  }

  if (needsRoot.length) {
    const script = needsRoot.map((t) => {
      const dest = trashDest(t.realPath);
      return `/bin/mv -f ${shQuote(t.realPath)} ${shQuote(dest)}\n`
        + `/usr/sbin/chown -R ${process.getuid()}:${process.getgid()} ${shQuote(dest)}`;
    }).join('\n');
    try {
      await runElevated(`/bin/mkdir -p ${shQuote(USER_TRASH)}\n${script}`, {
        prompt: `Disk Manager needs administrator access to move ${needsRoot.length} item(s) to the Trash.`,
      });
      moved.push(...needsRoot);
    } catch (err) {
      for (const t of needsRoot) rejected.push({ path: canonical(t.realPath), reason: err.message });
    }
  }

  return {
    moved: moved.map((t) => ({
      path: canonical(t.realPath), realPath: t.realPath,
      dsize: t.dsize || 0, isDir: !!t.isDir,
    })),
    rejected,
    bytes: moved.reduce((a, t) => a + (t.dsize || 0), 0),
  };
}

/**
 * Erase a batch outright. No trash, no quarantine, no undo.
 *
 * This is the same finality as `Quarantine.purge()`, reachable without staging
 * the item first. The UI gates it behind a typed confirmation.
 */
export async function eraseMany(targets, { force = false } = {}) {
  const { kept, rejected } = screenTargets(targets, { force });
  if (!kept.length) return { erased: [], rejected, bytes: 0 };

  const erased = [];
  const stubborn = [];
  for (const t of kept) {
    try { await fs.rm(t.realPath, { recursive: true, force: true }); erased.push(t); }
    catch {
      // Same order as trashMany(): an unwritable parent is root's to fix, and
      // only a refusal POSIX cannot account for is a privacy refusal.
      const privacy = writable(path.dirname(t.realPath)) ? privacyRefusal(t.realPath) : null;
      if (privacy) rejected.push({ path: canonical(t.realPath), reason: privacy, privacy: true });
      else stubborn.push(t);
    }
  }

  if (stubborn.length) {
    const script = stubborn.map((t) => `/bin/rm -rf ${shQuote(t.realPath)}`).join('\n');
    try {
      await runElevated(script, {
        prompt: `Disk Manager needs administrator access to permanently delete ${stubborn.length} item(s).`,
      });
      erased.push(...stubborn);
    } catch (err) {
      for (const t of stubborn) rejected.push({ path: canonical(t.realPath), reason: err.message });
    }
  }

  return {
    erased: erased.map((t) => ({ path: canonical(t.realPath), realPath: t.realPath })),
    rejected,
    bytes: erased.reduce((a, t) => a + (t.dsize || 0), 0),
  };
}

function writable(dir) {
  try { fsSync.accessSync(dir, fsSync.constants.W_OK); return true; }
  catch { return false; }
}
