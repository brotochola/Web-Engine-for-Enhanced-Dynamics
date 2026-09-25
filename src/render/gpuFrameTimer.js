/**
 * GPU elapsed time for the Performance GPU row.
 * WebGL: EXT_disjoint_timer_query_webgl2 (result 1–2 frames late).
 * WebGPU: timestamp-query on Pixi render passes (wrapped beginRenderPass)
 * plus compute stamps for bitonic (own encoders).
 */

const RING = 3;
const SLOTS = ['shadows', 'lights', 'custom', 'present'];
const QUERY_COUNT = 512;

export class GpuFrameTimer {
  constructor() {
    this.gl = null;
    this.ext = null;
    this.active = false;
    this._mode = null;
    this._ring = [];
    this._write = 0;
    this._open = null;
    this._disabled = false;
    this.shadowsMs = 0;
    this.lightsMs = 0;
    this.customMs = 0;
    this.presentMs = 0;
    this.sortMs = 0;
    this.stepMs = 0;
    this._device = null;
    this._queryCount = QUERY_COUNT;
    this._renderQuery = null;
    this._computeQuery = null;
    this._resolveBuf = null;
    this._reads = [];
    this._readI = 0;
    this._renderPasses = 0;
    this._computePasses = 0;
  }

  attach(renderer) {
    if (this.active || this._disabled) return this.active;
    const device = renderer?.gpu?.device;
    if (device) return this._attachWebGpu(renderer, device);
    const gl = renderer && renderer.gl;
    if (!gl || typeof gl.createQuery !== 'function') return false;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext || ext.TIME_ELAPSED_EXT == null) {
      this._disabled = true;
      return false;
    }
    this.gl = gl;
    this.ext = ext;
    this._mode = 'webgl';
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

  _attachWebGpu(renderer, device) {
    if (!device.features || !device.features.has('timestamp-query')) {
      this._disabled = true;
      return false;
    }
    this._device = device;
    this._renderer = renderer;
    this._mode = 'webgpu';
    const n = this._queryCount;
    this._renderQuery = device.createQuerySet({ type: 'timestamp', count: n, label: 'weed-gpu-render-ts' });
    this._computeQuery = device.createQuerySet({ type: 'timestamp', count: n, label: 'weed-gpu-compute-ts' });
    this._resolveBuf = device.createBuffer({
      size: n * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'weed-gpu-ts-resolve',
    });
    this._reads = [];
    for (let i = 0; i < RING; i++) {
      this._reads.push({
        buf: device.createBuffer({
          size: n * 8,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          label: `weed-gpu-ts-read-${i}`,
        }),
        pending: false,
        n: 0,
        slot: null,
      });
    }
    this._wrapEncoder(renderer.encoder);
    this.active = true;
    return true;
  }

  _wrapEncoder(encoder) {
    if (!encoder || encoder._weedGpuTimer) return;
    encoder._weedGpuTimer = this;
    const origStart = encoder.renderStart.bind(encoder);
    encoder.renderStart = () => {
      origStart();
      this._hookCommandEncoder(encoder.commandEncoder);
    };
    const origBegin = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (gpuRT) => {
      this._stampRenderPass(gpuRT);
      return origBegin(gpuRT);
    };
  }

  _hookCommandEncoder(ce) {
    if (!ce || ce._weedTsHook) return;
    ce._weedTsHook = true;
    const orig = ce.beginRenderPass.bind(ce);
    ce.beginRenderPass = (descriptor) => orig(this._withTimestamps(descriptor));
  }

  _withTimestamps(descriptor) {
    if (this._mode !== 'webgpu' || !this._open || !descriptor) return descriptor;
    if (descriptor.timestampWrites) return descriptor;
    const i = this._renderPasses;
    if (i * 2 + 1 >= this._queryCount) return descriptor;
    this._renderPasses++;
    return {
      ...descriptor,
      timestampWrites: {
        querySet: this._renderQuery,
        beginningOfPassWriteIndex: i * 2,
        endingOfPassWriteIndex: i * 2 + 1,
      },
    };
  }

  _stampRenderPass(gpuRT) {
    if (!gpuRT) return;
    if (gpuRT.descriptor) gpuRT.descriptor = this._withTimestamps(gpuRT.descriptor);
  }

  computeStamp() {
    if (this._mode !== 'webgpu' || !this._computeQuery) return null;
    const i = this._computePasses;
    if (i * 2 + 1 >= this._queryCount) return null;
    this._computePasses++;
    return {
      querySet: this._computeQuery,
      beginningOfPassWriteIndex: i * 2,
      endingOfPassWriteIndex: i * 2 + 1,
    };
  }

  resolveCompute() {
    if (this._mode !== 'webgpu' || this._computePasses <= 0) return;
    this._resolveAndRead(this._computeQuery, this._computePasses, 'sort');
    this._computePasses = 0;
  }

  begin(name) {
    if (!this.active) return;
    if (this._open) this.end();
    if (this._mode === 'webgpu') {
      this._wrapEncoder(this._renderer?.encoder);
      this._open = SLOTS.indexOf(name) >= 0 ? name : null;
      this._renderPasses = 0;
      return;
    }
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
    if (this._mode === 'webgpu') {
      if (this._renderPasses > 0) {
        this._resolveAndRead(this._renderQuery, this._renderPasses, this._open);
      }
      this._renderPasses = 0;
      this._open = null;
      return;
    }
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this._open = null;
  }

  /** Close the frame and read a ring slot from 1–2 frames ago. */
  finishFrame() {
    if (!this.active) return;
    if (this._open) this.end();
    if (this._mode === 'webgpu') return;
    this._write = (this._write + 1) % RING;
    for (let i = 0; i < RING; i++) this._poll(i);
  }

  _resolveAndRead(querySet, passCount, slotName) {
    const dest = this._reads[this._readI];
    this._readI = (this._readI + 1) % this._reads.length;
    if (!dest || dest.pending) return;
    const n = passCount * 2;
    const enc = this._device.createCommandEncoder({ label: 'weed-gpu-ts-resolve' });
    enc.resolveQuerySet(querySet, 0, n, this._resolveBuf, 0);
    enc.copyBufferToBuffer(this._resolveBuf, 0, dest.buf, 0, n * 8);
    this._device.queue.submit([enc.finish()]);
    dest.pending = true;
    dest.n = passCount;
    dest.slot = slotName;
    dest.buf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const view = new BigUint64Array(dest.buf.getMappedRange());
        let ns = 0n;
        for (let i = 0; i < dest.n; i++) {
          const a = view[i * 2];
          const b = view[i * 2 + 1];
          if (b > a) ns += b - a;
        }
        dest.buf.unmap();
        this[dest.slot + 'Ms'] = Number(ns) / 1e6;
        this._recomputeStep();
        dest.pending = false;
        dest.slot = null;
      })
      .catch(() => {
        try {
          dest.buf.unmap();
        } catch (_) {
          /* already unmapped */
        }
        dest.pending = false;
        dest.slot = null;
      });
  }

  _recomputeStep() {
    this.stepMs = this.shadowsMs + this.lightsMs + this.customMs + this.presentMs + this.sortMs;
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
    this.stepMs = step + this.sortMs;
    slot.issued = 0;
  }
}
