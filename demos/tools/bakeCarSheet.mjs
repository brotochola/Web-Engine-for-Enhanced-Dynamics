#!/usr/bin/env node
// A TopDown Vehicles car (MinZiin, as tools/hornear_autos.js bakes it: <name>.png + <name>.json, frames keyed by heading
// every 7.5°, the right-facing half only) as a WeedJS spritesheet with its height and normal maps:
//
//   node demos/tools/bakeCarSheet.mjs <car .json or folder> [more ...] [--out demos/img/autos] [--quality 2] [--type t]
//
// The maps come from nm-core (nmCore.cjs, the "Luz 2.5D" generator): a prism model of the car fitted to every frame's
// silhouette, each frame's own heading found, an SDF ray-marched for the height and normal of each pixel, the drawing's
// fine detail added. The model's body (sedan, hatch, pickup, colectivo, camion) comes from the name: nm-core's guess when
// the name says one, the pack's other models by kind below (a coupe is a sedan, an SUV a hatch, a dump truck a camion:
// the body that fits the silhouettes best is not always the shape, and a box fitted to a sports car lights like a box),
// and for a name neither knows, every body fitted and the best match kept; --type forces one. Each frame goes into a cell of one size with the car's centre on the floor at the same point (the
// entity's anchor), so <name>.png, <name>_h.png (height, R·256 + G in 1/64 px) and <name>_n.png (normals: R +x, G +y up,
// B +z) stay twins. <name>.json keeps the pack's headings (directions.drive, mirrorX: the left-facing half mirrored),
// so a car turns in even 7.5° steps as the pack draws it, and carries meta.light3d: how it casts, its tallest point, each
// frame's footprint on the floor (the fitted length and width, turned by the frame's own heading) and its box.
// Writes index.js next to the sheets: every sheet's anchor, tallest point and box (index.js is rewritten from all the
// sheets in the folder).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from '../lightBenchScene/tools/png.mjs';

const require = createRequire(import.meta.url);
const NM = require('./nmCore.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
let out = path.resolve(here, '../img/autos');
let quality = 2;
let forcedType = null;
let indexOnly = false;
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') out = path.resolve(argv[++i]);
  else if (argv[i] === '--quality') quality = Math.max(1, Math.min(3, Number(argv[++i]) | 0));
  else if (argv[i] === '--type') forcedType = argv[++i];
  else if (argv[i] === '--index') indexOnly = true;
  else inputs.push(argv[i]);
}
if ((inputs.length === 0 && !indexOnly) || (forcedType && !NM.TIPOS[forcedType])) {
  console.error('usage: bakeCarSheet.mjs <car .json or folder> [...] [--out demos/img/autos] [--quality 1..3] ' +
    `[--type ${Object.keys(NM.TIPOS).join('|')}]\n       bakeCarSheet.mjs --index [--out folder]   (only rewrites index.js)`);
  process.exit(1);
}
// Names that say their body (nm-core's guessType reads them).
const NAMED_BODY = /pickup|camioneta|colectivo|bus|omnibus|hatch|camion|truck|furgon|sedan|taxi|polic/i;
// The TopDown Vehicles pack's other models, by the shape they have.
const BODY_BY_MODEL = [
  [/ambulancia|volcador/i, 'camion'],
  [/casarodante/i, 'colectivo'],
  [/utilitario|monovolumen|rural|suv|jeep|micro|compacto/i, 'hatch'],
  [/coupe|deportivo|muscle|lujo|superauto|limusina/i, 'sedan'],
];

/** The body to fit: the forced one, nm-core's guess for a name that says it (undefined), the model's, else the best fit. */
function chooseType(atlas, W, H, json, name) {
  if (forcedType) return { tipo: forcedType, tried: null };
  if (NAMED_BODY.test(name)) return { tipo: undefined, tried: null };
  const model = BODY_BY_MODEL.find(([re]) => re.test(name));
  if (model) return { tipo: model[1], tried: null };
  let best = null;
  const tried = [];
  for (const tipo of Object.keys(NM.TIPOS)) {
    const r = NM.process(atlas, W, H, json, { nombre: name, calidad: 1, tipo });
    const ious = Object.values(r.luz.frames).map((f) => f.iou);
    const mean = ious.reduce((s, v) => s + v, 0) / ious.length;
    tried.push(`${tipo} ${mean.toFixed(3)}`);
    if (!best || mean > best.mean) best = { tipo, mean };
  }
  return { tipo: best.tipo, tried: tried.join(', ') };
}
const jsons = [];
for (const p of inputs) {
  if (fs.statSync(p).isDirectory()) {
    for (const f of fs.readdirSync(p)) if (f.endsWith('.json')) jsons.push(path.join(p, f));
  } else jsons.push(p);
}
fs.mkdirSync(out, { recursive: true });

