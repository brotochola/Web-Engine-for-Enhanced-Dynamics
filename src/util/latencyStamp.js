/**
 * E-197: the input-to-screen latency stamp. Nothing measured how many frames lie between an input and the picture that
 * shows it. Main stamps each input (keys, pointer) with its time; each stage copies the newest stamp it consumed into
 * what it publishes (logic: a word of the stamp buffer, once its frame's work is out; physics: the pose slot it writes;
 * pre-render: the render-queue buffer it writes, the newer of logic's and the latched pose's); Pixi records, the first
 * time it draws a newer stamp, the time since that input (LagMeter), as RENDERER_STATS.INPUT_LAG_*.
 *
 * A stamp is an Int32: tenths of a millisecond since the scene's base (a wall time every thread shares, written once
 * before the workers start), so one atomic store or load carries it. 0 is no stamp. It covers 59 hours.
 *
 * The stamp buffer (LATENCY_STAMP_BYTES): f64 the base (wall ms) at byte 0, i32 the newest input at index
 * STAMP_INPUT, i32 the newest input logic has acted on at STAMP_LOGIC.
 */
export const LATENCY_STAMP_BYTES = 16;
export const STAMP_INPUT = 2;
export const STAMP_LOGIC = 3;

/** Wall ms, the same clock in every thread (each realm's timeOrigin differs). */
export function wallMs() {
  return performance.timeOrigin + performance.now();
}

/** The scene's stamp buffer, its base the wall time now. */
export function createLatencyStampBuffer() {
  const sab = new SharedArrayBuffer(LATENCY_STAMP_BYTES);
  new Float64Array(sab, 0, 1)[0] = wallMs();
  return sab;
}

/** Views of a stamp buffer, or null. */
export function bindLatencyStamp(sab) {
  if (!sab || sab.byteLength < LATENCY_STAMP_BYTES) return null;
  return { base: new Float64Array(sab, 0, 1)[0], i32: new Int32Array(sab, 0, LATENCY_STAMP_BYTES >> 2) };
}

/** Now as a stamp (tenths of a ms since the base, at least 1). */
export function stampNow(stamp) {
  const t = Math.round((wallMs() - stamp.base) * 10);
  return t > 0 ? t : 1;
}

let inputStamp = null;

/** Main thread: the scene's stamp buffer that inputs are stamped into (null: none). */
export function bindInputStamp(sab) {
  inputStamp = bindLatencyStamp(sab);
}

/** Main thread: an input arrived. */
export function stampInput() {
  if (inputStamp !== null) Atomics.store(inputStamp.i32, STAMP_INPUT, stampNow(inputStamp));
}

/**
 * Pixi's meter: the time from an input to the first frame that draws a stamp at least that new, over the last
 * LAG_SAMPLES inputs drawn; median and 95th percentile in ms.
 */
export const LAG_SAMPLES = 64;

export class LagMeter {
  constructor() {
    this.samples = new Float64Array(LAG_SAMPLES);
    this.sorted = new Float64Array(LAG_SAMPLES);
    this.count = 0;
    this.next = 0;
    this.seen = 0;
    this.median = NaN;
    this.p95 = NaN;
  }

  /** A frame drew stamp `stamp` at `now` (both in stamp units); a newer stamp than any drawn before is a sample. */
  note(stamp, now) {
    if (!(stamp > this.seen)) return false;
    this.seen = stamp;
    const ms = (now - stamp) / 10;
    if (!(ms >= 0)) return false;
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % LAG_SAMPLES;
    if (this.count < LAG_SAMPLES) this.count++;
    const s = this.sorted.subarray(0, this.count);
    s.set(this.samples.subarray(0, this.count));
    s.sort();
    this.median = s[(this.count - 1) >> 1];
    this.p95 = s[Math.min(this.count - 1, Math.ceil(this.count * 0.95) - 1)];
    return true;
  }
}
