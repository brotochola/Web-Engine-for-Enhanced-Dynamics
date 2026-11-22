// JS twins of the shaders' math, for the tests (N-303 CR-12: out of src/, where only tests read them). Each one follows
// its shader line for line; the tests compare them with the shader text and with what the programs write.
import { PIXEL_DEPTH_BANDS, PIXEL_DEPTH_FLOOR_STEPS, PIXEL_DEPTH_PAINTER_STEPS } from '../../src/render/pixelDepth.js';

/**
 * A pixel's depth as the programs write it (for tests): band (0 back to 7 front), the floor place's u (0 north of the
 * view's span, 1 south), the painter step (an instance index). DX-FACEDEPTH: with `faces`, the continuous form (no floor()
 * of the floor place) and the painter step as given (a face's is 0; its innerZ is in u: FACE_INNER_Z_TIE).
 */
export function pixelDepthValue(band, u, instance, faces = false) {
  const b = Math.min(Math.max(band, 0), PIXEL_DEPTH_BANDS - 1);
  const uc = Math.min(Math.max(u, 0), 1) * (PIXEL_DEPTH_FLOOR_STEPS - 1);
  const q = faces ? uc : Math.floor(uc);
  const p = instance & (PIXEL_DEPTH_PAINTER_STEPS - 1);
  const d = (PIXEL_DEPTH_BANDS - 1 - b) * PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS
    + (PIXEL_DEPTH_FLOOR_STEPS - 1 - q) * PIXEL_DEPTH_PAINTER_STEPS
    + (PIXEL_DEPTH_PAINTER_STEPS - 1 - p);
  return d / (PIXEL_DEPTH_BANDS * PIXEL_DEPTH_FLOOR_STEPS * PIXEL_DEPTH_PAINTER_STEPS);
}

/**
 * N-258: the face pass's turnNormal in JS (faceMap.frag.glsl, faceFunctionsWgsl), for tests: a frame's normal (its own
 * camera space, x right, y up) as a sprite with rotation (cos, sin) and scale signs (sx, sy) draws it: mirrored where its
 * scale is negative, then turned with it (the screen's rotation, y down, is the opposite turn with y up).
 * @param {[number, number, number]|Float32Array} n
 * @param {number} c the sprite's rotation's cosine (1 for a shear: DX-DECOSKEW turns no normal)
 * @param {number} s its sine (0 for a shear)
 * @param {number} sx -1 for a negative scale x (flipX), else 1
 * @param {number} sy -1 for a negative scale y (flipY), else 1
 * @param {number[]|Float32Array} out
 */
export function turnFrameNormal(n, c, s, sx, sy, out) {
  const fx = n[0] * sx;
  const fy = n[1] * sy;
  out[0] = fx * c + fy * s;
  out[1] = fy * c - fx * s;
  out[2] = n[2];
  return out;
}

/**
 * JS twin of edgeLight, for the tests: the light at a canvas point `(u, v)` (0..1) from `texels` (RGBA floats, row-major,
 * `width` x `height`), the texels of kind `kind` only (all four when none is).
 */
export function edgeLightAt(texels, width, height, u, v, kind) {
  const px = u * width - 0.5;
  const py = v * height - 0.5;
  const bx = Math.floor(px);
  const by = Math.floor(py);
  const fx = px - bx;
  const fy = py - by;
  const at = (x, y) => {
    const cx = Math.min(width - 1, Math.max(0, x));
    const cy = Math.min(height - 1, Math.max(0, y));
    return (cy * width + cx) * 4;
  };
  const taps = [[bx, by, (1 - fx) * (1 - fy)], [bx + 1, by, fx * (1 - fy)], [bx, by + 1, (1 - fx) * fy], [bx + 1, by + 1, fx * fy]];
  let sum = 0;
  const own = taps.map(([x, y, w]) => {
    const keep = Math.abs(texels[at(x, y) + 3] - kind) <= 0.5 ? w : 0;
    sum += keep;
    return keep;
  });
  const weights = sum < 1e-5 ? taps.map((t) => t[2]) : own;
  const total = sum < 1e-5 ? 1 : sum;
  const out = [0, 0, 0];
  taps.forEach(([x, y], k) => {
    for (let c = 0; c < 3; c++) out[c] += (texels[at(x, y) + c] * weights[k]) / total;
  });
  return out;
}

/** Read back a packed light (for tests / debug). Writes into `out` and returns it. */
export function readLightDataTexel(data, maxLights, lightIndex, out = {}) {
  const i0 = lightIndex * 4;
  const i1 = maxLights * 4 + lightIndex * 4;
  out.x = data[i0];
  out.y = data[i0 + 1];
  out.intensity = data[i0 + 2];
  out.r = data[i1];
  out.g = data[i1 + 1];
  out.b = data[i1 + 2];
  return out;
}
