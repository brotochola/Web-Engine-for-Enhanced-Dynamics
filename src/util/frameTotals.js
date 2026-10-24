// frameTotals.js — running totals of every published frame, so a window is measured exactly.
//
// HOW_WE_MEASURE "Known limits", planned tool 1. The stats buffers hold the last frame's STEP_MS
// and the bench reads them every 100 ms: one frame in six at 60 Hz, at a phase that a staggered
// cycle can keep landing on. These totals count every frame a worker publishes its meters for
// (pre-render's backpressure skips and Pixi's paced ticks publish nothing, so they count
// nothing), so the difference between two reads is that window exactly: how many frames, the
// mean step and wait, and a histogram for the median and p95.
//
// Same slots as the frame clock (`frameClockSlot`), one writer per slot. Doubles, not stats
// slots: a Float32 sum of 10 ms steps loses the hundredth of a millisecond after a minute.
//
// Layout per slot, little-endian (SLOT_BYTES is a multiple of 64, so two writers never share a
// cache line):
//   0   i32  seq        odd while the writer is inside addFrame
//   8   f64  frames
//   16  f64  stepSum    STEP_MS
//   24  f64  waitSum    WAIT_MS: blocked on a sibling, inside the step
//   32  f64  extraSum   physics' QUERY_WAKE_MS (queries answered between steps); 0 elsewhere
//   64  u32  hist[HIST_BINS]  frames by STEP_MS − WAIT_MS, HIST_BIN_MS wide; the last bin holds
//                             everything from (HIST_BINS − 1) · HIST_BIN_MS up
//
// src/box2d/physicsHostImpl.js keeps a copy of addFrame (a classic script cannot import this);
// tests/node/frameTotals.test.js compares the two byte for byte.

import { SLOT_COUNT } from './frameClock.js';

export const HEADER_BYTES = 64;
export const HIST_BINS = 1024;
/** 1/8 ms: the bin index is `(work * 8) | 0`, exact in binary. Covers 0 to 128 ms. */
export const HIST_BIN_MS = 0.125;
export const SLOT_BYTES = HEADER_BYTES + HIST_BINS * 4;
export const FRAME_TOTALS_BYTES = SLOT_COUNT * SLOT_BYTES;

const SEQ = 0;
const FRAMES = 1;
const STEP = 2;
const WAIT = 3;
const EXTRA = 4;
const BINS_PER_MS = 1 / HIST_BIN_MS;

export function createFrameTotalsBuffer() {
  return new SharedArrayBuffer(FRAME_TOTALS_BYTES);
}

export function bindFrameTotals(sab) {
  if (!sab || sab.byteLength < FRAME_TOTALS_BYTES) return null;
  return {
    sab,
    f64: new Float64Array(sab),
    i32: new Int32Array(sab),
    u32: new Uint32Array(sab),
  };
}

/**
 * One published frame. Called once per frame by the slot's only writer.
 * @param {{ f64: Float64Array, i32: Int32Array, u32: Uint32Array }} view
 */
export function addFrame(view, slot, stepMs, waitMs, extraMs) {
  if (slot < 0 || slot >= SLOT_COUNT || !(stepMs >= 0)) return;
  const i32 = view.i32;
  const f64 = view.f64;
  const f0 = (slot * SLOT_BYTES) >> 3;
  const seq = (slot * SLOT_BYTES) >> 2;
  const work = waitMs > 0 ? stepMs - waitMs : stepMs;
  let bin = work > 0 ? (work * BINS_PER_MS) | 0 : 0;
  if (bin >= HIST_BINS) bin = HIST_BINS - 1;
  Atomics.add(i32, seq + SEQ, 1);
  f64[f0 + FRAMES] += 1;
  f64[f0 + STEP] += stepMs;
  if (waitMs > 0) f64[f0 + WAIT] += waitMs;
  if (extraMs > 0) f64[f0 + EXTRA] += extraMs;
  view.u32[((slot * SLOT_BYTES + HEADER_BYTES) >> 2) + bin]++;
  Atomics.add(i32, seq + SEQ, 1);
}

/**
 * A stable copy of one slot's totals, or null when the slot is out of range or never settled.
 * @returns {null | { frames: number, stepSum: number, waitSum: number, extraSum: number, hist: Uint32Array }}
 */
export function readTotals(view, slot) {
  if (!view || slot < 0 || slot >= SLOT_COUNT) return null;
  const i32 = view.i32;
  const f64 = view.f64;
  const f0 = (slot * SLOT_BYTES) >> 3;
  const seq = (slot * SLOT_BYTES) >> 2;
  const h0 = (slot * SLOT_BYTES + HEADER_BYTES) >> 2;
  const hist = new Uint32Array(HIST_BINS);
  for (let spin = 0; spin < 64; spin++) {
    const s1 = Atomics.load(i32, seq + SEQ);
    if (s1 & 1) continue;
    const frames = f64[f0 + FRAMES];
    const stepSum = f64[f0 + STEP];
    const waitSum = f64[f0 + WAIT];
    const extraSum = f64[f0 + EXTRA];
    hist.set(view.u32.subarray(h0, h0 + HIST_BINS));
    if (Atomics.load(i32, seq + SEQ) === s1) return { frames, stepSum, waitSum, extraSum, hist };
  }
  return null;
}

function percentile(hist, total, q) {
  // The frame at rank q·total, placed linearly inside its bin.
  const rank = q * total;
  let below = 0;
  for (let b = 0; b < hist.length; b++) {
    const n = hist[b];
    if (n > 0 && below + n >= rank) return (b + (rank - below) / n) * HIST_BIN_MS;
    below += n;
  }
  return hist.length * HIST_BIN_MS;
}

/**
 * The window between two reads of one slot: frame count, mean STEP_MS, WAIT_MS and extra, the mean
 * of STEP_MS − WAIT_MS (`workMs`) and its median and p95. Null when the slot published no frame.
 */
export function totalsWindow(start, end) {
  if (!start || !end) return null;
  const frames = end.frames - start.frames;
  if (!(frames > 0)) return null;
  const hist = new Uint32Array(HIST_BINS);
  for (let b = 0; b < HIST_BINS; b++) hist[b] = end.hist[b] - start.hist[b];
  const stepMs = (end.stepSum - start.stepSum) / frames;
  const waitMs = (end.waitSum - start.waitSum) / frames;
  return {
    frames,
    stepMs,
    waitMs,
    extraMs: (end.extraSum - start.extraSum) / frames,
    workMs: stepMs - waitMs,
    p50Ms: percentile(hist, frames, 0.5),
    p95Ms: percentile(hist, frames, 0.95),
  };
}
