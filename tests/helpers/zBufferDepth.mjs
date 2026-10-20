// Clip-Z helpers from the removed z-buffer sprite path (review D5). The
// renderer orders sprites on the CPU painter now, so no engine code calls
// these; gpuYSortDepth.test.js keeps their precision analysis runnable in
// case a depth-tested path comes back.
import { zSortBand } from '../../src/util/sortIndexByKey.js';

/**
 * Clip Z for the zIndex bands in use. `n` is (zMax - zMin + 1).
 * `half` is `-zMin * band`, so the low band starts at depth 1.
 */
export function depthSpanForZ(worldHeight, zMin, zMax) {
  const band = zSortBand(worldHeight);
  const n = (zMax | 0) - (zMin | 0) + 1;
  const bands = n > 0 ? n : 1;
  return { span: bands * band, half: -((zMin | 0) * band) };
}

/** Larger key closer to 0. `half` shifts the key (negative when min key is positive). */
export function depthFromOrderKey(key, span, half) {
  const s = span > 0 ? span : 1;
  const h = Number.isFinite(half) ? half : s * 0.5;
  let z = 1 - (key + h) / s;
  if (z < 0) z = 0;
  else if (z > 1) z = 1;
  return z;
}

/**
 * Clip Z for the same key the CPU painter orders. GL depth is less-wins,
 * so a larger key (farther down the screen, plus innerZ) maps closer to 0.
 * @param {number} key
 * @param {number} worldHeight
 * @param {number} ySortK
 */
export function depthFromSortKey(key, worldHeight, ySortK) {
  const span = (worldHeight > 0 ? worldHeight : 1) * (ySortK > 0 ? ySortK : 128);
  let z = 1 - key / span;
  if (z < 0) z = 0;
  else if (z > 1) z = 1;
  return z;
}

/** Full span of int16 zIndex bands. Too wide for a float32 clip Z: 1 px of foot collapses. */
export function orderKeySpan(worldHeight) {
  return 65536 * zSortBand(worldHeight);
}
