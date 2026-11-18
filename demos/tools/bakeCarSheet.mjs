#!/usr/bin/env node
// A TopDown Vehicles car (MinZiin, as tools/hornear_autos.js bakes it: <name>.png + <name>.json, frames keyed by heading
// every 7.5°, the right-facing half only) as a WeedJS spritesheet with its height and normal maps:
//
//   node demos/tools/bakeCarSheet.mjs <car .json or folder> [more ...] [--out demos/img/autos] [--quality 2] [--type t]
//   node demos/tools/bakeCarSheet.mjs --remap <baked sheet .json or folder> [more ...] [--quality 2]
//       (a sheet this tool wrote: its _h.png and _n.png made again in place, its picture and frames untouched)
//
// The maps come from nm-core (nmCore.cjs, the "Luz 2.5D" generator): a prism model of the car fitted to every frame's
// silhouette, each frame's own heading found, an SDF ray-marched for the height and normal of each pixel, the drawing's
// fine detail added. The model's body (sedan, hatch, pickup, colectivo, camion) comes from the name: nm-core's guess when
// the name says one (the cabin's two ends are not fitted: a silhouette from above says little about where the glass is, and the
// fit left a hatchback's windscreen over its bonnet, which then lit as a windscreen; they are measured on the side view's
// glass, cabinFromGlass), the pack's other models by kind below (a coupe is a sedan, an SUV a hatch, a dump truck a camion:
// the body that fits the silhouettes best is not always the shape, and a box fitted to a sports car lights like a box),
// and for a name neither knows, every body fitted and the best match kept; --type forces one. Each frame goes into a cell of one size with the car's centre on the floor at the same point (the
// entity's anchor), so <name>.png, <name>_h.png (height, R·256 + G in 1/64 px) and <name>_n.png (normals: R +x, G +y up,
// B +z) stay twins. <name>.json's directions.drive (mirrorX: the left-facing half mirrored) are the headings the frames
// are drawn at, as nm-core measured them (the pack's art is not drawn at even 7.5° steps: a frame and the frame the sun sees
// picked by those came out up to 9° off each their own way), as the owner's light bench prototype picks its frames; a
// measure out of order (no further round than the frame before it) takes the pack's heading. It carries meta.light3d: how
// it casts, its tallest point, each frame's footprint on the floor (the fitted length and width, turned by the frame's
// heading) and its box.
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
let remap = false;
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') out = path.resolve(argv[++i]);
  else if (argv[i] === '--quality') quality = Math.max(1, Math.min(3, Number(argv[++i]) | 0));
  else if (argv[i] === '--type') forcedType = argv[++i];
  else if (argv[i] === '--index') indexOnly = true;
  else if (argv[i] === '--remap') remap = true;
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

/**
 * Where the cabin starts and ends along the car, as shares of its length from the rear (nm-core's gr and gf), measured on
 * the drawing: the side view (heading 0, the car looking right) shows the near side's windows, and the glass is the grey
 * of the picture that is not the body's colour, above the wheels. null where the picture does not say it clearly (a grey
 * or black car, a body with no cabin of this kind): the body's own numbers stand.
 * @param {{ data: Uint8Array, width: number }} png the sheet's picture
 * @param {{ x: number, y: number, w: number, h: number }} f the side view's cell
 * @param {string} tipo the body fitted
 */
