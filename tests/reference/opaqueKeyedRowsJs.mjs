// The opaque pass's rows of a by-row keyed frame as Pixi built them in JavaScript until E-479 (gpuPack.c
// opaque_keyed_rows): the kernel writes the same rows and the same cover.
import { OPAQUE_FRAME_MASK, OPAQUE_KEYED_ROW_FLOATS } from '../../src/render/opaquePass.js';

/**
 * The opaque rows of a keyed frame drawn by queue row, `n` draw slots: draw slot k's queue row rows[k] and statics key
 * slots[k] (floats, as the keyed pack writes them), its alpha and texture from the queue's columns (`alpha`, `texture`):
 * the slots whose packed alpha is 255 (gpuPack.c packed_tint's rounding) and whose frame has none of OPAQUE_FRAME_MASK,
 * nearest first, OPAQUE_KEYED_ROW_FLOATS a row into `out` (the row, the key, the slot). Returns how many, and their cover
 * in cover[0]: each one's frame's solid texels (`area`, by texture) times its scale's (`scaleX`, `scaleY`), in world px.
 * @param {Float32Array} rows
 * @param {Float32Array} slots
 * @param {number} n
 * @param {Float32Array} alpha
 * @param {Uint16Array} texture
 * @param {Float32Array} scaleX
 * @param {Float32Array} scaleY
 * @param {Uint8Array} texels
 * @param {Float32Array} area
 * @param {Float32Array} out
 * @param {Float64Array} cover
 * @returns {number}
 */
export function buildOpaqueKeyedRows(rows, slots, n, alpha, texture, scaleX, scaleY, texels, area, out, cover) {
  const frames = texels.length;
  const areas = area.length;
  let sum = 0;
  let m = 0;
  for (let k = n - 1; k >= 0; k--) {
    const row = rows[k];
    const i = row | 0;
    // packed_tint: (a clamped to [0, 1]) * 255 + 0.5, truncated; 255 for a at 254.5 / 255 and up (and past 1), not NaN.
    if (!(alpha[i] * 255 + 0.5 >= 255)) continue;
    const tex = texture[i];
    if (tex >= frames || (texels[tex] & OPAQUE_FRAME_MASK) !== 0) continue;
    const to = m * OPAQUE_KEYED_ROW_FLOATS;
    out[to] = row;
    out[to + 1] = slots[k];
    out[to + 2] = k;
    if (tex < areas) sum += Math.abs(area[tex] * scaleX[i] * scaleY[i]);
    m++;
  }
  cover[0] = sum;
  return m;
}
