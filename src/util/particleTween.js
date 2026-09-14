// particleTween.js — ParticleEmitter value resolve + over-life ease (no Math.sin)
// number | {min,max} = spawn sample
// {from,to[,ease]} (+ start/end aliases) = over-life tween; endpoints may be nested {min,max}
// Expo easings use a 256-sample LUT + linear lerp (Math.pow is too expensive per particle).

import { PARTICLE_DEFAULTS, PARTICLE_EASE } from './ConfigDefaults.js';
import { randomRange, randomColor } from './utils.js';

/** @typedef {{ from: number, to: number, tween: boolean, ease: number }} ParticleTweenResult */
/** @typedef {{ from: number, to: number, tween: boolean, ease: number }} ParticleColorTweenResult */

export const PARTICLE_TWEEN = Object.freeze({
  ALPHA: 1,
  SCALEX: 2,
  SCALEY: 4,
  TINT: 8,
  ROT: 16,
});

const EASE_STRING_TO_ID = Object.freeze({
  lerp: PARTICLE_EASE.LERP,
  'quad.in': PARTICLE_EASE.QUAD_IN,
  'quad.out': PARTICLE_EASE.QUAD_OUT,
  'quad.inout': PARTICLE_EASE.QUAD_INOUT,
  'cubic.in': PARTICLE_EASE.CUBIC_IN,
  'cubic.out': PARTICLE_EASE.CUBIC_OUT,
  'cubic.inout': PARTICLE_EASE.CUBIC_INOUT,
  'expo.in': PARTICLE_EASE.EXPO_IN,
  'expo.out': PARTICLE_EASE.EXPO_OUT,
  'expo.inout': PARTICLE_EASE.EXPO_INOUT,
  'back.in': PARTICLE_EASE.BACK_IN,
  'back.out': PARTICLE_EASE.BACK_OUT,
  'back.inout': PARTICLE_EASE.BACK_INOUT,
  'bounce.out': PARTICLE_EASE.BOUNCE_OUT,
});

/** From PARTICLE_DEFAULTS — LUT built once at module load (scene override does not rebuild). */
const EXPO_LUT_SIZE = PARTICLE_DEFAULTS.expoLutSize | 0;

/**
 * @param {(t: number) => number} fn
 * @returns {Float32Array}
 */
function buildExpoLut(fn) {
  const lut = new Float32Array(EXPO_LUT_SIZE + 1);
  for (let i = 0; i <= EXPO_LUT_SIZE; i++) {
    lut[i] = fn(i / EXPO_LUT_SIZE);
  }
  return lut;
}

const EXPO_IN_LUT = buildExpoLut((t) => Math.pow(2, 10 * (t - 1)));
const EXPO_OUT_LUT = buildExpoLut((t) => 1 - Math.pow(2, -10 * t));
const EXPO_INOUT_LUT = buildExpoLut((t) =>
  t < 0.5
    ? 0.5 * Math.pow(2, 20 * t - 10)
    : 1 - 0.5 * Math.pow(2, -20 * t + 10)
);

/**
 * @param {Float32Array} lut
 * @param {number} t
 * @returns {number}
 */
