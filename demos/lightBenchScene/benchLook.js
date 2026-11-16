// The light bench's looks: how each element casts its shadows and is lit, written with DX-LIGHT3D's API
// (DX_LIGHT3D_PLAN.md §5.4 and §5.5). The page keeps a look per element and spawns the element again with a new one: no
// setter takes a caster back to its sheet's way, and a fresh entity is that way. The entity applies its look in onSpawned,
// on its logic worker; benchCode.js writes the same calls as the code panel shows them.

import { BENCH_ASSETS, drawnHeading } from './benchAssets.js';

/** What the sun can cast from an element, in the panel's order: 'auto' is its sheet's way (no setter called). */
export const SUN_KINDS = ['auto', 'sprite', 'heightMap', 'box', 'hull', 'none'];
/** What the lamps can cast: the same, and a wall (a flat view's 2D sweep: camera.pitch 90 or 0). */
export const LAMP_KINDS = ['auto', 'sprite', 'heightMap', 'box', 'hull', 'wall', 'none'];
export const KIND_NAMES = {
  auto: "its sheet's way",
  sprite: 'silhouette',
  heightMap: 'height map',
  box: 'box',
  hull: 'hull',
  wall: 'wall (flat view)',
  none: 'none',
};
export const ORIENTS = ['light', 'fixed'];
export const SELF_SHADOWS = ['auto', 'on', 'off'];
export const NORMALS = ['auto', 'map', 'height', 'flat'];

/** The art's camera: a px of height rises 0.752 px on the screen (a volume's heights are screen px). */
export const ART_HEIGHT_SCALE_Y = 0.7516549042792687;

/**
 * How a volume turns with the entity: its rotation is the facing plus this. A prop's frame 0 looks south (the camera) with
 * its model unturned; a car's looks east.
 */
const VOLUME_TURN = { prop: -Math.PI / 2, car: 0 };

const round1 = (v) => Math.round(v * 10) / 10;

/** A fresh look: everything its sheet's way. The fence casts a card along it, as the prototype's did. */
export function defaultLook(sheet) {
  const fence = sheet === 'cerca';
  return {
    sun: fence ? 'sprite' : 'auto',
    lamps: fence ? 'sprite' : 'auto',
    orient: fence ? 'fixed' : 'light',
    self: 'auto',
    normals: 'auto',
    base: 0,
    opacity: 1,
    emissive: false,
  };
}

/**
 * The look as it is applied: a fixed card is a silhouette's orientation, so a kind left to its sheet becomes the silhouette
 * when the card is fixed; a box or a hull the asset lacks is its sheet's way. Returns a new look.
 * @param {ReturnType<typeof defaultLook>} look
 * @param {string} sheet
 * @param {boolean} hasHull whether its sheet has hull points
 */
export function normalizeLook(look, sheet, hasHull) {
  const out = { ...look };
  const box = boxOf(sheet) !== null;
  for (const k of ['sun', 'lamps']) {
    if ((out[k] === 'box' && !box) || (out[k] === 'hull' && !hasHull)) out[k] = 'auto';
    if (out.orient === 'fixed' && out[k] === 'auto') out[k] = 'sprite';
  }
  if (out.sun === 'wall') out.sun = 'auto';
  return out;
}

/** Whether a look casts a volume (setBox or setHull) for some light. */
export function castsVolume(look) {
  return look.sun === 'box' || look.sun === 'hull' || look.lamps === 'box' || look.lamps === 'hull';
}

/**
 * The rotation that turns an element's volume with its facing; 0 for what has no volume turn (trees, the person). A car's
 * follows the frame drawn for that facing (its art is not drawn at even steps: benchAssets.js drawnHeading).
 */
export function volumeRotation(sheet, facing) {
  const kind = BENCH_ASSETS[sheet]?.kind;
  if (kind === 'car') return drawnHeading(sheet, facing) + VOLUME_TURN.car;
  const turn = VOLUME_TURN[kind];
  return turn === undefined ? 0 : facing + turn;
}

