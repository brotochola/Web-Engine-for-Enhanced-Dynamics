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
   * Pack LiquidFun pose into instance buffer (screen-space for RT).
   * @param {object} views - LiquidFun.getViews()
   * @param {object} opts
   * @param {number} opts.layerId
   * @param {number} opts.zoom
   * @param {number} opts.cameraX
   * @param {number} opts.cameraY
   * @param {number} [opts.resolution=1]
   * @param {number} opts.radius - world-space kernel radius
   * @param {number} [opts.intensity=1]
   * @param {boolean} [opts.useParticleTint=true]
   * @param {number} [opts.canvasW]
   * @param {number} [opts.canvasH]
   */
  upload(views, opts = {}) {
    if (!views?.count || !views.x || !views.y) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      return 0;
    }

    const count = views.count[0] | 0;
    if (count <= 0) {
      this.geometry.instanceCount = 0;
      this.mesh.visible = false;
      return 0;
    }

    const zoom = opts.zoom ?? 1;
    const cameraX = opts.cameraX ?? 0;
    const cameraY = opts.cameraY ?? 0;
    const resolution = opts.resolution ?? 1;
    const screenScale = zoom * resolution;
    const worldRadius = opts.radius > 0 ? opts.radius : 48;
    const screenRadius = worldRadius * screenScale;
    const intensity = opts.intensity ?? 1;
    const useTint = opts.useParticleTint !== false;
    const layerId = opts.layerId | 0;
    const xArr = views.x;
    const yArr = views.y;
    const tintArr = views.tint;
    const baseAlpha = views.baseAlpha;
    const alphaArr = views.alpha;
    const layerArr = views.layerId;
    const canvasW = opts.canvasW > 0 ? opts.canvasW : 0;
    const canvasH = opts.canvasH > 0 ? opts.canvasH : 0;
    const cull = canvasW > 0 && canvasH > 0;
    const pad = screenRadius;
    const data = this.data;
    const dataU32 = this.dataU32;

    let out = 0;
    const maxOut = this.capacity;
    const n = count > views.maxCount ? views.maxCount : count;

    for (let i = 0; i < n; i++) {
      if (layerArr && (layerArr[i] | 0) !== layerId) continue;

      const sx = (xArr[i] - cameraX) * screenScale;
      const sy = (yArr[i] - cameraY) * screenScale;
      if (cull) {
        if (sx < -pad || sy < -pad || sx > canvasW * resolution + pad || sy > canvasH * resolution + pad) {
          continue;
        }
      }
      if (out >= maxOut) break;

      let r = 255;
      let g = 255;
      let b = 255;
      if (useTint && tintArr) {
        const tint = tintArr[i] >>> 0;
        if (tint) {
          r = (tint >> 16) & 0xff;
          g = (tint >> 8) & 0xff;
          b = tint & 0xff;
        }
      }

      let a = intensity;
      if (baseAlpha) a *= baseAlpha[i];
      if (alphaArr) a *= alphaArr[i];
      let ai = (a * 255 + 0.5) | 0;
      if (ai < 0) ai = 0;
      else if (ai > 255) ai = 255;

      const base = out * LF_SPLAT_FLOATS;
      data[base] = sx;
      data[base + 1] = sy;
      data[base + 2] = screenRadius;
      dataU32[base + 3] = r | (g << 8) | (b << 16) | (ai << 24);
      out++;
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
