// AudioMixerProcessor.js — AudioWorklet processor for WeedJS
//
// Reads play commands from a SharedArrayBuffer slot array, mixes all active
// sounds with pitch interpolation + equal-power pan, and writes stereo output.
//
// SAB header (4 words): [maxSlots(i32), droppedCount(i32), mixGain(f32), masterVolume(f32)]
//
// SAB slot layout per slot (8 × Int32/Float32, 32 bytes):
//   +0 state   (Int32)   0=free  1=playing  2=claiming (skip)
//   +1 audioId (Int32)
//   +2 pitch   (Float32)
//   +3 pan     (Float32) -1..+1
//   +4 volume  (Float32) 0..1
//   +5 loop    (Int32)   0=once  1=loop
//   +6 cursor  (Float32) fractional sample position
//   +7 channel (Int32)   bus index
//
// Levels SAB (debug, separate buffer). Header 4 words, then three rings of the
// same length: post-clamp peak L, post-clamp peak R, mean square.
//   [0] writeIndex (i32, monotonic, published after the ring slot is written)
//   [1] clipSticky (i32, set to 1 when a pre-clamp sample exceeds full scale)

var H = 4; // header ints
var S = 8; // fields per slot
var CH_HEADER = 8;
var CH_STRIDE = 8;
var BUS_N = 8;
var PICK_MAX = 128;

function compressorTarget(peak, threshold, ratio) {
  if (!(peak > threshold) || !(ratio > 1) || !(threshold > 0)) return 1;
  var over = peak / threshold;
  var out = threshold * Math.pow(over, 1 / ratio);
  var gain = out / peak;
  if (!(gain < 1)) return 1;
  if (gain < 0) return 0;
  return gain;
}

function smoothGain(env, peak, threshold, ratio, attack, release, dt) {
  var target = compressorTarget(peak, threshold, ratio);
  var time = peak > threshold ? attack : release;
  if (!(time > 0.0001)) time = 0.0001;
  var coeff = 1 - Math.exp(-dt / time);
  return env + (target - env) * coeff;
}

function blockPeak(bufL, bufR, frames) {
  var pk = 0;
  for (var i = 0; i < frames; i++) {
    var a = bufL[i] < 0 ? -bufL[i] : bufL[i];
    if (a > pk) pk = a;
    if (bufR) {
      var b = bufR[i] < 0 ? -bufR[i] : bufR[i];
      if (b > pk) pk = b;
    }
  }
  return pk;
}

function considerVoice(slots, gains, counts, bus, maxKeep, slot, gain) {
  var n = counts[bus];
  if (n < maxKeep) {
    var i = n;
    while (i > 0 && gain > gains[i - 1]) {
      gains[i] = gains[i - 1];
      slots[i] = slots[i - 1];
      i--;
    }
    gains[i] = gain;
    slots[i] = slot;
    counts[bus] = n + 1;
    return;
  }
  if (gain <= gains[n - 1]) return;
  var j = n - 1;
  while (j > 0 && gain > gains[j - 1]) {
    gains[j] = gains[j - 1];
    slots[j] = slots[j - 1];
    j--;
  }
  gains[j] = gain;
  slots[j] = slot;
}

function advanceVoice(i32, f32, b, len, pitch, loop, frames) {
  var cursor = f32[b + 6];
  if (!(cursor >= 0)) cursor = 0;
  cursor += frames * pitch;
  if (loop) {
    if (len > 0 && cursor >= len) cursor %= len;
    f32[b + 6] = cursor;
    return;
  }
  if (cursor >= len) {
    Atomics.store(i32, b, 0);
    f32[b + 6] = 0;
    return;
  }
  f32[b + 6] = cursor;
}

