import test from 'node:test';
import assert from 'node:assert/strict';

import { radixSortIndicesBySortKey } from '../../src/util/sortIndexByKey.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

// Reference: plain 4-pass LSD radix on the float-to-ordinal key, one
// histogram per pass. Stable, so equal keys keep their input order.
function referenceSort(idx, n, keysU32) {
  if (n < 2) return;
  let src = idx;
  let dst = new Uint32Array(n);
  const hist = new Uint32Array(256);
  for (let shift = 0; shift < 32; shift += 8) {
    hist.fill(0);
    for (let i = 0; i < n; i++) {
      const u = keysU32[src[i]] >>> 0;
      const ord = (u & 0x80000000) ? ~u : (u | 0x80000000);
      hist[(ord >>> shift) & 255]++;
    }
    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const c = hist[b];
      hist[b] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const id = src[i];
      const u = keysU32[id] >>> 0;
      const ord = (u & 0x80000000) ? ~u : (u | 0x80000000);
      dst[hist[(ord >>> shift) & 255]++] = id;
    }
    [src, dst] = [dst, src];
  }
  if (src !== idx) idx.set(src);
}

function check(keysF32, slots) {
  const keysU32 = new Uint32Array(keysF32.buffer);
  const n = slots.length;
  const a = Uint32Array.from(slots);
  const b = Uint32Array.from(slots);
  referenceSort(a, n, keysU32);
  radixSortIndicesBySortKey(b, n, keysU32, new Uint32Array(Math.max(1, n)), new Uint32Array(256));
  assert.deepEqual(b, a);
}

test('radix order = reference LSD radix on engine-shaped and adversarial keys', () => {
  const rng = mulberry32(0x7ad1);
  const N = 5000;
  const make = (fn) => {
    const k = new Float32Array(N);
    for (let i = 0; i < N; i++) k[i] = fn(i);
    return k;
  };
  const all = [...Array(N).keys()];
  const sets = {
    spriteKeys: make(() => Math.round(rng() * 5000) * 128),
    mixedFractional: make(() => (rng() < 0.2 ? rng() * 5000 * 128 : Math.round(rng() * 5000) * 128)),
    negativesAndZero: make((i) => (i % 7 === 0 ? -0 : (rng() - 0.5) * 1e6)),
    allEqual: make(() => 4096),
    fewDistinct: make(() => [0, 128, 256, -128][(rng() * 4) | 0]),
    zBands: make(() => ((rng() * 3) | 0) * 640128 + Math.round(rng() * 5000) * 128),
  };
  for (const [name, keys] of Object.entries(sets)) {
    const shuffledSlots = all.slice().sort(() => rng() - 0.5);
    const subset = shuffledSlots.filter(() => rng() < 0.6);
    for (const slots of [all, shuffledSlots, subset]) {
      try {
        check(keys, slots);
      } catch (e) {
        e.message = `${name}: ${e.message}`;
        throw e;
      }
    }
  }
});

test('radix handles 0, 1 and 2 slots', () => {
  const keys = new Float32Array([5, -3, 2]);
  check(keys, []);
  check(keys, [2]);
  check(keys, [0, 1]);
  check(keys, [1, 0]);
});
