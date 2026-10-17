// Scene clock. One Float32 on a SAB. 1 is real time, 0 is a hitstop.
// Wall FPS and STEP_MS do not read this. Input and the audio mixer do not either.

/** Index of the scale inside `clockData`. */
export const TIME_SCALE_INDEX = 0;

/**
 * Non-finite becomes 1 so a torn or unset slot does not freeze the sim.
 * Negative becomes 0 (hitstop). Infinity becomes 0 so a bad write cannot
 * hand Box2D an unbounded step.
 * @param {number} scale
 * @returns {number}
 */
export function sanitizeTimeScale(scale) {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1;
  if (scale <= 0) return 0;
  return scale;
}

/**
 * Sim milliseconds from an unscaled step. `scale` is sanitized.
 * @param {number} simMs
 * @param {number} scale
 * @returns {number}
 */
export function scaleSimMs(simMs, scale) {
  return simMs * sanitizeTimeScale(scale);
}

/** Shared clock. Each realm (main, worker, physics host) binds the same SAB. */
export class Time {
  /** @type {Float32Array | null} */
  static view = null;

  /**
   * @param {SharedArrayBuffer | ArrayBuffer | null} sab
   */
  static bind(sab) {
    if (!sab) {
      this.view = null;
      return;
    }
    this.view = new Float32Array(sab);
  }

  static unbind() {
    this.view = null;
  }

  /** Sanitized scale. Unbound clock is 1. */
  static get scale() {
    const view = this.view;
    if (!view) return 1;
    return sanitizeTimeScale(view[TIME_SCALE_INDEX]);
  }

  /** Writes a sanitized scale. No-op when the clock is unbound. */
  static set scale(value) {
    const view = this.view;
    if (!view) return;
    view[TIME_SCALE_INDEX] = sanitizeTimeScale(value);
  }

  /**
   * @param {number} simMs
   * @returns {number}
   */
  static scaleSimMs(simMs) {
    return simMs * this.scale;
  }
}
