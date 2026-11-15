/**
 * DX-MAPS: a sheet's height and normal maps, packed into the atlas's twin page. The twin page has the atlas's size and the
 * same rectangles: where a frame's colour is in the atlas, its maps are in the twin, so a shader samples both with one UV.
 *
 * What a twin texel holds (RGBA8):
 * - R, G: the height above the floor of what the pixel shows, R·256 + G in 1/HEIGHT_UNITS px (up to 1023.98 px);
 * - B, A: its normal, octahedral, one byte each from 1 to 253 (as DX-FACES writes a face's), 0 where the pixel has none.
 * A texel with no map is 0 everywhere: "flat, on the floor".
 *
 * What a sheet gives (assets.spritesheets.<name>):
 * - `heightMap`: a PNG twin of its sheet (same frames, same places). Its height is R·256 + G in 1/64 px by default; a
 *   greyscale picture says so, `heightMap: { png, gray: 120 }` (white is 120 px).
 * - `normalMap`: a PNG twin in the usual RGB encoding, in the camera's space: x right, y up, z out of the screen (OpenGL's).
 * Without a normal map the normals come from the height (a Sobel gradient). Normals are in the camera's space throughout.
 */

/** Height steps a px in a twin texel (and in an rg16 heightMap). */
export const HEIGHT_UNITS = 64;
/** The largest height a twin texel holds, in px. */
export const HEIGHT_MAX = 65535 / HEIGHT_UNITS;
/** An edge pixel lower than every opaque neighbour by more than this (px) takes their height: see fixOutline. */
export const OUTLINE_STEP = 3;

/**
 * A normal's octahedral bytes, 1..253 each (0 stays "none"). The vector need not be unit.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {Uint8Array|Uint8ClampedArray|number[]} out
 * @param {number} at where the two bytes go
 */
export function encodeOctahedral(x, y, z, out, at) {
  const s = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / s;
  let v = y / s;
  if (z / s < 0) {
    const pu = u;
    u = (1 - Math.abs(v)) * (pu >= 0 ? 1 : -1);
    v = (1 - Math.abs(pu)) * (v >= 0 ? 1 : -1);
  }
  out[at] = Math.round(u * 126 + 127);
  out[at + 1] = Math.round(v * 126 + 127);
}

/**
 * The unit normal two octahedral bytes hold (the shaders decode it the same way: faceMap.js).
 * @returns {[number, number, number]}
 */
export function decodeOctahedral(a, b) {
  const fx = (a - 127) / 126;
  const fy = (b - 127) / 126;
  let nx = fx;
  let ny = fy;
  const nz = 1 - Math.abs(fx) - Math.abs(fy);
  const t = Math.max(-nz, 0);
  nx += nx >= 0 ? -t : t;
  ny += ny >= 0 ? -t : t;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/**
 * A frame's heights, in px, from its heightMap's pixels.
 * @param {Uint8ClampedArray} rgba the heightMap's pixels for the frame, w·h·4
 * @param {number} w
 * @param {number} h
 * @param {number} gray 0 for R·256 + G in 1/64 px; else the px that white is (a greyscale picture, R)
 * @returns {Float32Array}
 */
export function readHeights(rgba, w, h, gray = 0) {
  const out = new Float32Array(w * h);
  for (let p = 0, q = 0; p < w * h; p++, q += 4) {
    out[p] = gray > 0 ? (rgba[q] / 255) * gray : (rgba[q] * 256 + rgba[q + 1]) / HEIGHT_UNITS;
  }
  return out;
}

/**
 * The edge pixels a heightMap mixed with the background, raised to the surface they border (in place), as the light
 * bench found them: a pixel lower than every opaque neighbour by more than `step` px (the north outline of a table, 9 px
 * lower), and a pixel with nothing above it whose pixel below is more than `step` px higher.
 * @param {Float32Array} height px, w·h
 * @param {Uint8Array|Uint8ClampedArray} opaque 1 where the frame's colour is opaque, w·h
 * @returns {number} how many pixels it raised
 */
export function fixOutline(height, opaque, w, h, step = OUTLINE_STEP) {
  const src = Float32Array.from(height);
  let raised = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!opaque[p]) continue;
      let lowest = Infinity;
      let any = false;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!opaque[q]) continue;
          any = true;
          if (src[q] < lowest) lowest = src[q];
        }
      }
      if (any && src[p] < lowest - step) {
        height[p] = lowest;
        raised++;
        continue;
      }
      const emptyAbove = y === 0 || !opaque[p - w];
      if (emptyAbove && y + 1 < h && opaque[p + w] && src[p + w] > src[p] + step) {
        height[p] = src[p + w];
        raised++;
      }
    }
  }
  return raised;
}

/**
 * Normals in the camera's space from a frame's heights: a Sobel gradient over its opaque pixels (a transparent neighbour
 * counts as the pixel itself, so an outline does not lean towards the background). Screen y runs down, the normal's up.
 * @param {Float32Array} height px, w·h
 * @param {Uint8Array|Uint8ClampedArray} opaque w·h
 * @param {number} [strength] how much a px of height over a px of screen tilts it (1: as drawn)
 * @returns {Float32Array} x, y, z per pixel (0 where transparent)
 */
