#!/usr/bin/env node
/**
 * Kernel: SoundManager._writeSlot (the slot claim behind every play()) on the
 * shipped class with its own slot SAB, 2048 slots like Predator.
 *
 * The Predator fixture caught all 2048 slots busy: every play() scanned every
 * slot and dropped the sound. Cases: 0, 50, 90 and 100 % occupancy. Between
 * calls the "worklet" frees the slot just claimed so occupancy stays put.
 *
 *   node tests/bench/audioSlotMicrobench.mjs
 *   node tests/bench/audioSlotMicrobench.mjs --output out.json
 */
import { SoundManager } from '../../src/core/soundManager.js';
import { isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

// Hypotheses go here as variants; the shipped claim is L3b (HYPOTHESIS_LOG).
const VARIANTS = {
  base: () => {},
};

/**
 * Contention: `threads` worker_threads (the 3 logic workers) call _writeSlot
 * on one saturated SAB at once. Returns total calls per second.
 */
async function contended(variant, maxSlots, threads, callsPerThread) {
  const { Worker } = await import('node:worker_threads');
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + maxSlots * SoundManager.SLOT_SIZE) * 4);
  const i32 = new Int32Array(sab);
  for (let s = 0; s < maxSlots; s++) i32[SoundManager.HEADER_SIZE + s * SoundManager.SLOT_SIZE] = SoundManager.STATE_PLAYING;
  const go = new Int32Array(new SharedArrayBuffer(4));
  const workers = [];
  const done = [];
  for (let t = 0; t < threads; t++) {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { role: 'contender', variant, sab, maxSlots, calls: callsPerThread, go: go.buffer },
    });
    workers.push(w);
    done.push(new Promise((res, rej) => {
      w.once('message', res);
      w.once('error', rej);
    }));
  }
  await new Promise((r) => setTimeout(r, 300));
  const t0 = performance.now();
  Atomics.store(go, 0, 1);
  Atomics.notify(go, 0);
  await Promise.all(done);
  const ms = performance.now() - t0;
  for (const w of workers) await w.terminate();
  return { ms, opsPerSec: ((threads * callsPerThread) / ms) * 1000, iterations: threads * callsPerThread, threads };
}

async function contenderMain(data) {
  const { parentPort } = await import('node:worker_threads');
  VARIANTS[data.variant]();
  SoundManager.initializeSlotSAB({ sab: data.sab, maxSlots: data.maxSlots });
  const go = new Int32Array(data.go);
  for (let i = 0; i < 200; i++) SoundManager._writeSlot(7, 0.5, 1, 0, false);
  Atomics.wait(go, 0, 0);
  for (let i = 0; i < data.calls; i++) SoundManager._writeSlot(7, 0.5, 1, 0, false);
  parentPort.postMessage('done');
}

function setupSlots(maxSlots, occupancy, seed) {
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + maxSlots * SoundManager.SLOT_SIZE) * 4);
  SoundManager.initializeSlotSAB({ sab, maxSlots });
  const i32 = SoundManager._i32;
  const rng = mulberry32(seed);
  const busy = Math.round(maxSlots * occupancy);
  const order = Array.from({ length: maxSlots }, (_, i) => i);
  for (let i = maxSlots - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let k = 0; k < busy; k++) {
    Atomics.store(i32, SoundManager.HEADER_SIZE + order[k] * SoundManager.SLOT_SIZE, SoundManager.STATE_PLAYING);
  }
  return i32;
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  if (!VARIANTS[variant]) throw new Error(`unknown variant ${variant}`);
  VARIANTS[variant]();
  const maxSlots = Number(args.slots ?? 2048);
  const seed = 0xa0d10;
  const cases = {};
  const regimes = {};
  let checksum = 0;
  for (const occ of [0, 0.5, 0.9, 1]) {
    const i32 = setupSlots(maxSlots, occ, seed);
    const H = SoundManager.HEADER_SIZE;
    const S = SoundManager.SLOT_SIZE;
    let claimed = 0;
    let dropped = 0;
    const call = () => {
      const s = SoundManager._writeSlot(7, 0.5, 1, 0, false);
      if (s >= 0) {
        claimed++;
        Atomics.store(i32, H + s * S, SoundManager.STATE_FREE);
      } else dropped++;
    };
    for (let i = 0; i < 2000; i++) call();
    // Occupancy is unchanged by the loop (each claim is freed), so the outcome
    // per call is fixed: claim when a slot is free, drop when none is.
    regimes[`occ${Math.round(occ * 100)}`] = { claimed, dropped };
    checksum = (checksum * 31 + claimed * 7 + dropped) >>> 0;
    const name = `occ${Math.round(occ * 100)}`;
    cases[name] = timeIt(`_writeSlot ${variant} ${name} (${maxSlots} slots)`, (iters) => {
      for (let i = 0; i < iters; i++) call();
    }, { iterations: 2000 });
  }
  // Predator regime: saturated slots, 3 logic workers claiming at once.
  const reps = [];
  for (let r = 0; r < 5; r++) reps.push(await contended(variant, maxSlots, 3, 400));
  reps.sort((a, b) => a.opsPerSec - b.opsPerSec);
  cases.occ100x3 = reps[2];
  console.log(`_writeSlot ${variant} occ100x3: ${Math.round(cases.occ100x3.opsPerSec)} calls/s (3 threads)`);
  const report = {
    feature: 'audio-slot-claim',
    functions: ['SoundManager._writeSlot'],
    variant,
    n: maxSlots,
    seed,
    regimes,
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify(regimes));
}

const { isMainThread, workerData } = await import('node:worker_threads');
if (!isMainThread && workerData?.role === 'contender') await contenderMain(workerData);
else if (isCli(import.meta.url)) await main();
