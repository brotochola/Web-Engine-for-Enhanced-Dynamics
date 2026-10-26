// The JS decoration sway the particle worker ran before decorationSway.wasm took every frame (E-76 W22; close-out
// group B): updateDecorationSway's loop without a frequency grid and _updateDecorationSwayBuckets' on one, as they
// were in src/workers/particleWorker.js. The kernel's parity tests compare it with the worker's sway:
// updateDecorationSwayJs(worker, deltaTime) sways this frame's decorations on a particle worker as the JS did.
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import {
  IMPULSE_DONE,
  SWAY_ANGLE_PER_MS,
  SWAY_IMPULSE,
  SWAY_LOOP,
  SWAY_LOOP_SKEW,
  SWAY_OFF,
  SWAY_SKEW_C,
  advanceImpulsePhase,
  bucketFromSwayFrequency,
  swayFrequencyForBucket,
} from '../../src/util/decorationSway.js';

export function updateDecorationSwayJs(w, deltaTime = 0) {
  if (!w.maxDecorations || w.maxDecorations === 0 || !DecorationComponent.active) return;

  const activeData = w._activeDecorationSnapshot;
  const activeCount = w._activeDecorationSnapshotCount;
  if (activeCount === 0) return;

  const active = DecorationComponent.active;
  const sway = DecorationComponent.sway;
  const swayAmplitude = DecorationComponent.swayAmplitude;
  const swayFrequency = DecorationComponent.swayFrequency;
  const swayPhase = DecorationComponent.swayPhase;
  const rotC = DecorationComponent.rotC;
  const rotS = DecorationComponent.rotS;
  const baseRotC = DecorationComponent.baseRotC;
  const baseRotS = DecorationComponent.baseRotS;

  const swayBaseAngle = w.accumulatedTime * SWAY_ANGLE_PER_MS;

  if (w._swayBuckets > 1) {
    swayBucketsJs(w, deltaTime, swayBaseAngle);
    return;
  }

  const parentEntityIndex = DecorationComponent.parentEntityIndex;
  const isItOnScreen = DecorationComponent.isItOnScreen;

  // OPTIMIZED: Iterate over the stable active snapshot instead of maxDecorations.
  for (let idx = 0; idx < activeCount; idx++) {
    const i = activeData[idx];
    if (!active[i]) continue;
    if (parentEntityIndex[i] !== w._noParent) continue;
    if (!isItOnScreen[i]) continue;

    const mode = sway[i];
    if (mode === SWAY_OFF) continue;
    const bc = baseRotC[i];
    const bs = baseRotS[i];
    let delta = 0;
    if (mode === SWAY_LOOP || mode === SWAY_LOOP_SKEW) {
      delta = Math.sin(swayBaseAngle * swayFrequency[i] + i * 0.1) * swayAmplitude[i];
      if (mode === SWAY_LOOP_SKEW) {
        rotC[i] = SWAY_SKEW_C;
        rotS[i] = delta;
        continue;
      }
    } else if (mode === SWAY_IMPULSE) {
      const nextPhase = advanceImpulsePhase(swayPhase[i], deltaTime, swayFrequency[i]);
      if (nextPhase === IMPULSE_DONE) {
        sway[i] = SWAY_OFF;
        swayPhase[i] = 0;
        rotC[i] = bc;
        rotS[i] = bs;
        continue;
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
}

/**
 * Same loop as updateDecorationSway, but SWAY_LOOP uses the frequency grid.
 * Chosen once per frame so the hot path has no fallback into Math.sin.
 */
export function swayBucketsJs(w, deltaTime, swayBaseAngle) {
  const activeData = w._activeDecorationSnapshot;
  const activeCount = w._activeDecorationSnapshotCount;
  const active = DecorationComponent.active;
  const sway = DecorationComponent.sway;
  const swayAmplitude = DecorationComponent.swayAmplitude;
  const swayFrequency = DecorationComponent.swayFrequency;
  const swayPhase = DecorationComponent.swayPhase;
  const rotC = DecorationComponent.rotC;
  const rotS = DecorationComponent.rotS;
  const baseRotC = DecorationComponent.baseRotC;
  const baseRotS = DecorationComponent.baseRotS;
  const parentEntityIndex = DecorationComponent.parentEntityIndex;
  const isItOnScreen = DecorationComponent.isItOnScreen;
  const k = w._swayBuckets;
  const sA = w._bucketSin;
  const cA = w._bucketCos;
  const phaseSin = w._phaseSin;
  const phaseCos = w._phaseCos;
  for (let b = 0; b < k; b++) {
    const a = swayBaseAngle * swayFrequencyForBucket(b, k);
    sA[b] = Math.sin(a);
    cA[b] = Math.cos(a);
  }
  // A reconfigured bucket count invalidates every cached bucket at once.
  if (w._swayBucketCacheK !== k) {
    w._swayBucketCacheK = k;
    w._swayBucketFreq.fill(-1);
  }
  const bucketOf = w._swayBucketOf;
  const bucketFreq = w._swayBucketFreq;
  const noParent = w._noParent;

  for (let idx = 0; idx < activeCount; idx++) {
    const i = activeData[idx];
    if (!active[i]) continue;
    if (parentEntityIndex[i] !== noParent) continue;
    if (!isItOnScreen[i]) continue;

    const mode = sway[i];
    if (mode === SWAY_OFF) continue;
    const bc = baseRotC[i];
    const bs = baseRotS[i];
    let delta = 0;
    if (mode === SWAY_LOOP || mode === SWAY_LOOP_SKEW) {
      // Self-validating bucket cache.
      //
      // `bucketFromSwayFrequency` recomputes `2 / (k - 1)`, then divides,
      // rounds and clamps - per decoration, per frame. The loop above already
      // hoists the sin/cos for exactly this reason ("chosen once per frame so
      // the hot path has no fallback into Math.sin"), and this call was the
      // same mistake one layer down.
      //
      // A steady state hit is two typed-array reads and a float compare,
      // replacing a division. A miss recomputes and revalidates, so a
      // decoration whose swayFrequency changed is correct on the same frame it
      // changes - there is no window in which the cache is wrong.
      const f = swayFrequency[i];
      let b = bucketOf[i];
      if (bucketFreq[i] !== f) {
        b = bucketFromSwayFrequency(f, k);
        bucketOf[i] = b;
        bucketFreq[i] = f;
      }
      delta = (sA[b] * phaseCos[i] + cA[b] * phaseSin[i]) * swayAmplitude[i];
      if (mode === SWAY_LOOP_SKEW) {
        rotC[i] = SWAY_SKEW_C;
        rotS[i] = delta;
        continue;
      }
    } else if (mode === SWAY_IMPULSE) {
      const nextPhase = advanceImpulsePhase(swayPhase[i], deltaTime, swayFrequency[i]);
      if (nextPhase === IMPULSE_DONE) {
        sway[i] = SWAY_OFF;
        swayPhase[i] = 0;
        rotC[i] = bc;
        rotS[i] = bs;
        continue;
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
}
