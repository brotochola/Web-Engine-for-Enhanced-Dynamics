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
} from '../lib/pixi_8.16_.min.js';
import { packLiquidFunLightSlabs } from '../core/liquidFunLightSplat.js';
import { ParticleComponent } from '../components/ParticleComponent.js';

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
  }

  /**
   * Pack LiquidFun + CPU particle pose into instance buffer (screen-space for RT).
   * @param {object} views - LiquidFun.getViews()
   * @param {object} opts
   */
  upload(views, opts = {}) {
    const zoom = opts.zoom ?? 1;
    const cameraX = opts.cameraX ?? 0;
    const cameraY = opts.cameraY ?? 0;
    const resolution = opts.resolution ?? 1;
    const screenScale = zoom * resolution;
    const worldRadius = opts.radius > 0 ? opts.radius : 48;
    const screenRadius = worldRadius * screenScale;
    const intensity = opts.intensity ?? 1;
    const useTint = opts.useParticleTint !== false;
    const want = 1 << (opts.layerId | 0);
    const canvasW = opts.canvasW > 0 ? opts.canvasW : 0;
    const canvasH = opts.canvasH > 0 ? opts.canvasH : 0;
    const cull = canvasW > 0 && canvasH > 0;
    const pad = screenRadius;
    const data = this.data;
    const dataU32 = this.dataU32;
    const maxOut = this.capacity;
    let out = 0;

    const writeInst = (wx, wy, tint, alphaMul) => {
      const sx = (wx - cameraX) * screenScale;
      const sy = (wy - cameraY) * screenScale;
      if (cull) {
        if (sx < -pad || sy < -pad || sx > canvasW * resolution + pad || sy > canvasH * resolution + pad) {
          return;
        }
      }
      if (out >= maxOut) return;
      let r = 255;
      let g = 255;
      let b = 255;
      if (useTint && tint) {
        const t = tint >>> 0;
        if (t) {
          r = (t >> 16) & 0xff;
          g = (t >> 8) & 0xff;
          b = t & 0xff;
        }
      }
      let a = intensity * (alphaMul != null ? alphaMul : 1);
      let ai = (a * 255 + 0.5) | 0;
      if (ai < 0) ai = 0;
      else if (ai > 255) ai = 255;
      const base = out * LF_SPLAT_FLOATS;
      data[base] = sx;
      data[base + 1] = sy;
      data[base + 2] = screenRadius;
      dataU32[base + 3] = r | (g << 8) | (b << 16) | (ai << 24);
      out++;
    };

    if (views?.count && views.x && views.y) {
      const count = views.count[0] | 0;
      const n = count > views.maxCount ? views.maxCount : count;
      const xArr = views.x;
      const yArr = views.y;
      const tintArr = views.tint;
      const baseAlpha = views.baseAlpha;
      const alphaArr = views.alpha;
      const maskArr = views.layerMask;
      for (let i = 0; i < n && out < maxOut; i++) {
        if (maskArr && !(maskArr[i] & want)) continue;
        let a = 1;
        if (baseAlpha) a *= baseAlpha[i];
        if (alphaArr) a *= alphaArr[i];
        writeInst(xArr[i], yArr[i], tintArr ? tintArr[i] : 0, a);
      }
    }

    const active = ParticleComponent.active;
    const px = ParticleComponent.x;
    const py = ParticleComponent.y;
    if (active && px && py) {
      const cpuMask = ParticleComponent.layerMask;
      const cpuTint = ParticleComponent.tint;
      const cpuAlpha = ParticleComponent.alpha;
      const n = active.length;
      for (let i = 0; i < n && out < maxOut; i++) {
        if (!active[i]) continue;
        if (cpuMask && !(cpuMask[i] & want)) continue;
        writeInst(px[i], py[i], cpuTint ? cpuTint[i] : 0, cpuAlpha ? cpuAlpha[i] : 1);
      }
    }

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

  /**
   * Pack HEAP particles in lit group slabs (lightIntensity[id] > 0). Ignores sprite layerId.
   * @returns {number} packed instance count
   */
  uploadLitGroups(views, groups, opts = {}) {
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
