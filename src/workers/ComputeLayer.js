/**
 * Generic WebGPU compute-layer runner. Same GPUDevice as Pixi.
 * Bind groups created on grid resize / field swap, not per dispatch.
 *
 * ponytail: field-subset ping-pong rebuilds bind groups after each swap
 * (kindling). Ceiling: createBindGroup per swap. Upgrade: 16-combo cache.
 */
import { packBox2dBodies, BODY_FLOATS } from './Box2dBodyPack.js';
import { Layer } from '../core/Layer.js';
import { pinGpuTexture } from './pinGpuTexture.js';

const WORK = 8;
const MAX_SWIRLS = 200;
const SWIRL_FLOATS = 8;
const SIM_FLOATS = 32;

function ceilDiv(n, d) {
  return Math.ceil(n / d) | 0;
}

function fieldTexture(device, width, height, format) {
  return device.createTexture({
    size: { width, height },
    format,
    usage:
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC,
  });
}

export class ComputeLayer {
  constructor({ device, meta, renderer, heatSource }) {
    this.device = device;
    this.meta = meta;
    this.renderer = renderer;
    this.heatSource = heatSource;
    this.layerId = meta.id;
    this.maxBodies = (meta.maxBodies | 0) || 512;
    this.cellSize = meta.computeGrid?.cellSize > 0 ? meta.computeGrid.cellSize : 8;
    this.passes = (meta.compute?.passes || []).slice();
    this.numX = 0;
    this.numY = 0;
    this.h = this.cellSize;
    this.originX = 0;
    this.originY = 0;
    this._originReady = false;
    this.params = new Float32Array(SIM_FLOATS);
    this.bodyData = new Float32Array(this.maxBodies * BODY_FLOATS);
    this.vertData = new Float32Array(this.maxBodies * 8 * 2);
    this.swirlData = new Float32Array(MAX_SWIRLS * SWIRL_FLOATS);
    this.modules = new Map();
    this.pipelines = [];
    this.paramsBuffer = device.createBuffer({
      size: SIM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bodyBuffer = device.createBuffer({
      size: this.bodyData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.vertBuffer = device.createBuffer({
      size: Math.max(16, this.vertData.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.swirlBuffer = device.createBuffer({
      size: this.swirlData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.fields = null;
    this.stampTex = null;
    this.velTex = null;
    this.heatTex = null;
    this._layouts = null;
    this._ready = false;
    this._compileError = false;
    this._shiftPipe = null;
    this._shiftSwirlPipe = null;
    this.feederCount = 0;
    this.lastBodyCount = 0;
  }

  async compile() {
    const device = this.device;
    try {
      for (let i = 0; i < this.passes.length; i++) {
        const code = this.passes[i].code;
        if (!code) {
          console.error(`ComputeLayer "${this.meta.name}": pass "${this.passes[i].entry}" missing WGSL`);
          this._compileError = true;
          return false;
        }
        if (this.modules.has(code)) continue;
        const module = device.createShaderModule({
          label: `compute-${this.meta.name}-${i}`,
          code,
        });
        const info = await module.getCompilationInfo();
        const errs = info.messages.filter((m) => m.type === 'error');
        if (errs.length) {
          console.error(
            `ComputeLayer "${this.meta.name}" compile:`,
            errs.map((m) => m.message).join('\n')
          );
          this._compileError = true;
          return false;
        }
        this.modules.set(code, module);
      }
    } catch (err) {
      console.error(`ComputeLayer "${this.meta.name}":`, err);
      this._compileError = true;
      return false;
    }
    this._ensurePipelines();
    this._ready = true;
    return true;
  }

  _ensurePipelines() {
    if (this.pipelines.length || this._compileError || this.modules.size === 0) return;
    const device = this.device;
    this._layouts = {
      stamp: this._makeStampLayout(),
      fluid: this._makeFluidLayout(),
      pack: this._makePackLayout(),
      simple: this._makeSimpleLayout(),
    };
    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      const layoutName = p.layout || 'simple';
      const layout = this._layouts[layoutName] || this._layouts.simple;
      const module = this.modules.get(p.code);
      this.pipelines[i] = device.createComputePipeline({
        label: p.entry,
        layout: layout.pipeline,
        compute: { module, entryPoint: p.entry },
      });
    }
    const fluidPass = this.passes.find((p) => p.layout === 'fluid' && p.code);
    if (fluidPass && /fn shift_fields\b/.test(fluidPass.code)) {
      const module = this.modules.get(fluidPass.code);
      this._shiftPipe = device.createComputePipeline({
        label: 'shift_fields',
        layout: this._layouts.fluid.pipeline,
        compute: { module, entryPoint: 'shift_fields' },
      });
      if (/fn shift_swirls\b/.test(fluidPass.code)) {
        this._shiftSwirlPipe = device.createComputePipeline({
          label: 'shift_swirls',
          layout: this._layouts.fluid.pipeline,
          compute: { module, entryPoint: 'shift_swirls' },
        });
      }
    }
  }

  _makeStampLayout() {
    const device = this.device;
    const g0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    const g1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } },
      ],
    });
    return { g0, g1, pipeline: device.createPipelineLayout({ bindGroupLayouts: [g0, g1] }) };
  }

  _makeFluidLayout() {
    const device = this.device;
    const g0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    const g1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const g2 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
      ],
    });
    return { g0, g1, g2, pipeline: device.createPipelineLayout({ bindGroupLayouts: [g0, g1, g2] }) };
  }

