import test from 'node:test';
import assert from 'node:assert/strict';

import { Noise2D } from '../../src/core/Noise2D.js';

test('sample is deterministic for the same seed', () => {
  const a = new Noise2D(42);
  const b = new Noise2D(42);
  assert.equal(a.sample(1.25, 3.5), b.sample(1.25, 3.5));
  assert.equal(a.fbm(8, 2, 4, 0.1), b.fbm(8, 2, 4, 0.1));
});

test('different seeds change the field', () => {
  const a = new Noise2D(1);
  const b = new Noise2D(2);
  assert.notEqual(a.sample(10.5, 0.25), b.sample(10.5, 0.25));
});

test('sample stays in a bounded range near [-1, 1]', () => {
  const n = new Noise2D(7);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 400; i++) {
    const v = n.sample(i * 0.17, i * 0.09);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert.ok(min >= -1.6 && max <= 1.6, `range ${min}..${max}`);
  assert.ok(min < 0 && max > 0);
});

test('fillHeight1D writes into the caller buffer', () => {
  const n = new Noise2D(9);
  const out = new Float32Array(8);
  const same = n.fillHeight1D(out, 0, 0.5, 8, 2);
  assert.equal(same, out);
  assert.equal(out[0], n.sample(0, 2));
  assert.equal(out[3], n.sample(1.5, 2));
});

test('static facade matches a seeded instance', () => {
  Noise2D.seed(99);
  const inst = new Noise2D(99);
  assert.equal(Noise2D.sample(4.5, 1.25), inst.sample(4.5, 1.25));
});
