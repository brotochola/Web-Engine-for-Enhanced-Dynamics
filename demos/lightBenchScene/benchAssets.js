// The light bench's sheets: the farm's renders and the trees (assets/, converted from the prototype by
// tools/fromLightBench.mjs) and the repo's standard sheets it borrows, not copies: MinZiin cars (demos/img/autos, baked
// by demos/tools/bakeCarSheet.mjs) and an LPC person (demos/img/civil7 with its maps, demos/tools/bakeReliefMaps.mjs).
// The DX-LIGHT3D stress scenes (tests/bench/stressScenes/light3d/benchSheets.js) read the same table.
//
// Each entry: kind ('prop', 'tree', 'car', 'char'), the anchor its cells share, its base scale (the standard cars are
// drawn at twice their sheets' size: the farm's and the person's art puts a 4 m car at about 150 px), its tallest point
// and box (x0, x1, y0, y1, height: floor px of the model unturned, at that scale), whether it has height and normal maps,
// its files, and for a car the heading each of its directions is drawn at (its sheet's directions are the pack's even
// 7.5° steps; the art is not, so a volume turned with the car follows the frame drawn).

import { BENCH_ASSETS as FARM } from './assets/index.js';
import { CARS } from '../img/autos/index.js';

const FARM_DIR = '/demos/lightBenchScene/assets/';
const CAR_DIR = '/demos/img/autos/';

/** The standard cars the bench offers, and their scale next to its art. */
const BENCH_CARS = ['hatch_rojo', 'pickup_blanco', 'colectivo_amarillo', 'taxi', 'camion_rojo'];
const CAR_SCALE = 2;

/** The LPC sheet's animations the walker never plays (it walks and stands): left out of the atlas. */
const LPC_DIRS = ['up', 'left', 'down', 'right'];
const LPC_UNUSED = ['spellcast', 'thrust', 'slash', 'shoot', 'jump', 'sit', 'emote', 'run', 'combat', '1h_slash', '1h_halfslash']
  .flatMap((a) => LPC_DIRS.map((d) => `${a}_${d}`))
  .concat(['hurt', 'climb']);

const round1 = (v) => Math.round(v * 10) / 10;

export const BENCH_ASSETS = {};
for (const [name, a] of Object.entries(FARM)) {
  BENCH_ASSETS[name] = {
    ...a,
    scale: 1,
    json: `${FARM_DIR}${name}.json`,
    png: `${FARM_DIR}${name}.png`,
    heightMap: a.maps ? `${FARM_DIR}${name}_h.png` : null,
    normalMap: a.maps ? `${FARM_DIR}${name}_n.png` : null,
    headings: null,
    excludeAnimations: null,
  };
}
for (const name of BENCH_CARS) {
  const c = CARS[name];
  BENCH_ASSETS[name] = {
    kind: 'car',
    anchorX: c.anchor[0],
    anchorY: c.anchor[1],
    scale: CAR_SCALE,
    zmax: round1(c.zmax * CAR_SCALE),
    box: c.box.map((v) => round1(v * CAR_SCALE)),
    maps: true,
    json: `${CAR_DIR}${name}.json`,
    png: `${CAR_DIR}${name}.png`,
    heightMap: `${CAR_DIR}${name}_h.png`,
    normalMap: `${CAR_DIR}${name}_n.png`,
    headings: c.headings,
    excludeAnimations: null,
  };
}
// The person: an LPC sheet (64 px cells, the feet on row 62) with the layout every LPC sheet of the repo shares.
BENCH_ASSETS.civil7 = {
  kind: 'char',
  anchorX: 0.5,
  anchorY: 62 / 64,
  scale: 1,
  zmax: null,
  box: null,
  maps: true,
  json: '/demos/img/civil1.json',
  png: '/demos/img/civil7.png',
  heightMap: '/demos/img/civil7_h.png',
  normalMap: '/demos/img/civil7_n.png',
  headings: null,
  excludeAnimations: LPC_UNUSED,
};

/** assets.spritesheets' entry for a bench sheet, with its height and normal maps unless `maps` is false. */
export function benchSheetSpec(name, maps = true) {
  const a = BENCH_ASSETS[name];
  const spec = { json: a.json, png: a.png };
  if (maps && a.maps) Object.assign(spec, { heightMap: a.heightMap, normalMap: a.normalMap });
  if (a.excludeAnimations) spec.excludeAnimations = a.excludeAnimations;
  return spec;
}

/** The scale a bench sheet is drawn at next to the bench's art (times any scale of the entity's own). */
export function sheetScale(name) {
  return BENCH_ASSETS[name]?.scale ?? 1;
}

/**
 * The heading (radians, the world's: 0 east, π/2 south) of the frame a car sheet draws for `facing`: its nearest direction
 * of the right-facing half drawn, mirrored for the left (180° − a), as DirectionalSprite picks it. `facing` itself for a
 * sheet without measured headings.
 */
export function drawnHeading(name, facing) {
  const h = BENCH_ASSETS[name]?.headings;
  if (!h) return facing;
  const deg = (((facing * 180) / Math.PI) % 360 + 360) % 360;
  let best = null;
  let bestGap = Infinity;
  for (const [key, real] of Object.entries(h)) {
    const k = Number(key);
    for (const [at, drawn] of [[k, real], [(540 - k) % 360, 180 - real]]) {
      const gap = Math.abs(((deg - at + 540) % 360) - 180);
      if (gap < bestGap) {
        bestGap = gap;
        best = drawn;
      }
    }
  }
  return (best * Math.PI) / 180;
}
