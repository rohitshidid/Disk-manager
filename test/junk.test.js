/**
 * The junk sweep, and the excludes guard.
 *
 * The de-duplication rules are the whole reason the totals mean anything: a
 * `__pycache__` inside a flagged `.venv` counted twice would overstate what a
 * purge frees, and queue a delete that must fail because its parent went first.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { TreeStore, F_DIR } from '../server/tree.js';
import { findJunk } from '../server/junk.js';

const HOME = os.homedir();

/** Build a tree by path, the way a scan would have produced it. */
function treeFrom(entries) {
  const t = new TreeStore(64);
  t.add(-1, '/System/Volumes/Data', F_DIR, 0, 0, 0);
  const index = new Map([['', 0]]);
  for (const [rel, size, isDir = true] of entries) {
    const parts = rel.split('/');
    let parentKey = '';
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (index.has(key)) { parentKey = key; continue; }
      const last = i === parts.length - 1;
      const idx = t.add(index.get(parentKey), parts[i],
        last && !isDir ? 0 : F_DIR, last ? size : 0, last ? size : 0, 1000);
      index.set(key, idx);
      parentKey = key;
    }
  }
  t.aggregate();
  return t;
}

const rel = (p) => path.join(HOME, p).replace(/^\//, '');
const MB = 1024 * 1024;

test('a hit inside another hit is counted once', () => {
  const t = treeFrom([
    [rel('proj/.venv/lib/__pycache__/x.pyc'), 40 * MB, false],
  ]);
  const { categories, total } = findJunk(t);
  const ids = categories.map((c) => c.id);
  assert.deepEqual(ids, ['venv'], 'the outer hit wins; the nested one is dropped');
  assert.equal(total, 40 * MB, 'and the bytes are not counted twice');
});

test('a nested node_modules is not reported separately from its parent', () => {
  const t = treeFrom([
    [rel('proj/node_modules/pkg/node_modules/dep/a.js'), 30 * MB, false],
  ]);
  const cat = findJunk(t).categories.find((c) => c.id === 'node_modules');
  assert.equal(cat.count, 1);
  assert.match(cat.items[0].path, /proj\/node_modules$/);
});

test('anything under a megabyte is left out', () => {
  const t = treeFrom([[rel('proj/__pycache__/x.pyc'), 400 * 1024, false]]);
  assert.equal(findJunk(t).categories.length, 0);
});

test('the branch a refresh replaced is not swept', () => {
  const t = treeFrom([[rel('proj/node_modules/a.js'), 30 * MB, false]]);
  const nm = t.findByPath(path.join(HOME, 'proj/node_modules'));
  const fresh = new TreeStore(4);
  const r = fresh.add(-1, 'node_modules', F_DIR, 0, 0, 1000);
  fresh.add(r, 'a.js', 0, 5 * MB, 5 * MB, 1000);
  fresh.aggregate();
  t.spliceSubtree(nm, fresh);

  const cat = findJunk(t).categories.find((c) => c.id === 'node_modules');
  assert.equal(cat.count, 1, 'reported once, not once per copy of the branch');
  assert.equal(cat.size, 5 * MB, 'at the size the refresh measured');
});
