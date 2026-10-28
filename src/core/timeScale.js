// Scene clock on a SAB: the time scale (one Float32: 1 is real time, 0 is a hitstop) and the shared sim clock
// (Time.simNowMs, a Float64 behind a seqlock). Wall FPS and STEP_MS do not read the scale. Input and the audio
// mixer do not either.

/** Index of the scale inside `clockData`. */
export const TIME_SCALE_INDEX = 0;

/** Bytes of `clockData`: the scale (f32 at 0), the sim clock's sequence (i32 at 4), the sim clock (f64 at 8). */
export const CLOCK_BYTES = 16;

/** The longest frame the sim clock advances by: the clamp the workers put on their wall delta (abstractWorker). */
export const SIM_CLOCK_MAX_STEP_MS = 100;

/**
 * Sim ms the shared clock advances for one main-thread frame: the wall delta clamped to
 * [0, SIM_CLOCK_MAX_STEP_MS] as the workers clamp theirs, then scaled. A lockstep step's injected dt is not clamped.
 * @param {number} deltaMs
 * @param {number} scale
 * @param {boolean} [injected]
 */
export function simClockStepMs(deltaMs, scale, injected = false) {
  const d = +deltaMs;
  const base = injected ? (d > 0 ? d : 0) : d > 0 ? (d < SIM_CLOCK_MAX_STEP_MS ? d : SIM_CLOCK_MAX_STEP_MS) : 0;
  return base * sanitizeTimeScale(scale);
}

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
  /** @type {Int32Array | null} the sim clock's sequence: odd while the main thread writes it */
  static _simSeq = null;
  /** @type {Float64Array | null} */
  static _simNow = null;

  /**
   * @param {SharedArrayBuffer | ArrayBuffer | null} sab `clockData`; one shorter than CLOCK_BYTES has no sim clock
   */
  static bind(sab) {
    if (!sab) {
      this.unbind();
      return;
    }
    this.view = new Float32Array(sab, 0, 1);
    if (sab.byteLength >= CLOCK_BYTES) {
      this._simSeq = new Int32Array(sab, 4, 1);
      this._simNow = new Float64Array(sab, 8, 1);
    } else {
      this._simSeq = null;
      this._simNow = null;
    }
  }

  static unbind() {
    this.view = null;
    this._simSeq = null;
    this._simNow = null;
  }

  /**
   * The scene's sim clock in ms, the same in every thread: 0 when the scene starts, advanced once per
   * main-thread frame by the scaled frame time (so a pause or a hitstop stops it, `Time.scale` slows it).
   * GPU particles age by it. 0 when the clock is unbound.
   */
  static get simNowMs() {
    const seq = this._simSeq;
    const now = this._simNow;
    if (!seq) return 0;
    for (let tries = 0; tries < 64; tries++) {
      const before = Atomics.load(seq, 0);
      if (before & 1) continue;
      const v = now[0];
      if (Atomics.load(seq, 0) === before) return v;
    }
    return now[0];
  }

  /**
   * Time.simNowMs into `out[index]`. The engine's per-frame readers use it: a double returned from a call TurboFan
   * does not inline is boxed, one written into a typed array is not.
   * @param {Float64Array} out
   * @param {number} index
   */
  static readSimNowInto(out, index) {
    const seq = this._simSeq;
    if (!seq) {
      out[index] = 0;
      return;
    }
    const now = this._simNow;
    for (let tries = 0; tries < 64; tries++) {
      const before = Atomics.load(seq, 0);
      if (before & 1) continue;
      out[index] = now[0];
      if (Atomics.load(seq, 0) === before) return;
    }
    out[index] = now[0];
  }

  /**
   * Advance the sim clock by `simMs`. Engine-internal: the main thread is its one writer (Scene's frame loop and
   * stepFrame). No-op when the clock is unbound.
   * @param {number} simMs
   */
  static _advanceSimNow(simMs) {
    const seq = this._simSeq;
    if (!seq || !(simMs > 0)) return;
    Atomics.add(seq, 0, 1);
    this._simNow[0] += simMs;
    Atomics.add(seq, 0, 1);
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
