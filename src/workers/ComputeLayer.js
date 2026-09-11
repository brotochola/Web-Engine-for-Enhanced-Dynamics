/**
 * Generic WebGPU compute-layer runner. Same GPUDevice as Pixi.
 * Scene owns textures, extra buffers, bind layouts, and pass graph.
 * Engine owns Body/verts pack, SimParams prefix, dispatch, look pin.
 *
 * ponytail: field-subset ping-pong rebuilds bind groups after each swap.
 * Ceiling: createBindGroup per swap. Upgrade: 16-combo cache.
 */
import { packBox2dBodies, BODY_FLOATS } from './Box2dBodyPack.js';
import { Layer } from '../core/Layer.js';
import { pinGpuTexture } from './pinGpuTexture.js';

const WORK = 8;
/** Engine SimParams prefix (floats). Scene uniforms memcpy at this offset. */
export const ENGINE_SIM_PREFIX_FLOATS = 10;

const DEFAULT_LAYOUTS = {
  simple: [
    [
      { binding: 0, buffer: 'uniform', resource: 'params' },
      { binding: 1, buffer: 'read-only-storage', resource: 'bodies' },
      { binding: 2, buffer: 'read-only-storage', resource: 'verts' },
    ],
    [
      { binding: 0, storageTexture: { format: 'rgba8unorm', access: 'write-only' }, resource: 'out' },
    ],
  ],
};

function ceilDiv(n, d) {
  return Math.ceil(n / d) | 0;
}

function gpuTexture(device, width, height, format, storage) {
  let usage =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.COPY_SRC;
  if (storage) usage |= GPUTextureUsage.STORAGE_BINDING;
  return device.createTexture({
    size: { width, height },
    format,
    usage,
  });
}

function destroyTex(t) {
  if (t && typeof t.destroy === 'function') t.destroy();
}

