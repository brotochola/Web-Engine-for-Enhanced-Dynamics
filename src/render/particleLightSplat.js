/**
 * Pack lit ParticleComponent slots into the liquid-light instance layout.
 * float32 x, y, radius + packed unorm8x4 RGBA. No allocation.
 */

import { CAMERA_TYPES, LIGHTING_DEFAULTS } from '../util/configDefaults.js';
import { LIGHT_INFLUENCE_RADIUS_SCALE } from '../util/utils.js';

export const PARTICLE_LIGHT_FLOATS = 4;

/**
 * Whether particle lights run, and their cap. Raycasted visibility lighting
 * builds its own field and never draws them (as with the liquid light field),
 * so they are switched off there, with a warning, rather than allocating a
 * splat and forcing a lighting render texture nobody draws into.
 * @param {{ enabled?: boolean, max?: number }|undefined} particleLights lighting.particleLights
 * @param {boolean} raycasted visibilityPolygons.enabled
 * @returns {{ enabled: boolean, max: number, warning: string|null }}
 */
export function resolveParticleLights(particleLights, raycasted) {
  const cfg = particleLights || LIGHTING_DEFAULTS.particleLights;
  if (!cfg.enabled) return { enabled: false, max: 0, warning: null };
  if (raycasted) {
    return {
      enabled: false,
      max: 0,
      warning: 'lighting.particleLights is ignored with raycasted lighting (visibilityPolygons): it is not drawn there',
    };
  }
  const max = cfg.max != null ? cfg.max | 0 : LIGHTING_DEFAULTS.particleLights.max;
  return max > 0 ? { enabled: true, max, warning: null } : { enabled: false, max: 0, warning: null };
}
/** Drop quads whose projected alpha is at or under this. */
export const PARTICLE_LIGHT_ALPHA_CUT = 1 / 255;
/** Drop quads smaller than half a lighting-RT pixel. */
export const PARTICLE_LIGHT_MIN_SCREEN_RADIUS = 0.5;

/**
 * Lowest visible layer's alpha, or 0 when every subscribed layer is hidden.
 * No visibility table means "visible" so a pack without layers still runs.
 * @param {number} mask
 * @param {Uint8Array|null|undefined} visible
 * @param {Float32Array|null|undefined} alphaArr
 * @returns {number}
 */
function layerAlpha(mask, visible, alphaArr) {
  if (!visible) return 1;
  let m = mask | 0;
  if (!m) return 0;
  const n = visible.length | 0;
  while (m) {
    const bit = m & -m;
    const id = 31 - Math.clz32(bit);
    m ^= bit;
    if (id < 0 || id >= n || !visible[id]) continue;
    if (!alphaArr) return 1;
    const a = alphaArr[id];
    return a > 0 ? a : 0;
  }
  return 0;
}

/**
 * @param {Float32Array} data
 * @param {Uint32Array} dataU32
 * @param {number} capacity
 * @param {{ active: Uint16Array, lightSqrt: Float32Array, x: Float32Array, y: Float32Array, z?: Float32Array, alpha?: Float32Array, tint?: Uint32Array, flat?: Uint8Array, viewMode?: Uint8Array, renderOnly?: Uint8Array, layerMask?: Uint16Array }} views
 * @param {{ zoom?: number, cameraX?: number, cameraY?: number, cameraRot?: number, resolution?: number, canvasW?: number, canvasH?: number, zenithalMaxHeight?: number, zenithalAlphaFade?: number, layerVisible?: Uint8Array|null, layerAlpha?: Float32Array|null, max?: number }} opts
 * @returns {number} packed instance count
 */
