/**
 * Generic WebGPU compute-layer runner. Same GPUDevice as Pixi.
 * Scene owns textures, extra buffers, pass graph. Layouts inferred from WGSL
 * unless compute.layouts is set. Engine owns Body/verts pack, Frame prefix, pin.
 *
 * ponytail: field-subset ping-pong rebuilds bind groups after each swap.
 * Ceiling: createBindGroup per swap. Upgrade: 16-combo cache.
 */
import { packBox2dBodies, BODY_FLOATS } from './Box2dBodyPack.js';
import { packLiquidFunParticles, PARTICLE_FLOATS } from './LiquidFunParticlePack.js';
import { Layer } from '../core/Layer.js';
import { pinGpuTexture } from './pinGpuTexture.js';
import { inferComputeLayout } from './inferComputeLayout.js';
import { prependComputePrelude } from './wgslPrelude.js';

const WORK = 8;
/** Engine FrameData prefix (floats). Scene uniforms memcpy at this offset. */
export const ENGINE_FRAME_PREFIX_FLOATS = 16;

/** Skip/run a compute pass gated on camera origin vs zoom. */
export function computePassActive(when, zoomChanged, camStill) {
  if (when === 'originShift') return !camStill;
  if (when === 'zoomChanged') return !!zoomChanged;
  return true;
}

function finiteOrZero(n) {
  return Number.isFinite(n) ? n : 0;
}

