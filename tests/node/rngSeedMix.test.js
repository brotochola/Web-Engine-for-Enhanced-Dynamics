import test from 'node:test';
import assert from 'node:assert/strict';

import { mixSeed, seededRandom } from '../../src/util/utils.js';

test('mixSeed is deterministic and splits main vs worker streams', () => {
  const seed = 123456;
  assert.equal(mixSeed(seed, 'main'), mixSeed(seed, 'main'));
  assert.notEqual(mixSeed(seed, 'main'), mixSeed(seed, 'logic0'));
  assert.notEqual(mixSeed(seed, 'logic0'), mixSeed(seed, 'physics'));

  const main = seededRandom(seed, 'main');
  const logic = seededRandom(seed, 'logic0');
  for (let i = 0; i < 32; i++) {
    assert.notEqual(main(), logic());
  }

  const a = seededRandom(seed, 'logic0');
  const b = seededRandom(seed, 'logic0');
  assert.equal(a(), b());
});

/** The generator as it shipped until 2026-10-22: its state was a closure double that never wrapped. */
function seededRandomBefore(seed, workerId) {
  let t = workerId == null ? seed : mixSeed(seed, workerId);
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reference mulberry32 (Tommy Ettinger's), state wrapped to 32 bits. */
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('seededRandom gives the same numbers as before while the old state was exact', () => {
  for (const [seed, id] of [[123456, 'logic0'], [0x71c7, 'main'], [0, 'uninit'], [42, undefined], [7, 3]]) {
    const now = seededRandom(seed, id);
    const before = seededRandomBefore(seed, id);
    for (let i = 0; i < 100_000; i++) assert.equal(now(), before(), `seed ${seed}/${id}, call ${i}`);
  }
});

test('seededRandom stays mulberry32 past the call where the old state passed 2^53', () => {
  // The old state was a double that grew by 0x6d2b79f5 per call and passed 2^53
  // at call 4,917,760 (for this seed); from there it was no longer mulberry32.
  const seed = mixSeed(0x71c7, 'logic0');
  const now = seededRandom(0x71c7, 'logic0');
  const reference = mulberry32(seed);
  let x = 0;
  let y = 0;
  for (let i = 0; i < 6_000_000; i++) {
    x = now();
    y = reference();
  }
  assert.equal(x, y);
});
