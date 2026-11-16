// DX-SHADOW3D / DX-MAPS: where each frame stands, measured once from its pixels when the atlas is made, so a light's card
// can stand on the side of the base that faces the light (the light bench's baseSupport):
//
// - a picture of one view (a person, a tree): its base is an ellipse on the floor, the feet or the trunk. Its centre and
//   radius come from the frame's lowest opaque rows (the trunk above the roots when there is one); the card stands on
//   the ellipse's edge towards the light, so the whole base lies on its own shadow.
// - a render with a height map (a car, a table, a cow drawn from many directions): it touches the floor where its height
//   map is within 1.5 px of its lowest point (the wheels, the legs); the card stands on the contact nearest the light, not
//   on the footprint's edge (a cow's head).
//
// The atlas keeps the result in its json (each frame's `base`), in the frame's own pixels (screen px from its top
// left, untrimmed); the Pixi worker writes it into the texture table's two spare floats (lutBaseFloats), which only the
// shadow passes read.

/** A render's pixel touches the floor within this height (px) of the frame's lowest point. */
export const CONTACT_HEIGHT = 1.5;

/**
 * H-EDGE: what a frame's texels hold, as the registry scans them (spriteSheetRegistry.js: the atlas's json frame base's
 * `texels`): FRAME_SOFT a texel of alpha 1 to 127, FRAME_HALF one of 128 to 254, FRAME_GLOW a glowing texel in the
 * atlas's twin page. A frame with none is binary: every texel's alpha 0 or 255, none glowing. The texture table keeps them
 * a frame on the CPU (instancedSpriteBatch.js textureLutTexels), FRAME_UNSCANNED for a frame the registry did not scan.
 */
export const FRAME_SOFT = 1;
export const FRAME_HALF = 2;
export const FRAME_GLOW = 4;
export const FRAME_UNSCANNED = 8;

/**
 * H-EDGE: the texture table's soft-or-glow bit (instancedSpriteBatch.js packTextureLutRgba), set for a frame that has a
 * texel of alpha 1 to 127 or a glowing one (or was not scanned): the frames whose pixels DX-DEPTH's edge pass may draw
 * with an opaque tint besides the soft edges linear filtering makes. A bit a frame, at its slot in its row (t % perRow),
 * in a flags texel after the row's frames (textureLutLayout), TEX_LUT_FLAG_BITS a channel (whole numbers a float32 holds
 * exactly), so TEX_LUT_FLAGS_PER_ROW slots a row have one; a shader reads a slot past them, or a table without the texel,
 * as set. Every shader that reads the table still finds perRow as its width / 3.
 */
export const TEX_LUT_SOFT_OR_GLOW = FRAME_SOFT | FRAME_GLOW | FRAME_UNSCANNED;
export const TEX_LUT_FLAG_BITS = 24;
export const TEX_LUT_FLAGS_PER_ROW = 4 * TEX_LUT_FLAG_BITS;

/**
 * H-EDGE: FRAME_SOFT and FRAME_HALF for a frame's rectangle of an image's pixels (spriteSheetRegistry.js _readImagePixels:
 * { data, x, y, width, height }); what lies outside the read rectangle is transparent.
 * @param {{ data: Uint8ClampedArray, x: number, y: number, width: number, height: number }} pixels
 * @param {number} fx
 * @param {number} fy
 * @param {number} w
 * @param {number} h
 * @returns {number}
 */
export function frameAlphaKinds(pixels, fx, fy, w, h) {
  const data = pixels.data;
  const iw = pixels.width;
  const x0 = Math.max(fx, pixels.x) - pixels.x;
  const y0 = Math.max(fy, pixels.y) - pixels.y;
  const x1 = Math.min(fx + w, pixels.x + iw) - pixels.x;
  const y1 = Math.min(fy + h, pixels.y + pixels.height) - pixels.y;
  let kinds = 0;
  for (let y = y0; y < y1 && kinds !== (FRAME_SOFT | FRAME_HALF); y++) {
    for (let at = (y * iw + x0) * 4 + 3, end = (y * iw + x1) * 4; at < end; at += 4) {
      const a = data[at];
      if (a !== 0 && a !== 255) kinds |= a < 128 ? FRAME_SOFT : FRAME_HALF;
    }
  }
  return kinds;
}

/**
 * The base of a picture of one view, from its alpha: the lowest opaque row, the centre of what stands on it and the
 * ellipse's radii on the floor. A trunk (a narrow run 14 to 32 rows above the lowest row, under half as wide as what
 * spreads at the bottom) is round; feet are an ellipse 0.6 as deep as wide.
 * @param {(i: number, j: number) => boolean} opaque
 * @param {number} w
 * @param {number} h
 * @returns {{ bottom: number, cx: number, rx: number, ry: number } | null} null for an empty frame
 */