/**
 * The asset's box (the converter's x0, x1, y0, y1 in floor px, height in floor px) as setBox's arguments: width along x,
 * depth along y, height in screen px; null when the asset has none.
 */
export function boxOf(sheet) {
  const b = BENCH_ASSETS[sheet]?.box;
  if (!b) return null;
  return {
    width: round1(b[1] - b[0]),
    depth: round1(b[3] - b[2]),
    height: round1(b[4] * ART_HEIGHT_SCALE_Y),
    offsetX: round1((b[0] + b[1]) / 2),
    offsetY: round1((b[2] + b[3]) / 2),
  };
}

/** setBox's options for a box: its centre, when it is off the anchor. */
export function boxOptions(box) {
  const o = {};
  if (Math.abs(box.offsetX) >= 0.5) o.offsetX = box.offsetX;
  if (Math.abs(box.offsetY) >= 0.5) o.offsetY = box.offsetY;
  return Object.keys(o).length > 0 ? o : undefined;
}

/**
 * The hull's points for setHull, flat x, y, z: the converter's vertices (meta.light3d.hull in the sheet's json, floor px),
 * heights in screen px. Null when there are none.
 */
export function hullPoints(meta) {
  let hull = meta?.light3d?.hull;
  if (typeof hull === 'string') {
    try {
      hull = JSON.parse(hull);
    } catch {
      return null;
    }
  }
  const v = hull?.v;
  if (!Array.isArray(v) || v.length < 4) return null;
  const out = [];
  for (const p of v) out.push(round1(p[0]), round1(p[1]), round1(p[2] * ART_HEIGHT_SCALE_Y));
  return out;
}

/** One kind of light's setter, on `side` (the caster for every light, or its .sun or .lamps). */
function cast(side, kind, sheet, look, hull) {
  if (kind === 'sprite') {
    side.setSprite(look.orient === 'fixed' ? { orient: 'fixed' } : undefined);
  } else if (kind === 'heightMap') {
    side.setHeightMap();
  } else if (kind === 'box') {
    const box = boxOf(sheet);
    if (box !== null) side.setBox(box.width, box.depth, box.height, boxOptions(box));
  } else if (kind === 'hull') {
    if (hull !== null && hull.length >= 12) side.setHull(hull);
  } else if (kind === 'wall') {
    side.setWall({ shape: 'sprite' });
  } else if (kind === 'none') {
    side.clear();
  }
}

/**
 * The look, on a spawned entity (its logic worker, in onSpawned). The same kind for the sun and the lamps is one setter for
 * every light; else the sun's, then the lamps' (a volume is one per entity: the lamps' box or hull replaces the sun's).
 * @param {object} go the entity (ShadowCaster and a SpriteRenderer)
 * @param {string} sheet its sheet
 * @param {ReturnType<typeof defaultLook>} look
 * @param {number[]|null} hull hullPoints of its sheet
 * @param {number} facing where it looks (radians), for a volume's turn
 */
export function applyLook(go, sheet, look, hull, facing) {
  const caster = go.shadowCaster;
  if (look.sun === look.lamps) {
    cast(caster, look.sun, sheet, look, hull);
  } else {
    cast(caster.sun, look.sun, sheet, look, hull);
    cast(caster.lamps, look.lamps, sheet, look, hull);
  }
  if (castsVolume(look)) go.rotation = volumeRotation(sheet, facing);
  if (look.self !== 'auto') caster.selfShadow = look.self === 'on';
  if (look.base > 0) caster.baseRadius = look.base;
  if (look.opacity < 1) caster.opacity = look.opacity;
  const sprite = go.spriteRenderer;
  if (look.normals !== 'auto') sprite.normals = look.normals;
  if (look.emissive) sprite.emissive = true;
}
