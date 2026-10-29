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

/** This realm's time origin: a constant, and a slow read through the bindings (about 150 ns in Chrome 156). */
const TIME_ORIGIN = performance.timeOrigin;

/**
 * E-174: the wall time of this realm's current frame (ms since the epoch), noted by its frame loop
 * (AbstractWorker._runFrame, Scene's loop through _stepSimFrame); NaN in a realm that runs none. A running clock's
 * read took the wall time from performance.now() (about 170 ns in Chrome 156, 320 with timeOrigin), which more than
 * doubled a busy emitGpu caller's call; the hold it serves is a hundred milliseconds, far coarser than a frame.
 */
const FRAME_WALL = new Float64Array([NaN]);

/** The wall time in ms since the epoch, comparable between threads. */
function wallNowMs() {
  return TIME_ORIGIN + performance.now();
}

/** The wall time a read uses: this realm's frame's, or the clock's where no frame loop runs. */
function readerWallMs() {
  const w = FRAME_WALL[0];
  return w === w ? w : wallNowMs();
}

/** The longest frame the sim clock advances by: the clamp the workers put on their wall delta (abstractWorker). */
export const SIM_CLOCK_MAX_STEP_MS = 100;

/**
 * How long a running clock holds at its last main frame before its readers carry it on (ms). While frames come, the
 * clock moves once a main frame: a clock every reader moved by the wall time cost GPU Galaxy 8M 4 to 6 % of its
 * presented frames (the GPU was no busier a frame; the page drew fewer, DX-GPCLOCK).
 */
export const SIM_CLOCK_HOLD_MS = 100;

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
    FRAME_WALL[0] = NaN;
  }

  /** This realm's frame starts at `wall` (ms since the epoch): its clock reads take that time (E-174). */
  static _noteFrameWall(wall) {
    FRAME_WALL[0] = wall;
  }

  /**
   * The scene's sim clock in ms, the same in every thread: 0 when the scene starts; while it runs, it moves once a
   * main-thread frame by the frame's wall time times Time.scale, so a pause or a hitstop stops it and `Time.scale`
   * slows it. A main thread that gives no frame for SIM_CLOCK_HOLD_MS does not hold it back: past that its readers
   * carry it on at the scale, and the next frame goes on from there. GPU particles age by it. 0 when unbound.
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
    const wall = run[0] !== 0 ? readerWallMs() : 0;
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
        const late = wall - at - SIM_CLOCK_HOLD_MS;
        out[index] = running !== 0 && late > 0 ? base + late * scale : base;
        return;
      }
    }
    // The writer held the clock through every try (descheduled inside its few stores): go on from this realm's last
    // consistent read, not from the base of the last rebase, which can be minutes old (N-85).
    const late = wall - SIM_LAST[1] - SIM_CLOCK_HOLD_MS;
    out[index] = SIM_LAST[3] !== 0 && late > 0 ? SIM_LAST[0] + late * SIM_LAST[2] : SIM_LAST[0];
  }

  /**
   * The main frame's step (Scene's frame loop, at the frame's wall time): it starts a stopped clock, and moves a
   * running one by the frame (or on from where its readers carried it past a hold).
   */
  static _stepSimFrame(wall) {
    FRAME_WALL[0] = wall;
    if (this._simRun === null || this._simRun[0] === 0) {
      this._startSimClock();
      return;
    }
    if (!this._lockSim()) return;
    this._rebaseSim(wall);
    this._unlockSim();
  }

  /**
   * Take the clock's sequence for a write (a main frame's step, a start, a stop, a scale, a manual step; any thread).
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

  /** The base moved to `wall`, the time since the last stepped as a main frame steps it (the caller holds the lock). */
  static _rebaseSim(wall) {
    const now = this._simNow;
    const elapsed = wall - now[1];
    if (this._simRun[0] !== 0 && elapsed > 0) {
      // Within the hold the readers showed the base: the step is the frame. Past it they ran from the base, so the
      // step is at least what they showed (and at least a hold, as the old clamp gave a long frame).
      const late = elapsed - SIM_CLOCK_HOLD_MS;
      const step = elapsed <= SIM_CLOCK_HOLD_MS ? elapsed : late > SIM_CLOCK_HOLD_MS ? late : SIM_CLOCK_HOLD_MS;
      now[0] += step * sanitizeTimeScale(this.view[TIME_SCALE_INDEX]);
    }
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
