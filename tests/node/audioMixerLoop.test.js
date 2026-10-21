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
    let handler = null;
    this.port = { postMessage() {}, set onmessage(fn) { handler = fn; }, get onmessage() { return handler; } };
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

test('a one-shot end frees the slot and does not take the bus lock', { concurrency: false }, () => {
  const previousRate = globalThis.sampleRate;
  globalThis.sampleRate = 48000;
  const originalCas = Atomics.compareExchange;
  try {
    const { p, i32, f32, frames } = makeProcessor({ slots: 1, frames: 64 });
    attachBuses(p, { maxVoices: [4], voiceCap: 4 });
    const tail = 8 + 8 * 8;
    const wide = new Int32Array(tail + 16);
    wide.set(p._chI32);
    const wideF = new Float32Array(wide.buffer);
    wideF.set(p._chF32);
    p._chI32 = wide;
    p._chF32 = wideF;
    const chI = wide;
    chI[tail] = 1;
    chI[tail + 1] = 1;
    chI[tail + 8] = 7;
    Atomics.compareExchange = function (view, index, expected, replacement) {
      if (view === chI) throw new Error(`worklet compareExchange on the channel buffer at ${index}`);
      return originalCas.call(Atomics, view, index, expected, replacement);
    };
    installAsset(p, 1, [new Float32Array(16).fill(0.5)]);
    const b = claimSlot(i32, 0, { audioId: 1, pitch: 1, loop: 0, volume: 1, cursor: 14 });
    i32[b + 7] = 0;
    const out = runOnce({ p, i32, frames });
    assert.equal(Atomics.load(i32, b), 0);
    assert.equal(f32[b + 6], 0);
    assert.equal(chI[tail], 1);
    assert.equal(chI[tail + 1], 1);
    assert.equal(chI[tail + 8], 7);
    for (let i = 0; i < frames; i++) {
      assert.ok(Number.isFinite(out[0][i]), `sample ${i} is ${out[0][i]}`);
    }
  } finally {
    Atomics.compareExchange = originalCas;
    globalThis.sampleRate = previousRate;
  }
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

const CH_HEADER = 8;
const CH_STRIDE = 8;

function attachBuses(p, { count = 1, maxVoices = [32], mute = [], voiceCap = 32, threshold = 1, ratio = 1 } = {}) {
  const sab = new SharedArrayBuffer((CH_HEADER + CH_STRIDE * 8) * 4);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  f32[0] = 1;
  f32[1] = 1;
  f32[2] = 0.005;
  f32[3] = 0.12;
  f32[4] = 1;
  i32[5] = p._max;
  for (let bus = 0; bus < 8; bus++) {
    const b = CH_HEADER + bus * CH_STRIDE;
    f32[b] = 1;
    f32[b + 1] = 0;
    const cap = maxVoices[bus] > 0 ? maxVoices[bus] : 32;
    i32[b + 2] = (cap << 8) | (mute[bus] ? 1 : 0);
    f32[b + 3] = 1;
    f32[b + 4] = threshold;
    f32[b + 5] = ratio;
    f32[b + 6] = 0;
    f32[b + 7] = 0.05;
  }
  p._chI32 = i32;
  p._chF32 = f32;
  p._channelCount = count;
  p._setVoiceCap(voiceCap);
  p._applyMaxVoices(maxVoices);
  p._env.fill(1);
  p._masterEnv = 1;
  const levels = new SharedArrayBuffer((4 + 256 * 3) * 4);
  p._levelsI32 = new Int32Array(levels);
  p._levelsF32 = new Float32Array(levels);
  p._levelRing = 256;
  p._levelMask = 255;
  p._levelHeader = 4;
  return { chI: i32, chF: f32 };
}

function peakOf(buffer) {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = buffer[i] < 0 ? -buffer[i] : buffer[i];
    if (a > peak) peak = a;
  }
  return peak;
}

test('a muted bus is silent and a voice cap keeps one voice', { concurrency: false }, () => {
  const previousRate = globalThis.sampleRate;
  globalThis.sampleRate = 48000;
  try {
    const muted = makeProcessor({ slots: 1, frames: 64 });
    attachBuses(muted.p, { maxVoices: [4], mute: [1], voiceCap: 4 });
    installAsset(muted.p, 1, [new Float32Array(64).fill(1)]);
    const b = claimSlot(muted.i32, 0, { audioId: 1, pitch: 1, volume: 1, loop: 1 });
    muted.i32[b + 7] = 0;
    const silent = runOnce(muted);
    assert.equal(peakOf(silent[0]), 0);
    assert.equal(peakOf(silent[1]), 0);
    assert.ok(Number.isFinite(silent[0][0]) && Number.isFinite(silent[1][0]));

    const capped = makeProcessor({ slots: 2, frames: 64 });
    attachBuses(capped.p, { maxVoices: [1], voiceCap: 4 });
    installAsset(capped.p, 1, [new Float32Array(64).fill(1)]);
    const loud = claimSlot(capped.i32, 0, { audioId: 1, pitch: 1, volume: 1, loop: 1 });
    const quiet = claimSlot(capped.i32, 1, { audioId: 1, pitch: 1, volume: 1, loop: 1 });
    capped.i32[loud + 7] = 0;
    capped.i32[quiet + 7] = 0;
    const mixed = runOnce(capped);
    const peak = peakOf(mixed[0]);
    assert.ok(peak > 0.5 && peak < 0.9, `capped peak ${peak} should be one voice, not both`);
    assert.ok(Number.isFinite(mixed[0][0]) && Number.isFinite(mixed[1][0]));

    const stereo = makeProcessor({ slots: 1, frames: 32 });
    attachBuses(stereo.p, { maxVoices: [4], voiceCap: 4 });
    installAsset(stereo.p, 2, [new Float32Array(16).fill(0.4), new Float32Array(16).fill(-0.4)]);
    const sb = claimSlot(stereo.i32, 0, { audioId: 2, pitch: 3, pan: 0.25, volume: 1, loop: 1 });
    stereo.i32[sb + 7] = 0;
    for (let block = 0; block < 3; block++) {
      const out = runOnce(stereo);
      assert.ok(Number.isFinite(out[0][0]) && Number.isFinite(out[1][0]));
    }
  } finally {
    globalThis.sampleRate = previousRate;
  }
});

test('the bus compressor pulls a hot voice down', { concurrency: false }, () => {
  const previousRate = globalThis.sampleRate;
  globalThis.sampleRate = 48000;
  try {
    function render(threshold, ratio) {
      const ctx = makeProcessor({ slots: 1, frames: 128 });
      attachBuses(ctx.p, { maxVoices: [4], voiceCap: 4, threshold, ratio });
      installAsset(ctx.p, 1, [new Float32Array(128).fill(1)]);
      const b = claimSlot(ctx.i32, 0, { audioId: 1, pitch: 1, volume: 1, loop: 1 });
      ctx.i32[b + 7] = 0;
      return peakOf(runOnce(ctx)[0]);
    }
    const open = render(1, 1);
    const squeezed = render(0.2, 8);
    assert.ok(open > 0.6, `open peak ${open}`);
    assert.ok(squeezed < 0.45, `compressed peak ${squeezed}`);
    assert.ok(Number.isFinite(open) && Number.isFinite(squeezed));
  } finally {
    globalThis.sampleRate = previousRate;
  }
});

test('the levels ring records peaks and the clip flag', { concurrency: false }, () => {
  const previousRate = globalThis.sampleRate;
  globalThis.sampleRate = 48000;
  try {
    const ctx = makeProcessor({ slots: 2, frames: 64 });
    attachBuses(ctx.p, { maxVoices: [4], voiceCap: 4 });
    installAsset(ctx.p, 1, [new Float32Array(64).fill(1)]);
    const a = claimSlot(ctx.i32, 0, { audioId: 1, pitch: 1, volume: 1, loop: 1 });
    const b = claimSlot(ctx.i32, 1, { audioId: 1, pitch: 1, volume: 1, loop: 1 });
    ctx.i32[a + 7] = 0;
    ctx.i32[b + 7] = 0;
    const out = runOnce(ctx);
    assert.ok(Number.isFinite(out[0][0]) && Number.isFinite(out[1][0]));
    assert.equal(Atomics.load(ctx.p._levelsI32, 0), 1);
    assert.equal(Atomics.load(ctx.p._levelsI32, 1), 1);
    const peakL = ctx.p._levelsF32[4];
    const peakR = ctx.p._levelsF32[4 + 256];
    assert.equal(peakL, 1);
    assert.equal(peakR, 1);
  } finally {
    globalThis.sampleRate = previousRate;
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

// E-46. A bus list only gains dead entries when a voice is released, so the host
// walks its lists only after the release counter (channel header word 6) moves.
// The audio thread's releaseVoice must bump it, or the host never reclaims.
test('E-46: a one-shot voice that ends on the audio thread bumps the release counter', { concurrency: false }, () => {
  const Cls = loadProcessor();
  const p = new Cls();
  const slots = 4;
  const sab = new SharedArrayBuffer((H + slots * S) * 4);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  f32[2] = 1;
  f32[3] = 1;
  const channelSab = new SharedArrayBuffer(4096 * 4);
  const chI = new Int32Array(channelSab);
  const port = p.port;
  port.onmessage({ data: { type: 'init', sab, maxSlots: slots, channelSab: null } });
  assert.equal(chI[6], 0);
  port.onmessage({ data: { type: 'init', sab, maxSlots: slots, channelSab, channelCount: 1, voiceCap: 4, maxVoices: [4] } });
  p._assets = new Map();
  installAsset(p, 7, [new Float32Array(16).fill(0.25)]);
  claimSlot(i32, 0, { audioId: 7, loop: 0 });
  p._mixDirect(i32, f32, new Float32Array(128), new Float32Array(128), 128, 1, Math.PI / 4);
  assert.equal(Atomics.load(i32, H), 0, 'the voice ended and was released');
  assert.equal(Atomics.load(chI, 6), 1, 'one release, one bump');
  // A slot that is not playing is not released again.
  p._mixDirect(i32, f32, new Float32Array(128), new Float32Array(128), 128, 1, Math.PI / 4);
  assert.equal(Atomics.load(chI, 6), 1);
});
