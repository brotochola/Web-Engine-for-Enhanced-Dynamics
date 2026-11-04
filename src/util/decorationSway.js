// decorationSway.js - Shared sway mode constants + impulse phase step

/** No sway */
export const SWAY_OFF = 0;
/** Continuous loop (sin of accumulated time) */
export const SWAY_LOOP = 1;
/** One-shot half-sine 0→π then auto-clear */
export const SWAY_IMPULSE = 2;
/** Loop whose angle is a shear. Worker writes this into rotC; rotS holds the angle. */
export const SWAY_LOOP_SKEW = 3;
/** Not a cosine (|c| ≤ 1) and under the shadow discard (|c| > 2). */
export const SWAY_SKEW_C = 1.5;

/** DX-DECOSKEW: how far the marker goes from SWAY_SKEW_C, so it stays in (1.01, 1.99): past SKEW_C_MIN, short of 2. */
export const SKEW_C_SPAN = 0.49;
/**
 * DX-DECOSKEW: the sprite shader reads a facing whose cosine passes this as a shear. Not 1: a turned facing is not
 * always a unit pair. The sway composes an angle under 0.08 rad as (1, delta), to spare the cosine, so a swayed facing
 * reaches c = √(1 + 0.08²) ≈ 1.0032, and read as a shear that is a slope in the hundreds: a line across the screen.
 */
export const SKEW_C_MIN = 1.005;
/** A larger shear than this is held here (the marker is then a few float32 steps from its end). */
const SKEW_MAX = 1e6;

/**
 * DX-DECOSKEW. The facing a sheared decoration is drawn with: rotC (c) past SKEW_C_MIN says "shear, not turn", as a shear
 * sway's SWAY_SKEW_C does, and its distance from SWAY_SKEW_C carries the vertical shear, c = 1.5 + SPAN · t with
 * t = skewY / (1 + |skewY|) in (−1, 1). The sprite shader reads it back with one division and no trigonometry:
 * t = (c − 1.5) / SPAN, skewY = t / (1 − |t|). rotS carries the horizontal one (skewX). At skewY 0 it is SWAY_SKEW_C
 * itself. 0 when there is no shear at all.
 * @param {number} skewX
 * @param {number} skewY
 * @returns {number}
 */
export function skewMarkerC(skewX, skewY) {
  if (skewX === 0 && skewY === 0) return 0;
  const ky = skewY > SKEW_MAX ? SKEW_MAX : skewY < -SKEW_MAX ? -SKEW_MAX : skewY;
  return SWAY_SKEW_C + (SKEW_C_SPAN * ky) / (1 + (ky < 0 ? -ky : ky));
}

/** Same scale as continuous: sin(accumulatedTimeMs * 0.002 * freq) */
export const SWAY_ANGLE_PER_MS = 0.002;

/** Sentinel from advanceImpulsePhase: half-cycle finished */
export const IMPULSE_DONE = -1;

/**
 * Advance one-shot impulse phase. Zero-alloc (returns number only).
 * @param {number} phase - Current phase radians
 * @param {number} deltaTimeMs
 * @param {number} frequency
 * @returns {number} next phase, or IMPULSE_DONE (-1) when phase would reach π
 */
export function advanceImpulsePhase(phase, deltaTimeMs, frequency) {
  const next = phase + deltaTimeMs * SWAY_ANGLE_PER_MS * frequency;
  return next >= Math.PI ? IMPULSE_DONE : next;
}

/** Grass grid: 1..3 inclusive. Bucket 0 is 1, bucket K-1 is 3. */
export function swayFrequencyForBucket(bucket, k) {
  return 1 + bucket * (2 / (k - 1));
}

export function bucketFromSwayFrequency(freq, k) {
  const step = 2 / (k - 1);
  let b = Math.round((freq - 1) / step);
  if (b < 0) b = 0;
  if (b > k - 1) b = k - 1;
  return b;
}
