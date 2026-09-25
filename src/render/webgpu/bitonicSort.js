import { nextPow2, bitonicStageCount } from '../../util/bitonicSort.js';

export { bitonicStageCount };

const WG_SORT = 256;
const WG_PERM = 64;
const SENTINEL = 0xffffffff;

function ceilDiv(n, d) {
  return Math.ceil(n / d) | 0;
}

function beginTimedCompute(enc, timer) {
  const tw = timer && timer.computeStamp();
  return tw ? enc.beginComputePass({ timestampWrites: tw }) : enc.beginComputePass();
}

function createBuf(device, bytes, usage) {
  return device.createBuffer({ size: Math.max(bytes, 16), usage });
}

/** Pixi v8 GpuBufferSystem.updateBuffer returns the GPUBuffer (or a wrapper). */
export function pixiGpuBuffer(renderer, pixiBuffer) {
  const sys = renderer && renderer.buffer;
  if (!sys || !pixiBuffer) return null;
  let out = null;
  if (typeof sys.updateBuffer === 'function') {
    try {
      out = sys.updateBuffer(pixiBuffer);
    } catch (_) {
      out = null;
    }
  }
  if (out && typeof out.destroy === 'function' && out.size > 0) return out;
  if (out && out.buffer && typeof out.buffer.destroy === 'function') return out.buffer;
  if (typeof sys.getGPUBuffer === 'function') {
    try {
      const g = sys.getGPUBuffer(pixiBuffer);
      if (g && typeof g.destroy === 'function') return g;
      if (g && g.buffer) return g.buffer;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/**
 * GPU bitonic on uint32 keys + permute of instance floats.
 * `oneEncoder`: fill + all stages + permute in one submit (dynamic uniform offsets).
 * Off = one submit per stage (legacy A/B).
 */
export class BitonicInstanceSorter {
  constructor(device, sortWgsl, permuteWgsl, opts = {}) {
    this.device = device;
    this.ok = false;
    this.oneEncoder = opts.oneEncoder === true;
    this._align = Math.max(256, (device.limits && device.limits.minUniformBufferOffsetAlignment) || 256);
    this._retired = [];
    if (device.pushErrorScope) device.pushErrorScope('validation');
    this._sortMod = device.createShaderModule({ code: sortWgsl, label: 'bitonic-sort' });
    this._permMod = device.createShaderModule({ code: permuteWgsl, label: 'bitonic-permute' });
    this._sortBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        },
      ],
    });
    this._sortLayout = device.createPipelineLayout({ bindGroupLayouts: [this._sortBgl] });
    this._sortPipe = device.createComputePipeline({
      layout: this._sortLayout,
      compute: { module: this._sortMod, entryPoint: 'bitonicPass' },
    });
    this._fillPipe = device.createComputePipeline({
      layout: this._sortLayout,
      compute: { module: this._sortMod, entryPoint: 'fillIndices' },
    });
    this._permPipe = device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._permMod, entryPoint: 'permuteInstances' },
    });
    if (device.popErrorScope) {
      device.popErrorScope().then((err) => {
        this.ok = !err;
      });
    } else {
      this.ok = true;
    }
    this._sortParams = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'bitonic-sort-params',
    });
    this._permParams = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'bitonic-perm-params',
    });
    this._sortParamU32 = new Uint32Array(4);
    this._permParamU32 = new Uint32Array(4);
    this._paramTable = null;
    this._paramScratch = null;
    this._idxInit = null;
    this._cap = 0;
    this._idxBuf = null;
    this._keyBuf = null;
    this._srcBuf = null;
    this._dstBuf = null;
    this._sortBind = null;
    this._permBind = null;
    this._floats = 15;
  }

  _retire(buf) {
    if (buf) this._retired.push(buf);
  }

  _flushRetired() {
    const dead = this._retired;
    if (!dead.length) return;
    this._retired = [];
    const q = this.device && this.device.queue;
    const done = q && typeof q.onSubmittedWorkDone === 'function'
      ? q.onSubmittedWorkDone()
      : Promise.resolve();
    done.then(() => {
      for (let i = 0; i < dead.length; i++) {
        try { dead[i].destroy(); } catch (_) { /* already dead */ }
      }
    });
  }

  _ensure(n, floats, instFloats) {
    const N = nextPow2(n);
    const need = N < 1 ? 1 : N;
    this._floats = floats | 0;
    if (need <= this._cap && this._idxBuf && instFloats <= (this._srcBuf?.size || 0) / 4) {
      return need;
    }
    this._destroyWork();
    this._cap = need;
    const idxBytes = need * 4;
    const keyBytes = Math.max(n, 1) * 4;
    const instBytes = Math.max(instFloats, 1) * 4;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this._idxBuf = createBuf(this.device, idxBytes, usage);
    this._keyBuf = createBuf(this.device, keyBytes, usage);
    this._srcBuf = createBuf(this.device, instBytes, usage);
    this._dstBuf = createBuf(this.device, instBytes, usage);
    this._idxInit = new Uint32Array(need);
    this._sortBind = null;
    this._permBind = null;
    return need;
  }

  _destroyWork() {
    this._retire(this._idxBuf);
    this._retire(this._keyBuf);
    this._retire(this._srcBuf);
    this._retire(this._dstBuf);
    this._idxBuf = this._keyBuf = this._srcBuf = this._dstBuf = null;
    this._idxInit = null;
    this._sortBind = null;
    this._permBind = null;
    this._cap = 0;
  }

  _ensureParamTable(slots) {
    const bytes = Math.max(1, slots) * this._align;
    if (this._paramTable && this._paramTable.size >= bytes && this._paramScratch && this._paramScratch.byteLength >= bytes) {
      return;
    }
    this._retire(this._paramTable);
    this._paramTable = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'bitonic-sort-param-table',
    });
    this._paramScratch = new ArrayBuffer(bytes);
    this._sortBind = null;
  }

  _writeParamTable(N, n) {
    const stages = bitonicStageCount(n);
    const slots = 1 + stages;
    this._ensureParamTable(slots);
    const u32 = new Uint32Array(this._paramScratch);
    const stride = this._align >> 2;
    u32[0] = N;
    u32[1] = n;
    u32[2] = 0;
    u32[3] = 0;
    let slot = 1;
    for (let k = 2; k <= N; k <<= 1) {
      for (let j = k >> 1; j > 0; j >>= 1) {
        const o = slot * stride;
        u32[o] = N;
        u32[o + 1] = n;
        u32[o + 2] = k;
        u32[o + 3] = j;
        slot++;
      }
    }
    this.device.queue.writeBuffer(this._paramTable, 0, this._paramScratch, 0, slots * this._align);
    return slots;
  }

  _bindSort() {
    if (this._sortBind) return this._sortBind;
    const params = this.oneEncoder ? this._paramTable : this._sortParams;
    this._sortBind = this.device.createBindGroup({
      layout: this._sortBgl,
      entries: [
        { binding: 0, resource: { buffer: this._idxBuf } },
        { binding: 1, resource: { buffer: this._keyBuf } },
        { binding: 2, resource: { buffer: params, size: 16 } },
      ],
    });
    return this._sortBind;
  }

  _bindPerm() {
    if (this._permBind) return this._permBind;
    this._permBind = this.device.createBindGroup({
      layout: this._permPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._srcBuf } },
        { binding: 1, resource: { buffer: this._idxBuf } },
        { binding: 2, resource: { buffer: this._dstBuf } },
        { binding: 3, resource: { buffer: this._permParams } },
      ],
    });
    return this._permBind;
  }

  /**
   * @param {object} opts
   * @param {Float32Array} opts.instances
   * @param {Uint32Array} opts.keys
   * @param {number} opts.count
   * @param {number} [opts.floats=15]
   * @param {GPUBuffer} opts.destGpu
   * @param {number} [opts.destOffset=0]
   * @param {{ computeStamp?: Function, resolveCompute?: Function }} [opts.timer]
   */
  dispatch({ instances, keys, count, floats = 15, destGpu, destOffset = 0, timer = null }) {
    const n = count | 0;
    if (n <= 0 || !destGpu || !this.ok) return false;
    const fp = floats | 0;
    const instFloats = n * fp;
    const N = this._ensure(n, fp, instFloats);
    const q = this.device.queue;
    q.writeBuffer(this._keyBuf, 0, keys.buffer, keys.byteOffset, n * 4);
    q.writeBuffer(this._srcBuf, 0, instances.buffer, instances.byteOffset, instFloats * 4);

    this._permParamU32[0] = n;
    this._permParamU32[1] = fp;
    this._permParamU32[2] = 0;
    this._permParamU32[3] = 0;
    q.writeBuffer(this._permParams, 0, this._permParamU32);

    const ok = this.oneEncoder
      ? this._dispatchOne(N, n, instFloats, destGpu, destOffset, timer)
      : this._dispatchLegacy(N, n, instFloats, destGpu, destOffset, timer);
    this._flushRetired();
    return ok;
  }

  _dispatchOne(N, n, instFloats, destGpu, destOffset, timer) {
    this._writeParamTable(N, n);
    const sortBind = this._bindSort();
    const permBind = this._bindPerm();
    const enc = this.device.createCommandEncoder({ label: 'bitonic-one' });
    const groups = Math.max(1, ceilDiv(N, WG_SORT));

    const fillPass = beginTimedCompute(enc, timer);
    fillPass.setPipeline(this._fillPipe);
    fillPass.setBindGroup(0, sortBind, [0]);
    fillPass.dispatchWorkgroups(groups);
    fillPass.end();

    if (n >= 2) {
      let slot = 1;
      for (let k = 2; k <= N; k <<= 1) {
        for (let j = k >> 1; j > 0; j >>= 1) {
          const pass = beginTimedCompute(enc, timer);
          pass.setPipeline(this._sortPipe);
          pass.setBindGroup(0, sortBind, [slot * this._align]);
          pass.dispatchWorkgroups(groups);
          pass.end();
          slot++;
        }
      }
    }

    const permPass = beginTimedCompute(enc, timer);
    permPass.setPipeline(this._permPipe);
    permPass.setBindGroup(0, permBind);
    permPass.dispatchWorkgroups(Math.max(1, ceilDiv(n, WG_PERM)));
    permPass.end();
    enc.copyBufferToBuffer(this._dstBuf, 0, destGpu, destOffset | 0, instFloats * 4);
    this.device.queue.submit([enc.finish()]);
    if (timer && typeof timer.resolveCompute === 'function') timer.resolveCompute();
    return true;
  }

  _dispatchLegacy(N, n, instFloats, destGpu, destOffset, timer) {
    const q = this.device.queue;
    const init = this._idxInit;
    for (let i = 0; i < n; i++) init[i] = i;
    for (let i = n; i < N; i++) init[i] = SENTINEL;
    q.writeBuffer(this._idxBuf, 0, init.buffer, init.byteOffset, N * 4);

    if (n >= 2) {
      const sortBind = this._bindSort();
      const p = this._sortParamU32;
      const groups = Math.max(1, ceilDiv(N, WG_SORT));
      for (let k = 2; k <= N; k <<= 1) {
        for (let j = k >> 1; j > 0; j >>= 1) {
          p[0] = N;
          p[1] = n;
          p[2] = k;
          p[3] = j;
          q.writeBuffer(this._sortParams, 0, p);
          const enc = this.device.createCommandEncoder({ label: 'bitonic-pass' });
          const pass = beginTimedCompute(enc, timer);
          pass.setPipeline(this._sortPipe);
          pass.setBindGroup(0, sortBind, [0]);
          pass.dispatchWorkgroups(groups);
          pass.end();
          q.submit([enc.finish()]);
        }
      }
    }

    const permBind = this._bindPerm();
    const enc = this.device.createCommandEncoder({ label: 'bitonic-permute' });
    const permPass = beginTimedCompute(enc, timer);
    permPass.setPipeline(this._permPipe);
    permPass.setBindGroup(0, permBind);
    permPass.dispatchWorkgroups(Math.max(1, ceilDiv(n, WG_PERM)));
    permPass.end();
    enc.copyBufferToBuffer(this._dstBuf, 0, destGpu, destOffset | 0, instFloats * 4);
    q.submit([enc.finish()]);
    if (timer && typeof timer.resolveCompute === 'function') timer.resolveCompute();
    return true;
  }

  destroy() {
    this._destroyWork();
    this._retire(this._sortParams);
    this._retire(this._permParams);
    this._retire(this._paramTable);
    this._sortParams = this._permParams = this._paramTable = null;
    this._flushRetired();
    this.device = null;
  }
}
