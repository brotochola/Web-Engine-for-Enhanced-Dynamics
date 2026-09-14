/**
 * Pack LiquidFun HEAP + CPU ParticleEmitter poses into the GPU particles SSBO.
 */
import { LiquidFun } from '../core/LiquidFun.js';
import { ParticleComponent } from '../components/ParticleComponent.js';

export const PARTICLE_FLOATS = 4;
export const PARTICLE_STRIDE_BYTES = PARTICLE_FLOATS * 4;

/** Reused pack result (no alloc in the hot loop). */
export const PARTICLE_OUT = { particleCount: 0 };

let _overflowWarned = 0;

function packOne(particleData, written, x, y, vx, vy) {
  const b = written * PARTICLE_FLOATS;
  particleData[b] = x;
  particleData[b + 1] = y;
  particleData[b + 2] = vx;
  particleData[b + 3] = vy;
}

/**
 * Pack live particles whose emit `layerMask` includes this compute layer.
 * Missing `layerMask` column (heap-only tests) packs the live LF prefix.
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
  const want = 1 << (layerId | 0);
  let written = 0;

  const views = LiquidFun.getViews();
  if (views && views.count && views.x && views.y) {
    const live = views.count[0] | 0;
    const maxN = views.maxCount | 0;
    const n = live < maxN ? live : maxN;
    const x = views.x;
    const y = views.y;
    const vx = views.vx;
    const vy = views.vy;
    const mask = views.layerMask;
    for (let i = 0; i < n; i++) {
      if (mask && !(mask[i] & want)) continue;
      if (written >= cap) {
        if (!_overflowWarned) {
          _overflowWarned = 1;
          console.warn(`packLiquidFunParticles: overflow (maxParticles=${cap})`);
        }
        PARTICLE_OUT.particleCount = written;
        return PARTICLE_OUT;
      }
      packOne(particleData, written, x[i], y[i], vx ? vx[i] : 0, vy ? vy[i] : 0);
      written++;
    }
  }

  const active = ParticleComponent.active;
  const px = ParticleComponent.x;
  const py = ParticleComponent.y;
  if (active && px && py) {
    const cpuMask = ParticleComponent.layerMask;
    const cpuVx = ParticleComponent.vx;
    const cpuVy = ParticleComponent.vy;
    const n = active.length;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      if (cpuMask && !(cpuMask[i] & want)) continue;
      if (written >= cap) {
        if (!_overflowWarned) {
          _overflowWarned = 1;
          console.warn(`packLiquidFunParticles: overflow (maxParticles=${cap})`);
        }
        break;
      }
      packOne(particleData, written, px[i], py[i], cpuVx ? cpuVx[i] : 0, cpuVy ? cpuVy[i] : 0);
      written++;
    }
  }

  PARTICLE_OUT.particleCount = written;
  return PARTICLE_OUT;
}
