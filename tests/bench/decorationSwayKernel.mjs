// Same unattached sway math as particleWorker.updateDecorationSway.
// Scan walks maxDecorations. Snapshot walks a compact index list.

import {
  SWAY_OFF,
  SWAY_LOOP,
  SWAY_IMPULSE,
  SWAY_ANGLE_PER_MS,
  IMPULSE_DONE,
  advanceImpulsePhase,
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

export function checksumRot(snapshot, count, rotC, rotS) {
  let sum = 0;
  for (let n = 0; n < count; n++) {
    const i = snapshot[n];
    sum += rotC[i] + rotS[i];
  }
  return sum;
}

export { SWAY_OFF, SWAY_LOOP, SWAY_IMPULSE, NO_PARENT };
