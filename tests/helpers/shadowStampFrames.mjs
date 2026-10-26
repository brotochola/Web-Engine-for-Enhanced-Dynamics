// The shadow stamp's test frames (tests/node/shadowStampWasm.test.js, shadowStampF32.test.js): the
// render-queue memory the scene builds, with the sun rows and the stamp output on the GPU queue's region and
// the scratch in the stamp regions, and random frames built to reach every branch of stampLightRange.
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS, computeGpuQueueBufferSize, createGpuQueueViews, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { computeBufferSize } from '../../src/render/renderQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { bindShadowStamp } from '../../src/render/shadowStampClient.js';

export const MAX = 3000;
export const LIGHTS = 24;
export const PER_ENTITY = 3;

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {{ allPairs?: boolean }} [opts] allPairs: a stamp region with a row for every light and caster (the
 *   caps of a scene without per-light or per-entity limits), so an uncapped call never fills it
 */
export async function setup(opts = {}) {
  const lighting = { enabled: true, shadowsEnabled: true, maxShadowCastingLights: LIGHTS, maxShadowsPerLight: 64, maxShadowsPerEntity: PER_ENTITY, maxLights: 64 };
  const caps = gpuQueueCaps(MAX, opts.allPairs ? { ...lighting, maxShadowsPerLight: 0, maxShadowsPerEntity: 0 } : lighting);
  const m = createRenderQueueMemory(MAX, computeBufferSize(MAX), computeGpuQueueBufferSize(caps), null,
    { maxSun: caps.maxSun, maxPerEntity: PER_ENTITY, maxLights: LIGHTS });
  assert.ok(m?.layout.stamp);
  const dst = createGpuQueueViews(m.buffer, caps, m.layout.gpuAByte);
  const b = await bindShadowStamp(m.memory, m.layout.stamp);
  // The JS scratch as pre-render sizes it (_ensureStampScratch and the init's caps).
  const scratch = {
    tmpIdx: new Uint32Array(MAX),
    dist: new Float32Array(MAX),
    order: new Uint32Array(MAX),
    keepIdx: new Uint32Array(MAX),
    gridCounts: new Int32Array(128 * 128),
    gridStarts: new Int32Array(128 * 128 + 1),
    gridItems: new Uint32Array(MAX),
    lightVec: new Float32Array(4),
  };
  return { m, caps, dst, b, scratch };
}

/** A frame: casters into dst.sun, a light list, the stamp's parameters. */
export function frame(r, k, caps, dst) {
  const mode = k % 7;
  const nSun = mode === 5 ? 1 + Math.floor(r() * 3) : Math.floor(r() * (caps.maxSun + 1));
  const sun = dst.sun;
  sun.fill(0, 0, (nSun + 1) * GPU_CASTER_FLOATS);
  const spread = mode === 1 ? 60000 : 4000;
  for (let c = 0; c < nSun; c++) {
    const b = c * GPU_CASTER_FLOATS;
    let x = (mode === 2 ? 1500 + r() * 300 : r() * spread) - 200;
    let y = (mode === 2 ? 1500 + r() * 300 : r() * spread) - 200;
    if (mode === 3 && c % 97 === 0) x = NaN;
    if (mode === 3 && c % 131 === 0) y = Infinity;
    if (mode === 4 && c % 53 === 0) x = (r() < 0.5 ? -1 : 1) * (1e12 + r() * 1e12);
    if (c % 7 === 0) x = Math.round(x); // exact ties in distance
    // Mode 6: casters on a few integer spots, so many share a distance to a light (the selection's ties).
    if (mode === 6) {
      x = 1000 + 16 * Math.floor(r() * 6);
      y = 1000 + 16 * Math.floor(r() * 6);
    }
    sun[b] = x;
    sun[b + 1] = y;
    for (let f = 2; f < GPU_CASTER_FLOATS; f++) sun[b + f] = r();
  }
  const lights = [];
  const n = Math.floor(r() * (LIGHTS + 1));
  for (let i = 0; i < n; i++) {
    if (r() < 0.05) {
      lights.push(null);
      continue;
    }
    const range = r() < 0.05 ? 0 : 50 + r() * 900;
    // Mode 6: lights in pairs and triples on one spot, so a caster is as near to several (the per-caster ties).
    if (mode === 6 && i > 0 && lights[i - 1] && r() < 0.6) {
      lights.push({ ...lights[i - 1] });
      continue;
    }
    if (mode === 6) {
      lights.push({ x: 1040 + 8 * Math.floor(r() * 4), y: 1040 + 8 * Math.floor(r() * 4), intensity: 1, rangeSq: 400 * 400, maxShadows: r() < 0.5 ? 1 + Math.floor(r() * 6) : 0 });
      continue;
    }
    lights.push({
      x: (mode === 2 ? 1600 : r() * spread) + (r() - 0.5) * 400,
      y: (mode === 2 ? 1600 : r() * spread) + (r() - 0.5) * 400,
      intensity: r() < 0.05 ? -1 : r() * 2,
      rangeSq: r() < 0.03 ? NaN : range * range,
      maxShadows: r() < 0.3 ? Math.floor(r() * 40) : 0,
    });
  }
  return {
    nSun,
    lights,
    maxPerLight: [0, 8, 64, 512][k % 4],
    maxPerEntity: k % 3 === 0 ? 0 : (k % 3 === 1 ? 1 : PER_ENTITY),
    lightBegin: k % 5 === 4 ? 1 : 0,
    lightStride: k % 7 === 6 ? 2 : 1,
    stampCap: k % 4 === 3 ? Math.floor(r() * 50) : caps.maxStamp,
    stampBase: k % 9 === 8 ? 3 : 0,
  };
}

export function specFor(f, dst, scratch) {
  return {
    sun: dst.sun,
    sunN: f.nSun,
    sunFloats: GPU_CASTER_FLOATS,
    lights: f.lights,
    lightBegin: f.lightBegin,
    lightEnd: f.lights.length,
    lightStride: f.lightStride,
    maxPerLight: f.maxPerLight,
    maxPerEntity: f.maxPerEntity,
    used: null,
    ...scratch,
    stamp: dst.stamp,
    stampFloats: GPU_CASTER_FLOATS,
    stampCap: f.stampCap,
    stampBase: f.stampBase,
    stampLightIdx: dst.stampLightIdx,
  };
}