export function normalsFromHeight(height, opaque, w, h, strength = 1) {
  const out = new Float32Array(w * h * 3);
  const at = (x, y, here) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return here;
    const q = y * w + x;
    return opaque[q] ? height[q] : here;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!opaque[p]) continue;
      const c = height[p];
      const gx = (at(x + 1, y - 1, c) + 2 * at(x + 1, y, c) + at(x + 1, y + 1, c) - at(x - 1, y - 1, c) - 2 * at(x - 1, y, c) - at(x - 1, y + 1, c)) / 8;
      const gy = (at(x - 1, y + 1, c) + 2 * at(x, y + 1, c) + at(x + 1, y + 1, c) - at(x - 1, y - 1, c) - 2 * at(x, y - 1, c) - at(x + 1, y - 1, c)) / 8;
      // A surface z = h(x, y) with y down: (-∂h/∂x, +∂h/∂y, 1), the second sign turned for y up.
      const nx = -gx * strength;
      const ny = gy * strength;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      out[p * 3] = nx / l;
      out[p * 3 + 1] = ny / l;
      out[p * 3 + 2] = 1 / l;
    }
  }
  return out;
}

/**
 * A frame's normals from its normalMap's pixels (RGB in [0, 1] → [-1, 1], OpenGL's y up).
 * @returns {Float32Array} x, y, z per pixel
 */
export function readNormals(rgba, w, h) {
  const out = new Float32Array(w * h * 3);
  for (let p = 0, q = 0; p < w * h; p++, q += 4) {
    out[p * 3] = rgba[q] / 127.5 - 1;
    out[p * 3 + 1] = rgba[q + 1] / 127.5 - 1;
    out[p * 3 + 2] = rgba[q + 2] / 127.5 - 1;
  }
  return out;
}

/**
 * A frame's twin texels: its heights (R, G) and normals (B, A) where its colour is opaque, 0 elsewhere.
 * @param {Float32Array|null} height px, w·h (null: on the floor)
 * @param {Float32Array|null} normals x, y, z per pixel (null: none, the shader keeps its own)
 * @param {Uint8Array|Uint8ClampedArray} opaque w·h
 * @returns {Uint8ClampedArray} w·h·4
 */
export function twinTexels(height, normals, opaque, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    if (!opaque[p]) continue;
    const q = p * 4;
    if (height !== null) {
      const z = Math.round(Math.min(Math.max(height[p], 0), HEIGHT_MAX) * HEIGHT_UNITS);
      out[q] = z >> 8;
      out[q + 1] = z & 255;
    }
    if (normals !== null) encodeOctahedral(normals[p * 3], normals[p * 3 + 1], normals[p * 3 + 2], out, q + 2);
  }
  return out;
}

/**
 * A frame's opaque pixels from its colour (alpha past `threshold`).
 * @param {Uint8ClampedArray} rgba w·h·4
 * @returns {Uint8Array}
 */
export function opaqueMask(rgba, w, h, threshold = 127) {
  const out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = rgba[p * 4 + 3] > threshold ? 1 : 0;
  return out;
}

/**
 * Everything above for one frame: its colour, its maps (either may be null), and the twin texels for its rectangle.
 * @param {{ color: Uint8ClampedArray, height: Uint8ClampedArray|null, normal: Uint8ClampedArray|null, w: number, h: number,
 *   gray?: number, strength?: number }} frame
 * @returns {Uint8ClampedArray|null} null when the frame has no map
 */
export function frameTwinTexels({ color, height, normal, w, h, gray = 0, strength = 1, emissive = false }) {
  if (height === null && normal === null && !emissive) return null;
  const opaque = opaqueMask(color, w, h);
  if (height === null && normal === null) return emissiveTexels(null, opaque, w, h);
  let heights = null;
  if (height !== null) {
    heights = readHeights(height, w, h, gray);
    fixOutline(heights, opaque, w, h);
  }
  const normals = normal !== null ? readNormals(normal, w, h) : normalsFromHeight(heights, opaque, w, h, strength);
  return emissive ? emissiveTexels(heights, opaque, w, h) : twinTexels(heights, normals, opaque, w, h);
}

/** DX-EMISSIVE: the normal bytes that mark a glowing pixel in the twin page (no octahedral normal reaches 0 or 255). */
export const EMISSIVE_CODE = [0, 255];

/**
 * DX-EMISSIVE (F10): a glowing frame's twin texels: its heights when it has them, and EMISSIVE_CODE where a normal would
 * be. The face pass passes the code on, the light pass gives such a pixel full light.
 */
export function emissiveTexels(height, opaque, w, h) {
  const out = twinTexels(height, null, opaque, w, h);
  for (let p = 0; p < w * h; p++) {
    if (!opaque[p]) continue;
    out[p * 4 + 2] = EMISSIVE_CODE[0];
    out[p * 4 + 3] = EMISSIVE_CODE[1];
  }
  return out;
}
