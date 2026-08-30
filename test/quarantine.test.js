/**
 * The quarantine, against a real filesystem.
 *
 * Nothing here is mocked: files are created, renamed aside and restored, and
 * the manifest is read back from disk. The point of the bin is that it is
 * exactly reversible, and that is not a property you can assert about a stub.
 *
 * `HOME` is pointed at a scratch directory *before* the modules load, because
 * `util.js` resolves the app's paths once at import. It sits inside the real
 * home so that everything stays on one volume — a quarantine move is a rename,
 * and a rename across volumes fails — and so the paths still read as `/Users/…`
 * to `assess()`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REAL_HOME = os.homedir();
const SANDBOX = fs.mkdtempSync(path.join(REAL_HOME, '.dm-qtest-'));
process.env.HOME = SANDBOX;

const { Quarantine } = await import('../server/quarantine.js');

const WORK = path.join(SANDBOX, 'work');
const APP = path.join(SANDBOX, 'Library', 'Application Support', 'DiskManager');

/**
 * A quarantine with nothing in it.
 *
 * The manifest is a file, so instances share it: without this, each test would
 * start holding whatever the previous one left behind, and `live()[0]` would
 * be somebody else's entry. Reopening the same manifest deliberately is what
 * the restart test does, and it is the only one that skips this.
 */
async function freshQuarantine() {
  fs.rmSync(APP, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  return new Quarantine().init();
}
let seq = 0;
function makeFile(contents = 'hello') {
  fs.mkdirSync(WORK, { recursive: true });
  const p = path.join(WORK, `file-${seq++}.txt`);
  fs.writeFileSync(p, contents);
  return p;
}
const target = (p) => ({ realPath: p, dsize: 4096, asize: 5, items: 0, isDir: false });

test.after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

test('delete moves the file aside rather than unlinking it', async () => {
  const q = await freshQuarantine();
  const file = makeFile();

  const res = await q.deleteMany([target(file)]);
  assert.equal(res.rejected.length, 0, JSON.stringify(res.rejected));
  assert.equal(res.moved.length, 1);
  assert.equal(fs.existsSync(file), false, 'gone from where it was');

  const entry = q.live()[0];
  assert.ok(fs.existsSync(entry.quarantinePath), 'and present in the quarantine');
  assert.equal(fs.readFileSync(entry.quarantinePath, 'utf8'), 'hello', 'byte for byte');
  assert.equal(q.reclaimable().count, 1);
  assert.equal(q.reclaimable().bytes, 4096);
});

test('undo, redo and undo again all land where they should', async () => {
  const q = await freshQuarantine();
  const file = makeFile('round trip');
  await q.deleteMany([target(file)]);

  assert.equal((await q.undo()).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'round trip', 'undo puts it back');
  assert.equal(q.reclaimable().count, 0);

  assert.equal((await q.redo()).ok, true);
  assert.equal(fs.existsSync(file), false, 'redo takes it away again');

  assert.equal((await q.undo()).ok, true);
  assert.equal(fs.existsSync(file), true, 'and undo still works after a redo');
});

test('one undo covers a whole batch', async () => {
  // The operation, not the file, is the unit: binning 107 folders and pressing
  // ⌘Z once has to bring back all 107.
  const q = await freshQuarantine();
  const files = Array.from({ length: 12 }, () => makeFile('batch'));
  const res = await q.deleteMany(files.map(target));
  assert.equal(res.moved.length, 12);
  assert.ok(files.every((f) => !fs.existsSync(f)));

  await q.undo();
  assert.ok(files.every((f) => fs.existsSync(f)), 'all twelve came back in one step');
});

test('a restore never overwrites whatever took the name', async () => {
  const q = await freshQuarantine();
  const file = makeFile('original');
  await q.deleteMany([target(file)]);
  fs.writeFileSync(file, 'something new');

  const res = await q.restore([q.live()[0].id]);
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'something new', 'the newcomer is untouched');
  const beside = fs.readdirSync(WORK).find((n) => n.includes('(restored'));
  assert.ok(beside, 'and the restored copy lands beside it');
  assert.equal(fs.readFileSync(path.join(WORK, beside), 'utf8'), 'original');
});

test('the manifest survives a restart', async () => {
  const q = await freshQuarantine();
  const file = makeFile('persisted');
  await q.deleteMany([target(file)]);

  // A second instance is what the app does on relaunch: same manifest, no
  // shared memory.
  const reopened = await new Quarantine().init();
  assert.equal(reopened.reclaimable().count, q.reclaimable().count);
  assert.equal(reopened.summary().canUndo, true, 'undo is still available tomorrow');
  assert.equal((await reopened.undo()).ok, true);
  assert.equal(fs.existsSync(file), true);
});

test('purge is the one door that does not open again', async () => {
  const q = await freshQuarantine();
  const file = makeFile('doomed');
  await q.deleteMany([target(file)]);
  const entry = q.live()[0];

  const res = await q.purge([entry.id]);
  assert.equal(res.ok, true);
  assert.equal(res.freed, 4096);
  assert.equal(fs.existsSync(entry.quarantinePath), false, 'the copy is gone');
  assert.equal(fs.existsSync(file), false, 'and so is the original');
  assert.equal(q.reclaimable().count, 0);
  assert.equal(q.summary().canUndo, false, 'purging clears the undo stack');
});

test('an entry whose copy vanished is dropped, not offered as an undo', async () => {
  // Someone emptying the quarantine folder by hand used to leave the app
  // promising an undo it could not deliver.
  const q = await freshQuarantine();
  const file = makeFile('vanishing');
  await q.deleteMany([target(file)]);
  fs.rmSync(q.live()[0].holder, { recursive: true, force: true });

  const reopened = await new Quarantine().init();
  assert.equal(reopened.reclaimable().count, 0);
  assert.equal(reopened.summary().canUndo, false);
});

test('the bin refuses to eat itself', async () => {
  const q = await freshQuarantine();
  const entry = path.join(SANDBOX, 'Library', 'Application Support', 'DiskManager', 'quarantine');
  fs.mkdirSync(entry, { recursive: true });
  const res = await q.deleteMany([{ realPath: entry, dsize: 1, asize: 1, items: 0, isDir: true }], { force: true });
  assert.equal(res.moved.length, 0);
  assert.match(res.rejected[0].reason, /quarantine/i);
});