function cabinFromGlass(png, f, tipo) {
  if (tipo !== 'sedan' && tipo !== 'hatch' && tipo !== 'pickup') return null;
  const at = (x, y) => ((f.y + y) * png.width + f.x + x) * 4;
  // The car's columns, and each one's top and bottom.
  let x0 = -1;
  let x1 = -1;
  const top = new Int32Array(f.w).fill(-1);
  const bottom = new Int32Array(f.w).fill(-1);
  const lums = [];
  let coloured = 0;
  let opaque = 0;
  for (let x = 0; x < f.w; x++) {
    for (let y = 0; y < f.h; y++) {
      const o = at(x, y);
      if (png.data[o + 3] < 128) continue;
      if (top[x] < 0) top[x] = y;
      bottom[x] = y;
      const r = png.data[o];
      const g = png.data[o + 1];
      const b = png.data[o + 2];
      opaque++;
      if (Math.max(r, g, b) - Math.min(r, g, b) >= 60) coloured++;
      lums.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
    if (top[x] >= 0) {
      if (x0 < 0) x0 = x;
      x1 = x;
    }
  }
  if (x0 < 0 || x1 - x0 < 20) return null;
  lums.sort((a, b) => a - b);
  const bodyLum = lums[Math.floor(lums.length * 0.6)];
  const colourBody = coloured > opaque * 0.2;
  // A car with a grey body: its glass is what is clearly darker than it. A dark one says nothing.
  if (!colourBody && bodyLum < 110) return null;
  const glass = new Uint8Array(f.w);
  for (let x = x0; x <= x1; x++) {
    const upper = top[x] + Math.round((bottom[x] - top[x]) * 0.62);
    let n = 0;
    for (let y = top[x]; y <= upper; y++) {
      const o = at(x, y);
      if (png.data[o + 3] < 128) continue;
      const r = png.data[o];
      const g = png.data[o + 1];
      const b = png.data[o + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const grey = Math.max(r, g, b) - Math.min(r, g, b) < 45;
      if (grey && lum > 35 && (colourBody ? lum < 175 : lum < bodyLum * 0.72)) n++;
    }
    glass[x] = n >= 2 ? 1 : 0;
  }
  // The longest run of glass columns, a pillar's width forgiven.
  let best = null;
  let start = -1;
  let last = -1;
  for (let x = x0; x <= x1 + 1; x++) {
    if (x <= x1 && glass[x]) {
      if (start < 0 || x - last > 5) start = x;
      last = x;
      if (!best || last - start > best[1] - best[0]) best = [start, last];
    }
  }
  if (!best) return null;
  const len = x1 - x0 + 1;
  const gr = (best[0] - x0) / len;
  const gf = (best[1] + 1 - x0) / len;
  const ok = tipo === 'pickup'
    ? gr >= 0.2 && gr <= 0.6 && gf >= 0.55 && gf <= 0.85 && gf - gr >= 0.12
    : gr >= 0.04 && gr <= 0.45 && gf >= 0.5 && gf <= 0.82 && gf - gr >= 0.25;
  return ok ? { gr: Math.round(gr * 1000) / 1000, gf: Math.round(gf * 1000) / 1000 } : null;
}

// The run of the nose's drop, floor px. The fit gave it 9 to 11 px (the silhouette's rounded front), so the front half of a
// bonnet lit as a slope; on the drawings a bonnet is flat to the bumper.
const NOSE_RUN = 3;

/** A sheet's model: its name without the colour ("hatch_rojo": hatch), a wreck's the body it was ("quemado_coupe": coupe). */
function modelOf(name) {
  // The taxi is the sedan with a sign on its roof.
  if (name === 'taxi') return 'sedan';
  const cut = name.indexOf('_');
  if (cut < 0) return name;
  const head = name.slice(0, cut);
  return head === 'abandonado' || head === 'quemado' ? name.slice(cut + 1) : head;
}

/** The side view's frame of a sheet: the pack's heading 0, or this tool's frame 00. */
function sideFrame(json, name) {
  const byHeading = json.animations?.['0']?.[0];
  if (byHeading && json.frames[byHeading]) return byHeading;
  if (json.frames[`${name}_00`]) return `${name}_00`;
  return Object.keys(json.frames)[0];
}

// The cabins measured on a folder's sheets, by model: { gr, gf } averaged over the colours that said it.
const folderCabins = new Map();
function cabinsOfFolder(dir) {
  if (folderCabins.has(dir)) return folderCabins.get(dir);
  const byModel = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const name = path.basename(file, '.json');
    let json;
    try {
      json = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!json.frames || !json.animations) continue;
    const pngPath = path.join(dir, json.meta?.image || `${name}.png`);
    if (!fs.existsSync(pngPath)) continue;
    const body = json.meta?.light3d?.fit?.type ?? NM.guessType(name).tipo;
    const cabin = cabinFromGlass(decodePng(fs.readFileSync(pngPath)), json.frames[sideFrame(json, name)].frame, body);
    if (!cabin) continue;
    const key = `${modelOf(name)}|${body}`;
    const sum = byModel.get(key) ?? { gr: 0, gf: 0, n: 0 };
    sum.gr += cabin.gr;
    sum.gf += cabin.gf;
    sum.n++;
    byModel.set(key, sum);
  }
  folderCabins.set(dir, byModel);
  return byModel;
}

/**
 * nm-core's options for a sheet: the body, and the cabin's ends where the drawing's glass gave them, on this sheet or on
 * the same model in another colour (a white, grey or black car's glass does not stand out; the model is the same).
 */
function fitOptions(png, json, name, tipo, dir) {
  const body = tipo ?? NM.guessType(name).tipo;
  let cabin = cabinFromGlass(png, json.frames[sideFrame(json, name)].frame, body);
  let from = 'its glass';
  if (!cabin) {
    const sum = cabinsOfFolder(dir).get(`${modelOf(name)}|${body}`);
    if (sum) {
      cabin = { gr: Math.round((sum.gr / sum.n) * 1000) / 1000, gf: Math.round((sum.gf / sum.n) * 1000) / 1000 };
      from = "the same model's glass in another colour";
    }
  }
  return cabin ? { p0: { ...cabin, cf: NOSE_RUN }, fijos: ['gr', 'gf', 'cf'], cabin, from } : { cabin: null, from: null };
}

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
  const fit = fitOptions(png, json, name, chosen.tipo, path.dirname(jsonPath));
  const r = NM.process(atlas, W, H, json, { nombre: name, calidad: quality, tipo: chosen.tipo, p0: fit.p0, fijos: fit.fijos });
  console.log(`${name}: cabin ${fit.cabin ? `from ${fit.from}, ${fit.cabin.gr} to ${fit.cabin.gf} of the length` : "the body's own"}`);
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
  // The headings in the turn's order (-90 to 90): a measure no further round than the one before takes the pack's.
  const signed = (a) => {
    const w = ((a % 360) + 360) % 360;
    return w > 180 ? w - 360 : w;
  };
  let prev = -Infinity;
  for (const f of [...frames].sort((a, b) => signed(a.deg) - signed(b.deg))) {
    let real = signed(f.real);
    if (!(real > prev + 0.25)) real = signed(f.deg) > prev + 0.25 ? signed(f.deg) : prev + 0.5;
    f.real = Math.round((((real % 360) + 360) % 360) * 100) / 100;
    prev = real;
  }
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
  for (const f of frames) drive[String(f.real)] = f.name;
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

/**
 * --remap: a sheet this tool wrote, its height and normal maps made again in place (the same cells: nm-core writes each
 * frame's maps where its picture is). Its picture, frames, headings, anchors and footprints stay; meta.light3d.zmax follows
 * the new heights. Each frame is fitted from the heading the sheet keeps for it (meta.light3d.headings: a wreck has a few
 * frames at headings of its own, so a frame's number does not say its heading).
 */
function remapSheet(jsonPath) {
  const name = path.basename(jsonPath, '.json');
  const sheet = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const l3 = sheet.meta?.light3d;
  if (!l3 || l3.kind !== 'car') return;
  const dir = path.dirname(jsonPath);
  const png = decodePng(fs.readFileSync(path.join(dir, sheet.meta.image || `${name}.png`)));
  const W = png.width;
  const H = png.height;
  const atlas = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length);
  const animations = {};
  for (const fname of Object.keys(sheet.frames)) {
    const heading = l3.headings?.[fname];
    if (!Number.isFinite(heading)) throw new Error(`${name}: no heading kept for frame ${fname}`);
    animations[String(heading)] = [fname];
  }
  const json = { frames: sheet.frames, animations };
  const tipo = forcedType ?? l3.fit?.type;
  const t0 = Date.now();
  const fit = fitOptions(png, json, name, tipo, dir);
  if (!fit.cabin) {
    console.log(`${name}: ${tipo}, cabin the body's own: left as it is`);
    return;
  }
  const r = NM.process(atlas, W, H, json, { nombre: name, calidad: quality, tipo, p0: fit.p0, fijos: fit.fijos });
  const height = new Uint8Array(W * H * 4);
  const normal = new Uint8Array(W * H * 4);
  let zmax = 0;
  for (let s = 0; s < W * H; s++) {
    if (png.data[s * 4 + 3] === 0) continue;
    for (let c = 0; c < 4; c++) normal[s * 4 + c] = r.normal[s * 4 + c];
    const z = r.heightF[s];
    if (z > zmax) zmax = z;
    const q = Math.max(0, Math.min(65535, Math.round(z * 64)));
    height[s * 4] = q >> 8;
    height[s * 4 + 1] = q & 255;
    height[s * 4 + 3] = 255;
  }
  fs.writeFileSync(path.join(dir, `${name}_h.png`), encodePng(W, H, height));
  fs.writeFileSync(path.join(dir, `${name}_n.png`), encodePng(W, H, normal));
  if (r1(zmax) !== l3.zmax) {
    l3.zmax = r1(zmax);
    fs.writeFileSync(jsonPath, JSON.stringify(sheet));
  }
  console.log(`${name}: ${r.params.tipo}, cabin ${fit.cabin ? `from ${fit.from} ${fit.cabin.gr} to ${fit.cabin.gf}` : "the body's own"}, ` +
    `zmax ${r1(zmax)} px, fit IoU ${r.params.fit ? r.params.fit.iou.toFixed(3) : 'none'}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

for (const j of jsons) (remap ? remapSheet : bake)(j);

// index.js: every sheet in the folder (its cell, tallest point, box, anchor and the heading each direction is drawn at).
const index = {};
for (const f of fs.readdirSync(out).sort()) {
  if (!f.endsWith('.json')) continue;
  const s = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8'));
  const l3 = s.meta?.light3d;
  if (!l3 || l3.kind !== 'car') continue;
  const first = Object.values(s.frames)[0].frame;
  const name = path.basename(f, '.json');
  // The headings its frames are drawn at (directions.drive's), the right-facing half; the rest is 180° - these.
  const headings = Object.keys(s.directions?.drive ?? {}).filter((k) => k !== 'mirrorX').map(Number).sort((a, b) => a - b);
  index[name] = { kind: 'car', cell: [first.w, first.h], zmax: l3.zmax, box: l3.box, maps: true, anchor: s.meta.anchor, headings };
}
fs.writeFileSync(
  path.join(out, 'index.js'),
  '// Written by demos/tools/bakeCarSheet.mjs: each car sheet\'s cell, tallest point (px), box (x0, x1, y0, y1, height in floor\n' +
    '// px, unturned), anchor (the car\'s centre on the floor, every cell\'s same point: its JSON\'s meta.anchor) and headings:\n' +
    '// the headings its frames are drawn at (its directions; the left half is these mirrored, 180° - a), for code that turns\n' +
    '// a volume or steps a car frame by frame.\n' +
    `export const CARS = {\n${Object.entries(index).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n')}\n};\n`,
);
