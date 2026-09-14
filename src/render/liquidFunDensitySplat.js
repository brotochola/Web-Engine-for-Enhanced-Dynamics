/**
 * Procedural LiquidFun density splat: instanced unit quads with soft falloff.
 * Drawn ADD into a layer density RT (no atlas). Look pass stays on the layer frag.
 *
 * Instance layout (16 bytes): float32 x, y, radius + packed unorm8x4 RGBA.
 */

import {
  Geometry,
  Mesh,
  Shader,
  GpuProgram,
  GlProgram,
  Buffer,
  BufferUsage,
  State,
} from '../vendor/pixi.min.js';
import { packLiquidFunLightSlabs } from './liquidFunLightSplat.js';
import { ParticleComponent } from '../components/particleComponent.js';
import { snapshotParticleFeed } from '../util/layerFeed.js';

export const LF_SPLAT_FLOATS = 4;
export const LF_SPLAT_STRIDE = LF_SPLAT_FLOATS * 4;

export class LiquidFunDensitySplat {
  /**
   * @param {object} opts
   * @param {number} opts.capacity
   * @param {string} [opts.label]
   * @param {string} [opts.blendMode='add']
   * @param {boolean} [opts.useWebGpu=true]
   * @param {object} opts.shaders - fetched engine sources (`lfSplat` or lfSplatVert/Frag)
   * @param {object} [opts.shaderResources] - extra Pixi shader resources (lighting splat uniforms)
   */
  constructor({ capacity, label, blendMode = 'add', useWebGpu = true, shaders = null, shaderResources = null }) {
    this.capacity = Math.max(1, capacity | 0);
    this.data = new Float32Array(this.capacity * LF_SPLAT_FLOATS);
    this.dataU32 = new Uint32Array(this.data.buffer);
    this.buffer = new Buffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
      label: label || 'lf-density-splat',
    });

    // Centered unit quad in [-1, 1]
    const quad = new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]);
    const stride = LF_SPLAT_STRIDE;
    const buf = this.buffer;

    this.geometry = new Geometry({
      attributes: {
        aQuad: { buffer: quad, format: 'float32x2' },
        aInstXY: { buffer: buf, format: 'float32x2', stride, offset: 0, instance: true },
        aInstRadius: { buffer: buf, format: 'float32', stride, offset: 8, instance: true },
        aInstColor: { buffer: buf, format: 'unorm8x4', stride, offset: 12, instance: true },
      },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    this.geometry.instanceCount = 0;

    const name = label || 'lf-density-splat';
    if (useWebGpu) {
      const source = shaders?.lfSplat;
      if (!source) {
        throw new Error(
          'WeedJS: LiquidFun splat WGSL was not loaded before LiquidFunDensitySplat construction.'
        );
      }
      const gpuProgram = GpuProgram.from({
        name,
        vertex: { source, entryPoint: 'mainVert' },
        fragment: { source, entryPoint: 'mainFrag' },
      });
      this.shader = new Shader({ gpuProgram, resources: shaderResources || {} });
    } else {
      const vertex = shaders?.lfSplatVert;
      const fragment = shaders?.lfSplatFrag;
      if (!vertex || !fragment) {
        throw new Error(
          'WeedJS: LiquidFun splat GLSL was not loaded before LiquidFunDensitySplat construction.'
        );
      }
      const glProgram = GlProgram.from({
        vertex,
        fragment,
        name,
      });
      this.shader = new Shader({ glProgram, resources: shaderResources || {} });
    }

    const state = new State();
    state.blend = true;
    state.blendMode = blendMode || 'add';
    state.depthTest = false;
    state.depthMask = false;
    state.culling = false;

    this.mesh = new Mesh({
      geometry: this.geometry,
      shader: this.shader,
      state,
    });
    this.mesh.label = label || 'lf-density-splat';
    this.mesh.blendMode = blendMode || 'add';
    this.mesh.visible = false;
    this._camX = 0;
    this._camY = 0;
    this._screenScale = 1;
    this._canvasW = 0;
    this._canvasH = 0;
    this._resolution = 1;
    this._screenRadius = 1;
    this._pad = 0;
    this._cull = false;
    this._useTint = true;
    this._intensity = 1;
    this._out = 0;
  }

  /**
   * Pack LiquidFun + CPU particle pose into instance buffer (screen-space for RT).
   * @param {object} views - LiquidFun.getViews()
   * @param {object} opts
   */
  upload(views, opts) {
    const zoom = opts.zoom ?? 1;
    const resolution = opts.resolution ?? 1;
    const screenScale = zoom * resolution;
    const worldRadius = opts.radius > 0 ? opts.radius : 48;
    this._camX = opts.cameraX ?? 0;
    this._camY = opts.cameraY ?? 0;
    this._screenScale = screenScale;
    this._resolution = resolution;
    this._screenRadius = worldRadius * screenScale;
    this._intensity = opts.intensity ?? 1;
    this._useTint = opts.useParticleTint !== false;
    this._canvasW = opts.canvasW > 0 ? opts.canvasW : 0;
    this._canvasH = opts.canvasH > 0 ? opts.canvasH : 0;
    this._cull = this._canvasW > 0 && this._canvasH > 0;
    this._pad = this._screenRadius;
    this._out = 0;
    const want = 1 << (opts.layerId | 0);
    const maxOut = this.capacity;

    if (views?.count && views.x && views.y) {
      const count = views.count[0] | 0;
      const n = count > views.maxCount ? views.maxCount : count;
      const xArr = views.x;
      const yArr = views.y;
      const tintArr = views.tint;
      const baseAlpha = views.baseAlpha;
      const alphaArr = views.alpha;
      const maskArr = views.layerMask;
      for (let i = 0; i < n && this._out < maxOut; i++) {
        if (maskArr && !(maskArr[i] & want)) continue;
        let a = 1;
        if (baseAlpha) a *= baseAlpha[i];
        if (alphaArr) a *= alphaArr[i];
        this._writeInst(xArr[i], yArr[i], tintArr ? tintArr[i] : 0, a);
      }
    }

    const active = ParticleComponent.active;
    const px = ParticleComponent.x;
    const py = ParticleComponent.y;
    if (active && px && py) {
      const cpuMask = ParticleComponent.layerMask;
      const cpuTint = ParticleComponent.tint;
      const cpuAlpha = ParticleComponent.alpha;
      const snap = snapshotParticleFeed(opts.layerId | 0);
      const useFeed = !!snap;
      const cpuN = useFeed ? snap.count : active.length;
      const feedIdx = useFeed ? snap.indices : null;
      for (let f = 0; f < cpuN && this._out < maxOut; f++) {
        const i = feedIdx ? feedIdx[f] : f;
        if (!active[i]) continue;
        if (cpuMask && !(cpuMask[i] & want)) continue;
        this._writeInst(px[i], py[i], cpuTint ? cpuTint[i] : 0, cpuAlpha ? cpuAlpha[i] : 1);
      }
    }

    const out = this._out;
    if (out <= 0) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      return 0;
    }

    this.buffer.update(out * LF_SPLAT_STRIDE);
    this.geometry.instanceCount = out;
    this.mesh.visible = true;
    return out;
  }

  _writeInst(wx, wy, tint, alphaMul) {
    const sx = (wx - this._camX) * this._screenScale;
    const sy = (wy - this._camY) * this._screenScale;
    if (this._cull) {
      const pad = this._pad;
      if (sx < -pad || sy < -pad || sx > this._canvasW * this._resolution + pad || sy > this._canvasH * this._resolution + pad) {
        return;
      }
    }
    let out = this._out;
    if (out >= this.capacity) return;
    let r = 255;
    let g = 255;
    let b = 255;
    if (this._useTint && tint) {
      const t = tint >>> 0;
      if (t) {
        r = (t >> 16) & 0xff;
        g = (t >> 8) & 0xff;
        b = t & 0xff;
      }
    }
    let a = this._intensity * (alphaMul != null ? alphaMul : 1);
    let ai = (a * 255 + 0.5) | 0;
    if (ai < 0) ai = 0;
    else if (ai > 255) ai = 255;
    const base = out * LF_SPLAT_FLOATS;
    this.data[base] = sx;
    this.data[base + 1] = sy;
    this.data[base + 2] = this._screenRadius;
    this.dataU32[base + 3] = r | (g << 8) | (b << 16) | (ai << 24);
    this._out = out + 1;
  }

  /**
   * Pack HEAP particles in lit group slabs (lightIntensity[id] > 0). Ignores sprite layerId.
   * @returns {number} packed instance count
   */
  uploadLitGroups(views, groups, opts) {
    const n = packLiquidFunLightSlabs(
      this.data,
      this.dataU32,
      this.capacity,
      views,
      groups,
      opts,
    );
    if (n <= 0) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      return 0;
    }
    this.buffer.update(n * LF_SPLAT_STRIDE);
    this.geometry.instanceCount = n;
    this.mesh.visible = true;
    return n;
  }

  destroy() {
    this.mesh?.destroy({ children: true });
    this.geometry = null;
    this.shader = null;
    this.mesh = null;
    this.buffer = null;
    this.data = null;
    this.dataU32 = null;
  }
}
