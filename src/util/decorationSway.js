// decorationSway.js - Shared sway mode constants + impulse phase step

/** No sway */
export const SWAY_OFF = 0;
/** Continuous loop (sin of accumulated time) */
export const SWAY_LOOP = 1;
/** One-shot half-sine 0→π then auto-clear */
export const SWAY_IMPULSE = 2;

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
