#!/usr/bin/env node
// Height and normal maps for single-view sprite sheets (LPC characters, trees, props), next to their pictures:
//
//   node demos/tools/bakeReliefMaps.mjs <sheet .json> <picture .png> [more pictures with the same layout ...]
//     [--profile personaje|arbol|prop|caja] [--out folder]
//
// nm-core's relief mode (nmCore.cjs processRelieve, the "Luz 2.5D" generator): each part of the silhouette rounded by
// its thickness (arms and trunks cylinders, a torso or a crown a dome), the drawing's fine detail and the light its
// artist painted (shape from shading) turned into normals, the height a card standing on its feet row plus the depth of
// that volume. Writes <picture>_h.png (height, R·256 + G in 1/64 px) and <picture>_n.png (normals: R +x, G +y up, B +z),
// the picture's twins. One layout (the .json) serves every picture given (LPC sheets share theirs).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { decodePng, encodePng } from '../lightBenchScene/tools/png.mjs';

const require = createRequire(import.meta.url);
const NM = require('./nmCore.cjs');

const argv = process.argv.slice(2);
let profile = 'personaje';
let out = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--profile') profile = argv[++i];
  else if (argv[i] === '--out') out = path.resolve(argv[++i]);
  else files.push(argv[i]);
}
const jsonPath = files.find((f) => f.endsWith('.json'));
const pictures = files.filter((f) => f.endsWith('.png'));
if (!jsonPath || pictures.length === 0 || !NM.PERFILES[profile]) {
  console.error('usage: bakeReliefMaps.mjs <sheet .json> <picture .png> [...] [--profile personaje|arbol|prop|caja] [--out folder]');
  process.exit(1);
}
const layout = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
// nm-core reads { frames: { name: { frame } } }: an array of frames (TexturePacker's other form) becomes that.
const json = Array.isArray(layout.frames)
  ? { ...layout, frames: Object.fromEntries(layout.frames.map((f) => [f.filename, f])) }
  : layout;

for (const pic of pictures) {
  const t0 = Date.now();
  const png = decodePng(fs.readFileSync(pic));
  const W = png.width;
  const H = png.height;
  const atlas = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length);
  const r = NM.processRelieve(atlas, W, H, json, { perfil: profile });
  const height = new Uint8Array(W * H * 4);
  let zmax = 0;
  for (let q = 0; q < W * H; q++) {
    if (!r.normal[q * 4 + 3]) continue;
    const z = r.heightF[q];
    if (z > zmax) zmax = z;
    const v = Math.max(0, Math.min(65535, Math.round(z * 64)));
    height[q * 4] = v >> 8;
    height[q * 4 + 1] = v & 255;
    height[q * 4 + 3] = 255;
  }
  const dir = out ?? path.dirname(pic);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(pic, '.png');
  fs.writeFileSync(path.join(dir, `${base}_h.png`), encodePng(W, H, height));
  fs.writeFileSync(path.join(dir, `${base}_n.png`), encodePng(W, H, r.normal));
  console.log(`${base}: ${Object.keys(json.frames).length} frames, ${profile}, feet row ${r.luz.base}, tallest ${zmax.toFixed(1)} px, ` +
    `${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
