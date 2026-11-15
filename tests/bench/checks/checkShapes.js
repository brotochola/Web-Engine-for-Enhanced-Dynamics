/**
 * The shapes DX-LIGHT3D's checks against a formula draw (plan §8.2), as geometry: makeCheckArt.mjs ray-traces them into
 * the checks' sheets (colour, height map, normal map, json), and each check works out what a pixel should read from the
 * same geometry, not from those pictures. Browser- and Node-safe (no imports).
 *
 * Space: the floor's. x right, y across the floor towards the camera (south), z up. The checks' camera has a pitch of 45
 * degrees: a floor px is FLOOR_SCALE_Y px tall on the screen and a px of height rises HEIGHT_SCALE_Y px, so a point
 * (x, y, z) is drawn at (x, y * FLOOR_SCALE_Y - z * HEIGHT_SCALE_Y). A frame is drawn with its foot (the shape's origin
 * on the floor) at the entity's position: the entity's anchor is (footX / w, footY / h).
 *
 * A shape stands at its origin looking south (+y); a frame shows it turned to face `facing` degrees (the world's angle:
 * 0 east, 90 south, as DirectionalSprite.facing in degrees), as makeShapes.mjs turns its shapes.
 */

export const PITCH = 45;
export const FLOOR_SCALE_Y = Math.sin((PITCH * Math.PI) / 180);
export const HEIGHT_SCALE_Y = Math.cos((PITCH * Math.PI) / 180);
const S = FLOOR_SCALE_Y;
const C = HEIGHT_SCALE_Y;

/** A convex solid as half-spaces n·p <= c ([nx, ny, nz, c], n unit). */
function box(hx, hy, h) {
  return [[1, 0, 0, hx], [-1, 0, 0, hx], [0, 1, 0, hy], [0, -1, 0, hy], [0, 0, 1, h], [0, 0, -1, 0]];
}

/**
 * A house: walls hx by hy by `wall` high under a gable roof along x up to `ridge`. Convex (a pentagon swept along x): each
 * slope goes through the ridge (y 0, z ridge) and an eave (y ±hy, z wall).
 */
function house(hx, hy, wall, ridge) {
  const rise = ridge - wall;
  const len = Math.sqrt(rise * rise + hy * hy);
  return [
    [1, 0, 0, hx], [-1, 0, 0, hx], [0, 1, 0, hy], [0, -1, 0, hy], [0, 0, -1, 0],
    [0, rise / len, hy / len, (hy * ridge) / len],
    [0, -rise / len, hy / len, (hy * ridge) / len],
  ];
}

/** The first point of line o + t·d (any t: an orthographic view sees the whole line) inside the planes, or null. */
function hitPlanes(planes, o, d) {
  let tIn = -Infinity;
  let tOut = Infinity;
  let normal = null;
  for (const [nx, ny, nz, c] of planes) {
    const denom = nx * d[0] + ny * d[1] + nz * d[2];
    const dist = c - (nx * o[0] + ny * o[1] + nz * o[2]);
    if (Math.abs(denom) < 1e-12) {
      if (dist < 0) return null;
      continue;
    }
    const t = dist / denom;
    if (denom < 0) {
      if (t > tIn) {
        tIn = t;
        normal = [nx, ny, nz];
      }
    } else if (t < tOut) {
      tOut = t;
    }
  }
  if (normal === null || tIn > tOut) return null;
  return { t: tIn, n: normal };
}

function hitSphere(r, o, d) {
  const oz = o[2] - r;
  const b = o[0] * d[0] + o[1] * d[1] + oz * d[2];
  const c = o[0] * o[0] + o[1] * o[1] + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  const p = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
  return { t, n: [p[0] / r, p[1] / r, (p[2] - r) / r] };
}

/** The 3D shapes, each with its frame (w, h, foot) and the facings it is drawn at. */
export const SOLIDS = {
  // normalLightCheck: a white ball (a sphere on the floor).
  ball: { radius: 56, w: 160, h: 160, footX: 80, footY: 128, facings: [90], hit: (o, d) => hitSphere(56, o, d) },
  // shadowOutlineCheck: a crate from 8 directions (a render with a height map: it casts its solid).
  crate: { hx: 26, hy: 36, height: 48, w: 192, h: 192, footX: 96, footY: 144, facings: [0, 45, 90, 135, 180, 225, 270, 315], planes: box(26, 36, 48) },
  // depthSortCheck: a long table turned 45 degrees, and a barn with a gable roof turned 20.
  table: { hx: 100, hy: 22, height: 34, w: 192, h: 192, footX: 96, footY: 120, facings: [45], planes: box(100, 22, 34) },
  barn: { hx: 70, hy: 50, wall: 70, ridge: 110, w: 224, h: 192, footX: 112, footY: 128, facings: [110], planes: house(70, 50, 70, 110) },
};