function passLayoutName(p) {
  return p.layout || p.source || 'simple';
}

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
    this.maxParticles = (meta.maxParticles | 0) || (meta.compute?.maxParticles | 0) || 0;
    this._texSize = meta.compute?.size || { scale: 1 };
    // Shallow-copy passes: compile() rewrites p.code with the engine prelude.
    this.passes = (meta.compute?.passes || []).map((p) => ({ ...p }));
    this.texDecls = (meta.compute?.textures || []).slice();
    this.bufDecls = (meta.compute?.buffers || []).slice();
    this.layoutSpecs = meta.compute?.layouts || null;
    if (!this.texDecls.length) {
      this.texDecls = [{ name: 'out', format: 'rgba8unorm', pingPong: false, look: true }];
    }
    this.numX = 0;
    this.numY = 0;
    this._texReady = false;

    const extra = Layer._uniformFloats[this.layerId]?.length || 0;
    this._paramCount = Math.max(32, Math.ceil((ENGINE_FRAME_PREFIX_FLOATS + extra) / 4) * 4);
    this.params = new Float32Array(this._paramCount);
    this.bodyData = new Float32Array(this.maxBodies * BODY_FLOATS);
    this.vertData = new Float32Array(this.maxBodies * 8 * 2);
    this.particleData = new Float32Array(Math.max(1, this.maxParticles) * PARTICLE_FLOATS);
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
    this.particleBuffer = device.createBuffer({
      size: Math.max(16, this.particleData.byteLength),
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
    // Reused packBox2dBodies opts — filled in step(), never allocated per tick.
    this._packOpts = {
      sweep: true,
      poseX: null,
      poseY: null,
      poseRotC: null,
      poseRotS: null,
      prevPoseX: null,
      prevPoseY: null,
      prevPoseRotC: null,
      prevPoseRotS: null,
    };
    this._layoutNames = null;
    this._bindGroups = Object.create(null);
    this._passDX = new Int32Array(Math.max(1, this.passes.length));
    this._passDY = new Int32Array(Math.max(1, this.passes.length));
    this._ready = false;
    this._compileError = false;
    this.feederCount = 0;
    this.lastBodyCount = 0;
    this.lastParticleCount = 0;
    this._prevCameraX = 0;
    this._prevCameraY = 0;
    this._prevZoom = 1;
    this._hasPrevFrame = false;
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
    const uniformMap = Layer._uniformMaps[this.layerId] || null;
    const uniformTypes = this.meta.uniformTypes || null;
    try {
      for (let i = 0; i < this.passes.length; i++) {
        const raw = this.passes[i].code;
        if (!raw) {
          throw new Error(`pass "${this.passes[i].entry}" missing WGSL`);
        }
        // Prepend engine FrameData/Body prelude; throws on redeclared structs.
        if (!this.passes[i]._preluded) {
          this.passes[i].code = prependComputePrelude(raw, uniformMap, uniformTypes);
          this.passes[i]._preluded = true;
        }
        const code = this.passes[i].code;
        if (this.modules.has(code)) continue;
        const module = device.createShaderModule({
          label: `compute-${this.meta.name}-${i}`,
          code,
        });
        const info = await module.getCompilationInfo();
        const errs = info.messages.filter((m) => m.type === 'error');
        if (errs.length) {
          throw new Error(errs.map((m) => m.message).join('\n'));
        }
        this.modules.set(code, module);
      }
      this._ensurePipelines();
    } catch (err) {
      this._compileError = true;
      this._compileErrorMessage = err && err.message ? err.message : String(err);
      throw err;
    }
    this._ready = true;
    return true;
  }

  _resolveLayoutSpecs() {
    if (this.layoutSpecs && Object.keys(this.layoutSpecs).length) {
      return this.layoutSpecs;
    }
    const out = Object.create(null);
    const ctx = { textures: this.texDecls, buffers: this.bufDecls };
    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      const key = passLayoutName(p);
      if (out[key]) continue;
      const inferred = inferComputeLayout(p.code || '', ctx);
      out[key] = inferred.length ? inferred : DEFAULT_LAYOUTS.simple;
    }
    if (!Object.keys(out).length) return DEFAULT_LAYOUTS;
    return out;
  }

  _ensurePipelines() {
    if (this.pipelines.length || this._compileError || this.modules.size === 0) return;
    const device = this.device;
    const specs = this._resolveLayoutSpecs();
    this._layouts = Object.create(null);
    const names = Object.keys(specs);
    this._layoutNames = names;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      this._layouts[name] = this._makeLayoutFromSpec(specs[name]);
    }
    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      const layoutName = passLayoutName(p);
      const layout = this._layouts[layoutName] || this._layouts.simple;
      if (!layout) {
        throw new Error(`WeedJS: missing layout "${layoutName}"`);
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

  resize(numX, numY) {
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
    if (name === 'particles') return { buffer: this.particleBuffer };
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
        const n = p.dispatchFrom === 'particles'
          ? Math.max(1, this.lastParticleCount | 0)
          : (this._bufCount[p.dispatchFrom] || 1);
        this._passDX[i] = ceilDiv(n, wx);
        this._passDY[i] = 1;
        continue;
      }
      const wy = wg && wg.length > 1 && wg[1] > 0 ? (wg[1] | 0) : WORK;
      this._passDX[i] = ceilDiv(this.numX, wx);
      this._passDY[i] = ceilDiv(this.numY, wy);
    }
  }

  _writeParams(frame, bodyCount, particleCount, prevX, prevY, prevZoom) {
    const p = this.params;
    const zoom = frame.zoom > 0 ? frame.zoom : 1;
    p[0] = frame.dt;
    p[1] = this.numX;
    p[2] = this.numY;
    p[3] = frame.cameraX;
    p[4] = frame.cameraY;
    p[5] = zoom;
    p[6] = bodyCount;
    p[7] = frame.canvasW;
    p[8] = frame.canvasH;
    p[9] = finiteOrZero(frame.worldW);
    p[10] = finiteOrZero(frame.worldH);
    p[11] = Number.isFinite(frame.time) ? frame.time : 0;
    p[12] = prevX;
    p[13] = prevY;
    p[14] = prevZoom > 0 ? prevZoom : 1;
    p[15] = particleCount;
    const floats = Layer._uniformFloats[this.layerId];
    if (floats && floats.length) {
      const n = Math.min(floats.length, p.length - ENGINE_FRAME_PREFIX_FLOATS);
      if (n > 0) p.set(floats.subarray(0, n), ENGINE_FRAME_PREFIX_FLOATS);
    }
    this.device.queue.writeBuffer(this.paramsBuffer, 0, p);
  }

  /**
   * @param {object} frame
   * @param {{ poseX?: Float32Array|null, poseY?: Float32Array|null, poseRotC?: Float32Array|null, poseRotS?: Float32Array|null, prevPoseX?: Float32Array|null, prevPoseY?: Float32Array|null, prevPoseRotC?: Float32Array|null, prevPoseRotS?: Float32Array|null }|null} [pose]
   */
  step(frame, pose) {
    if (this._compileError || !this._ready) return false;
    const ext = Layer.computeTextureExtent(frame.canvasW, frame.canvasH, this._texSize);
    this.resize(ext.texW, ext.texH);

    const packOpts = this._packOpts;
    packOpts.poseX = pose ? pose.poseX : null;
    packOpts.poseY = pose ? pose.poseY : null;
    packOpts.poseRotC = pose ? pose.poseRotC : null;
    packOpts.poseRotS = pose ? pose.poseRotS : null;
    packOpts.prevPoseX = pose ? pose.prevPoseX : null;
    packOpts.prevPoseY = pose ? pose.prevPoseY : null;
    packOpts.prevPoseRotC = pose ? pose.prevPoseRotC : null;
    packOpts.prevPoseRotS = pose ? pose.prevPoseRotS : null;
    const packed = packBox2dBodies(this.layerId, this.bodyData, this.vertData, this.maxBodies, packOpts);
    this.lastBodyCount = packed.bodyCount;
    this.feederCount = Layer._feedCount ? Atomics.load(Layer._feedCount, this.layerId) : 0;
    let particleCount = 0;
    if (this.maxParticles > 0) {
      particleCount = packLiquidFunParticles(
        this.layerId,
        this.particleData,
        this.maxParticles
      ).particleCount;
    }
    this.lastParticleCount = particleCount;
    this._refreshDispatch();
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
    if (particleCount > 0) {
      device.queue.writeBuffer(
        this.particleBuffer,
        0,
        this.particleData.subarray(0, particleCount * PARTICLE_FLOATS)
      );
    }

    const zoom = frame.zoom > 0 ? frame.zoom : 1;
    const camX = frame.cameraX;
    const camY = frame.cameraY;
    const prevX = this._hasPrevFrame ? this._prevCameraX : camX;
    const prevY = this._hasPrevFrame ? this._prevCameraY : camY;
    const prevZoom = this._hasPrevFrame ? this._prevZoom : zoom;

    this._writeParams(frame, packed.bodyCount, particleCount, prevX, prevY, prevZoom);

    const encoder = device.createCommandEncoder();
    const map = Layer._uniformMaps[this.layerId];
    const floats = Layer._uniformFloats[this.layerId];
    const zoomChanged = Math.abs(zoom - prevZoom) > 1e-6;
    const camStill = Math.abs(camX - prevX) < 1e-6 && Math.abs(camY - prevY) < 1e-6;

    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      if (!computePassActive(p.when, zoomChanged, camStill)) continue;
      const layout = passLayoutName(p);
      let iters = 1;
      if (typeof p.iterate === 'number') iters = Math.max(0, p.iterate | 0);
      else if (typeof p.iterate === 'string') {
        const e = map && map[p.iterate];
        iters = e && floats ? Math.max(0, floats[e.offset] | 0) : 0;
      }
      if (p.dispatchFrom === 'particles' && particleCount <= 0) continue;
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
    this._prevCameraX = camX;
    this._prevCameraY = camY;
    this._prevZoom = zoom;
    this._hasPrevFrame = true;
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
