import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { mulberry32 } from '../bench/benchMath.js';

// E-66. The light sorts' comparators returned `a - b`, a double that is boxed on
// its way back to the sort (a heap number per comparison in Chrome). They now
// return ±1, or the difference itself when it is ±0 or NaN. Same sign for every
// pair, so the order is the same, NaN keys and ties included, through
// Array.prototype.sort and through _sortPrefix's insertion and merge paths.

const oldY = (a, b) => Transform.y[a] - Transform.y[b];
const oldStamp = (a, b) => a.distSq - b.distSq || a.id - b.id;

function key(rng) {
  const r = rng();
  if (r < 0.05) return NaN;
  if (r < 0.1) return -0;
  if (r < 0.15) return 0;
  if (r < 0.4) return Math.round(rng() * 20);
  return (rng() - 0.5) * 2000;
}

test('the light Y order sorts exactly as the old comparator', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const rng = mulberry32(0xe66);
  Transform.y = new Float32Array(4096);
  for (const n of [2, 5, 40, 64, 65, 200, 900]) {
    for (let trial = 0; trial < 6; trial++) {
      for (let i = 0; i < Transform.y.length; i++) Transform.y[i] = key(rng);
      const ids = Array.from({ length: n }, () => (rng() * 4096) | 0);
      // A full array goes to Array.prototype.sort; a prefix of a pooled one to
      // the insertion or merge sort.
      for (const pooled of [false, true]) {
        const a = pooled ? [...ids, -1, -2] : [...ids];
        const b = [...a];
        pre._sortPrefix(a, n, pre._lightYComparator);
        pre._sortPrefix(b, n, oldY);
        assert.deepEqual(a, b, `n ${n} trial ${trial} pooled ${pooled}`);
      }
    }
  }
});

test('the stamp light order sorts exactly as the old comparator', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const rng = mulberry32(0x66e);
  for (const n of [2, 7, 64, 65, 300]) {
    for (let trial = 0; trial < 6; trial++) {
      const lights = Array.from({ length: n }, (_, id) => ({ id, distSq: key(rng) }));
      for (const pooled of [false, true]) {
        const a = pooled ? [...lights, { id: -1, distSq: 0 }] : [...lights];
        const b = [...a];
        pre._sortPrefix(a, n, pre._stampLightCmp);
        pre._sortPrefix(b, n, oldStamp);
        assert.deepEqual(a.map((l) => l.id), b.map((l) => l.id), `n ${n} trial ${trial} pooled ${pooled}`);
      }
    }
  }
});

test('the light orders return small integers for distinct keys', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  Transform.y = Float32Array.of(1.25, 3.5, 3.5);
  assert.equal(pre._lightYComparator(0, 1), -1);
  assert.equal(pre._lightYComparator(1, 0), 1);
  assert.equal(pre._lightYComparator(1, 2), 0);
  assert.equal(pre._stampLightCmp({ id: 4, distSq: 2.5 }, { id: 1, distSq: 0.75 }), 1);
  assert.equal(pre._stampLightCmp({ id: 4, distSq: 2.5 }, { id: 1, distSq: 2.5 }), 3);
});
