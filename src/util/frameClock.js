// frameClock.js — one clock for "when did this worker's step run?"
//
// E-24 in docs/internal/EXECUTION_PLAN.md.
//
// IDLE_MS says how long a worker waited. It does not say whether the six workers
// woke on the same vsync or took turns through the frame. A CPU trace could not
// answer that: thread ids did not resolve and the capture had no idle samples.
//
// performance.now() is not comparable across workers — each realm has its own
// time origin. The comparable value is performance.timeOrigin + performance.now(),
// which is milliseconds since the Unix epoch on every realm that implements the
// spec. Those absolute milliseconds do not fit in the Float32 stats buffers
// (a Float32 around 1e12 has a ulp of minutes), and the benchmark averages every
// stat it reads, which erases a phase. So this is a separate SharedArrayBuffer,
// not another stats slot.
//
// Layout, little-endian:
//   Header 32 bytes
//     0  f64  frameT0     absolute ms of the main thread's last rAF publish
//     16 i32  seq         even = frameT0/gen are stable; odd = main is writing
//     20 i32  gen         increments once per main-thread animation frame, from 1
//   Slot 32 bytes, SLOT_COUNT of them. One writer per slot, so no cross-writer race.
//     0  f64  startAbs
//     8  f64  endAbs
//     16 i32  gen         the main-thread gen the worker observed when it stamped
//     20 i32  seq         even = the three fields above are a finished step
//
// ponytail: logic slots are 8 and spatial slots are 8. A scene that asks for more
// gets no stamp on the extra workers (upgrade: size the table from the config).

export const HEADER_BYTES = 32;
export const SLOT_BYTES = 32;
export const MAX_LOGIC = 8;
export const MAX_SPATIAL = 8;

export const FRAME_CLOCK_SLOTS = Object.freeze({
  main: 0,
  physics: 1,
  renderer: 2,
  particle: 3,
  preRender: 4,
});

export const LOGIC_SLOT0 = 5;
export const SPATIAL_SLOT0 = LOGIC_SLOT0 + MAX_LOGIC;

export const SLOT_COUNT = SPATIAL_SLOT0 + MAX_SPATIAL;
export const FRAME_CLOCK_BYTES = HEADER_BYTES + SLOT_COUNT * SLOT_BYTES;

const HEADER_SEQ = 4;
const HEADER_GEN = 5;

export const SLOT_NAME = Object.freeze([
  'main',
  'physics',
  'renderer',
  'particle',
  'preRender',
  ...Array.from({ length: MAX_LOGIC }, (_, i) => `logic${i}`),
  ...Array.from({ length: MAX_SPATIAL }, (_, i) => `spatial${i}`),
]);

/** Slot for a worker kind, or -1 when the index does not fit the table. */
export function frameClockSlot(kind, index = 0) {
  if (kind === 'logic') {
    const slot = LOGIC_SLOT0 + (index | 0);
    return slot < SPATIAL_SLOT0 ? slot : -1;
  }
  if (kind === 'spatial') {
    const slot = SPATIAL_SLOT0 + (index | 0);
    return slot < SLOT_COUNT ? slot : -1;
  }
  const fixed = FRAME_CLOCK_SLOTS[kind];
  return fixed === undefined ? -1 : fixed;
}

export function createFrameClockBuffer() {
  return new SharedArrayBuffer(FRAME_CLOCK_BYTES);
}

export function bindFrameClock(sab) {
  if (!sab || sab.byteLength < FRAME_CLOCK_BYTES) return null;
  return {
    sab,
    f64: new Float64Array(sab),
    i32: new Int32Array(sab),
  };
}

function slotF64(slot) {
  return (HEADER_BYTES + slot * SLOT_BYTES) >> 3;
}

function slotI32(slot) {
  return (HEADER_BYTES + slot * SLOT_BYTES) >> 2;
}

/**
 * Main thread, once per animation frame. Returns the generation just published.
 * @param {{ f64: Float64Array, i32: Int32Array }} view
 * @param {number} absNow performance.timeOrigin + performance.now()
 */
export function publishFrame(view, absNow) {
  const i32 = view.i32;
  Atomics.add(i32, HEADER_SEQ, 1);
  view.f64[0] = absNow;
  const gen = Atomics.add(i32, HEADER_GEN, 1) + 1;
  Atomics.add(i32, HEADER_SEQ, 1);
  return gen;
}

/** Stable read of the main thread's last publish. */
export function readFrame(view) {
  const i32 = view.i32;
  const f64 = view.f64;
  for (let spin = 0; spin < 8; spin++) {
    const s1 = Atomics.load(i32, HEADER_SEQ);
    if (s1 & 1) continue;
    const t0 = f64[0];
    const gen = Atomics.load(i32, HEADER_GEN);
    const s2 = Atomics.load(i32, HEADER_SEQ);
    if (s1 === s2 && (s2 & 1) === 0) return { t0, gen };
  }
  return { t0: f64[0], gen: Atomics.load(i32, HEADER_GEN) };
}

/** readFrame's generation alone: no object, it runs once per worker per frame (review G5). */
function readGen(i32) {
  for (let spin = 0; spin < 8; spin++) {
    const s1 = Atomics.load(i32, HEADER_SEQ);
    if (s1 & 1) continue;
    const gen = Atomics.load(i32, HEADER_GEN);
    const s2 = Atomics.load(i32, HEADER_SEQ);
    if (s1 === s2 && (s2 & 1) === 0) return gen;
  }
  return Atomics.load(i32, HEADER_GEN);
}

/**
 * One finished step. Called after the step, with both ends, so a reader never
 * pairs this frame's start with the previous frame's end. The gen stored is the
 * main-thread generation observed at stamp time.
 * @param {{ f64: Float64Array, i32: Int32Array }} view
 */
export function stampStep(view, slot, startAbs, endAbs) {
  if (!view || slot < 0 || slot >= SLOT_COUNT) return;
  if (!(startAbs > 0) || !(endAbs >= startAbs)) return;
  const i32 = view.i32;
  const f64 = view.f64;
  const gen = readGen(i32);
  const f0 = slotF64(slot);
  const seq = slotI32(slot) + 5;
  const genAt = slotI32(slot) + 4;
  Atomics.add(i32, seq, 1);
  f64[f0] = startAbs;
  f64[f0 + 1] = endAbs;
  Atomics.store(i32, genAt, gen);
  Atomics.add(i32, seq, 1);
}

export function readSlot(view, slot) {
  if (!view || slot < 0 || slot >= SLOT_COUNT) return null;
  const i32 = view.i32;
  const f64 = view.f64;
  const f0 = slotF64(slot);
  const seq = slotI32(slot) + 5;
  const genAt = slotI32(slot) + 4;
  for (let spin = 0; spin < 8; spin++) {
    const s1 = Atomics.load(i32, seq);
    if (s1 & 1) continue;
    const start = f64[f0];
    const end = f64[f0 + 1];
    const gen = Atomics.load(i32, genAt);
    const s2 = Atomics.load(i32, seq);
    if (s1 === s2 && (s2 & 1) === 0) {
      return { name: SLOT_NAME[slot], gen, start, end };
    }
  }
  return null;
}

/** One sample, taken by the main thread at the end of its frame. */
export function readPhaseSample(view) {
  const frame = readFrame(view);
  const slots = [];
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const row = readSlot(view, slot);
    if (!row || !(row.gen > 0) || !(row.start > 0)) continue;
    slots.push(row);
  }
  return { mainGen: frame.gen, mainT0: frame.t0, slots };
}
