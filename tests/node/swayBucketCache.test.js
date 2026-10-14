import test from 'node:test';
import assert from 'node:assert/strict';

import {
  swayFrequencyForBucket,
  bucketFromSwayFrequency,
} from '../../src/util/decorationSway.js';

/**
 * H-10 structural change: the sway hot loop no longer calls
 * `bucketFromSwayFrequency` per decoration per frame. It reads a self-validating
 * cache instead - two typed-array reads and a compare, replacing a division, a
 * `Math.round` and two clamps.
 *
 * The cache is validated against the frequency it was derived from, so it is
 * correct on the same frame a frequency changes. These tests pin that claim,
 * because a stale bucket is a decoration swaying at the wrong frequency: it
 * looks fine in a screenshot and is invisible in a benchmark.
 */

/** The cached lookup, as implemented in particleWorker. */
function cachedLookup(bucketOf, bucketFreq, i, f, k) {
  let b = bucketOf[i];
  if (bucketFreq[i] !== f) {
    b = bucketFromSwayFrequency(f, k);
    bucketOf[i] = b;
    bucketFreq[i] = f;
  }
  return b;
}

function newCache(n) {
  return {
    bucketOf: new Uint16Array(n),
    bucketFreq: new Float32Array(n).fill(-1),
  };
}

/**
 * Compare as an array index rather than as a number.
 *
 * `bucketFromSwayFrequency` can return **-0**: `Math.round(-0.3)` is `-0`, and
 * the `b < 0` clamp does not fire because `-0 < 0` is false. No typed array can
 * store a negative zero, so the cache hands back `0`.
 *
 * That normalisation is safe and is the reason it is allowed: `b` is only ever
 * used to index `sA`/`cA`, and `arr[-0]` is the same slot as `arr[0]`. Asserting
 * `Object.is` identity here would be asserting the cache preserves a signed zero
 * that has no effect on any output - while missing the case that does matter,
 * which is `k > 255`.
 */
function assertSameBucket(actual, want, msg) {
  // `===` and not `Object.is`: `0 === -0` is true, which is exactly the property
  // that makes the -0 -> 0 normalisation harmless. `assert.equal` under
  // node:assert/strict IS Object.is, so using it here would assert the cache
  // preserves a signed zero that changes no output.
  assert.ok(actual === want, `${msg}: got ${actual}, want ${want}`);
}

test('a cold cache matches the reference for every bucket grid value', () => {
  for (const k of [2, 3, 4, 5, 8, 16]) {
    const { bucketOf, bucketFreq } = newCache(k);
    for (let b = 0; b < k; b++) {
      const f = swayFrequencyForBucket(b, k);
      const got = cachedLookup(bucketOf, bucketFreq, b, f, k);
      assert.equal(got, b, `k=${k} bucket ${b} (freq ${f})`);
    }
  }
});

test('a warm cache matches the reference across a dense frequency sweep', () => {
  // The whole point of the cache is the steady state, so the second pass is the
  // one that matters. Sweep past the grid points too, since swayFrequency is
  // writable at runtime and need not land on a bucket boundary.
  for (const k of [2, 3, 5, 8]) {
    const { bucketOf, bucketFreq } = newCache(512);
    const freqs = [];
    for (let b = 0; b < k; b++) freqs.push(swayFrequencyForBucket(b, k));
    for (let i = 0; i < 512; i++) freqs.push(0.5 + (i / 512) * 3);

    // First pass populates, second pass is the steady state being optimised.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < freqs.length; i++) {
        const want = bucketFromSwayFrequency(freqs[i], k);
        assertSameBucket(
          cachedLookup(bucketOf, bucketFreq, i, freqs[i], k),
          want,
          `k=${k} i=${i} f=${freqs[i]} pass=${pass}`,
        );
      }
    }
  }
});

test('changing a frequency mid-flight is correct on the SAME frame', () => {
  // The failure a cross-file invalidation contract would have: the decoration
  // keeps swaying at the old bucket for some number of frames after its
  // frequency changes, and nothing notices.
  const k = 4;
  const { bucketOf, bucketFreq } = newCache(1);
  const f0 = swayFrequencyForBucket(0, k);
  assert.equal(cachedLookup(bucketOf, bucketFreq, 0, f0, k), 0);

  // Same index, new frequency. Must reflect immediately.
  const f2 = swayFrequencyForBucket(2, k);
  assert.equal(cachedLookup(bucketOf, bucketFreq, 0, f2, k), 2);

  // And back again, because a decoration can be re-set repeatedly.
  assert.equal(cachedLookup(bucketOf, bucketFreq, 0, f0, k), 0);
});