function sampleExpoLut(lut, t) {
  const x = t * EXPO_LUT_SIZE;
  const i = x | 0;
  const f = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

/**
 * @param {unknown} ease
 * @returns {number}
 */
export function resolveEaseId(ease) {
  if (ease == null) return PARTICLE_EASE.LERP;
  if (typeof ease === 'number' && ease >= 0 && ease <= PARTICLE_EASE.BOUNCE_OUT) {
    return ease | 0;
  }
  if (typeof ease === 'string') {
    const id = EASE_STRING_TO_ID[ease.toLowerCase()];
    if (id !== undefined) return id;
  }
  return PARTICLE_EASE.LERP;
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isFromToObject(v) {
  return (
    v != null &&
    typeof v === 'object' &&
    ('from' in v || 'to' in v || 'start' in v || 'end' in v)
  );
}

/**
 * Sample a number or `{min,max}` once.
 * @param {unknown} v
 * @param {number} defaultVal
 * @returns {number}
 */
export function sampleNum(v, defaultVal = 0) {
  if (v === undefined || v === null) return defaultVal;
  if (typeof v === 'number') return v;
  return randomRange(v, defaultVal);
}

/**
 * @param {unknown} value
 * @param {number} defaultVal
 * @returns {ParticleTweenResult}
 */
export function resolveParticleOp(value, defaultVal = 0) {
  if (value === undefined || value === null) {
    return { from: defaultVal, to: defaultVal, tween: false, ease: PARTICLE_EASE.LERP };
  }
  if (typeof value === 'number') {
    return { from: value, to: value, tween: false, ease: PARTICLE_EASE.LERP };
  }
  if (isFromToObject(value)) {
    const fromRaw = value.from ?? value.start ?? defaultVal;
    const toRaw = value.to ?? value.end ?? defaultVal;
    return {
      from: sampleNum(fromRaw, defaultVal),
      to: sampleNum(toRaw, defaultVal),
      tween: true,
      ease: resolveEaseId(value.ease),
    };
  }
  // Spawn-only {min,max}
  const v = randomRange(value, defaultVal);
  return { from: v, to: v, tween: false, ease: PARTICLE_EASE.LERP };
}

/**
 * Color: number | {min,max} spawn | {from,to[,ease]} over life (endpoints number|{min,max}).
 * @param {unknown} value
 * @param {number} defaultVal
 * @returns {ParticleColorTweenResult}
 */
export function resolveParticleColorOp(value, defaultVal = 0xffffff) {
  if (value === undefined || value === null) {
    return { from: defaultVal, to: defaultVal, tween: false, ease: PARTICLE_EASE.LERP };
  }
  if (typeof value === 'number') {
    return { from: value, to: value, tween: false, ease: PARTICLE_EASE.LERP };
  }
  if (isFromToObject(value)) {
    const fromRaw = value.from ?? value.start ?? defaultVal;
    const toRaw = value.to ?? value.end ?? defaultVal;
    const from =
      typeof fromRaw === 'number' ? fromRaw : randomColor(fromRaw, defaultVal);
    const to = typeof toRaw === 'number' ? toRaw : randomColor(toRaw, defaultVal);
    return { from, to, tween: true, ease: resolveEaseId(value.ease) };
  }
  const c = randomColor(value, defaultVal);
  return { from: c, to: c, tween: false, ease: PARTICLE_EASE.LERP };
}

/**
 * Apply ease id to life progress t in [0,1]. No Math.sin.
 * Expo uses LUT256 + lerp (see particle-ease microbench).
 * @param {number} t
 * @param {number} easeId
 * @returns {number}
 */
export function applyParticleEase(t, easeId) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  switch (easeId | 0) {
    case PARTICLE_EASE.QUAD_IN:
      return t * t;
    case PARTICLE_EASE.QUAD_OUT:
      return t * (2 - t);
    case PARTICLE_EASE.QUAD_INOUT:
      return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case PARTICLE_EASE.CUBIC_IN:
      return t * t * t;
    case PARTICLE_EASE.CUBIC_OUT: {
      const u = t - 1;
      return u * u * u + 1;
    }
    case PARTICLE_EASE.CUBIC_INOUT: {
      if (t < 0.5) return 4 * t * t * t;
      const u = 2 * t - 2;
      return (t - 1) * u * u + 1;
    }
    case PARTICLE_EASE.EXPO_IN:
      return sampleExpoLut(EXPO_IN_LUT, t);
    case PARTICLE_EASE.EXPO_OUT:
      return sampleExpoLut(EXPO_OUT_LUT, t);
    case PARTICLE_EASE.EXPO_INOUT:
      return sampleExpoLut(EXPO_INOUT_LUT, t);
    case PARTICLE_EASE.BACK_IN: {
      const s = 1.70158;
      return t * t * ((s + 1) * t - s);
    }
    case PARTICLE_EASE.BACK_OUT: {
      const s = 1.70158;
      const u = t - 1;
      return u * u * ((s + 1) * u + s) + 1;
    }
    case PARTICLE_EASE.BACK_INOUT: {
      const s = 1.70158 * 1.525;
      if (t < 0.5) {
        const u = t * 2;
        return 0.5 * (u * u * ((s + 1) * u - s));
      }
      const u = t * 2 - 2;
      return 0.5 * (u * u * ((s + 1) * u + s) + 2);
    }
    case PARTICLE_EASE.BOUNCE_OUT: {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) {
        const u = t - 1.5 / d1;
        return n1 * u * u + 0.75;
      }
      if (t < 2.5 / d1) {
        const u = t - 2.25 / d1;
        return n1 * u * u + 0.9375;
      }
      const u = t - 2.625 / d1;
      return n1 * u * u + 0.984375;
    }
    case PARTICLE_EASE.LERP:
    default:
      return t;
  }
}

/**
 * Lerp two 0xRRGGBB colors.
 * @param {number} from
 * @param {number} to
 * @param {number} t
 * @returns {number}
 */
export function lerpRgb(from, to, t) {
  const fr = (from >> 16) & 0xff;
  const fg = (from >> 8) & 0xff;
  const fb = from & 0xff;
  const tr = (to >> 16) & 0xff;
  const tg = (to >> 8) & 0xff;
  const tb = to & 0xff;
  const r = (fr + (tr - fr) * t + 0.5) | 0;
  const g = (fg + (tg - fg) * t + 0.5) | 0;
  const b = (fb + (tb - fb) * t + 0.5) | 0;
  return (r << 16) | (g << 8) | b;
}
