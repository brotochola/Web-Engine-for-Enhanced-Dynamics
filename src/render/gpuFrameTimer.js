/**
 * GPU elapsed time for the Performance GPU row.
 * WebGL: EXT_disjoint_timer_query_webgl2 (result 1–2 frames late).
 * WebGPU: Pixi owns the encoder, so timestamps stay off.
 */

const RING = 3;
const SLOTS = ['shadows', 'lights', 'present'];

export class GpuFrameTimer {
  constructor() {
    this.gl = null;
    this.ext = null;
    this.active = false;
    this._ring = [];
    this._write = 0;
    this._open = null;
    this._disabled = false;
    this.shadowsMs = 0;
    this.lightsMs = 0;
    this.presentMs = 0;
    this.stepMs = 0;
  }

  attach(renderer) {
    if (this.active || this._disabled) return this.active;
    if (renderer?.gpu && !renderer.gl) {
      this._disabled = true;
      return false;
    }
    const gl = renderer && renderer.gl;
    if (!gl || typeof gl.createQuery !== 'function') return false;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext || ext.TIME_ELAPSED_EXT == null) {
      this._disabled = true;
      return false;
    }
    this.gl = gl;
    this.ext = ext;
    this._ring = [];
    for (let i = 0; i < RING; i++) {
      const slot = { issued: 0 };
      for (let s = 0; s < SLOTS.length; s++) {
        const q = gl.createQuery();
        if (!q) return false;
        slot[SLOTS[s]] = q;
      }
      this._ring.push(slot);
    }
    this.active = true;
    this._write = 0;
    return true;
  }

  begin(name) {
    if (!this.active) return;
    if (this._open) this.end();
    const bit = 1 << SLOTS.indexOf(name);
    if (bit < 1) return;
    const slot = this._ring[this._write];
    if (slot.issued & bit) {
      this._poll(this._write);
      if (slot.issued & bit) return;
    }
    const q = slot[name];
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    slot.issued |= bit;
    this._open = name;
  }

  end() {
    if (!this.active || !this._open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this._open = null;
  }

  /** Close the frame and read a ring slot from 1–2 frames ago. */
  finishFrame() {
    if (!this.active) return;
    if (this._open) this.end();
    this._write = (this._write + 1) % RING;
    for (let i = 0; i < RING; i++) this._poll(i);
  }

  _poll(i) {
    const gl = this.gl;
    const ext = this.ext;
    const slot = this._ring[i];
    if (!slot.issued) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      slot.issued = 0;
      return;
    }
    for (let s = 0; s < SLOTS.length; s++) {
      if (((slot.issued >> s) & 1) === 0) continue;
      if (!gl.getQueryParameter(slot[SLOTS[s]], gl.QUERY_RESULT_AVAILABLE)) return;
    }
    let step = 0;
    for (let s = 0; s < SLOTS.length; s++) {
      let ms = 0;
      if ((slot.issued >> s) & 1) {
        ms = gl.getQueryParameter(slot[SLOTS[s]], gl.QUERY_RESULT) / 1e6;
      }
      this[SLOTS[s] + 'Ms'] = ms;
      step += ms;
    }
    this.stepMs = step;
    slot.issued = 0;
  }
}
