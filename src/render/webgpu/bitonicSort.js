import { nextPow2 } from '../../util/bitonicSort.js';

const WG_SORT = 256;
const WG_PERM = 64;
const SENTINEL = 0xffffffff;

function ceilDiv(n, d) {
  return Math.ceil(n / d) | 0;
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
 * Draws go through Pixi: copyBufferToBuffer onto the blend batch GPUBuffer.
 */
export class BitonicInstanceSorter {
  constructor(device, sortWgsl, permuteWgsl) {
    this.device = device;
    this.ok = false;
    if (device.pushErrorScope) device.pushErrorScope('validation');
    this._sortMod = device.createShaderModule({ code: sortWgsl, label: 'bitonic-sort' });
    this._permMod = device.createShaderModule({ code: permuteWgsl, label: 'bitonic-permute' });
    this._sortPipe = device.createComputePipeline({
      layout: 'auto',
      compute: { module: this._sortMod, entryPoint: 'bitonicPass' },
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
    this._idxInit = null;
    this._cap = 0;
    this._idxBuf = null;
    this._keyBuf = null;
    this._srcBuf = null;
    this._dstBuf = null;
    this._floats = 15;
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
    return need;
  }

  _destroyWork() {
    if (this._idxBuf) this._idxBuf.destroy();
    if (this._keyBuf) this._keyBuf.destroy();
    if (this._srcBuf) this._srcBuf.destroy();
    if (this._dstBuf) this._dstBuf.destroy();
    this._idxBuf = this._keyBuf = this._srcBuf = this._dstBuf = null;
    this._idxInit = null;
    this._cap = 0;
  }

  /**
   * @param {object} opts
   * @param {Float32Array} opts.instances - packed instance floats (blend region or full)
   * @param {Uint32Array} opts.keys - floatBitsToOrd keys, length count, local 0..count
   * @param {number} opts.count
   * @param {number} [opts.floats=15]
   * @param {GPUBuffer} opts.destGpu - Pixi vertex GPUBuffer
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
    const init = this._idxInit;
    for (let i = 0; i < n; i++) init[i] = i;
    for (let i = n; i < N; i++) init[i] = SENTINEL;
    q.writeBuffer(this._idxBuf, 0, init.buffer, init.byteOffset, N * 4);
    q.writeBuffer(this._keyBuf, 0, keys.buffer, keys.byteOffset, n * 4);
    q.writeBuffer(this._srcBuf, 0, instances.buffer, instances.byteOffset, instFloats * 4);

    if (n >= 2) {
      const sortBind = this.device.createBindGroup({
        layout: this._sortPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this._idxBuf } },
          { binding: 1, resource: { buffer: this._keyBuf } },
          { binding: 2, resource: { buffer: this._sortParams } },
        ],
      });
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
          const tw = timer && timer.computeStamp();
          const pass = tw ? enc.beginComputePass({ timestampWrites: tw }) : enc.beginComputePass();
          pass.setPipeline(this._sortPipe);
          pass.setBindGroup(0, sortBind);
          pass.dispatchWorkgroups(groups);
          pass.end();
          q.submit([enc.finish()]);
        }
      }
    }

    this._permParamU32[0] = n;
    this._permParamU32[1] = fp;
    this._permParamU32[2] = 0;
    this._permParamU32[3] = 0;
    q.writeBuffer(this._permParams, 0, this._permParamU32);
    const permBind = this.device.createBindGroup({
      layout: this._permPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this._srcBuf } },
        { binding: 1, resource: { buffer: this._idxBuf } },
        { binding: 2, resource: { buffer: this._dstBuf } },
        { binding: 3, resource: { buffer: this._permParams } },
      ],
    });
    const enc = this.device.createCommandEncoder({ label: 'bitonic-permute' });
    const permTw = timer && timer.computeStamp();
    const permPass = permTw
      ? enc.beginComputePass({ timestampWrites: permTw })
      : enc.beginComputePass();
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
    if (this._sortParams) this._sortParams.destroy();
    if (this._permParams) this._permParams.destroy();
    this._sortParams = this._permParams = null;
    this.device = null;
  }
}