export function measureStandingBase(opaque, w, h) {
  let bottom = -1;
  for (let j = h - 1; j >= 0 && bottom < 0; j--) {
    for (let i = 0; i < w; i++) {
      if (opaque(i, j)) {
        bottom = j + 1;
        break;
      }
    }
  }
  if (bottom < 0) return null;
  const span = (j0, j1) => {
    let lo = Infinity;
    let hi = -1;
    for (let j = Math.max(0, j0); j < Math.min(h, j1); j++) {
      for (let i = 0; i < w; i++) {
        if (opaque(i, j)) {
          if (i < lo) lo = i;
          if (i > hi) hi = i;
        }
      }
    }
    return [lo, hi];
  };
  const [blo, bhi] = span(bottom - 5, bottom);
  const bandCx = (blo + bhi + 1) / 2;
  const bandHalf = (bhi - blo + 1) / 2;
  // A trunk: in each row 14..32 above the bottom, the opaque run through the column nearest the centre.
  const centres = [];
  const halves = [];
  for (let j = bottom - 32; j < bottom - 14; j++) {
    if (j < 0 || j >= h) continue;
    const c = Math.round(bandCx);
    let at = -1;
    for (let d = 0; d < w && at < 0; d++) {
      if (c - d >= 0 && opaque(c - d, j)) at = c - d;
      else if (c + d < w && opaque(c + d, j)) at = c + d;
    }
    if (at < 0) continue;
    let a = at;
    let b = at;
    while (a > 0 && opaque(a - 1, j)) a--;
    while (b < w - 1 && opaque(b + 1, j)) b++;
    if (b - a + 1 < 30) {
      centres.push((a + b + 1) / 2);
      halves.push((b - a + 1) / 2);
    }
  }
  const median = (v) => v.slice().sort((p, q) => p - q)[v.length >> 1];
  // A trunk is much narrower than what spreads under it (roots, grass): a person's body over its feet is not (0.75).
  if (centres.length >= 5 && median(halves) < 0.5 * bandHalf) {
    const r = Math.min(12, Math.max(2, median(halves)));
    return { bottom, cx: median(centres), rx: r, ry: r };
  }
  const r = Math.min(8, Math.max(3, bandHalf));
  return { bottom, cx: bandCx, rx: r, ry: r * 0.6 };
}

/**
 * Where a render touches the floor nearest the camera: the lowest row (screen px, a pixel's centre) of its opaque pixels
 * within CONTACT_HEIGHT of its lowest point. The lowest point, not the floor: a render made smaller keeps its wheels'
 * lowest visible pixels a few px up (a hatchback's, 2.5 px from some directions). A light's frame of a render is the view
 * from that light, the light where the camera is, so this is the contact nearest the light. Null for an empty frame.
 * @param {(i: number, j: number) => boolean} opaque
 * @param {(i: number, j: number) => number} heightAt px of height
 * @param {number} w
 * @param {number} h
 * @returns {number | null}
 */
export function measureLowestContact(opaque, heightAt, w, h) {
  let floor = Infinity;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (opaque(i, j)) {
        const z = heightAt(i, j);
        if (z < floor) floor = z;
      }
    }
  }
  if (floor === Infinity) return null;
  const top = floor + CONTACT_HEIGHT;
  for (let j = h - 1; j >= 0; j--) {
    for (let i = 0; i < w; i++) {
      if (opaque(i, j) && heightAt(i, j) <= top) return j + 0.5;
    }
  }
  return null;
}

/** A group spec's keys that are no direction (spriteDirections.js). */
const GROUP_KEYS = new Set(['count', 'startAngle', 'clockwise', 'anims', 'mirrorX']);

/**
 * Whether a sheet's directions spec says it is a render: 8 directions or more in some group (a count form, or keys,
 * twice with mirrorX). A person drawn from 4 directions, or a sheet without a spec, stands as a picture of one view.
 * @param {object | null | undefined} spec assets.spritesheets.*.directions, or its json's
 */
export function isRenderDirections(spec) {
  if (!spec || typeof spec !== 'object') return false;
  for (const g of Object.values(spec)) {
    if (!g || typeof g !== 'object') continue;
    if ((g.count | 0) >= 8) return true;
    let n = 0;
    for (const k of Object.keys(g)) if (!GROUP_KEYS.has(k)) n++;
    if ((g.mirrorX === true ? 2 * n : n) >= 8) return true;
  }
  return false;
}

/**
 * A frame's base as the texture table's two spare floats (instancedSpriteBatch.js writeLutSlot), read by the shadow
 * shaders: [0, 0] none; an ellipse [cx + 1, rx] (feet, ry = 0.6 rx) or [cx + 1, -rx] (a round trunk); a render
 * [-(1 + its lowest contact row), 0], or -0.5 in the second when it casts its card for the sun (base.card: the sheet's
 * shadowCast.sun 'sprite'). writeLutSlot then puts its footprint row there, + 1, with that sign. H-EDGE: a base also says
 * what its frame's texels hold (base.texels, FRAME_SOFT...), which the texture table keeps apart (buildTextureLut); a
 * base of that alone floats as none.
 * @param {{ cx?: number, rx?: number, ry?: number, contact?: number, texels?: number } | null | undefined} base
 * @param {Float32Array|number[]} out
 * @param {number} at
 */