const r1 = (v) => Math.round(v * 10) / 10;

function bake(jsonPath) {
  const name = path.basename(jsonPath, '.json');
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!json.animations || !json.frames) throw new Error(`${name}: not a baked car sheet (frames and animations by heading)`);
  const png = decodePng(fs.readFileSync(path.join(path.dirname(jsonPath), json.meta?.image || `${name}.png`)));
  const W = png.width;
  const H = png.height;
  const atlas = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length);
  const t0 = Date.now();
  const chosen = chooseType(atlas, W, H, json, name);
  if (chosen.tried) console.log(`${name}: bodies tried (mean frame IoU): ${chosen.tried}`);
  const r = NM.process(atlas, W, H, json, { nombre: name, calidad: quality, tipo: chosen.tipo });
  // Each frame by its heading in the pack (the animations' keys), with nm-core's own heading and anchor for it.
  const frames = [];
  for (const [deg, names] of Object.entries(json.animations)) {
    const fname = names[0];
    const f = json.frames[fname].frame;
    const fit = r.luz.frames[fname];
    if (!fit) continue;
    frames.push({ name: fname, deg: Number(deg), real: fit.rumbo, x: f.x, y: f.y, w: f.w, h: f.h, ax: fit.ancla[0], ay: fit.ancla[1], iou: fit.iou });
  }
  frames.sort((a, b) => a.deg - b.deg);
  // Cells: room on each side of the anchor for the widest frame on that side.
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
  const SW = cols * cw;
  const SH = rows * ch;
  const colour = new Uint8Array(SW * SH * 4);
  const height = new Uint8Array(SW * SH * 4);
  const normal = new Uint8Array(SW * SH * 4);
  let zmax = 0;
  frames.forEach((f, k) => {
    const ox = (k % cols) * cw + Math.round(left - f.ax);
    const oy = Math.floor(k / cols) * ch + Math.round(top - f.ay);
    for (let j = 0; j < f.h; j++) {
      for (let i = 0; i < f.w; i++) {
        const s = (f.y + j) * W + f.x + i;
        const d = (oy + j) * SW + ox + i;
        if (d < 0 || d >= SW * SH) continue;
        for (let c = 0; c < 4; c++) colour[d * 4 + c] = png.data[s * 4 + c];
        if (png.data[s * 4 + 3] === 0) continue;
        for (let c = 0; c < 4; c++) normal[d * 4 + c] = r.normal[s * 4 + c];
        const z = r.heightF[s];
        if (z > zmax) zmax = z;
        const q = Math.max(0, Math.min(65535, Math.round(z * 64)));
        height[d * 4] = q >> 8;
        height[d * 4 + 1] = q & 255;
        height[d * 4 + 3] = 255;
      }
    }
  });
  // The fitted car: its length and width (floor px), its roof height; each frame's footprint is that rectangle turned by
  // the frame's own heading (nm-core's silhouette turns the model by +heading: X along the length, Y south).
  const L = r.luz.collider.largo;
  const Wd = r.luz.collider.ancho;
  const footprint = (deg) => {
    const c = Math.cos((deg * Math.PI) / 180);
    const s = Math.sin((deg * Math.PI) / 180);
    return [[-L / 2, -Wd / 2], [L / 2, -Wd / 2], [L / 2, Wd / 2], [-L / 2, Wd / 2]].map(([X, Y]) => [r1(X * c - Y * s), r1(X * s + Y * c)]);
  };
  const drive = { mirrorX: true };
  for (const f of frames) drive[String(f.deg)] = f.name;
  const roof = r.params.p.Hr ?? r.params.p.Hbox ?? zmax;
  const sheet = {
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
    animations: Object.fromEntries(frames.map((f) => [f.name, [f.name]])),
    directions: { drive },
    meta: {
      image: `${name}.png`,
      size: { w: SW, h: SH },
      scale: 1,
      // The car's centre on the floor in its cell (every cell puts it at the same point): the sprite's anchor.
      anchor: [Math.round((left / cw) * 1e6) / 1e6, Math.round((top / ch) * 1e6) / 1e6],
      source: json.meta?.fuente || 'TopDown Vehicles v1.17, MinZiin (CC BY 4.0)',
      // How it casts (as the owner's light bench prototype: a card for the sun, the frame the sun sees standing on the
      // contact nearest it; its heightmap's solid for the lamps), its tallest point (px), each frame's
      // footprint (floor px around the anchor, in frame order), its box unturned (x0, x1, y0, y1, height) and the frames'
      // own headings as nm-core found them (the art is not drawn every 7.5° exactly).
      light3d: {
        kind: 'car',
        cast: { sun: 'sprite', lamp: 'heightmap' },
        zmax: r1(zmax),
        footprints: frames.map((f) => footprint(f.real)),
        box: [r1(-L / 2), r1(L / 2), r1(-Wd / 2), r1(Wd / 2), r1(roof)],
        hull: null,
        headings: Object.fromEntries(frames.map((f) => [f.name, f.real])),
        fit: { type: r.params.tipo, iou: r.params.fit ? Math.round(r.params.fit.iou * 1000) / 1000 : null, coverage: Math.round(r.params.cobertura * 1000) / 1000 },
      },
    },
  };
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(sheet));
  fs.writeFileSync(path.join(out, `${name}.png`), encodePng(SW, SH, colour));
  fs.writeFileSync(path.join(out, `${name}_h.png`), encodePng(SW, SH, height));
  fs.writeFileSync(path.join(out, `${name}_n.png`), encodePng(SW, SH, normal));
  const meanIou = frames.reduce((s, f) => s + f.iou, 0) / frames.length;
  console.log(`${name}: ${frames.length} frames, ${r.params.tipo}, cells ${cw}x${ch}, sheet ${SW}x${SH}, zmax ${r1(zmax)} px, ` +
    `fit IoU ${r.params.fit ? r.params.fit.iou.toFixed(3) : 'none'}, frames' IoU ${meanIou.toFixed(3)}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

for (const j of jsons) bake(j);

// index.js: every sheet in the folder (its cell, tallest point, box, anchor and the heading each direction is drawn at).
const index = {};
for (const f of fs.readdirSync(out).sort()) {
  if (!f.endsWith('.json')) continue;
  const s = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
  const l3 = s.meta?.light3d;
  if (!l3 || l3.kind !== 'car') continue;
  const first = Object.values(s.frames)[0].frame;
  const name = path.basename(f, '.json');
  // directions.drive's degrees (the pack's even steps) to the heading the frame was drawn at, as nm-core found it.
  const headings = {};
  for (const [deg, frame] of Object.entries(s.directions?.drive ?? {})) {
    if (deg !== 'mirrorX' && l3.headings?.[frame] !== undefined) headings[deg] = l3.headings[frame];
  }
  index[name] = { kind: 'car', cell: [first.w, first.h], zmax: l3.zmax, box: l3.box, maps: true, anchor: s.meta.anchor, headings };
}
fs.writeFileSync(
  path.join(out, 'index.js'),
  '// Written by demos/tools/bakeCarSheet.mjs: each car sheet\'s cell, tallest point (px), box (x0, x1, y0, y1, height in floor\n' +
    '// px, unturned), anchor (the car\'s centre on the floor, every cell\'s same point: its JSON\'s meta.anchor) and headings:\n' +
    '// each of its directions (degrees, the pack\'s 7.5° steps; the left half is these mirrored, 180° - a) to the heading its\n' +
    '// frame is drawn at (the art\'s steps are not even), for a volume turned with the car.\n' +
    `export const CARS = {\n${Object.entries(index).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n};\n`,
);
