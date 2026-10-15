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
        } else {
          this._chI32 = null;
          this._chF32 = null;
          this._channelCount = 0;
        }
        this._ready = true;
      } else if (d.type === 'channels') {
        this._channelCount = d.channelCount | 0;
        if (!(this._channelCount > 0)) this._channelCount = 1;
      } else if (d.type === 'load') {
        this._assets.set(d.id, { ch: d.channels, len: d.length, nCh: d.channels.length });
      } else if (d.type === 'unload') {
        this._assets.delete(d.id);
      }
    }.bind(this);
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
    var PI_4 = Math.PI * 0.25;
    var mixGain = f32[2];
    if (mixGain < 0) mixGain = 0;

    for (var s = 0; s < this._max; s++) {
      var b = H + s * S;
      if (Atomics.load(i32, b) !== 1) continue;

      var id = i32[b + 1];
      var pitch = f32[b + 2];
      if (!(pitch > 0)) pitch = 1;
      var pan = f32[b + 3];
      var vol = f32[b + 4] * mixGain;
      var chI = this._chI32;
      if (chI) {
        var bus = i32[b + 7];
        if (bus < 0 || bus >= this._channelCount) bus = 0;
        var cb = bus << 2;
        var cVol = this._chF32[cb];
        if (chI[cb + 2]) cVol = 0;
        vol *= cVol;
        pan += this._chF32[cb + 1];
        if (pan > 1) pan = 1;
        else if (pan < -1) pan = -1;
      }
      var loop = i32[b + 5];
      var asset = this._assets.get(id);
      if (!asset) {
        Atomics.store(i32, b, 0);
        continue;
      }

      var ch = asset.ch;
      var len = asset.len;
      var nCh = asset.nCh;
      // H-12b. The channel arrays do not change during the block. The sample
      // locals below are per iteration, because idx moves. Same bytes as the
      // inline ch[0][idx] loads.
      var ch0 = ch[0];
      var ch1 = nCh > 1 ? ch[1] : null;

      // Normalise once per block, not once per sample. `!(cursor >= 0)` also
      // catches NaN, so a poisoned cursor self-heals on the next block instead
      // of persisting for the life of the AudioContext.
      var cursor = f32[b + 6];
      if (!(cursor >= 0)) cursor = 0;
      else if (loop && cursor >= len) cursor %= len;

      var angle = (pan + 1) * PI_4;
      var gL = Math.cos(angle) * vol;
      var gR = Math.sin(angle) * vol;

      var ended = false;
      for (var i = 0; i < frames; i++) {
        if (cursor >= len) {
          if (loop) {
            // Reduce, do not subtract once. A pitch above the sample length
            // leaves cursor >= len after a single subtraction, and the read
            // below then goes out of bounds: undefined -> NaN, which the output
            // clamp cannot catch (NaN > 1 and NaN < -1 are both false). That
            // poisons every later block for the life of the context.
            //
            // The second reduction is only reachable when pitch > len, so
            // ordinary audio never pays for it.
            cursor -= len;
            if (cursor >= len) cursor %= len;
          } else {
            Atomics.store(i32, b, 0);
            ended = true;
            break;
          }
        }
        // cursor is in [0, len) here: normalised before the loop, and the wrap
        // above is taken on every path that could have left the range.
        var idx = ~~cursor;
        var frac = cursor - idx;
        var ni = idx + 1 < len ? idx + 1 : loop ? 0 : idx;

        var s0 = ch0[idx];
        var sN = ch0[ni];
        var sL = s0 + (sN - s0) * frac;
        L[i] += sL * gL;
        if (R) {
          var sR = sL;
          if (ch1) {
            var r0 = ch1[idx];
            var rN = ch1[ni];
            sR = r0 + (rN - r0) * frac;
          }
          R[i] += sR * gR;
        }
        cursor += pitch;
      }
      // Keep the published cursor in range too, so anything reading the SAB -
      // a debug view, a resume, a second consumer - never sees an out-of-range
      // position and has to re-derive the invariant.
      if (!ended && loop && cursor >= len) cursor %= len;
      f32[b + 6] = ended ? 0 : cursor;
    }

    var masterVol = f32[3];
    var pkL = 0;
    var pkR = 0;
    var sumSq = 0;
    var clipped = 0;
    var channelsOut = R ? 2 : 1;
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
