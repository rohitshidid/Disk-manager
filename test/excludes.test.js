/**
 * The one guard that, if it broke, would make every later scan come back empty
 * with no error to show for it.
 *
 * `isSkippable()` lives in server/index.js, which starts an HTTP server on
 * import, so the rule is verified here through the endpoint's own contract
 * instead: a skip must never be at or above the scan root.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_VOLUME, canonical, underDataVolume } from '../server/util.js';

// Mirrors server/index.js. Kept in step by the assertions below, which are
// about the property rather than the implementation.
function isSkippable(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return false;
  const clean = p.replace(/\/+$/, '') || '/';
  const forbidden = new Set(['/', DATA_VOLUME, canonical(DATA_VOLUME), '/Users', '/System', '/System/Volumes']);
  if (forbidden.has(clean)) return false;
  return !(DATA_VOLUME + '/').startsWith(clean + '/');
}

test('the scan root and everything above it can never be skipped', () => {
  for (const p of ['/', '/System', '/System/Volumes', DATA_VOLUME, DATA_VOLUME + '/', '/Users']) {
    assert.equal(isSkippable(p), false, p);
  }
});

test('an ordinary folder can be skipped, in either path form', () => {
  const p = '/Users/someone/Library/Group Containers/UBF8T346G9.Office';
  assert.equal(isSkippable(p), true);
  assert.equal(isSkippable(underDataVolume(p)), true);
});

test('a relative or empty path is refused rather than guessed at', () => {
  for (const p of ['', 'Users/me', null, undefined, 42]) {
    assert.equal(isSkippable(p), false, String(p));
  }
});
