// Scene clock on a SAB: the time scale (one Float32: 1 is real time, 0 is a hitstop) and the shared sim clock
// (Time.simNowMs, behind a seqlock). Wall FPS and STEP_MS do not read the scale. Input and the audio mixer do not
// either.

/** Index of the scale inside `clockData`. */
export const TIME_SCALE_INDEX = 0;

/**
 * Bytes of `clockData`: the scale (f32 at 0), the sim clock's sequence (i32 at 4: odd while a writer holds it), the
 * sim time at its base (f64 at 8), the wall time of its base (f64 at 16, ms since the epoch: performance.timeOrigin +
 * performance.now(), the same in every thread) and whether it runs (i32 at 24).
 */
export const CLOCK_BYTES = 32;

/** Time.simNowMs's result (readSimNowInto writes it). */
const SIM_NOW = new Float64Array(1);
/** This realm's last consistent read of the clock: base, its wall time, the scale, running (readSimNowInto's fallback). */
const SIM_LAST = new Float64Array(4);

/** The wall time in ms since the epoch, comparable between threads. */
function wallNowMs() {
  return performance.timeOrigin + performance.now();
}

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
  /** @type {Int32Array | null} the sim clock's sequence: odd while a writer holds it */
  static _simSeq = null;
  /** @type {Float64Array | null} [sim time at the base, wall time of the base] */
  static _simNow = null;
  /** @type {Int32Array | null} 1 while the clock runs (between a start and a stop) */
  static _simRun = null;

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
      this._simNow = new Float64Array(sab, 8, 2);
      this._simRun = new Int32Array(sab, 24, 1);
    } else {
      this._simSeq = null;
      this._simNow = null;
      this._simRun = null;
    }
  }

  static unbind() {
    this.view = null;
    this._simSeq = null;
    this._simNow = null;
    this._simRun = null;
  }

  /**
   * The scene's sim clock in ms, the same in every thread: 0 when the scene starts; while it runs, its base plus the
   * wall time since the base times Time.scale, so a pause or a hitstop stops it and `Time.scale` slows it, and it
   * keeps time on its own: a main thread that stalls does not hold it back, as it holds no worker's frame back.
   * GPU particles age by it. 0 when the clock is unbound.
   */
  static get simNowMs() {
    this.readSimNowInto(SIM_NOW, 0);
    return SIM_NOW[0];
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
    const run = this._simRun;
    const view = this.view;
    const wall = run[0] !== 0 ? wallNowMs() : 0;
    for (let tries = 0; tries < 64; tries++) {
      const before = Atomics.load(seq, 0);
      if (before & 1) continue;
      const base = now[0];
      const at = now[1];
      const running = run[0];
      const scale = sanitizeTimeScale(view[TIME_SCALE_INDEX]);
      if (Atomics.load(seq, 0) === before) {
        SIM_LAST[0] = base;
        SIM_LAST[1] = at;
        SIM_LAST[2] = scale;
        SIM_LAST[3] = running;
        out[index] = running !== 0 && wall > at ? base + (wall - at) * scale : base;
        return;
      }
    }
    // The writer held the clock through every try (descheduled inside its few stores): go on from this realm's last
    // consistent read, not from the base of the last rebase, which can be minutes old (N-85).
    out[index] = SIM_LAST[3] !== 0 && wall > SIM_LAST[1] ? SIM_LAST[0] + (wall - SIM_LAST[1]) * SIM_LAST[2] : SIM_LAST[0];
  }

  /**
   * Take the clock's sequence for a write (writers are rare: a start, a stop, a scale, a manual step; any thread).
   * @returns {boolean} false when the clock is unbound
   */
  static _lockSim() {
    const seq = this._simSeq;
    if (!seq) return false;
    for (;;) {
      const v = Atomics.load(seq, 0);
      if ((v & 1) === 0 && Atomics.compareExchange(seq, 0, v, v + 1) === v) return true;
    }
  }

  static _unlockSim() {
    Atomics.add(this._simSeq, 0, 1);
  }

  /** The base moved to `wall` at the time the clock reads there (the caller holds the sequence). */
  static _rebaseSim(wall) {
    const now = this._simNow;
    if (this._simRun[0] !== 0 && wall > now[1]) now[0] += (wall - now[1]) * sanitizeTimeScale(this.view[TIME_SCALE_INDEX]);
    now[1] = wall;
  }

  /** Whether the sim clock runs on its own (started and not stopped). */
  static get simRunning() {
    const run = this._simRun;
    return !!run && run[0] !== 0;
  }

  /** Start the sim clock from its current time (the scene's frame loop, after a load or a resume). */
  static _startSimClock() {
    if (!this._lockSim()) return;
    this._rebaseSim(wallNowMs());
    this._simRun[0] = 1;
    this._unlockSim();
  }

  /** Stop the sim clock where it reads now (a pause, a manual step). */
  static _stopSimClock() {
    if (!this._lockSim()) return;
    this._rebaseSim(wallNowMs());
    this._simRun[0] = 0;
    this._unlockSim();
  }

  /**
   * Advance a stopped sim clock by `simMs`: Scene.stepFrame's lockstep step (a running clock keeps its own time).
   * No-op when the clock is unbound.
   * @param {number} simMs
   */
  static _advanceSimNow(simMs) {
    if (!(simMs > 0) || !this._lockSim()) return;
    this._simNow[0] += simMs;
    this._simNow[1] = wallNowMs();
    this._unlockSim();
  }

  /** Sanitized scale. Unbound clock is 1. */
  static get scale() {
    const view = this.view;
    if (!view) return 1;
    return sanitizeTimeScale(view[TIME_SCALE_INDEX]);
  }

  /**
   * Writes a sanitized scale. The sim clock is rebased first, so the time already run keeps the old scale.
   * No-op when the clock is unbound.
   */
  static set scale(value) {
    const view = this.view;
    if (!view) return;
    const locked = this._lockSim();
    if (locked) this._rebaseSim(wallNowMs());
    view[TIME_SCALE_INDEX] = sanitizeTimeScale(value);
    if (locked) this._unlockSim();
  }

  /**
   * @param {number} simMs
   * @returns {number}
   */
  static scaleSimMs(simMs) {
    return simMs * this.scale;
  }
}