/** Flat pictures (no maps): their frames and what is opaque in each, by rectangles of [x0, y0, x1, y1, alpha]. */
export const PICTURES = {
  // shadowOutlineCheck: a card (a white board standing on its foot, one view).
  card: { w: 64, h: 96, footX: 32, footY: 88, frames: { card: [[12, 8, 52, 88, 255]] } },
  // silhouetteDirectionCheck / depthSortCheck: a person from 4 directions, 30 px wide from the front and the back, 12 from
  // the side, 80 tall.
  walker: {
    w: 48,
    h: 96,
    footX: 24,
    footY: 90,
    frames: {
      stand_down: [[9, 10, 39, 90, 255]],
      stand_up: [[9, 10, 39, 90, 255]],
      stand_left: [[18, 10, 30, 90, 255]],
      stand_right: [[18, 10, 30, 90, 255]],
    },
  },
  // emissiveCheck: a flame, an opaque core in a half-transparent glow (alpha 128).
  flame: { w: 64, h: 96, footX: 32, footY: 92, color: [255, 150, 60], frames: { flame: [[12, 20, 52, 92, 128], [22, 40, 42, 82, 255]] } },
};

/** A frame's name for a solid at a facing: `<shape>_<i>` for one drawn from several directions, else the shape's name. */
export function solidFrameName(shape, facing) {
  const s = SOLIDS[shape];
  if (s.facings.length === 1) return shape;
  return `${shape}_${s.facings.indexOf(facing)}`;
}

/**
 * Where the camera's line through a frame pixel's centre (sx, sy: screen px from the foot, y down) first meets a solid
 * turned to `facing` degrees: { p: [x, y, z] from the foot in the floor's space, n: the unit normal there }, or null.
 */
export function rayHit(shape, facing, sx, sy) {
  const s = SOLIDS[shape];
  const th = ((facing - 90) * Math.PI) / 180;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const toShape = (v) => [v[0] * ct + v[1] * st, -v[0] * st + v[1] * ct, v[2]];
  const fromShape = (v) => [v[0] * ct - v[1] * st, v[0] * st + v[1] * ct, v[2]];
  // The line through the floor point under (sx, sy) towards the camera's direction (makeShapes.mjs).
  const o = [sx, sy * S, -sy * C];
  const d = [0, -C, -S];
  const hit = s.hit ? s.hit(toShape(o), toShape(d)) : hitPlanes(s.planes, toShape(o), toShape(d));
  if (hit === null) return null;
  const p = [o[0] + hit.t * d[0], o[1] + hit.t * d[1], o[2] + hit.t * d[2]];
  const n = fromShape(hit.n);
  const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
  return { p, n: [n[0] / len, n[1] / len, n[2] / len] };
}

/** A solid's corners (bottom and top of each vertical edge) turned to `facing`, from its foot: [x, y, z][]. */
export function solidCorners(shape, facing) {
  const s = SOLIDS[shape];
  const th = ((facing - 90) * Math.PI) / 180;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const out = [];
  const hx = s.hx;
  const hy = s.hy;
  const tops = s.ridge ? [[-hx, -hy, s.wall], [hx, -hy, s.wall], [hx, hy, s.wall], [-hx, hy, s.wall], [-hx, 0, s.ridge], [hx, 0, s.ridge]] : [[-hx, -hy, s.height], [hx, -hy, s.height], [hx, hy, s.height], [-hx, hy, s.height]];
  for (const [x, y] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) out.push([x * ct - y * st, x * st + y * ct, 0]);
  for (const [x, y, z] of tops) out.push([x * ct - y * st, x * st + y * ct, z]);
  return out;
}

/** A picture frame's alpha (0..255) at its pixel (px, py). */
export function pictureAlpha(sheet, frame, px, py) {
  let a = 0;
  for (const [x0, y0, x1, y1, alpha] of PICTURES[sheet].frames[frame]) {
    if (px >= x0 && px < x1 && py >= y0 && py < y1) a = alpha;
  }
  return a;
}

/** A picture frame's opaque rectangle (the union's bounds of its alpha-255 parts): [x0, y0, x1, y1]. */
export function pictureBounds(sheet, frame) {
  const rects = PICTURES[sheet].frames[frame];
  return [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
}

/**
 * A picture's base as the design measures a picture of one view (plan §6.2, §17.1): its lowest opaque row (exclusive,
 * frame px), the centre of what stands on it, and the feet's ellipse on the floor: half the bottom rows' width, from 3
 * to 8 px, 0.6 as deep as wide.
 * @returns {{ bottom: number, cx: number, rx: number, ry: number }}
 */
export function pictureBase(sheet, frame) {
  const p = PICTURES[sheet];
  const opaque = (x, y) => pictureAlpha(sheet, frame, x, y) > 127;
  let bottom = -1;
  for (let y = p.h - 1; y >= 0 && bottom < 0; y--) {
    for (let x = 0; x < p.w; x++) {
      if (opaque(x, y)) {
        bottom = y + 1;
        break;
      }
    }
  }
  let lo = Infinity;
  let hi = -1;
  for (let y = Math.max(0, bottom - 5); y < bottom; y++) {
    for (let x = 0; x < p.w; x++) {
      if (opaque(x, y)) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
  }
  const rx = Math.min(8, Math.max(3, (hi - lo + 1) / 2));
  return { bottom, cx: (lo + hi + 1) / 2, rx, ry: 0.6 * rx };
}

/** A point of the floor's space on the screen, for an entity whose foot is at screen (fx, fy). */
export function toScreen(fx, fy, p) {
  return [fx + p[0], fy + p[1] * S - p[2] * C];
}
