#!/usr/bin/env node
/**
 * Kernel: one AudioWorklet process() quantum of the shipped mixer.
 * Cases are active-voice counts, plus 128 voices in a 2048-slot table
 * (the direct mix walks every slot).
 *
 *   node tests/bench/audioMixerMicrobench.mjs
 *   node tests/bench/audioMixerMicrobench.mjs --output out.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checksumFloats, isCli, timeIt, writeReport } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workletSrc = fs.readFileSync(path.join(repoRoot, 'src', 'workers', 'audioMixerProcessor.js'), 'utf8');

class StubProcessor {
  constructor() {
    this.port = { postMessage() {}, set onmessage(_fn) {}, get onmessage() { return null; } };
  }
}

function loadProcessor() {
  const previous = {
    registerProcessor: globalThis.registerProcessor,
    AudioWorkletProcessor: globalThis.AudioWorkletProcessor,
    sampleRate: globalThis.sampleRate,
  };
  globalThis.AudioWorkletProcessor = StubProcessor;
  globalThis.sampleRate = 48000;
  let captured = null;
  globalThis.registerProcessor = (_name, cls) => {
    captured = cls;
  };
  try {
    new Function(workletSrc)();
  } finally {
    globalThis.registerProcessor = previous.registerProcessor;
    globalThis.AudioWorkletProcessor = previous.AudioWorkletProcessor;
    globalThis.sampleRate = previous.sampleRate;
  }
  if (!captured) throw new Error('worklet did not register');
  return captured;
}

const H = 4;
const S = 8;
const FRAMES = 128;
const Mixer = loadProcessor();

function makeMix(slots, active) {
  const p = new Mixer();
  const sab = new SharedArrayBuffer((H + slots * S) * 4);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  f32[2] = 1;
  f32[3] = 1;
  p._i32 = i32;
  p._f32 = f32;
  p._max = slots;
  p._ready = true;
  p._processMs = null;
  p._assets = new Map();
  const samples = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) samples[i] = i & 1 ? 0.25 : -0.25;
  p._assets.set(1, { ch: [samples], len: FRAMES, nCh: 1 });
  for (let s = 0; s < active; s++) {
    const b = H + s * S;
    i32[b + 1] = 1;
    i32[b + 5] = 1;
    f32[b + 2] = 1;
    f32[b + 3] = ((s % 17) - 8) / 8;
    f32[b + 4] = 0.4;
    f32[b + 6] = 0;
    Atomics.store(i32, b, 1);
  }
  const L = new Float32Array(FRAMES);
  const R = new Float32Array(FRAMES);
  const out = [{ 0: L, 1: R }];
  const once = () => {
    p.process([], out);
    return L;
  };
  return { once, L, R };
}

function blockChecksum(L, R) {
  return (checksumFloats(L) ^ checksumFloats(R)) >>> 0;
}

function main() {
  const args = process.argv.slice(2);
  let output = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output') output = args[++i] || '';
  }
  const specs = [
    ['v32', 32, 32],
    ['v128', 128, 128],
    ['v512', 512, 512],
    ['scan2048', 2048, 128],
  ];
  const cases = {};
  let checksum = 2166136261;
  const warmup = makeMix(128, 128);
  for (let i = 0; i < 30; i++) warmup.once();
  for (let i = 0; i < specs.length; i++) {
    const [name, slots, active] = specs[i];
    const probe = makeMix(slots, active);
    probe.once();
    const piece = blockChecksum(probe.L, probe.R);
    checksum = Math.imul(checksum ^ piece, 16777619) >>> 0;
    const timed = makeMix(slots, active);
    cases[name] = timeIt(`mixer process ${name}`, (iters) => {
      for (let n = 0; n < iters; n++) timed.once();
    }, { iterations: 4 });
  }
  const report = {
    feature: 'audio-mixer-process',
    functions: ['MixerProcessor.process'],
    n: 2048,
    seed: 0xa11d10,
    checksum,
    cases,
  };
  if (output) writeReport(output, report);
  else console.log(JSON.stringify({ checksum, scan2048: cases.scan2048.opsPerSec }));
}

if (isCli(import.meta.url)) main();