function mixVoice(i32, f32, b, asset, pitch, loop, gL, gR, busL, busR, frames) {
  var ch = asset.ch;
  var len = asset.len;
  var ch0 = ch[0];
  var ch1 = asset.nCh > 1 ? ch[1] : null;
  var cursor = f32[b + 6];
  if (!(cursor >= 0)) cursor = 0;
  else if (loop && cursor >= len) cursor %= len;
  var ended = false;
  for (var i = 0; i < frames; i++) {
    if (cursor >= len) {
      if (loop) {
        cursor -= len;
        if (cursor >= len) cursor %= len;
      } else {
        Atomics.store(i32, b, 0);
        ended = true;
        break;
      }
    }
    var idx = ~~cursor;
    var frac = cursor - idx;
    var ni = idx + 1 < len ? idx + 1 : loop ? 0 : idx;
    var s0 = ch0[idx];
    var sN = ch0[ni];
    var sL = s0 + (sN - s0) * frac;
    busL[i] += sL * gL;
    if (busR) {
      var sR = sL;
      if (ch1) {
        var r0 = ch1[idx];
        var rN = ch1[ni];
        sR = r0 + (rN - r0) * frac;
      }
      busR[i] += sR * gR;
    }
    cursor += pitch;
  }
  if (!ended && loop && cursor >= len) cursor %= len;
  f32[b + 6] = ended ? 0 : cursor;
}
// AudioWorkletGlobalScope: performance missing in some browsers
var now = typeof performance !== 'undefined' && performance.now
  ? function () { return performance.now(); }
  : function () { return Date.now(); };

class MixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ready = false;
    this._i32 = null;
    this._f32 = null;
    this._processMs = null;
    this._max = 0;
    this._assets = new Map();
    this._levelsI32 = null;
    this._levelsF32 = null;
    this._levelRing = 0;
    this._levelMask = 0;
    this._levelHeader = 4;
    this._chI32 = null;
    this._chF32 = null;
    this._channelCount = 0;
    this._maxVoices = new Int32Array(BUS_N);
    this._maxVoices.fill(32);
    this._env = new Float32Array(BUS_N);
    this._env.fill(1);
    this._masterEnv = 1;
    this._pick = [];
    this._pickGain = [];
    this._pickCount = new Int32Array(BUS_N);
    for (var p = 0; p < BUS_N; p++) {
      this._pick[p] = new Int32Array(PICK_MAX);
      this._pickGain[p] = new Float32Array(PICK_MAX);
    }
    this._active = new Int32Array(0);
    this._busL = [];
    this._busR = [];
    this._busFrames = 0;

    this.port.onmessage = function (e) {
      var d = e.data;
      if (d.type === 'init') {
        this._i32 = new Int32Array(d.sab);
        this._f32 = new Float32Array(d.sab);
        this._max = d.maxSlots;
        this._processMs = d.processMsSab ? new Float32Array(d.processMsSab) : null;
        if (d.levelsSab) {
          this._levelsI32 = new Int32Array(d.levelsSab);
          this._levelsF32 = new Float32Array(d.levelsSab);
          var ring = ((d.levelsSab.byteLength >> 2) - this._levelHeader) / 3 | 0;
          this._levelRing = ring;
          this._levelMask = ring > 0 ? ring - 1 : 0;
        } else {
          this._levelsI32 = null;
          this._levelsF32 = null;
          this._levelRing = 0;
          this._levelMask = 0;
        }
        if (d.channelSab) {
          this._chI32 = new Int32Array(d.channelSab);
          this._chF32 = new Float32Array(d.channelSab);
          this._channelCount = d.channelCount | 0;
          if (!(this._channelCount > 0)) this._channelCount = 1;
          this._applyMaxVoices(d.maxVoices);
          this._env.fill(1);
          this._masterEnv = 1;
        } else {
          this._chI32 = null;
          this._chF32 = null;
          this._channelCount = 0;
        }
        this._ready = true;
      } else if (d.type === 'channels') {
        this._channelCount = d.channelCount | 0;
        if (!(this._channelCount > 0)) this._channelCount = 1;
        this._applyMaxVoices(d.maxVoices);
        this._env.fill(1);
        this._masterEnv = 1;
      } else if (d.type === 'load') {
        this._assets.set(d.id, { ch: d.channels, len: d.length, nCh: d.channels.length });
      } else if (d.type === 'unload') {
        this._assets.delete(d.id);
      }
    }.bind(this);
  }

  _applyMaxVoices(list) {
    var n = BUS_N;
    for (var i = 0; i < n; i++) {
      var v = list && list[i] | 0;
      if (v < 1) v = 32;
      else if (v > PICK_MAX) v = PICK_MAX;
      this._maxVoices[i] = v;
    }
  }

  _ensureMixBuffers(frames) {
    if (frames > this._busFrames) {
      var n = frames < 512 ? 512 : frames;
      for (var i = 0; i < BUS_N; i++) {
        this._busL[i] = new Float32Array(n);
        this._busR[i] = new Float32Array(n);
      }
      this._busFrames = n;
    }
    if (this._active.length < this._max) this._active = new Int32Array(this._max);
  }

  _mixDirect(i32, f32, L, R, frames, mixGain, PI_4) {
    for (var s = 0; s < this._max; s++) {
      var b = H + s * S;
      if (Atomics.load(i32, b) !== 1) continue;
      var asset = this._assets.get(i32[b + 1]);
      if (!asset) {
        Atomics.store(i32, b, 0);
        continue;
      }
      var pitch = f32[b + 2];
      if (!(pitch > 0)) pitch = 1;
      var pan = f32[b + 3];
      var vol = f32[b + 4] * mixGain;
      if (pan > 1) pan = 1;
      else if (pan < -1) pan = -1;
      var angle = (pan + 1) * PI_4;
      mixVoice(i32, f32, b, asset, pitch, i32[b + 5], Math.cos(angle) * vol, Math.sin(angle) * vol, L, R, frames);
    }
  }

  _mixBuses(i32, f32, chF, chI, L, R, frames, mixGain, PI_4) {
    var buses = this._channelCount;
    if (buses < 1) buses = 1;
    else if (buses > BUS_N) buses = BUS_N;
    var pickCount = this._pickCount;
    pickCount.fill(0);
    for (var bus = 0; bus < buses; bus++) {
      this._busL[bus].fill(0, 0, frames);
      this._busR[bus].fill(0, 0, frames);
    }

    var activeN = 0;
    var active = this._active;
    var limit = this._max;
    var hw = chI[5] | 0;
    if (hw > 0 && hw < limit) limit = hw;
    for (var s = 0; s < limit; s++) {
      var b = H + s * S;
      if (Atomics.load(i32, b) !== 1) continue;
      if (!this._assets.get(i32[b + 1])) {
        Atomics.store(i32, b, 0);
        continue;
      }
      active[activeN++] = s;
      var voiceBus = i32[b + 7];
      if (voiceBus < 0 || voiceBus >= buses) voiceBus = 0;
      var cb = CH_HEADER + voiceBus * CH_STRIDE;
      var cVol = chF[cb];
      if (chI[cb + 2] & 1) continue;
      var vol = f32[b + 4] * mixGain * cVol;
      if (!(vol > 0)) continue;
      var maxKeep = chI[cb + 2] >> 8;
      if (maxKeep < 1) maxKeep = this._maxVoices[voiceBus];
      if (maxKeep > PICK_MAX) maxKeep = PICK_MAX;
      considerVoice(
        this._pick[voiceBus],
        this._pickGain[voiceBus],
        pickCount,
        voiceBus,
        maxKeep,
        s,
        vol
      );
    }

    var keep = this._keep;
    if (!keep || keep.length < this._max) keep = this._keep = new Uint8Array(this._max);
    keep.fill(0);
    for (var bus = 0; bus < buses; bus++) {
      var picked = pickCount[bus];
      var slots = this._pick[bus];
      for (var k = 0; k < picked; k++) keep[slots[k]] = 1;
    }

    for (var n = 0; n < activeN; n++) {
      var s = active[n];
      var b = H + s * S;
      var asset = this._assets.get(i32[b + 1]);
      if (!asset) {
        Atomics.store(i32, b, 0);
        continue;
      }
      var pitch = f32[b + 2];
      if (!(pitch > 0)) pitch = 1;
      var loop = i32[b + 5];
      if (!keep[s]) {
        advanceVoice(i32, f32, b, asset.len, pitch, loop, frames);
        continue;
      }
      var voiceBus = i32[b + 7];
      if (voiceBus < 0 || voiceBus >= buses) voiceBus = 0;
      var cb = CH_HEADER + voiceBus * CH_STRIDE;
      var pan = f32[b + 3] + chF[cb + 1];
      if (pan > 1) pan = 1;
      else if (pan < -1) pan = -1;
      var vol = f32[b + 4] * mixGain * chF[cb];
      var angle = (pan + 1) * PI_4;
      mixVoice(
        i32, f32, b, asset, pitch, loop,
        Math.cos(angle) * vol, Math.sin(angle) * vol,
        this._busL[voiceBus], R ? this._busR[voiceBus] : null, frames
      );
    }

    var dt = frames / sampleRate;
    var env = this._env;
    for (var bus = 0; bus < buses; bus++) {
      var cb = CH_HEADER + bus * CH_STRIDE;
      var busL = this._busL[bus];
      var busR = R ? this._busR[bus] : null;
      var gain = smoothGain(env[bus], blockPeak(busL, busR, frames), chF[cb + 4], chF[cb + 5], chF[cb + 6], chF[cb + 7], dt);
      env[bus] = gain;
      chF[cb + 3] = gain;
      for (var i = 0; i < frames; i++) {
        L[i] += busL[i] * gain;
        if (R) R[i] += busR[i] * gain;
      }
    }
  }

  process(_inputs, outputs) {
    if (!this._ready) return true;

    var t0 = this._processMs ? now() : 0;

    var out = outputs[0];
    var L = out[0];
    var R = out[1];
    if (!L) return true;
    var frames = L.length;

    L.fill(0);
    if (R) R.fill(0);

    var i32 = this._i32;
    var f32 = this._f32;
    var chF = this._chF32;
    var chI = this._chI32;
    var PI_4 = Math.PI * 0.25;
    var mixGain = f32[2];
    if (mixGain < 0) mixGain = 0;
    var masterVol = f32[3];
    var pkL = 0;
    var pkR = 0;
    var sumSq = 0;
    var clipped = 0;
    var channelsOut = R ? 2 : 1;

    if (!chF) {
      this._mixDirect(i32, f32, L, R, frames, mixGain, PI_4);
    } else {
      this._ensureMixBuffers(frames);
      this._mixBuses(i32, f32, chF, chI, L, R, frames, mixGain, PI_4);
    }

    var dt = frames / sampleRate;
    if (chF) {
      var mGain = smoothGain(this._masterEnv, blockPeak(L, R, frames), chF[0], chF[1], chF[2], chF[3], dt);
      this._masterEnv = mGain;
      chF[4] = mGain;
      for (var i = 0; i < frames; i++) {
        L[i] *= mGain;
        if (R) R[i] *= mGain;
      }
    }

    for (var i = 0; i < frames; i++) {
      var sL = L[i] * masterVol;
      var aL = sL < 0 ? -sL : sL;
      if (aL > 1) {
        clipped = 1;
        sL = sL < 0 ? -1 : 1;
        aL = 1;
      }
      L[i] = sL;
      if (aL > pkL) pkL = aL;
      if (R) {
        var sR = R[i] * masterVol;
        var aR = sR < 0 ? -sR : sR;
        if (aR > 1) {
          clipped = 1;
          sR = sR < 0 ? -1 : 1;
          aR = 1;
        }
        R[i] = sR;
        if (aR > pkR) pkR = aR;
        sumSq += sL * sL + sR * sR;
      } else {
        sumSq += sL * sL;
      }
    }

    var levelsI = this._levelsI32;
    if (levelsI && this._levelRing > 0) {
      var idx = Atomics.load(levelsI, 0);
      var slot = idx & this._levelMask;
      var base = this._levelHeader;
      var ring = this._levelRing;
      var lf = this._levelsF32;
      lf[base + slot] = pkL;
      lf[base + ring + slot] = pkR;
      lf[base + ring + ring + slot] = frames > 0 ? sumSq / (frames * channelsOut) : 0;
      if (clipped) Atomics.store(levelsI, 1, 1);
      Atomics.store(levelsI, 0, idx + 1);
    }

    if (this._processMs) {
      this._processMs[0] = now() - t0;
    }
    return true;
  }
}

registerProcessor('weed-audio-mixer', MixerProcessor);
