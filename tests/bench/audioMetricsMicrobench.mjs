#!/usr/bin/env node
/**
 * Kernel: the main-thread slot scan behind getMetrics, and readPlayingVoices.
 * 2048 slots, 128 of them playing. Checksum is the active count.
 *
 *   node tests/bench/audioMetricsMicrobench.mjs
 *   node tests/bench/audioMetricsMicrobench.mjs --output out.json
 */
import { SoundManager } from '../../src/core/soundManager.js';
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const SLOTS = 2048;
const ACTIVE = 128;
const SEED = 0xa11d10;

function boot() {
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + SLOTS * SoundManager.SLOT_SIZE) * 4);
  SoundManager.initializeSlotSAB({ sab, maxSlots: SLOTS });
  SoundManager._idToName[1] = 'tone';
  SoundManager._channelNames[0] = 'sfx';
  const i32 = SoundManager._i32;
  const f32 = SoundManager._f32;
  const H = SoundManager.HEADER_SIZE;
  const S = SoundManager.SLOT_SIZE;
  for (let i = 0; i < ACTIVE; i++) {
    const s = (i * 16) % SLOTS;
    const b = H + s * S;
    i32[b + 1] = 1;
    i32[b + 5] = 1;
    i32[b + 7] = 0;
    f32[b + 2] = 1;
    f32[b + 4] = 0.5;
    f32[b + 6] = i;
    Atomics.store(i32, b, SoundManager.STATE_PLAYING);
  }
}

function main() {
  const args = parseArgs();
  boot();
  const voices = [];
  const count = SoundManager.getActiveSlotCount();
  const listed = SoundManager.readPlayingVoices(voices);
  if (count !== ACTIVE || listed.length !== ACTIVE) {
    throw new Error(`checksum load ${count} voices ${listed.length}, expected ${ACTIVE}`);
  }
  const cases = {
    count: timeIt('getActiveSlotCount 2048/128', (iters) => {
      for (let i = 0; i < iters; i++) SoundManager.getActiveSlotCount();
    }, { iterations: 200 }),
    voices: timeIt('readPlayingVoices 2048/128', (iters) => {
      for (let i = 0; i < iters; i++) SoundManager.readPlayingVoices(voices);
    }, { iterations: 200 }),
  };
  const report = {
    feature: 'audio-metrics-scan',
    functions: ['SoundManager.getActiveSlotCount', 'SoundManager.readPlayingVoices'],
    n: SLOTS,
    seed: SEED,
    checksum: count,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify({
    checksum: count,
    count: cases.count.opsPerSec,
    voices: cases.voices.opsPerSec,
  }));
}

if (isCli(import.meta.url)) main();
