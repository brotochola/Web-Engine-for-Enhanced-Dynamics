// Same unattached sway math as particleWorker.updateDecorationSway.
// Scan walks maxDecorations. Snapshot walks a compact index list.

import {
  SWAY_OFF,
  SWAY_LOOP,
  SWAY_IMPULSE,
  SWAY_ANGLE_PER_MS,
  IMPULSE_DONE,
  advanceImpulsePhase,
  swayFrequencyForBucket,
  bucketFromSwayFrequency,
} from '../../src/util/decorationSway.js';

const NO_PARENT = 0xffff;

function swaySlot(i, swayBaseAngle, deltaTime, soa) {
  const {
    active,
    sway,
    swayAmplitude,
    swayFrequency,
    swayPhase,
    rotC,
    rotS,
    baseRotC,
    baseRotS,
    parentEntityIndex,
  } = soa;
  if (!active[i]) return;
  if (parentEntityIndex && parentEntityIndex[i] !== NO_PARENT) return;
  const mode = sway[i];
  if (mode === SWAY_OFF) return;
  const bc = baseRotC[i];
  const bs = baseRotS[i];
  let delta = 0;
  if (mode === SWAY_LOOP) {
    delta = Math.sin(swayBaseAngle * swayFrequency[i] + i * 0.1) * swayAmplitude[i];
  } else if (mode === SWAY_IMPULSE) {
    const nextPhase = advanceImpulsePhase(swayPhase[i], deltaTime, swayFrequency[i]);
    if (nextPhase === IMPULSE_DONE) {
      sway[i] = SWAY_OFF;
      swayPhase[i] = 0;
      rotC[i] = bc;
      rotS[i] = bs;
      return;
    }
    swayPhase[i] = nextPhase;
    delta = Math.sin(nextPhase) * swayAmplitude[i];
  }
  if (delta !== 0) {
    const ad = delta < 0 ? -delta : delta;
    const dc = ad < 0.08 ? 1 : Math.cos(delta);
    const ds = ad < 0.08 ? delta : Math.sin(delta);
    rotC[i] = bc * dc - bs * ds;
    rotS[i] = bs * dc + bc * ds;
  } else {
    rotC[i] = bc;
    rotS[i] = bs;
  }
}

/**
 * @param {'scan'|'snapshot'} mode
 * @returns {void}
 */
export function tickDecorationSwayBuffers(mode, soa, opts) {
  const maxDecorations = opts.maxDecorations | 0;
  const snapshot = opts.snapshot;
  const snapshotCount = opts.snapshotCount | 0;
  const accumulatedTimeMs = opts.accumulatedTimeMs || 0;
  const deltaTime = opts.deltaTime || 16.6667;
  const swayBaseAngle = accumulatedTimeMs * SWAY_ANGLE_PER_MS;
  if (mode === 'snapshot') {
    for (let idx = 0; idx < snapshotCount; idx++) {
      swaySlot(snapshot[idx], swayBaseAngle, deltaTime, soa);
    }
    return;
  }
  for (let i = 0; i < maxDecorations; i++) {
    swaySlot(i, swayBaseAngle, deltaTime, soa);
  }
}

const TAU = Math.PI * 2;
const LUT_N = 1024;

export function buildPhaseTables(n) {
  const phaseSin = new Float32Array(n);
  const phaseCos = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 0.1;
    phaseSin[i] = Math.sin(p);
    phaseCos[i] = Math.cos(p);
  }
  return { phaseSin, phaseCos };
}

export function buildSinLut() {
  const lut = new Float32Array(LUT_N + 1);
  for (let i = 0; i <= LUT_N; i++) lut[i] = Math.sin((i / LUT_N) * TAU);
  return lut;
}

function lutSin(lut, x) {
  let u = x % TAU;
  if (u < 0) u += TAU;
  const i = (u * (LUT_N / TAU)) | 0;
  const t = u * (LUT_N / TAU) - i;
  return lut[i] + (lut[i + 1] - lut[i]) * t;
}

function composeDelta(i, delta, soa) {
  const bc = soa.baseRotC[i];
  const bs = soa.baseRotS[i];
  if (delta !== 0) {
    const ad = delta < 0 ? -delta : delta;
    const dc = ad < 0.08 ? 1 : Math.cos(delta);
    const ds = ad < 0.08 ? delta : Math.sin(delta);
    soa.rotC[i] = bc * dc - bs * ds;
    soa.rotS[i] = bs * dc + bc * ds;
  } else {
    soa.rotC[i] = bc;
    soa.rotS[i] = bs;
  }
}

/**
 * One frame of on-screen loop sway.
 * `lut` set: sin from a 1024-entry table, still one lookup per blade.
 * `buckets` set: sin(A*f) once per frequency, phase tables once per index.
 */
export function tickSwayFormula(snapshot, count, swayBaseAngle, soa, mode) {
  if (mode.buckets) {
    const k = mode.buckets;
    const sA = mode.sA;
    const cA = mode.cA;
    const step = 2 / (k - 1);
    for (let b = 0; b < k; b++) {
      const a = swayBaseAngle * (1 + b * step);
      sA[b] = Math.sin(a);
      cA[b] = Math.cos(a);
    }
    const phaseSin = mode.phaseSin;
    const phaseCos = mode.phaseCos;
    const freq = soa.swayFrequency;
    const amp = soa.swayAmplitude;
    for (let n = 0; n < count; n++) {
      const i = snapshot[n];
      const b = bucketFromSwayFrequency(freq[i], k);
      const delta = (sA[b] * phaseCos[i] + cA[b] * phaseSin[i]) * amp[i];
      composeDelta(i, delta, soa);
    }
    return;
  }
  const lut = mode.lut;
  const freq = soa.swayFrequency;
  const amp = soa.swayAmplitude;
  for (let n = 0; n < count; n++) {
    const i = snapshot[n];
    const angle = swayBaseAngle * freq[i] + i * 0.1;
    const delta = (lut ? lutSin(lut, angle) : Math.sin(angle)) * amp[i];
    composeDelta(i, delta, soa);
  }
}

export function checksumRot(snapshot, count, rotC, rotS) {
  let sum = 0;
  for (let n = 0; n < count; n++) {
    const i = snapshot[n];
    sum += rotC[i] + rotS[i];
  }
  return sum;
}

export { SWAY_OFF, SWAY_LOOP, SWAY_IMPULSE, NO_PARENT, swayFrequencyForBucket, bucketFromSwayFrequency };
