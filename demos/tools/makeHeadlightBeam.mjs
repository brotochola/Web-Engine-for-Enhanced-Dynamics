// The first stretch of a car's beam, drawn over the car's own front (demos/buenosAiresScene/cars.js): a white cone of light
// from the middle of its left edge, fading along its length and at its sides.
//
//   node demos/tools/makeHeadlightBeam.mjs      (writes demos/img/haz_auto.png and .json)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../lightBenchScene/tools/png.mjs';

const IMG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../img');
/** cars.js scales the picture by these: its length, and half its width at the far end (px). */
const LENGTH = 48;
const HALF_WIDTH = 24;
/** How much of each half fades out, as the headlights' cones do (coneSoftness). */
const SOFTNESS = 0.5;
/** Full up to this share of the length, then fading to nothing at its end. */
const FULL_TO = 0.12;

const smooth = (v) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
const data = new Uint8Array(LENGTH * HALF_WIDTH * 2 * 4);
for (let y = 0; y < HALF_WIDTH * 2; y++) {
  for (let x = 0; x < LENGTH; x++) {
    const along = (x + 0.5) / LENGTH;
    const across = Math.abs(y + 0.5 - HALF_WIDTH) / HALF_WIDTH / along; // 1 at the cone's edge
    const side = smooth((1 - across) / SOFTNESS);
    const fade = 1 - smooth((along - FULL_TO) / (1 - FULL_TO));
    const at = (y * LENGTH + x) * 4;
    data[at] = data[at + 1] = data[at + 2] = 255;
    data[at + 3] = Math.round(255 * side * fade);
  }
}
const size = { w: LENGTH, h: HALF_WIDTH * 2 };
fs.writeFileSync(path.join(IMG, 'haz_auto.png'), encodePng(size.w, size.h, data));
fs.writeFileSync(
  path.join(IMG, 'haz_auto.json'),
  `${JSON.stringify({
    frames: { haz: { frame: { x: 0, y: 0, ...size }, sourceSize: size, spriteSourceSize: { x: 0, y: 0, ...size } } },
    animations: { haz: ['haz'] },
    meta: { image: 'haz_auto.png', size, scale: 1 },
  })}\n`,
);