export function packParticleLights(data, dataU32, capacity, views, opts) {
  if (!data || !dataU32 || !views || !views.active || !views.lightSqrt || !views.x || !views.y) {
    return 0;
  }
  const storeCap = capacity | 0;
  const max = opts && opts.max != null ? opts.max | 0 : storeCap;
  const cap = max > 0 && max < storeCap ? max : storeCap;
  if (cap <= 0) return 0;

  const active = views.active;
  let n = active[0] | 0;
  if (n < 0) n = 0;
  const listMax = active.length - 1;
  if (n > listMax) n = listMax;
  if (n <= 0) return 0;

  const zoom = opts.zoom ?? 1;
  const cameraX = opts.cameraX ?? 0;
  const cameraY = opts.cameraY ?? 0;
  const resolution = opts.resolution ?? 1;
  const screenScale = zoom * resolution;
  if (!(screenScale > 0)) return 0;

  const canvasW = opts.canvasW > 0 ? opts.canvasW : 0;
  const canvasH = opts.canvasH > 0 ? opts.canvasH : 0;
  const cull = canvasW > 0 && canvasH > 0;
  const rtW = canvasW * resolution;
  const rtH = canvasH * resolution;
  const rot = opts.cameraRot || 0;
  const useRot = !!(rot && cull && zoom > 0);
  let camC = 1;
  let camS = 0;
  let focusX = 0;
  let focusY = 0;
  let halfW = 0;
  let halfH = 0;
  if (useRot) {
    camC = Math.cos(rot);
    camS = Math.sin(rot);
    focusX = cameraX + canvasW / (2 * zoom);
    focusY = cameraY + canvasH / (2 * zoom);
    halfW = canvasW * 0.5 * resolution;
    halfH = canvasH * 0.5 * resolution;
  }

  const lightSqrt = views.lightSqrt;
  const xArr = views.x;
  const yArr = views.y;
  const zArr = views.z;
  const alphaArr = views.alpha;
  const tintArr = views.tint;
  const flatArr = views.flat;
  const viewMode = views.viewMode;
  const renderOnly = views.renderOnly;
  const layerMask = views.layerMask;
  const layerVisible = opts.layerVisible || null;
  const layerAlphaArr = opts.layerAlpha || null;
  const zMax = opts.zenithalMaxHeight > 0 ? opts.zenithalMaxHeight : 0;
  const zFade = opts.zenithalAlphaFade > 0 ? opts.zenithalAlphaFade : 0;
  const poolN = lightSqrt.length | 0;

  let out = 0;
  for (let s = 0; s < n && out < cap; s++) {
    const i = active[1 + s] | 0;
    if (i < 0 || i >= poolN) continue;
    const sqrtI = lightSqrt[i];
    if (!(sqrtI > 0)) continue;
    if (renderOnly && renderOnly[i]) continue;

    const worldRadius = sqrtI * LIGHT_INFLUENCE_RADIUS_SCALE;
    const screenRadius = worldRadius * screenScale;
    if (!(screenRadius >= PARTICLE_LIGHT_MIN_SCREEN_RADIUS)) continue;

    const isFlat = !!(flatArr && flatArr[i]);
    const isZenithal = !isFlat && !!(viewMode && viewMode[i] === CAMERA_TYPES.ZENITHAL);
    let wy = yArr[i];
    if (!isFlat && !isZenithal && zArr) wy += zArr[i];

    let a = alphaArr ? alphaArr[i] : 1;
    if (isZenithal && zArr && zFade > 0 && zMax > 0) {
      const height = -zArr[i];
      const alphaFade = Math.min(1, (height / zMax) * zFade);
      a *= Math.max(0, 1 - alphaFade);
    }
    if (layerMask) a *= layerAlpha(layerMask[i], layerVisible, layerAlphaArr);
    if (!(a > PARTICLE_LIGHT_ALPHA_CUT)) continue;

    let sx;
    let sy;
    if (useRot) {
      const dx = xArr[i] - focusX;
      const dy = wy - focusY;
      sx = halfW + (dx * camC - dy * camS) * screenScale;
      sy = halfH + (dx * camS + dy * camC) * screenScale;
    } else {
      sx = (xArr[i] - cameraX) * screenScale;
      sy = (wy - cameraY) * screenScale;
    }
    if (cull) {
      if (sx < -screenRadius || sy < -screenRadius || sx > rtW + screenRadius || sy > rtH + screenRadius) {
        continue;
      }
    }

    let r = 255;
    let g = 255;
    let b = 255;
    if (tintArr) {
      const tint = tintArr[i] >>> 0;
      if (tint) {
        r = (tint >> 16) & 0xff;
        g = (tint >> 8) & 0xff;
        b = tint & 0xff;
      }
    }
    let ai = (a * 255 + 0.5) | 0;
    if (ai < 0) ai = 0;
    else if (ai > 255) ai = 255;

    const base = out * PARTICLE_LIGHT_FLOATS;
    data[base] = sx;
    data[base + 1] = sy;
    data[base + 2] = screenRadius;
    dataU32[base + 3] = r | (g << 8) | (b << 16) | (ai << 24);
    out++;
  }
  return out;
}
