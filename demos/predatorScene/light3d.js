// Predator with DX-LIGHT3D's pieces on: ?light3d=1 (DX_LIGHT3D_PLAN.md F11). An oblique camera (camera.pitch), the sun's and
// the lamps' shadow maps, self-shadow and pixel depth; the light bench's barn as each house (a box for its shadow) and its
// trees with their height and normal maps (their silhouettes), borrowed by path from demos/lightBenchScene/assets/; lamp
// posts that cast the sun's shadow; fires and bonfires that glow (spriteRenderer.emissive). People are DirectionalSprites
// already: each light sees its own view of them. ?light3d=1&hour=22 pins the hour (no day cycle): night, with the lamps.
//
// Without the knob nothing here changes a thing: Predator is the engine's regression guard, and its default draws and costs
// what it did. WEED.params is the same on the page and in every worker, so every thread lists the same components.

import WEED from '/src/index.js';
import { BENCH_ASSETS } from '../lightBenchScene/assets/index.js';

export const LIGHT3D = WEED.params?.get('light3d') === '1';

/** Where the light bench keeps its farm's renders and their twins. */
const FARM = '/demos/lightBenchScene/assets/';

/** The camera LPC art and the farm's renders were drawn with: the floor at 0.736, a px of height rising 0.752 px. */
export const ART_FLOOR_SCALE_Y = 0.7364193217154872;
export const ART_HEIGHT_SCALE_Y = 0.7516549042792687;
export const LIGHT3D_PITCH = 47;

/** A farm sheet with its height and normal maps, as the scene's assets list it. */
export function farmSheet(name) {
  return {
    json: `${FARM}${name}.json`,
    png: `${FARM}${name}.png`,
    heightMap: `${FARM}${name}_h.png`,
    normalMap: `${FARM}${name}_n.png`,
  };
}

/** The barn (the bench's granero): its cell's anchor, its box (x0, x1, y0, y1, height; floor px, unturned) and its scale here. */
export const BARN = BENCH_ASSETS.granero;
export const HOUSE_SCALE = 0.6;

/** The bench's trees: their anchor. */
export const FARM_TREES = BENCH_ASSETS.arboles;
