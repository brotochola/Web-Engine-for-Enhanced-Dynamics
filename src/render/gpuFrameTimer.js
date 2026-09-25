/**
 * GPU elapsed time for the Performance GPU row.
 * WebGL: EXT_disjoint_timer_query_webgl2 (result 1–2 frames late).
 * WebGPU: timestamp-query on Pixi render passes (wrapped beginRenderPass)
 * plus compute stamps for bitonic. Resolve once in finishFrame.
 */

const RING = 6;
const SLOTS = ['shadows', 'lights', 'custom', 'present'];
const QUERY_COUNT = 512;

function emptySlotRanges() {
  return { shadows: null, lights: null, custom: null, present: null };
}

function sumTimestampPairs(view, startPair, count) {
  let ns = 0n;
  const base = startPair * 2;
  for (let i = 0; i < count; i++) {
    const a = view[base + i * 2];
    const b = view[base + i * 2 + 1];
    if (b > a) ns += b - a;
    else if (a > 0n && i + 1 < count) {
      const next = view[base + (i + 1) * 2];
      if (next > a) ns += next - a;
    }
  }
  return Number(ns) / 1e6;
}

function spanTimestamps(view, startTs, tsCount) {
  let min = 0n;
  let max = 0n;
  let any = false;
  for (let i = 0; i < tsCount; i++) {
    const t = view[startTs + i];
    if (!t) continue;
    if (!any || t < min) min = t;
    if (!any || t > max) max = t;
    any = true;
  }
  return any && max > min ? Number(max - min) / 1e6 : 0;
}

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
    this._slotStart = 0;
    this._slotPasses = 0;
    this._slotRanges = emptySlotRanges();
    this._computeViewOff = QUERY_COUNT;
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
    this._computeViewOff = n;
    this._writeQs = 0;
    this._pendingFrame = null;
    this._renderQueries = [
      device.createQuerySet({ type: 'timestamp', count: n, label: 'weed-gpu-render-ts-0' }),
      device.createQuerySet({ type: 'timestamp', count: n, label: 'weed-gpu-render-ts-1' }),
    ];
    this._computeQueries = [
      device.createQuerySet({ type: 'timestamp', count: n, label: 'weed-gpu-compute-ts-0' }),
      device.createQuerySet({ type: 'timestamp', count: n, label: 'weed-gpu-compute-ts-1' }),
    ];
    const bytes = n * 8 * 2;
    this._resolveBuf = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'weed-gpu-ts-resolve',
    });
    this._reads = [];
    for (let i = 0; i < RING; i++) {
      this._reads.push({
        buf: device.createBuffer({
          size: bytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          label: `weed-gpu-ts-read-${i}`,
        }),
        pending: false,
        renderPasses: 0,
        computePasses: 0,
        ranges: emptySlotRanges(),
      });
    }
    this._hookDevice(device);
    this._wrapEncoder(renderer.encoder);
    this._resetGpuFrame();
    this.active = true;
    return true;
  }

  _hookDevice(device) {
    if (!device || device._weedTsCreate) return;
    device._weedTsCreate = true;
    const orig = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = (desc) => {
      const enc = orig(desc);
      this._hookCommandEncoder(enc);
      return enc;
    };
  }

  _resetGpuFrame() {
    this._renderPasses = 0;
    this._computePasses = 0;
    this._slotStart = 0;
    this._slotPasses = 0;
    this._slotRanges = emptySlotRanges();
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
    this._slotPasses++;
    return {
      ...descriptor,
      timestampWrites: {
        querySet: this._renderQueries[this._writeQs],
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
    if (this._mode !== 'webgpu' || !this._computeQueries) return null;
    const i = this._computePasses;
    if (i * 2 + 1 >= this._queryCount) return null;
    this._computePasses++;
    return {
      querySet: this._computeQueries[this._writeQs],
      beginningOfPassWriteIndex: i * 2,
      endingOfPassWriteIndex: i * 2 + 1,
    };
  }

  /** Bitonic used to resolve here; finishFrame owns the readback. */
  resolveCompute() {}

  begin(name) {
    if (!this.active) return;
    if (this._open) this.end();
    if (this._mode === 'webgpu') {
      this._wrapEncoder(this._renderer?.encoder);
      this._open = SLOTS.indexOf(name) >= 0 ? name : null;
      this._slotStart = this._renderPasses;
      this._slotPasses = 0;
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
      if (this._slotPasses > 0) {
        this._slotRanges[this._open] = { start: this._slotStart, count: this._slotPasses };
      }
      this._open = null;
      this._slotPasses = 0;
      return;
    }
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this._open = null;
  }

  /** Close the frame and read a ring slot from 1–2 frames ago. */
  finishFrame() {
    if (!this.active) return;
    if (this._open) this.end();
    if (this._mode === 'webgpu') {
      this._resolveGpuFrame();
      return;
    }
    this._write = (this._write + 1) % RING;
    for (let i = 0; i < RING; i++) this._poll(i);
  }

  _resolveGpuFrame() {
    const dest = this._reads[this._readI];
    if (this._pendingFrame && dest && !dest.pending) {
      this._submitGpuResolve(this._pendingFrame, dest);
      this._pendingFrame = null;
    }
    if (!this._pendingFrame && (this._renderPasses > 0 || this._computePasses > 0)) {
      this._pendingFrame = {
        qi: this._writeQs,
        renderPasses: this._renderPasses,
        computePasses: this._computePasses,
        ranges: this._slotRanges,
      };
      this._writeQs ^= 1;
      this._resetGpuFrame();
    }
  }

  _submitGpuResolve(prev, dest) {
    const renderTs = prev.renderPasses * 2;
    const computeTs = prev.computePasses * 2;
    const enc = this._device.createCommandEncoder({ label: 'weed-gpu-ts-resolve' });
    if (renderTs >= 2) {
      enc.resolveQuerySet(this._renderQueries[prev.qi], 0, renderTs, this._resolveBuf, 0);
    }
    if (computeTs >= 2) {
      enc.resolveQuerySet(this._computeQueries[prev.qi], 0, computeTs, this._resolveBuf, this._queryCount * 8);
    }
    enc.copyBufferToBuffer(this._resolveBuf, 0, dest.buf, 0, this._queryCount * 8 * 2);
    this._device.queue.submit([enc.finish()]);
    dest.pending = true;
    dest.renderPasses = prev.renderPasses;
    dest.computePasses = prev.computePasses;
    dest.ranges = prev.ranges;
    const done = this._device.queue.onSubmittedWorkDone
      ? this._device.queue.onSubmittedWorkDone()
      : Promise.resolve();
    done
      .then(() => dest.buf.mapAsync(GPUMapMode.READ))
      .then(() => {
        const view = new BigUint64Array(dest.buf.getMappedRange());
        const ranges = dest.ranges || emptySlotRanges();
        for (let s = 0; s < SLOTS.length; s++) {
          const name = SLOTS[s];
          const range = ranges[name];
          this[name + 'Ms'] = range ? sumTimestampPairs(view, range.start, range.count) : 0;
        }
        this.sortMs = dest.computePasses > 0
          ? sumTimestampPairs(view, this._computeViewOff / 2, dest.computePasses)
            || spanTimestamps(view, this._computeViewOff, dest.computePasses * 2)
          : 0;
        const slotSum = this.shadowsMs + this.lightsMs + this.customMs + this.presentMs;
        if (!(slotSum > 0) && dest.renderPasses > 0) {
          const span = spanTimestamps(view, 0, dest.renderPasses * 2);
          if (span > 0) this.presentMs = span;
        }
        this._recomputeStep();
        dest.buf.unmap();
        dest.pending = false;
      })
      .catch(() => {
        try {
          dest.buf.unmap();
        } catch (_) {
          /* already unmapped */
        }
        dest.pending = false;
      });
    this._readI = (this._readI + 1) % this._reads.length;
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

export { sumTimestampPairs };