export function lutBaseFloats(base, out, at) {
  out[at] = 0;
  out[at + 1] = 0;
  if (!base) return;
  if (base.contact >= 0) {
    out[at] = -(1 + base.contact);
    if (base.card === true) out[at + 1] = -0.5;
  } else if (base.rx > 0 && base.cx >= 0) {
    out[at] = base.cx + 1;
    out[at + 1] = base.ry >= base.rx ? -base.rx : base.rx;
  }
}


/**
 * Whether a sheet of the big atlas casts its solid: a frame of it stands on a contact (a render with height maps, its
 * base measured by _paintMapsPage) and the sheet does not cast its card (shadowCast.sun 'sprite'). Such a sheet's shadow
 * is built from the frame the camera sees (the columns), so it keeps that frame in the sun rows instead of the one the
 * sun sees.
 * @param {{ animations?: object, frames?: object } | null | undefined} json the big atlas's
 * @param {{ animations?: Record<string, { prefixedName?: string }> } | null | undefined} proxy the sheet's proxy entry
 * @returns {boolean}
 */
export function sheetCastsSolid(json, proxy) {
  return someFirstBase(json, proxy, true);
}

/**
 * N-203: whether a sheet of the big atlas stands on a contact (a render with height maps), whatever its json says the sun
 * casts. Left to its sheet, such a sheet casts its solid for the lamps (sunShadowMap.js compactColumnRows: a render's frame
 * casts columns for them even when the sun takes its card), so the lamps' rows keep the frame the camera sees.
 * @param {{ animations?: object, frames?: object } | null | undefined} json the big atlas's
 * @param {{ animations?: Record<string, { prefixedName?: string }> } | null | undefined} proxy the sheet's proxy entry
 * @returns {boolean}
 */
export function sheetStandsOnContact(json, proxy) {
  return someFirstBase(json, proxy, false);
}

/** Whether the first frame of one of the sheet's animations stands on a contact (and, with `solid`, casts no card). */
function someFirstBase(json, proxy, solid) {
  const anims = json?.animations;
  const frames = json?.frames;
  if (!anims || !frames || !proxy?.animations) return false;
  for (const a of Object.values(proxy.animations)) {
    const list = anims[a?.prefixedName];
    const first = list && list[0];
    const base = first !== undefined ? frames[first]?.base : undefined;
    if (base && base.contact >= 0 && !(solid && base.card === true)) return true;
  }
  return false;
}

/** The vertices a footprint keeps (the light bench's own cap): the footprint texture's rows hold no more. */
export const FOOTPRINT_MAX_VERTICES = 16;
/** RGBA32F texels a footprint row: its vertex count, then two vertices a texel. */
export const FOOTPRINT_TEXELS = 1 + FOOTPRINT_MAX_VERTICES / 2;

/**
 * A frame's footprint as a sheet's json gives it (meta.footprints, or meta.light3d.footprints as the light bench's
 * converter writes them): a polygon in floor px around the frame's anchor ([[x, y], ...], y towards the camera), its
 * first FOOTPRINT_MAX_VERTICES vertices; null when it is not one.
 * @param {unknown} poly
 * @returns {Array<[number, number]> | null}
 */
export function readFootprint(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return null;
  const out = [];
  for (const v of poly.slice(0, FOOTPRINT_MAX_VERTICES)) {
    if (!Array.isArray(v) || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
    out.push([+v[0], +v[1]]);
  }
  return out;
}

/**
 * The northmost floor y where a footprint's boundary crosses x (floor px around the anchor): where a cell of the frame at
 * that x, swept north at its own height, ends (the light bench's heightmap solid). Infinity when the boundary does not
 * cross x. The shaders' footprintNorth.
 * @param {Array<[number, number]>} poly
 * @param {number} x
 */
export function footprintNorthY(poly, x) {
  let ym = Infinity;
  const n = poly.length;
  for (let k = 0; k < n; k++) {
    const p = poly[k];
    const q = poly[k + 1 < n ? k + 1 : 0];
    if (x >= Math.min(p[0], q[0]) && x <= Math.max(p[0], q[0]) && Math.abs(q[0] - p[0]) > 1e-4) {
      const y = p[1] + ((x - p[0]) / (q[0] - p[0])) * (q[1] - p[1]);
      if (y < ym) ym = y;
    }
  }
  return ym;
}

/**
 * One footprint into row `row` of the footprint texture's floats (FOOTPRINT_TEXELS RGBA texels a row): texel 0 its
 * vertex count, then the vertices two a texel (x, y, x, y).
 * @param {Float32Array} out
 * @param {number} row
 * @param {Array<[number, number]>} poly
 */
export function writeFootprintRow(out, row, poly) {
  const at = row * FOOTPRINT_TEXELS * 4;
  out.fill(0, at, at + FOOTPRINT_TEXELS * 4);
  const n = Math.min(poly.length, FOOTPRINT_MAX_VERTICES);
  out[at] = n;
  for (let k = 0; k < n; k++) {
    out[at + 4 + k * 2] = poly[k][0];
    out[at + 4 + k * 2 + 1] = poly[k][1];
  }
}
