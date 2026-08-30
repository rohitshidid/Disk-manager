/**
 * The gate every removal goes through.
 *
 * `screenTargets()` is the single reason "the bin refuses this" and "the Trash
 * refuses this" cannot drift apart, so its verdicts are worth pinning down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assess, screenTargets, privacyRefusal } from '../server/safety.js';

const HOME = os.homedir();
const GIB = 1024 ** 3;

test('system roots and SIP trees can never be removed', () => {
  for (const p of ['/', '/System', '/usr', '/Users', '/Volumes', HOME]) {
    assert.equal(assess(p).level, 'blocked', p);
  }
  for (const p of ['/System/Library/Fonts', '/usr/bin/env', '/bin/sh', '/private/var/db/x']) {
    assert.equal(assess(p).level, 'blocked', p);
  }
});

test('an ancestor of your home folder is blocked, not merely warned about', () => {
  assert.equal(assess(path.dirname(HOME)).level, 'blocked');
});

test("the app's own quarantine is blocked — it holds the undo history", () => {
  const q = path.join(HOME, 'Library', 'Application Support', 'DiskManager', 'quarantine', 'abc');
  assert.equal(assess(q).level, 'blocked');
});

test('ordinary things in your home folder are ok until they are big', () => {
  const p = path.join(HOME, 'Projects', 'thing');
  assert.equal(assess(p, { size: 1000, items: 3 }).level, 'ok');
  assert.equal(assess(p, { size: 2 * GIB, items: 3 }).level, 'caution');
  assert.equal(assess(p, { size: 1000, items: 50_000 }).level, 'caution');
});

test('anything outside your home folder is danger, whatever its size', () => {
  const v = assess('/opt/homebrew/Cellar/thing', { size: 10 });
  assert.equal(v.level, 'danger');
  assert.ok(v.confirm.length, 'and it says why');
});

test('screenTargets drops targets nested inside other targets', () => {
  // Removing the parent takes the child with it, so a nested target would only
  // fail later, confusingly, as "no longer exists".
  const dir = fs.mkdtempSync(path.join(HOME, '.dm-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'child'), { recursive: true });
    const targets = [
      { realPath: path.join(dir, 'child'), dsize: 10, items: 1 },
      { realPath: dir, dsize: 20, items: 2 },
    ];
    const { kept } = screenTargets(targets);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].realPath, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('screenTargets refuses a path that has since gone', () => {
  const gone = path.join(HOME, '.dm-test-not-here-' + Date.now());
  const { kept, rejected } = screenTargets([{ realPath: gone, dsize: 1, items: 0 }]);
  assert.equal(kept.length, 0);
  assert.match(rejected[0].reason, /No longer exists/);
});

test('screenTargets holds back anything needing confirmation until forced', () => {
  const dir = fs.mkdtempSync(path.join(HOME, '.dm-test-'));
  try {
    const big = [{ realPath: dir, dsize: 5 * GIB, items: 0 }];
    assert.equal(screenTargets(big).kept.length, 0, 'not without confirmation');
    assert.equal(screenTargets(big).rejected[0].level, 'caution');
    assert.equal(screenTargets(big, { force: true }).kept.length, 1, 'and through with it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a privacy refusal is named as one, and only where it applies', () => {
  // These are refusals root cannot lift, so telling them apart from an
  // ordinary permission problem is what keeps the app from spending an admin
  // prompt on a guaranteed no.
  assert.ok(privacyRefusal(path.join(HOME, 'Library', 'Containers', 'com.example.app')));
  assert.ok(privacyRefusal(path.join(HOME, 'Desktop', 'thing')));
  assert.equal(privacyRefusal(path.join(HOME, 'Projects', 'thing')), null);
});
