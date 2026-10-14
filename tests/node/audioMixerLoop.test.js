import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * B-05. audioMixerProcessor mixes a looping sound with a cursor:
 *
 *   if (cursor >= len) {
 *     if (loop) { cursor -= len; }        // subtracts ONCE
 *     else { ...; break; }
 *   }
 *   var idx = ~~cursor;                   // no bound after one subtraction
 *   var sL = ch[0][idx] + (ch[0][ni] - ch[0][idx]) * frac;
 *   L[i] += sL * gL;
 *
 * A looping sound whose pitch exceeds its own sample length still has
 * cursor >= len after a single subtraction, so idx reads past the end of the
 * Float32Array. An out-of-bounds typed-array read is undefined; the
 * interpolation becomes NaN; L[i] += NaN propagates. The clamp at the end of
 * process() does not catch it (NaN > 1 and NaN < -1 are both false), so the
 * buffer is poisoned and every later block inherits it. On the audio thread that
 * is a permanent click or silence that no amount of re-triggering fixes.
 *
 * The worklet is a classic script that calls registerProcessor, so it is loaded
 * here with stubbed globals and the registered class is driven directly.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workletSrc = fs.readFileSync(
  path.join(repoRoot, 'src', 'workers', 'audioMixerProcessor.js'),
  'utf8',
);

class StubProcessor {
  constructor() {
    this.port = { postMessage() {}, set onmessage(_fn) {}, get onmessage() { return null; } };
  }
}

let MixerProcessor = null;

function loadProcessor() {
  if (MixerProcessor) return MixerProcessor;
  const previous = {
    registerProcessor: globalThis.registerProcessor,
    AudioWorkletProcessor: globalThis.AudioWorkletProcessor,
    sampleRate: globalThis.sampleRate,
    currentTime: globalThis.currentTime,
    performance: globalThis.performance,
  };
  globalThis.AudioWorkletProcessor = StubProcessor;
  globalThis.sampleRate = 48000;
  globalThis.currentTime = 0;
  let captured = null;
  globalThis.registerProcessor = (_name, cls) => {
    captured = cls;
  };
  try {
    // The worklet is a plain script, not an ES module.
    new Function(workletSrc)();
  } finally {
    globalThis.registerProcessor = previous.registerProcessor;
    globalThis.AudioWorkletProcessor = previous.AudioWorkletProcessor;
    globalThis.sampleRate = previous.sampleRate;
    globalThis.currentTime = previous.currentTime;
    globalThis.performance = previous.performance;
  }
  assert.ok(captured, 'the worklet must register a processor');
  MixerProcessor = captured;
  return MixerProcessor;
}

const H = 4;
const S = 8;

function makeProcessor({ slots = 4, frames = 128 } = {}) {
  const Cls = loadProcessor();
  const p = new Cls();
  // Header (H ints) plus slots*S ints of slot state.
  const sab = new SharedArrayBuffer((H + slots * S) * 4);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  Atomics.store(i32, 0, slots); // maxSlots
  // Header floats: f32[2] = mixGain, f32[3] = masterVolume. Both default to 0,
  // which would mix everything to silence and make these cases vacuous.
  f32[2] = 1;
  f32[3] = 1;
  p.port = { postMessage() {} };
  p._i32 = i32;
  p._f32 = f32;
  p._max = slots;
  p._ready = true;
  p._processMs = null;
  p._assets = new Map();
  p._frames = frames;
  return { p, i32, f32, frames };
}

function installAsset(p, id, channels) {
  p._assets.set(id, { ch: channels, len: channels[0].length, nCh: channels.length });
}

function claimSlot(i32, slot, { audioId, pitch = 1, pan = 0, volume = 1, loop = 1, cursor = 0 }) {
  const b = H + slot * S;
  Atomics.store(i32, b + 1, audioId);
  i32[b + 3] = 0;
  i32[b + 4] = 0;
  i32[b + 5] = loop;
  i32[b + 6] = 0;
  Atomics.store(i32, b, 1); // state = playing
  const f32 = new Float32Array(i32.buffer);
  f32[b + 2] = pitch;
  f32[b + 3] = pan;
  f32[b + 4] = volume;
  f32[b + 6] = cursor;
  return b;
}

function runOnce({ p, i32, frames }) {
  const out = [{ 0: new Float32Array(frames), 1: new Float32Array(frames) }];
  p.process([], out);
  return out[0];
}

test('B-05: a looping sound with pitch above its sample length does not poison the buffer', { concurrency: false }, () => {
  const { p, i32, frames } = makeProcessor({ slots: 1, frames: 128 });

  // 16 samples of audio, played at pitch 1000 while looping.
  const samples = new Float32Array(16).fill(0.5);
  installAsset(p, 1, [samples]);
  claimSlot(i32, 0, { audioId: 1, pitch: 1000, loop: 1, volume: 1 });

  for (let block = 0; block < 8; block++) {
    const out = runOnce({ p, i32, frames });
    for (const ch of [out[0], out[1]]) {
      for (let i = 0; i < frames; i++) {
        assert.ok(
          Number.isFinite(ch[i]),
          `block ${block} sample ${i} is ${ch[i]}; the mixer poisoned the buffer`,
        );
      }
    }
  }
});

