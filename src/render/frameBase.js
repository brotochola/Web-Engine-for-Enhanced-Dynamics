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
 * [-(1 + its lowest contact row), 0].
 * @param {{ cx?: number, rx?: number, ry?: number, contact?: number } | null | undefined} base
 * @param {Float32Array|number[]} out
 * @param {number} at
 */
export function lutBaseFloats(base, out, at) {
  out[at] = 0;
  out[at + 1] = 0;
  if (!base) return;
  if (base.contact >= 0) {
    out[at] = -(1 + base.contact);
  } else if (base.rx > 0 && base.cx >= 0) {
    out[at] = base.cx + 1;
    out[at + 1] = base.ry >= base.rx ? -base.rx : base.rx;
  }
}

