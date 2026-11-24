// Where each standard car's headlights are drawn (demos/img/autos), measured on its pictures:
//
//   node demos/tools/measureCarLamps.mjs        (writes demos/img/autos/lamps.js)
//
// A headlight is the bluish white of a car's front, off its middle. Every pixel of the frames that look at the camera is
// put where it is in 3D by the sheet's height map (its floor place turned back by the frame's heading), and the lamp is
// the median of those pixels: how far ahead of the car's centre, how far out to a side, how high. A white car's body has
// that colour too, so it takes the lamps of its model in another colour; a model whose pictures draw none (a wreck) takes
// the median of the others.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CARS } from '../img/autos/index.js';
import { decodePng } from '../lightBenchScene/tools/png.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../img/autos');
const FLOOR_SCALE = 0.7364193217154872;
const HEIGHT_SCALE = 0.7516549042792687;
/** The frames that look at the camera: their headings, degrees on the floor (90 faces it). */
const HEADING_FROM = 20;
const HEADING_TO = 90.5;
/** A front's pixels: past this share of the half length, between these shares of the half width, this high at least. */
const AHEAD_FROM = 0.78;
const SIDE_FROM = 0.3;
const SIDE_TO = 1.02;
const HEIGHT_FROM = 3;
/** Fewer pixels than this are no lamp (a highlight), more are a white body. */
const LAMP_PIXELS = [30, 250];
/** A lamp the colour does not tell: where the owner marked it on the picture (2026-11-23). */
const MARKED = { colectivo: [1.02, 0.62, 13.2] };

const isLampColor = (r, g, b) => r >= 225 && g >= 225 && b >= 240 && b - g >= 4 && b - g < 22;
const median = (values) => values.slice().sort((p, q) => p - q)[values.length >> 1];
const modelOf = (sheet) => sheet.replace(/_[^_]+$/, '');

/** A sheet's lamp: [ahead as a share of the half length, side as a share of the half width, height px], or null. */
function measure(sheet) {
  const json = JSON.parse(fs.readFileSync(path.join(DIR, `${sheet}.json`), 'utf8'));
  const picture = decodePng(fs.readFileSync(path.join(DIR, `${sheet}.png`)));
  const heights = decodePng(fs.readFileSync(path.join(DIR, `${sheet}_h.png`)));
  const [x0, x1, y0, y1] = CARS[sheet].box;
  const halfLength = (x1 - x0) / 2;
  const halfWidth = (y1 - y0) / 2;
  const ahead = [];
  const side = [];
  const height = [];
  for (const [name, heading] of Object.entries(json.meta.light3d.headings)) {
    if (heading < HEADING_FROM || heading > HEADING_TO) continue;
    const frame = json.frames[name].frame;
    const cos = Math.cos((heading * Math.PI) / 180);
    const sin = Math.sin((heading * Math.PI) / 180);
    for (let y = 0; y < frame.h; y++) {
      for (let x = 0; x < frame.w; x++) {
        const at = ((frame.y + y) * picture.width + frame.x + x) * 4;
        if (picture.data[at + 3] < 128 || !isLampColor(picture.data[at], picture.data[at + 1], picture.data[at + 2])) continue;
        const h = (heights.data[at] * 256 + heights.data[at + 1]) / 64;
        const floorX = x + 0.5 - json.meta.anchor[0] * frame.w;
        const floorY = (y + 0.5 - json.meta.anchor[1] * frame.h + HEIGHT_SCALE * h) / FLOOR_SCALE;
        const a = (floorX * cos + floorY * sin) / halfLength;
        const s = Math.abs(-floorX * sin + floorY * cos) / halfWidth;
        if (a < AHEAD_FROM || s < SIDE_FROM || s > SIDE_TO || h < HEIGHT_FROM) continue;
        ahead.push(a);
        side.push(s);
        height.push(h);
      }
    }
  }
  if (ahead.length < LAMP_PIXELS[0] || ahead.length > LAMP_PIXELS[1]) return null;
  return [median(ahead), median(side), median(height)];
}

const sheets = Object.keys(CARS);
const measured = {};
for (const sheet of sheets) measured[sheet] = MARKED[modelOf(sheet)] ?? measure(sheet);
const found = sheets.map((sheet) => measured[sheet]).filter(Boolean);
const usual = [0, 1, 2].map((k) => median(found.map((lamp) => lamp[k])));
const round = (v, digits) => Number(v.toFixed(digits));
const lines = sheets.map((sheet) => {
  const mate = sheets.find((other) => modelOf(other) === modelOf(sheet) && measured[other]);
  const lamp = measured[sheet] ?? (mate ? measured[mate] : usual);
  return `  ${JSON.stringify(sheet)}: [${round(lamp[0], 2)}, ${round(lamp[1], 2)}, ${round(lamp[2], 1)}],`;
});
fs.writeFileSync(
  path.join(DIR, 'lamps.js'),
  `// Written by demos/tools/measureCarLamps.mjs: where each car sheet's headlights are drawn: how far ahead of the car's centre (a
// share of its box's half length), how far to each side (of its half width) and how high (px of height).
export const CAR_LAMPS = {
${lines.join('\n')}
};
`,
);
console.log(`${found.length} of ${sheets.length} measured; the usual lamp ${usual.map((v) => v.toFixed(2)).join(', ')}`);
