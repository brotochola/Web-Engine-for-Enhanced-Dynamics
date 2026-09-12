/**
 * Pack LiquidFun HEAP particles into the GPU particles SSBO (no alloc in the hot loop).
 */
import { LiquidFun } from '../core/LiquidFun.js';

export const PARTICLE_FLOATS = 4;
export const PARTICLE_STRIDE_BYTES = PARTICLE_FLOATS * 4;

/** Reused pack result (no alloc in the hot loop). */
export const PARTICLE_OUT = { particleCount: 0 };

let _overflowWarned = 0;

/**
 * @param {number} layerId
 * @param {Float32Array} particleData
 * @param {number} maxParticles
 * @returns {{ particleCount: number }}
 */
export function packLiquidFunParticles(layerId, particleData, maxParticles) {
  const cap = maxParticles | 0;
  if (!particleData || cap <= 0) {
    PARTICLE_OUT.particleCount = 0;
    return PARTICLE_OUT;
  }
  const views = LiquidFun.getViews();
  if (!views || !views.count || !views.x || !views.y) {
    PARTICLE_OUT.particleCount = 0;
    return PARTICLE_OUT;
  }
  const live = views.count[0] | 0;
  if (live <= 0) {
    PARTICLE_OUT.particleCount = 0;
    return PARTICLE_OUT;
  }
  const maxN = views.maxCount | 0;
  const n = live < maxN ? live : maxN;
  const x = views.x;
  const y = views.y;
  const vx = views.vx;
  const vy = views.vy;
  const layerIds = views.layerId;
  const wantLayer = layerId | 0;
  let written = 0;
  for (let i = 0; i < n; i++) {
    if (layerIds) {
      const lid = layerIds[i] | 0;
      if (lid !== 0 && lid !== wantLayer) continue;
    }
    if (written >= cap) {
      if (!_overflowWarned) {
        _overflowWarned = 1;
        console.warn(`packLiquidFunParticles: overflow (maxParticles=${cap})`);
      }
      break;
    }
    const b = written * PARTICLE_FLOATS;
    particleData[b] = x[i];
    particleData[b + 1] = y[i];
    particleData[b + 2] = vx ? vx[i] : 0;
    particleData[b + 3] = vy ? vy[i] : 0;
    written++;
  }
  PARTICLE_OUT.particleCount = written;
  return PARTICLE_OUT;
}
