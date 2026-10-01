import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import {
  bucketFromSwayFrequency,
  swayFrequencyForBucket,
} from '../../src/util/decorationSway.js';
import { tickSwayFormula, buildPhaseTables } from '../bench/decorationSwayKernel.mjs';

test('sway frequency grid round-trips every bucket', () => {
  for (const k of [32, 100]) {
    for (let b = 0; b < k; b++) {
      const f = swayFrequencyForBucket(b, k);
      assert.equal(bucketFromSwayFrequency(f, k), b);
      assert.ok(f >= 1 && f <= 3 + 1e-12);
    }
  }
});

test('bucket sway stays within 1e-3 of Math.sin; the sin path matches itself', () => {
  const n = 64;
  const k = 100;
  const sab = new SharedArrayBuffer(DecorationComponent.getBufferSize(n));
  DecorationComponent.initializeArrays(sab, n);
  const phase = buildPhaseTables(n);
  const sA = new Float32Array(k);
  const cA = new Float32Array(k);
  const snapshot = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    snapshot[i] = i;
    DecorationComponent.baseRotC[i] = 1;
    DecorationComponent.baseRotS[i] = 0;
    DecorationComponent.swayAmplitude[i] = 0.06;
    DecorationComponent.swayFrequency[i] = swayFrequencyForBucket(i % k, k);
  }
  const soa = {
    swayFrequency: DecorationComponent.swayFrequency,
    swayAmplitude: DecorationComponent.swayAmplitude,
    baseRotC: DecorationComponent.baseRotC,
    baseRotS: DecorationComponent.baseRotS,
    rotC: DecorationComponent.rotC,
    rotS: DecorationComponent.rotS,
  };
  const angle = 2.5;
  tickSwayFormula(snapshot, n, angle, soa, {});
  const refC = Float32Array.from(DecorationComponent.rotC.subarray(0, n));
  const refS = Float32Array.from(DecorationComponent.rotS.subarray(0, n));
  tickSwayFormula(snapshot, n, angle, soa, {});
  for (let i = 0; i < n; i++) {
    assert.equal(DecorationComponent.rotC[i], refC[i]);
    assert.equal(DecorationComponent.rotS[i], refS[i]);
  }
  tickSwayFormula(snapshot, n, angle, soa, {
    buckets: k,
    sA,
    cA,
    phaseSin: phase.phaseSin,
    phaseCos: phase.phaseCos,
  });
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(DecorationComponent.rotC[i] - refC[i]) <= 1e-3);
    assert.ok(Math.abs(DecorationComponent.rotS[i] - refS[i]) <= 1e-3);
  }
});
