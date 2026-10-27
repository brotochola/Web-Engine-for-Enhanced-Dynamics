// Scene clock. Float32s on a SAB: the scale (1 is real time, 0 is a hitstop), and whether the editor holds the world.
// Wall FPS and STEP_MS do not read this. Input and the audio mixer do not either.

/** Index of the scale inside `clockData`. */
export const TIME_SCALE_INDEX = 0;
/** Index of the editor's hold inside `clockData` (VISUAL_EDITOR_PLAN.md ED-71): 1 while edit mode holds the world. */
export const TIME_HELD_INDEX = 1;

export const MAX_TIME_SCALE = 4.0;

/**
 * Non-finite becomes 1 so a torn or unset slot does not freeze the sim.
 * Negative becomes 0 (hitstop). Values exceeding MAX_TIME_SCALE are clamped
 * to prevent Box2D solver divergence or physics tunnelling.
 * @param {number} scale
 * @returns {number}
 */
export function sanitizeTimeScale(scale) {
  if (typeof scale !== 'number' || !Number.isFinite(scale)) return 1;
  if (scale <= 0) return 0;
  if (scale > MAX_TIME_SCALE) return MAX_TIME_SCALE;
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
   * The editor holds the world (edit mode, ED-71): besides a scale of 0, the logic workers run no entity ticks, which
   * at dt 0 would only redo their last frame (littleCity's 8,000 people: 3.6 ms a frame). Spawns, list updates and
   * messages go on: the editor's respawns need them. A game's own pause (a scale of 0) still ticks.
   * @type {boolean}
   */
  static get held() {
    const view = this.view;
    return view !== null && view.length > TIME_HELD_INDEX && view[TIME_HELD_INDEX] === 1;
  }

  static set held(value) {
    const view = this.view;
    if (view !== null && view.length > TIME_HELD_INDEX) view[TIME_HELD_INDEX] = value ? 1 : 0;
  }

  /**
   * @param {number} simMs
   * @returns {number}
   */
  static scaleSimMs(simMs) {
    return simMs * this.scale;
  }
}
