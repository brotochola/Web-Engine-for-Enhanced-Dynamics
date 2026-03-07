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
//   +7 reserved

var H = 4; // header ints
var S = 8; // fields per slot

class MixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ready = false;
    this._i32 = null;
    this._f32 = null;
    this._max = 0;
    this._assets = new Map();

    this.port.onmessage = function (e) {
      var d = e.data;
      if (d.type === 'init') {
        this._i32 = new Int32Array(d.sab);
        this._f32 = new Float32Array(d.sab);
        this._max = d.maxSlots;
        this._ready = true;
      } else if (d.type === 'load') {
        this._assets.set(d.id, { ch: d.channels, len: d.length, nCh: d.channels.length });
      } else if (d.type === 'unload') {
        this._assets.delete(d.id);
      }
    }.bind(this);
  }

  process(_inputs, outputs) {
    if (!this._ready) return true;

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
    var mixGain = f32[2] || 1;

    for (var s = 0; s < this._max; s++) {
      var b = H + s * S;
      if (Atomics.load(i32, b) !== 1) continue;

      var id = i32[b + 1];
      var pitch = f32[b + 2] || 1;
      var pan = f32[b + 3];
      var vol = f32[b + 4] * mixGain;
      var loop = i32[b + 5];
      var cursor = f32[b + 6];

      var asset = this._assets.get(id);
      if (!asset) {
        Atomics.store(i32, b, 0);
        continue;
      }

      var ch = asset.ch;
      var len = asset.len;
      var nCh = asset.nCh;

      var angle = (pan + 1) * PI_4;
      var gL = Math.cos(angle) * vol;
      var gR = Math.sin(angle) * vol;

      var ended = false;
      for (var i = 0; i < frames; i++) {
        if (cursor >= len) {
          if (loop) {
            cursor -= len;
          } else {
            Atomics.store(i32, b, 0);
            ended = true;
            break;
          }
        }
        var idx = ~~cursor;
        var frac = cursor - idx;
        var ni = idx + 1 < len ? idx + 1 : loop ? 0 : idx;

        var sL = ch[0][idx] + (ch[0][ni] - ch[0][idx]) * frac;
        L[i] += sL * gL;
        if (R) {
          var sR = nCh > 1 ? ch[1][idx] + (ch[1][ni] - ch[1][idx]) * frac : sL;
          R[i] += sR * gR;
        }
        cursor += pitch;
      }
      f32[b + 6] = ended ? 0 : cursor;
    }

    var masterVol = f32[3];
    for (var i = 0; i < frames; i++) {
      L[i] *= masterVol;
      if (L[i] > 1) L[i] = 1;
      else if (L[i] < -1) L[i] = -1;
      if (R) {
        R[i] *= masterVol;
        if (R[i] > 1) R[i] = 1;
        else if (R[i] < -1) R[i] = -1;
      }
    }
    return true;
  }
}

registerProcessor('weed-audio-mixer', MixerProcessor);