export class ComputeLayer {
  constructor({ device, meta, renderer, lookSource }) {
    this.device = device;
    this.meta = meta;
    this.renderer = renderer;
    this.lookSource = lookSource;
    this.layerId = meta.id;
    this.maxBodies = (meta.maxBodies | 0) || 512;
    const grid = meta.computeGrid || meta.compute?.grid || {};
    this.cellSize = grid.cellSize > 0 ? grid.cellSize : 8;
    this.gridFit = grid.fit === 'canvas' ? 'canvas' : 'view';
    this.passes = (meta.compute?.passes || []).slice();
    this.texDecls = (meta.compute?.textures || []).slice();
    this.bufDecls = (meta.compute?.buffers || []).slice();
    this.layoutSpecs = meta.compute?.layouts || null;
    if (!this.texDecls.length) {
      this.texDecls = [{ name: 'out', format: 'rgba8unorm', pingPong: false, look: true }];
    }
    this.numX = 0;
    this.numY = 0;
    this.h = this.cellSize;
    this.originX = 0;
    this.originY = 0;
    this._originReady = false;
    this._texReady = false;

    const extra = Layer._uniformFloats[this.layerId]?.length || 0;
    this._paramCount = Math.max(32, Math.ceil((ENGINE_SIM_PREFIX_FLOATS + extra) / 4) * 4);
    this.params = new Float32Array(this._paramCount);
    this.bodyData = new Float32Array(this.maxBodies * BODY_FLOATS);
    this.vertData = new Float32Array(this.maxBodies * 8 * 2);
    this.modules = new Map();
    this.pipelines = [];
    this.paramsBuffer = device.createBuffer({
      size: this.params.byteLength,
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
    this._tex = Object.create(null);
    this._buf = Object.create(null);
    this._bufCount = Object.create(null);
    this._allocSceneBuffers();
    this._lookName = null;
    for (let i = 0; i < this.texDecls.length; i++) {
      if (this.texDecls[i].look) {
        this._lookName = this.texDecls[i].name;
        break;
      }
    }
    if (!this._lookName && this.texDecls.length) this._lookName = this.texDecls[0].name;
    this._lookSample = null;
    this._layouts = null;
    this._layoutNames = null;
    this._bindGroups = Object.create(null);
    this._passDX = new Int32Array(Math.max(1, this.passes.length));
    this._passDY = new Int32Array(Math.max(1, this.passes.length));
    this._gridOut = { numX: 0, numY: 0, h: 0 };
    this._ready = false;
    this._compileError = false;
    this.feederCount = 0;
    this.lastBodyCount = 0;
  }

  _allocSceneBuffers() {
    const device = this.device;
    for (let i = 0; i < this.bufDecls.length; i++) {
      const d = this.bufDecls[i];
      const floats = Math.max(1, d.strideFloats | 0) * Math.max(1, d.count | 0);
      const bytes = Math.max(16, floats * 4);
      this._buf[d.name] = device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this._bufCount[d.name] = Math.max(1, d.count | 0);
    }
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
      this._ensurePipelines();
    } catch (err) {
      console.error(`ComputeLayer "${this.meta.name}":`, err);
      this._compileError = true;
      return false;
    }
    this._ready = true;
    return true;
  }

  _ensurePipelines() {
    if (this.pipelines.length || this._compileError || this.modules.size === 0) return;
    const device = this.device;
    const specs = this.layoutSpecs && Object.keys(this.layoutSpecs).length
      ? this.layoutSpecs
      : DEFAULT_LAYOUTS;
    this._layouts = Object.create(null);
    const names = Object.keys(specs);
    this._layoutNames = names;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      this._layouts[name] = this._makeLayoutFromSpec(specs[name]);
    }
    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      const layoutName = p.layout || 'simple';
      const layout = this._layouts[layoutName] || this._layouts.simple;
      if (!layout) {
        console.error(`ComputeLayer "${this.meta.name}": missing layout "${layoutName}"`);
        this._compileError = true;
        return;
      }
      const module = this.modules.get(p.code);
      this.pipelines[i] = device.createComputePipeline({
        label: p.entry,
        layout: layout.pipeline,
        compute: { module, entryPoint: p.entry },
      });
    }
  }

  _makeLayoutFromSpec(groups) {
    const device = this.device;
    const gpuGroups = [];
    for (let g = 0; g < groups.length; g++) {
      const specs = groups[g];
      const entries = [];
      for (let i = 0; i < specs.length; i++) {
        const s = specs[i];
        const e = { binding: s.binding, visibility: GPUShaderStage.COMPUTE };
        const buf = typeof s.buffer === 'string' ? s.buffer : s.buffer?.type;
        if (buf) {
          e.buffer = { type: buf };
        } else if (s.storageTexture) {
          e.storageTexture = {
            access: s.storageTexture.access || 'write-only',
            format: s.storageTexture.format,
          };
        } else if (s.texture) {
          e.texture = { sampleType: s.texture.sampleType || 'unfilterable-float' };
        }
        entries.push(e);
      }
      gpuGroups.push(device.createBindGroupLayout({ entries }));
    }
    return {
      groups: gpuGroups,
      pipeline: device.createPipelineLayout({ bindGroupLayouts: gpuGroups }),
      spec: groups,
    };
  }

  _destroyTextures() {
    const tex = this._tex;
    const names = Object.keys(tex);
    for (let i = 0; i < names.length; i++) {
      const t = tex[names[i]];
      destroyTex(t.read);
      destroyTex(t.write);
      destroyTex(t.tex);
    }
    this._tex = Object.create(null);
    destroyTex(this._lookSample);
    this._lookSample = null;
    this._texReady = false;
  }

  resize(numX, numY, h) {
    this.h = h;
    if (this.numX === numX && this.numY === numY && this._texReady) return;
    this._destroyTextures();
    this.numX = numX;
    this.numY = numY;
    this._ensurePipelines();
    const device = this.device;
    for (let i = 0; i < this.texDecls.length; i++) {
      const d = this.texDecls[i];
      const format = d.format || 'rgba8unorm';
      if (d.pingPong) {
        this._tex[d.name] = {
          read: gpuTexture(device, numX, numY, format, true),
          write: gpuTexture(device, numX, numY, format, true),
        };
      } else {
        this._tex[d.name] = { tex: gpuTexture(device, numX, numY, format, true) };
      }
    }
    this._lookSample = gpuTexture(device, numX, numY, this._lookFormat(), false);
    this._texReady = true;
    this._refreshDispatch();
    this._rebuildBindGroups();
  }

  _lookFormat() {
    for (let i = 0; i < this.texDecls.length; i++) {
      if (this.texDecls[i].name === this._lookName) {
        return this.texDecls[i].format || 'rgba8unorm';
      }
    }
    return 'rgba8unorm';
  }

  _lookGpu() {
    const t = this._tex[this._lookName];
    if (!t) return null;
    if (t.tex) return t.tex;
    return t.write || t.read;
  }

  _resourceGpu(spec) {
    const name = spec.resource;
    if (name === 'params') return { buffer: this.paramsBuffer };
    if (name === 'bodies') return { buffer: this.bodyBuffer };
    if (name === 'verts') return { buffer: this.vertBuffer };
    const buf = this._buf[name];
    if (buf) return { buffer: buf };
    const t = this._tex[name];
    if (!t) return null;
    let ping = spec.ping;
    if (!ping) ping = spec.storageTexture ? 'write' : 'read';
    if (t.read && t.write) {
      const gpu = ping === 'write' ? t.write : t.read;
      return gpu.createView();
    }
    return t.tex.createView();
  }

  _rebuildBindGroups() {
    const device = this.device;
    const layouts = this._layouts;
    const names = this._layoutNames;
    if (!layouts || !this._texReady || !names) return;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const L = layouts[name];
      const groups = [];
      for (let g = 0; g < L.spec.length; g++) {
        const specs = L.spec[g];
        const entries = [];
        for (let b = 0; b < specs.length; b++) {
          const s = specs[b];
          const resource = this._resourceGpu(s);
          if (!resource) continue;
          entries.push({ binding: s.binding, resource });
        }
        groups.push(device.createBindGroup({ layout: L.groups[g], entries }));
      }
      this._bindGroups[name] = groups;
    }
  }

  _swapNamed(names) {
    if (!names) return;
    let any = false;
    for (let i = 0; i < names.length; i++) {
      const pair = this._tex[names[i]];
      if (!pair || !pair.read || !pair.write) continue;
      const tmp = pair.read;
      pair.read = pair.write;
      pair.write = tmp;
      any = true;
    }
    if (any) this._rebuildBindGroups();
  }

  _refreshDispatch() {
    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      const wg = p.workgroup;
      const wx = wg && wg[0] > 0 ? (wg[0] | 0) : WORK;
      if (p.dispatchFrom) {
        const n = this._bufCount[p.dispatchFrom] || 1;
        this._passDX[i] = ceilDiv(n, wx);
        this._passDY[i] = 1;
        continue;
      }
      const wy = wg && wg.length > 1 && wg[1] > 0 ? (wg[1] | 0) : WORK;
      this._passDX[i] = ceilDiv(this.numX, wx);
      this._passDY[i] = ceilDiv(this.numY, wy);
    }
  }

  _writeParams(dt, originX, originY, bodyCount, shiftX, shiftY) {
    const p = this.params;
    p[0] = dt;
    p[1] = this.h;
    p[2] = this.numX;
    p[3] = this.numY;
    p[4] = originX;
    p[5] = originY;
    p[6] = bodyCount;
    p[7] = shiftX;
    p[8] = shiftY;
    p[9] = 0;
    const floats = Layer._uniformFloats[this.layerId];
    if (floats && floats.length) {
      const n = Math.min(floats.length, p.length - ENGINE_SIM_PREFIX_FLOATS);
      if (n > 0) p.set(floats.subarray(0, n), ENGINE_SIM_PREFIX_FLOATS);
    }
    this.device.queue.writeBuffer(this.paramsBuffer, 0, p);
  }

  _gridSize(frame, out) {
    const zoom = frame.zoom > 0 ? frame.zoom : 1;
    const cell = this.cellSize;
    const canvasW = frame.canvasW;
    const canvasH = frame.canvasH;
    const viewW = canvasW / zoom;
    const viewH = canvasH / zoom;
    if (this.gridFit === 'canvas') {
      out.numX = Math.max(8, (Math.ceil(canvasW / cell) | 0) + 2);
      out.numY = Math.max(8, (Math.ceil(canvasH / cell) | 0) + 2);
      out.h = viewW / out.numX;
      return out;
    }
    out.h = cell;
    out.numX = Math.max(8, (Math.ceil(viewW / out.h) | 0) + 2);
    out.numY = Math.max(8, (Math.ceil(viewH / out.h) | 0) + 2);
    return out;
  }

  step(frame) {
    if (this._compileError || !this._ready) return false;
    const g = this._gridSize(frame, this._gridOut);
    const numX = g.numX;
    const numY = g.numY;
    const h = g.h;
    const texelsChanged = this.numX !== numX || this.numY !== numY || !this._texReady;
    const hChanged = this._originReady && Math.abs(this.h - h) > 1e-6;
    this.resize(numX, numY, h);
    const originX = Math.floor(frame.cameraX / h) * h;
    const originY = Math.floor(frame.cameraY / h) * h;
    let di = 0;
    let dj = 0;
    if (this._originReady && !texelsChanged && !hChanged) {
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

    this._writeParams(frame.dt, originX, originY, packed.bodyCount, di, dj);

    const encoder = device.createCommandEncoder();
    const map = Layer._uniformMaps[this.layerId];
    const floats = Layer._uniformFloats[this.layerId];

    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      if (p.when === 'originShift' && di === 0 && dj === 0) continue;
      const layout = p.layout || 'simple';
      let iters = 1;
      if (typeof p.iterate === 'number') iters = Math.max(0, p.iterate | 0);
      else if (typeof p.iterate === 'string') {
        const e = map && map[p.iterate];
        iters = e && floats ? Math.max(0, floats[e.offset] | 0) : 0;
      }
      const dx = this._passDX[i];
      const dy = this._passDY[i];
      for (let k = 0; k < iters; k++) {
        this._dispatchIndex(encoder, i, layout, dx, dy);
        if (p.swap && p.swap.length) this._swapNamed(p.swap);
      }
    }

    const lookGpu = this._lookGpu();
    if (lookGpu && this._lookSample) {
      encoder.copyTextureToTexture(
        { texture: lookGpu },
        { texture: this._lookSample },
        { width: this.numX, height: this.numY }
      );
    }
    device.queue.submit([encoder.finish()]);
    if (this.lookSource && this._lookSample) {
      pinGpuTexture(this.renderer, this.lookSource, this._lookSample);
    }
    return true;
  }

  _dispatchPipe(encoder, pipe, layout, gx, gy) {
    const groups = this._bindGroups[layout];
    if (!pipe || !groups) return;
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipe);
    for (let g = 0; g < groups.length; g++) pass.setBindGroup(g, groups[g]);
    pass.dispatchWorkgroups(gx, gy);
    pass.end();
  }

  _dispatchIndex(encoder, passIndex, layout, gx, gy) {
    const pipe = this.pipelines[passIndex];
    if (!pipe) return;
    this._dispatchPipe(encoder, pipe, layout, gx, gy);
  }
}