test('the sentinel forces a miss on first read for every index', () => {
  // A zero-initialised cache would look valid and silently return bucket 0 for
  // everything on the first frame - the bug the -1 sentinel exists to prevent.
  const k = 5;
  const { bucketOf, bucketFreq } = newCache(16);
  for (let i = 0; i < 16; i++) {
    const f = swayFrequencyForBucket(k - 1, k);
    assert.equal(bucketFreq[i], -1, `index ${i} must start invalidated`);
    assert.equal(cachedLookup(bucketOf, bucketFreq, i, f, k), k - 1);
    assert.equal(bucketFreq[i], f);
  }
});

test('Float32 storage of the frequency does not cause false misses or wrong hits', () => {
  // `_swayBucketFreq` is a Float32Array but `swayFrequency` may hold float64.
  // A frequency that is not representable in float32 will compare unequal every
  // frame - that is a wasted recompute, never a wrong answer. What must not
  // happen is a *hit* on a different frequency.
  const k = 4;
  const { bucketOf, bucketFreq } = newCache(1);
  const f = 1 + Math.fround(1 / 3); // not exactly representable
  const first = cachedLookup(bucketOf, bucketFreq, 0, f, k);
  const second = cachedLookup(bucketOf, bucketFreq, 0, f, k);
  // Correctness, not hit rate: both must agree with the reference.
  assert.equal(first, bucketFromSwayFrequency(f, k));
  assert.equal(second, bucketFromSwayFrequency(f, k));
});

test('out-of-range frequencies clamp identically to the reference', () => {
  const k = 4;
  const { bucketOf, bucketFreq } = newCache(8);
  const weird = [-100, -1, 0, 0.4, 3.6, 4, 99];
  for (let i = 0; i < weird.length; i++) {
    assertSameBucket(
      cachedLookup(bucketOf, bucketFreq, i, weird[i], k),
      bucketFromSwayFrequency(weird[i], k),
      `f=${weird[i]}`,
    );
  }
});

test('a bucket grid above 255 does not wrap the cache', () => {
  // The bug this replaced: `swayFrequencyBuckets` is read straight from config
  // with no upper bound (`particleWorker.js:458`), so a Uint8Array cache wrapped
  // for k > 256 and returned another decoration's bucket. A Uint8 cache here
  // gives 299 -> 43: a real decoration swaying at decoration 43's frequency.
  const k = 300;
  const { bucketOf, bucketFreq } = newCache(k);
  for (let b = 0; b < k; b++) {
    const got = cachedLookup(bucketOf, bucketFreq, b, swayFrequencyForBucket(b, k), k);
    assertSameBucket(got, b, `bucket ${b} at k=${k} must not wrap`);
  }
  // Explicitly: the value that would have wrapped under Uint8.
  const f = swayFrequencyForBucket(299, k);
  assert.equal(bucketFromSwayFrequency(f, k), 299);
  assert.equal(cachedLookup(bucketOf, bucketFreq, 299, f, k), 299);
});

test('a changed bucket count invalidates every cached bucket', () => {
  // k is reconfigurable. A cache populated for one k must not survive into
  // another, which is why _swayBucketCacheK exists.
  const cache = newCache(4);
  const k1 = 4;
  for (let b = 0; b < k1; b++) {
    cachedLookup(cache.bucketOf, cache.bucketFreq, b, swayFrequencyForBucket(b, k1), k1);
  }
  // Simulate the reconfigure: the worker fills bucketFreq with -1 when k changes.
  const k2 = 8;
  cache.bucketFreq.fill(-1);
  for (let b = 0; b < k2; b++) {
    assert.equal(
      cachedLookup(cache.bucketOf, cache.bucketFreq, b, swayFrequencyForBucket(b, k2), k2),
      b,
      `bucket ${b} after k changed to ${k2}`,
    );
  }
});