  _makePackLayout() {
    const device = this.device;
    const g0 = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
    });
    const g1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const g2 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      ],
    });
    return { g0, g1, g2, pipeline: device.createPipelineLayout({ bindGroupLayouts: [g0, g1, g2] }) };
  }

  _makeSimpleLayout() {
    const device = this.device;
    const g0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    const g1 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba8unorm' } },
      ],
    });
    return { g0, g1, pipeline: device.createPipelineLayout({ bindGroupLayouts: [g0, g1] }) };
  }

  resize(numX, numY, h) {
    if (this.numX === numX && this.numY === numY && Math.abs(this.h - h) < 1e-6 && this.fields) {
      return;
    }
    this.numX = numX;
    this.numY = numY;
    this.h = h;
    this._ensurePipelines();
    const device = this.device;
    const pair = () => ({
      read: fieldTexture(device, numX, numY, 'r32float'),
      write: fieldTexture(device, numX, numY, 'r32float'),
    });
    this.fields = { u: pair(), v: pair(), t: pair(), p: pair() };
    this.stampTex = fieldTexture(device, numX, numY, 'rgba8unorm');
    this.velTex = device.createTexture({
      size: { width: numX, height: numY },
      format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.heatTex = fieldTexture(device, numX, numY, 'rgba8unorm');
    this._bindPersistent();
  }

  _bindPersistent() {
    const device = this.device;
    const L = this._layouts;
    if (!L) return;
    this._stampParams = device.createBindGroup({
      layout: L.stamp.g0,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.bodyBuffer } },
        { binding: 2, resource: { buffer: this.vertBuffer } },
      ],
    });
    this._fluidParams = device.createBindGroup({
      layout: L.fluid.g0,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.swirlBuffer } },
        { binding: 2, resource: { buffer: this.bodyBuffer } },
      ],
    });
    this._packParams = device.createBindGroup({
      layout: L.pack.g0,
      entries: [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    });
    this._simpleParams = this._stampParams;
    this._rebuildFieldGroups();
  }

  _rebuildFieldGroups() {
    const device = this.device;
    const L = this._layouts;
    const f = this.fields;
    if (!L || !f) return;
    this._fluidRead = device.createBindGroup({
      layout: L.fluid.g1,
      entries: [
        { binding: 0, resource: f.u.read.createView() },
        { binding: 1, resource: f.v.read.createView() },
        { binding: 2, resource: f.t.read.createView() },
        { binding: 3, resource: f.p.read.createView() },
        { binding: 4, resource: this.stampTex.createView() },
        { binding: 5, resource: this.velTex.createView() },
      ],
    });
    this._fluidWrite = device.createBindGroup({
      layout: L.fluid.g2,
      entries: [
        { binding: 0, resource: f.u.write.createView() },
        { binding: 1, resource: f.v.write.createView() },
        { binding: 2, resource: f.t.write.createView() },
        { binding: 3, resource: f.p.write.createView() },
      ],
    });
    this._stampWrite = device.createBindGroup({
      layout: L.stamp.g1,
      entries: [
        { binding: 0, resource: this.stampTex.createView() },
        { binding: 1, resource: this.velTex.createView() },
      ],
    });
    this._simpleWrite = device.createBindGroup({
      layout: L.simple.g1,
      entries: [{ binding: 0, resource: this.heatTex.createView() }],
    });
    this._packWrite = device.createBindGroup({
      layout: L.pack.g2,
      entries: [{ binding: 0, resource: this.heatTex.createView() }],
    });
    this._packRead = device.createBindGroup({
      layout: L.pack.g1,
      entries: [
        { binding: 0, resource: f.t.read.createView() },
        { binding: 1, resource: this.stampTex.createView() },
        { binding: 2, resource: f.u.read.createView() },
        { binding: 3, resource: f.v.read.createView() },
      ],
    });
  }

  _swapNamed(names) {
    if (!names || !this.fields) return;
    for (let i = 0; i < names.length; i++) {
      const pair = this.fields[names[i]];
      if (!pair) continue;
      const tmp = pair.read;
      pair.read = pair.write;
      pair.write = tmp;
    }
    this._rebuildFieldGroups();
  }

  _uniformMap(layerId) {
    const floats = Layer._uniformFloats[layerId];
    const map = Layer._uniformMaps[layerId];
    const out = Object.create(null);
    if (!floats || !map) return out;
    for (const name of Object.keys(map)) {
      const e = map[name];
      out[name] = floats[e.offset];
    }
    return out;
  }

  _writeParams(dt, originX, originY, bodyCount, uniforms, shiftX, shiftY) {
    const p = this.params;
    p[0] = dt;
    p[1] = this.h;
    p[2] = this.numX;
    p[3] = this.numY;
    p[4] = uniforms.uOverRelax ?? uniforms.overRelax ?? 1.0;
    p[5] = uniforms.uSmokeSplit ?? 0.06;
    p[6] = uniforms.uFireCool ?? 0.55;
    p[7] = uniforms.uSmokeCool ?? 0.12;
    p[8] = uniforms.uRise ?? 1.2;
    p[9] = uniforms.uDiffusion ?? 0;
    p[10] = MAX_SWIRLS;
    p[11] = uniforms.uSwirlForce ?? 0.45;
    p[12] = originX;
    p[13] = originY;
    p[14] = bodyCount;
    p[15] = uniforms.uTime ?? 0;
    p[16] = uniforms.uBodyDrive ?? 1;
    p[17] = uniforms.uSourcePad ?? 0;
    p[18] = uniforms.uSwirlDamp ?? 0;
    p[19] = uniforms.uDrawCutoff ?? 0;
    p[20] = uniforms.uStampPad ?? 0;
    p[21] = uniforms.uEmberOn ?? 1;
    p[22] = uniforms.uSwirlChance ?? 0.35;
    p[23] = uniforms.uSwirlSpin ?? 28;
    p[24] = uniforms.uSwirlLife ?? 1.2;
    p[25] = uniforms.uSwirlRadius ?? 2.5;
    p[26] = uniforms.uMaxSwirls ?? MAX_SWIRLS;
    p[27] = shiftX;
    p[28] = shiftY;
    p[29] = 0;
    p[30] = 0;
    p[31] = 0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, p);
  }

  step(frame) {
    if (this._compileError || !this._ready) return false;
    const zoom = frame.zoom > 0 ? frame.zoom : 1;
    const h = this.cellSize;
    const viewW = frame.canvasW / zoom;
    const viewH = frame.canvasH / zoom;
    const numX = Math.max(8, (Math.ceil(viewW / h) | 0) + 2);
    const numY = Math.max(8, (Math.ceil(viewH / h) | 0) + 2);
    const originX = Math.floor(frame.cameraX / h) * h;
    const originY = Math.floor(frame.cameraY / h) * h;
    this.resize(numX, numY, h);
    let di = 0;
    let dj = 0;
    if (this._originReady) {
      di = Math.round((originX - this.originX) / h);
      dj = Math.round((originY - this.originY) / h);
    } else {
      this._originReady = true;
    }
    this.originX = originX;
    this.originY = originY;

    const packed = packBox2dBodies(this.layerId, this.bodyData, this.vertData, this.maxBodies, {
      sweep: true,
    });
    this.lastBodyCount = packed.bodyCount;
    this.feederCount = Layer._feedCount ? Atomics.load(Layer._feedCount, this.layerId) : 0;
    const device = this.device;
    if (packed.bodyCount > 0) {
      device.queue.writeBuffer(
        this.bodyBuffer,
        0,
        this.bodyData.subarray(0, packed.bodyCount * BODY_FLOATS)
      );
    }
    if (packed.vertCount > 0) {
      device.queue.writeBuffer(this.vertBuffer, 0, this.vertData.subarray(0, packed.vertCount * 2));
    }

    const uniforms = this._uniformMap(this.layerId);
    this._writeParams(frame.dt, originX, originY, packed.bodyCount, uniforms, di, dj);

    const encoder = device.createCommandEncoder();
    const gx = ceilDiv(this.numX, WORK);
    const gy = ceilDiv(this.numY, WORK);

    if ((di || dj) && this._shiftPipe) {
      this._dispatchPipe(encoder, this._shiftPipe, 'fluid', gx, gy);
      this._swapNamed(['u', 'v', 't', 'p']);
      if (this._shiftSwirlPipe) {
        this._dispatchPipe(encoder, this._shiftSwirlPipe, 'fluid', ceilDiv(MAX_SWIRLS, 64), 1);
      }
    }

    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      const layout = p.layout || 'simple';
      let iters = 1;
      if (typeof p.iterate === 'number') iters = Math.max(0, p.iterate | 0);
      else if (typeof p.iterate === 'string') {
        iters = Math.max(0, (uniforms[p.iterate] | 0) || 0);
      }
      const swirlPass = p.entry === 'step_swirls' || p.entry === 'shift_swirls';
      const dx = swirlPass ? ceilDiv(MAX_SWIRLS, 64) : gx;
      const dy = swirlPass ? 1 : gy;
      for (let k = 0; k < iters; k++) {
        this._dispatchIndex(encoder, i, layout, dx, dy);
        if (p.swap && p.swap.length) this._swapNamed(p.swap);
      }
    }

    device.queue.submit([encoder.finish()]);
    if (this.heatSource && this.heatTex) {
      pinGpuTexture(this.renderer, this.heatSource, this.heatTex);
    }
    return true;
  }

  _dispatchPipe(encoder, pipe, layout, gx, gy) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipe);
    this._bindLayout(pass, layout);
    pass.dispatchWorkgroups(gx, gy);
    pass.end();
  }

  _bindLayout(pass, layout) {
    if (layout === 'stamp') {
      pass.setBindGroup(0, this._stampParams);
      pass.setBindGroup(1, this._stampWrite);
    } else if (layout === 'fluid') {
      pass.setBindGroup(0, this._fluidParams);
      pass.setBindGroup(1, this._fluidRead);
      pass.setBindGroup(2, this._fluidWrite);
    } else if (layout === 'pack') {
      pass.setBindGroup(0, this._packParams);
      pass.setBindGroup(1, this._packRead);
      pass.setBindGroup(2, this._packWrite);
    } else {
      pass.setBindGroup(0, this._simpleParams);
      pass.setBindGroup(1, this._simpleWrite);
    }
  }

  _dispatchIndex(encoder, passIndex, layout, gx, gy) {
    const pipe = this.pipelines[passIndex];
    if (!pipe) return;
    this._dispatchPipe(encoder, pipe, layout, gx, gy);
  }
}
