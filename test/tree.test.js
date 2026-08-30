/**
 * The tree: parsing ncdu's export, and the two things the rest of the app
 * assumes about the result — that sizes roll up, and that a refreshed folder
 * can be swapped in without disturbing anything above it.
 *
 * Every case here is one that actually went wrong during development.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TreeStore, NcduParser, F_HLDUP } from '../server/tree.js';

/** Feed `json` to a parser `chunk` bytes at a time. */
function parse(json, chunk = Infinity) {
  const tree = new TreeStore(64);
  const parser = new NcduParser(tree);
  const buf = Buffer.from(json);
  for (let i = 0; i < buf.length; i += chunk) {
    parser.write(buf.subarray(i, Math.min(i + chunk, buf.length)));
  }
  parser.end();
  tree.aggregate();
  return tree;
}

const EXPORT = JSON.stringify([1, 2, { progname: 'ncdu' }, [
  { name: '/root' },
  { name: 'a.txt', dsize: 4096, asize: 10, mtime: 100 },
  [
    { name: 'sub', mtime: 50 },
    { name: 'b.bin', dsize: 8192, asize: 8000, mtime: 900 },
  ],
]]);

test('parses a whole export in one write', () => {
  const t = parse(EXPORT);
  assert.equal(t.name(0), '/root');
  assert.equal(t.subD[0], 4096 + 8192);
  assert.equal(t.subItems[0], 3);
});

test('parses identically one byte at a time', () => {
  // The export is tailed while ncdu is still writing it, so a record can be
  // split anywhere at all. This is the property that makes that safe.
  const whole = parse(EXPORT);
  const drip = parse(EXPORT, 1);
  assert.equal(drip.n, whole.n);
  assert.equal(drip.subD[0], whole.subD[0]);
  assert.deepEqual([...drip.subD.subarray(0, drip.n)], [...whole.subD.subarray(0, whole.n)]);
});

test('survives quotes, braces and brackets inside filenames', () => {
  // These are structural characters to the scanner that finds record
  // boundaries, so a filename containing them is the classic way to break it.
  const nasty = 'we"ird {name} [2] \\ end.txt';
  const json = JSON.stringify([1, 2, {}, [
    { name: '/root' },
    { name: nasty, dsize: 512, asize: 1, mtime: 1 },
  ]]);
  for (const chunk of [Infinity, 7, 1]) {
    const t = parse(json, chunk);
    assert.equal(t.n, 2, `chunk size ${chunk}`);
    assert.equal(t.name(1), nasty, `chunk size ${chunk}`);
  }
});

test('a hardlinked file is counted once', () => {
  const json = JSON.stringify([1, 2, {}, [
    { name: '/root' },
    { name: 'first', dsize: 4096, asize: 4000, mtime: 1, ino: 7, hlnkc: true },
    { name: 'second', dsize: 4096, asize: 4000, mtime: 1, ino: 7, hlnkc: true },
  ]]);
  const t = parse(json);
  assert.equal(t.subD[0], 4096, 'the second link must not add to the total');
  assert.ok(t.flags[2] & F_HLDUP, 'the second link is flagged as a duplicate');
});

test('modified rolls up to the newest change anywhere inside', () => {
  // The bug this guards: a directory's own mtime only moves when an entry is
  // added or removed directly inside it, so `sub` says 1970 while holding a
  // file from 900.
  const t = parse(EXPORT);
  const sub = t.findByPath('/root/sub');
  assert.equal(t.mtime[sub], 50, 'the folder keeps its own date');
  assert.equal(t.subMtime[sub], 900, 'and reports its newest contained change');
  assert.equal(t.subMtime[0], 900, 'which carries to the root');
});

test('findByPath resolves and refuses', () => {
  const t = parse(EXPORT);
  assert.equal(t.findByPath('/root'), 0);
  assert.equal(t.name(t.findByPath('/root/sub/b.bin')), 'b.bin');
  assert.equal(t.findByPath('/root/nope'), -1);
});

test('marking a node deleted subtracts it from every ancestor', () => {
  const t = parse(EXPORT);
  const before = t.subD[0];
  const b = t.findByPath('/root/sub/b.bin');
  t.markDeleted(b, true);
  assert.equal(t.subD[0], before - 8192);
  t.markDeleted(b, false);
  assert.equal(t.subD[0], before, 'and hands it back on restore');
});

test('splicing a refreshed folder corrects every ancestor total', () => {
  const t = parse(EXPORT);
  const sub = t.findByPath('/root/sub');
  const rootBefore = t.subD[0];

  // What a re-measure of /root/sub found: the file grew and gained a sibling.
  const fresh = new TreeStore(8);
  const r = fresh.add(-1, '/root/sub', 1, 0, 0, 60);
  fresh.add(r, 'b.bin', 0, 20480, 20000, 950);
  fresh.add(r, 'c.bin', 0, 1024, 1000, 960);
  fresh.aggregate();

  const at = t.spliceSubtree(sub, fresh);
  assert.ok(at > 0, 'the splice returns the new index');
  assert.equal(t.subD[at], 21504);
  assert.equal(t.subD[0], rootBefore - 8192 + 21504, 'the root reflects the difference');
  assert.equal(t.subMtime[0], 960, 'and the newest-change rollup is recomputed');
  assert.equal(t.findByPath('/root/sub'), at, 'the path now resolves to the new node');
  assert.equal(t.name(t.findByPath('/root/sub/c.bin')), 'c.bin');
  assert.ok(t.isStale(sub), 'the replaced branch is flagged, not left reachable');
});

test('a whole-array walk can tell the replaced branch apart', () => {
  // Junk finder and search both walk by index rather than by child links; if
  // they did not skip stale nodes, everything inside a refreshed folder would
  // be reported twice, at two different sizes.
  const t = parse(EXPORT);
  const sub = t.findByPath('/root/sub');
  const fresh = new TreeStore(4);
  const r = fresh.add(-1, '/root/sub', 1, 0, 0, 60);
  fresh.add(r, 'b.bin', 0, 1, 1, 1);
  fresh.aggregate();
  t.spliceSubtree(sub, fresh);

  let live = 0;
  for (let i = 1; i < t.n; i++) if (!t.isStale(i) && t.nameIs(i, 'b.bin')) live++;
  assert.equal(live, 1);
});