test('B-05: the loop cursor stays inside the asset', { concurrency: false }, () => {
  const { p, i32, frames } = makeProcessor({ slots: 1, frames: 128 });
  const samples = new Float32Array(16).fill(0.25);
  installAsset(p, 1, [samples]);
  const b = claimSlot(i32, 0, { audioId: 1, pitch: 1000, loop: 1, volume: 1 });

  for (let block = 0; block < 5; block++) {
    runOnce({ p, i32, frames });
    const cursor = new Float32Array(i32.buffer)[b + 6];
    assert.ok(
      Number.isFinite(cursor) && cursor >= 0 && cursor < samples.length,
      `cursor ${cursor} left [0, ${samples.length})`,
    );
  }
});

test('B-05: a normal looping sound still loops and stays audible', { concurrency: false }, () => {
  const { p, i32, frames } = makeProcessor({ slots: 1, frames: 64 });
  const samples = new Float32Array(32).fill(0.5);
  installAsset(p, 1, [samples]);
  claimSlot(i32, 0, { audioId: 1, pitch: 1, loop: 1, volume: 1 });

  const out = runOnce({ p, i32, frames });
  let nonzero = 0;
  for (let i = 0; i < frames; i++) if (out[0][i] !== 0) nonzero++;
  assert.equal(nonzero, frames, 'a healthy loop must fill the block, not silence it');
});

test('B-05: a non-looping sound still stops and releases its slot', { concurrency: false }, () => {
  const { p, i32, frames } = makeProcessor({ slots: 1, frames: 64 });
  const samples = new Float32Array(16).fill(0.5);
  installAsset(p, 1, [samples]);
  const b = claimSlot(i32, 0, { audioId: 1, pitch: 1, loop: 0, volume: 1, cursor: 14 });

  const out = runOnce({ p, i32, frames });
  assert.equal(Atomics.load(i32, b), 0, 'the slot is freed when a one-shot ends');
  for (let i = 0; i < frames; i++) {
    assert.ok(Number.isFinite(out[0][i]), `sample ${i} is ${out[0][i]}`);
  }
});

function referenceMix(channels, { frames, pitch, pan, volume, loop }) {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const len = channels[0].length;
  const nCh = channels.length;
  let cursor = 0;
  const angle = (pan + 1) * (Math.PI * 0.25);
  const gL = Math.cos(angle) * volume;
  const gR = Math.sin(angle) * volume;
  for (let i = 0; i < frames; i++) {
    if (cursor >= len) {
      if (loop) {
        cursor -= len;
        if (cursor >= len) cursor %= len;
      } else break;
    }
    const idx = ~~cursor;
    const frac = cursor - idx;
    const ni = idx + 1 < len ? idx + 1 : loop ? 0 : idx;
    const sL = channels[0][idx] + (channels[0][ni] - channels[0][idx]) * frac;
    L[i] += sL * gL;
    const sR = nCh > 1
      ? channels[1][idx] + (channels[1][ni] - channels[1][idx]) * frac
      : sL;
    R[i] += sR * gR;
    cursor += pitch;
  }
  for (let i = 0; i < frames; i++) {
    if (L[i] > 1) L[i] = 1;
    else if (L[i] < -1) L[i] = -1;
    if (R[i] > 1) R[i] = 1;
    else if (R[i] < -1) R[i] = -1;
  }
  return [L, R];
}

test('H-12b: hoisted channel loads match the inline mix for mono and stereo', { concurrency: false }, () => {
  const frames = 64;
  const mono = [new Float32Array([0.2, -0.4, 0.6, 0.1, -0.3, 0.5, 0.0, 0.8])];
  const stereo = [
    new Float32Array([0.2, -0.4, 0.6, 0.1, -0.3, 0.5, 0.0, 0.8]),
    new Float32Array([-0.1, 0.3, -0.5, 0.7, 0.2, -0.6, 0.4, 0.0]),
  ];
  for (const [id, channels, pan] of [[1, mono, 0], [2, stereo, -0.25]]) {
    const { p, i32, f32 } = makeProcessor({ slots: 1, frames });
    installAsset(p, id, channels);
    const b = claimSlot(i32, 0, { audioId: id, pitch: 0.5, pan, volume: 0.8, loop: 1, cursor: 0 });
    const out = runOnce({ p, i32, frames });
    // Pan and volume round when they land in the slot's Float32 view. The
    // reference has to read those bits back, or it is testing the SAB, not the hoist.
    const expected = referenceMix(channels, {
      frames,
      pitch: f32[b + 2],
      pan: f32[b + 3],
      volume: f32[b + 4],
      loop: 1,
    });
    for (let ch = 0; ch < 2; ch++) {
      for (let i = 0; i < frames; i++) {
        assert.equal(out[ch][i], expected[ch][i], `asset ${id} ch ${ch} sample ${i}`);
      }
    }
  }
});

test('B-05: stereo assets stay finite', { concurrency: false }, () => {
  const { p, i32, frames } = makeProcessor({ slots: 1, frames: 64 });
  const l = new Float32Array(16).fill(0.3);
  const r = new Float32Array(16).fill(-0.3);
  installAsset(p, 2, [l, r]);
  claimSlot(i32, 0, { audioId: 2, pitch: 900, loop: 1, volume: 1, pan: 0.5 });

  for (let block = 0; block < 4; block++) {
    const out = runOnce({ p, i32, frames });
    assert.ok(Number.isFinite(out[0][0]), 'left channel finite');
    assert.ok(Number.isFinite(out[1][0]), 'right channel finite');
  }
});
