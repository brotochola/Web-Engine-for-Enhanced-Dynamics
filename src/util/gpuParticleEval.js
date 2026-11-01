// GPU particles in JavaScript: the closed form the vertex shaders (src/shaders/gpuParticle.*) evaluate, for tests
// and for "where is that particle now?" while debugging (GpuParticles.evaluate). A GPU particle moves the way a
// CPU particle does at whole frames, by semi-implicit Euler (v += a; p += v), so without drag
//   p(t) = p0 + v0·t + a·(t² + t) / 2              t = age in frames (ms / 16.67)
// and with drag d (per frame) the exact solution of dv/dt = a - d·v:
//   p(t) = p0 + (a/d)·t + (v0 - a/d)·(1 - e^(-d·t)) / d
// Flat: gravity on y. Heighted: the ground point (x, y) moves without gravity, the height z with it, drawn at
// y + z; v1 has no floor, so z stops at 0 (z < 0 is up). Eases are applyParticleEase (the CPU's: its expo eases
// sample a 256-entry table; the shaders compute them exactly, within 1e-3).

import { applyParticleEase } from './particleTween.js';
import { GPU_FLAG, GPU_FRAME_MS, GPU_REC } from './gpuParticleLayout.js';

const _f = new Float32Array(1);
const _u = new Uint32Array(_f.buffer);

/** The uint32 bits of a float (a record's `_T` fields). */
export function floatBits(v) {
  _f[0] = v;
  return _u[0];
}

/** The float whose bits are `u`. */
export function bitsFloat(u) {
  _u[0] = u >>> 0;
  return _f[0];
}

/**
 * Position along one axis after `t` frames with constant acceleration `a` and drag `d` per frame.
 * @param {number} p0
 * @param {number} v0
 * @param {number} a
 * @param {number} d
 * @param {number} t
 */
export function gpuTravel(p0, v0, a, d, t) {
  if (d < 1e-5) return p0 + v0 * t + (a * (t * t + t)) * 0.5;
  const terminal = a / d;
  return p0 + terminal * t + ((v0 - terminal) * (1 - Math.exp(-d * t))) / d;
}

/** Velocity after `t` frames (the derivative of gpuTravel; without drag, the Euler step's v after t updates). */
export function gpuVelocity(v0, a, d, t) {
  if (d < 1e-5) return v0 + a * t;
  const terminal = a / d;
  return terminal + (v0 - terminal) * Math.exp(-d * t);
}

function lerpRgb(from, to, e) {
  const fr = (from >>> 16) & 255, fg = (from >>> 8) & 255, fb = from & 255;
  const tr = (to >>> 16) & 255, tg = (to >>> 8) & 255, tb = to & 255;
  const r = Math.min(255, Math.max(0, Math.round(fr + (tr - fr) * e)));
  const g = Math.min(255, Math.max(0, Math.round(fg + (tg - fg) * e)));
  const b = Math.min(255, Math.max(0, Math.round(fb + (tb - fb) * e)));
  return (r << 16) | (g << 8) | b;
}

/**
 * Evaluate the record at `base` (a float index into `rec`) at `nowMs` on its ring's epoch.
 * @param {Float32Array} rec
 * @param {number} base
 * @param {number} nowMs
 * @param {object} [out]
 * @returns {{ alive: boolean, x: number, y: number, groundY: number, z: number, scaleX: number, scaleY: number,
 *   alpha: number, tint: number, rotation: number, frame: number, textureId: number }}
 */
export function evaluateGpuParticle(rec, base, nowMs, out = {}) {
  const birth = rec[base + GPU_REC.BIRTH];
  const life = rec[base + GPU_REC.LIFE];
  const ageMs = nowMs - birth;
  out.alive = ageMs >= 0 && ageMs < life;
  if (!out.alive) return out;
  const t = ageMs / GPU_FRAME_MS;
  const lp = ageMs / life;
  const bits = floatBits(rec[base + GPU_REC.EASES_T]);
  const heighted = (bits & GPU_FLAG.HEIGHTED) !== 0;
  const d = rec[base + GPU_REC.DRAG];
  const g = rec[base + GPU_REC.GRAVITY];
  const x = gpuTravel(rec[base + GPU_REC.X0], rec[base + GPU_REC.VX], 0, d, t);
  const y = gpuTravel(rec[base + GPU_REC.Y0], rec[base + GPU_REC.VY], heighted ? 0 : g, d, t);
  let z = 0;
  if (heighted) {
    z = gpuTravel(rec[base + GPU_REC.Z0], rec[base + GPU_REC.VZ], g, d, t);
    if (z > 0) z = 0;
  }
  const ease = (shift) => applyParticleEase(lp, (bits >>> shift) & 15);
  out.x = x;
  out.groundY = y;
  out.z = z;
  out.y = y + z;
  out.alpha = rec[base + GPU_REC.ALPHA_FROM] + (rec[base + GPU_REC.ALPHA_TO] - rec[base + GPU_REC.ALPHA_FROM]) * ease(0);
  out.scaleX = rec[base + GPU_REC.SCALE_X_FROM] + (rec[base + GPU_REC.SCALE_X_TO] - rec[base + GPU_REC.SCALE_X_FROM]) * ease(4);
  out.scaleY = rec[base + GPU_REC.SCALE_Y_FROM] + (rec[base + GPU_REC.SCALE_Y_TO] - rec[base + GPU_REC.SCALE_Y_FROM]) * ease(8);
  out.tint = lerpRgb(floatBits(rec[base + GPU_REC.TINT_FROM_T]), floatBits(rec[base + GPU_REC.TINT_TO_T]), ease(12));
  const rot = rec[base + GPU_REC.ROT_FROM] + (rec[base + GPU_REC.ROT_TO] - rec[base + GPU_REC.ROT_FROM]) * ease(16);
  const spin = rec[base + GPU_REC.SPIN_FROM] + (rec[base + GPU_REC.SPIN_TO] - rec[base + GPU_REC.SPIN_FROM]) * ease(20);
  out.rotation = rot + spin * ageMs;
  const frames = ((bits & GPU_FLAG.FRAMES_MASK) >>> GPU_FLAG.FRAMES_SHIFT) + 1;
  let f = Math.floor(lp * frames);
  if (f >= frames) f = frames - 1;
  out.frame = f;
  const word = floatBits(rec[base + GPU_REC.TEX01_T + (f >> 1)]);
  out.textureId = f & 1 ? word >>> 16 : word & 0xffff;
  return out;
}
