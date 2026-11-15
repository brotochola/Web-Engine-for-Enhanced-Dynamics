#!/usr/bin/env node
// The light bench prototype's assets (the "Banco de luz y sombras" page: Quaternius farm props rendered from 32
// directions, MinZinn cars, an LPC person and two trees, each with a height map and a normal map) as WeedJS spritesheets.
//
//   node demos/lightBenchScene/tools/fromLightBench.mjs <folder with meta.json and the pngs> [out folder]
//
// The bench kept one anchor per frame (the footprint's centre on the floor); WeedJS anchors a sprite per entity, so each
// asset's frames go into cells of one size with every frame's anchor at the same point of its cell (the atlas trims the
// empty margins away when it packs). The colour, height and normal pictures move the same way, so they stay twins.
// Writes <name>.json / .png / _h.png / _n.png per asset and index.js (anchors, kinds, heights, boxes for the scene).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
const out = process.argv[3] ?? path.join(here, '..', 'assets');
if (!src) {
  console.error('usage: fromLightBench.mjs <bench asset folder> [out folder]');
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8')).assets;
fs.mkdirSync(out, { recursive: true });

/** Frames of an asset as { name, x, y, w, h, ax, ay } in its own pictures, plus its animations and directions. */
function describe(name, a) {
  if (a.kind === 'char') {
    const frames = Object.entries(a.frames).map(([n, [x, y]]) => ({ name: n, x, y, w: a.fw, h: a.fh, ax: a.ancla[0], ay: a.ancla[1] }));
    // walk_up / idle_left…: WeedJS finds the directions from the names.
    return { frames, animations: a.anims, directions: undefined };
  }
  if (a.kind === 'tree') {
    const frames = a.frames.map((f, k) => ({ name: a.claves[k], x: f[0], y: f[1], w: f[2], h: f[3], ax: f[4], ay: f[5] }));
    return { frames, animations: Object.fromEntries(frames.map((f) => [f.name, [f.name]])), directions: undefined };
  }
  if (a.kind === 'car') {
    // f[6]: the heading drawn, in the floor's degrees from east, clockwise on the screen (the world's angles); the other
    // side of the turn is the same pictures mirrored (180° - a), as the bench did.
    const frames = a.frames.map((f, k) => ({ name: `drive_${k}`, x: f[0], y: f[1], w: f[2], h: f[3], ax: f[4], ay: f[5], deg: f[6] }));
    const drive = { mirrorX: true };
    for (const f of frames) drive[String(f.deg)] = f.name;
    return { frames, animations: Object.fromEntries(frames.map((f) => [f.name, [f.name]])), directions: { drive } };
  }
  // A prop rendered from n directions: frame k is the model turned k·360/n counter-clockwise on the floor.
  const frames = a.frames.map((f, k) => ({ name: `${name}_${k}`, x: f[0], y: f[1], w: f[2], h: f[3], ax: f[4], ay: f[5] }));
  return {
    frames,
    animations: Object.fromEntries(frames.map((f) => [f.name, [f.name]])),
    directions: { stand: { count: frames.length, startAngle: 90, clockwise: false, anims: `${name}_{i}` } },
  };
}

function blit(from, fw, to, tw, sx, sy, w, h, dx, dy) {
  for (let j = 0; j < h; j++) {
    const s = ((sy + j) * fw + sx) * 4;
    const d = ((dy + j) * tw + dx) * 4;
    to.set(from.subarray(s, s + w * 4), d);
  }
}

const index = {};
let total = 0;
for (const [name, a] of Object.entries(meta)) {
  const { frames, animations, directions } = describe(name, a);
  // The cell: room on each side of the anchor for the widest frame on that side.
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  for (const f of frames) {
    left = Math.max(left, Math.ceil(f.ax));
    right = Math.max(right, Math.ceil(f.w - f.ax));
    top = Math.max(top, Math.ceil(f.ay));
    bottom = Math.max(bottom, Math.ceil(f.h - f.ay));
  }
  const cw = left + right;
  const ch = top + bottom;
  const cols = Math.ceil(Math.sqrt(frames.length * (ch / cw)));
  const rows = Math.ceil(frames.length / cols);
  const W = cols * cw;
  const H = rows * ch;
  const pics = {};
  for (const suffix of ['', '_h', '_n']) {
    const file = path.join(src, `${name}${suffix}.png`);
    if (!fs.existsSync(file)) continue;
    const p = decodePng(fs.readFileSync(file));
    const dst = new Uint8Array(W * H * 4);
    frames.forEach((f, k) => {
      const cx = (k % cols) * cw;
      const cy = Math.floor(k / cols) * ch;
      blit(p.data, p.width, dst, W, f.x, f.y, f.w, f.h, cx + Math.round(left - f.ax), cy + Math.round(top - f.ay));
    });
    pics[suffix] = encodePng(W, H, dst);
  }
  const json = {
    frames: Object.fromEntries(
      frames.map((f, k) => [
        f.name,
        {
          frame: { x: (k % cols) * cw, y: Math.floor(k / cols) * ch, w: cw, h: ch },
          sourceSize: { w: cw, h: ch },
          spriteSourceSize: { x: 0, y: 0, w: cw, h: ch },
        },
      ]),
    ),
    animations,
    ...(directions ? { directions } : {}),
    meta: {
      image: `${name}.png`,
      size: { w: W, h: H },
      scale: 1,
      // The light bench's data the engine does not read yet: footprints per frame (floor px around the anchor), the box
      // (x0, x1, y0, y1, height) and the hull of the model unturned, its tallest point.
      light3d: { kind: a.kind ?? 'prop', zmax: a.zmax ?? null, footprints: a.huellas ?? null, box: a.caja ?? null, hull: a.casco ?? null },
    },
  };
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(json));
  for (const [suffix, buf] of Object.entries(pics)) {
    fs.writeFileSync(path.join(out, `${name}${suffix}.png`), buf);
    total += buf.length;
  }
  index[name] = {
    kind: a.kind ?? 'prop',
    anchorX: Math.round((left / cw) * 1e6) / 1e6,
    anchorY: Math.round((top / ch) * 1e6) / 1e6,
    zmax: a.zmax ?? null,
    box: a.caja ?? null,
    maps: Boolean(pics._h),
  };
  console.log(`${name}: ${frames.length} frames, cells ${cw}x${ch}, sheet ${W}x${H}`);
}
// The floor's grass, as it is.
if (fs.existsSync(path.join(src, 'pasto.png'))) fs.copyFileSync(path.join(src, 'pasto.png'), path.join(out, 'pasto.png'));
fs.writeFileSync(
  path.join(out, 'index.js'),
  '// Written by tools/fromLightBench.mjs: each sheet\'s anchor (its cells put every frame\'s anchor there), kind, tallest\n' +
    '// point (px), box (x0, x1, y0, y1, height in floor px, unturned) and whether it has height and normal maps.\n' +
    `export const BENCH_ASSETS = ${JSON.stringify(index, null, 2)};\n`,
);
console.log(`${(total / 1048576).toFixed(1)} MB of pictures in ${out}`);
