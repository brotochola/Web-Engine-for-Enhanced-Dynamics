#!/usr/bin/env node
/**
 * weed maps (DX-MAPS): a spritesheet's height map and normal map, written beside it, for pictures of one view drawn
 * without a 3D model (LPC people, trees, props): a relief from the alpha.
 *
 *   node scripts/weedMaps.mjs <sheet.png | sheet.json> [more sheets] [options]
 *   npm run maps -- <sheet.png | sheet.json> [options]
 *
 * Each frame stands on its foot row, a card facing the camera whose pixels rise 1 / heightScaleY px of height per screen
 * px above it, and bulges towards the camera by a dome: each part of the silhouette is rounded by how thick it is there
 * (its distance to the silhouette's edge, the thickest within --neighbour px, capped at --radius), smoothed, scaled by
 * --relief. A bulge towards the camera keeps its screen pixel and rises: height = card + dome · floorScaleY /
 * √(floorScaleY² + heightScaleY²). The heights get the engine's outline fix (src/render/spriteMaps.js fixOutline) and
 * the normals come from them (normalsFromHeight), the functions the engine runs when it packs a sheet's maps.
 *
 * Writes <name>_h.png (R·256 + G in 1/64 px above the floor, alpha 255 where the frame is opaque) and <name>_n.png (RGB,
 * camera space: x right, y up, z out of the screen), twins of the sheet: same size, frames at the same places. With
 * --directions, it also writes the json's `directions` (the count form DirectionalSprite reads). The scene then says:
 *   spritesheets: { civil7: { json: 'civil7.json', png: 'civil7.png', heightMap: 'civil7_h.png', normalMap: 'civil7_n.png' } }
 *
 * The sheet's frames come from its json (`frames`, TexturePacker's hash or array; `meta.image` names the png); a png
 * without json is one frame, or a grid of cells with --grid.
 *
 * Options:
 *   --profile person|tree|prop  presets for the dome (default person):
 *                                 person  radius 9,  neighbour 5,  smooth 1,   close 0
 *                                 tree    radius 85, neighbour 64, smooth 2.5, close 3  (a canopy is one ball)
 *                                 prop    radius 22, neighbour 14, smooth 1.4, close 1
 *   --relief <k>                scales the dome (default 1; 0: the card alone)
 *   --radius <px>               the dome of the thickest part, at most (its half thickness, up to this)
 *   --neighbour <px>            how far around a pixel its part's thickness is looked for
 *   --smooth <px>               sigma of the gaussian that smooths the dome (0: none)
 *   --close <px>                closes gaps and holes in the silhouette before the dome (leaves of a canopy)
 *   --surface standing|floor    standing (default): the card plus the dome; floor: the dome alone, as height above the
 *                               floor (a rug, a manhole lid)
 *   --base auto|frame|<row>     the foot row. auto (default): the commonest lowest opaque row among the frames of one
 *                               height, so an animation does not bounce; frame: each frame's own; a number: that row
 *                               from the top of each (untrimmed) frame
 *   --pitch <deg>               the camera the art was drawn for, as config.camera.pitch: heightScaleY = cos(pitch),
 *                               floorScaleY = sin(pitch); without it both are 1 (the engine's rule, cameraView.js)
 *   --height-scale-y <k>        screen px a px of height rises (config.camera.heightScaleY; LPC art: 0.752)
 *   --floor-scale-y <k>         the floor's foreshortening (config.camera.floorScaleY; LPC art: 0.736)
 *   --normals height|relief     height (default): from the final heights, as the engine derives them from a heightMap;
 *                               relief: from the dome alone (the card faces the camera)
 *   --strength <k>              how much a px of height over a px of screen tilts a normal (default 1, the engine's)
 *   --alpha <0..254>            opaque past this alpha (default 127, as the engine's twin page)
 *   --grid <w>x<h>              a png's frames are the cells of this grid (LPC sheets without a json)
 *   --no-normal                 writes the height map only
 *   --directions <group>:<count>[:<startAngle>[:cw|ccw[:<anims>]]]
 *                               (repeatable) writes json.directions[group] = { count, startAngle, clockwise, anims }:
 *                               direction i is drawn by animation <anims> with {i} replaced by i (default
 *                               '<group>_{i}'), facing startAngle ± i · 360 / count world degrees (0 east, 90 south,
 *                               default 0; cw, the default, adds)
 *   --out <dir>                 writes into this folder instead of beside the sheet (the json too, when it changes)
 *   --dry-run                   says what it would write, writes nothing
 *   --help
 */
import fs from 'node:fs';
import path from 'node:path';

import { decodePng, encodePng } from '../demos/lightBenchScene/tools/png.mjs';
import { HEIGHT_MAX, HEIGHT_UNITS, fixOutline, normalsFromHeight } from '../src/render/spriteMaps.js';
import { resolveFloorScaleY, resolveHeightScaleY } from '../src/util/cameraView.js';

const PROFILES = {
  person: { radius: 9, neighbour: 5, smooth: 1, close: 0 },
  tree: { radius: 85, neighbour: 64, smooth: 2.5, close: 3 },
  prop: { radius: 22, neighbour: 14, smooth: 1.4, close: 1 },
};
const VALUE_FLAGS = new Set([
  'profile', 'relief', 'radius', 'neighbour', 'smooth', 'close', 'surface', 'base', 'pitch', 'height-scale-y',
  'floor-scale-y', 'normals', 'strength', 'alpha', 'grid', 'directions', 'out',
]);
const BOOLEAN_FLAGS = new Set(['no-normal', 'dry-run', 'help']);
/** The distance transform's "no background yet": finite, so two of them subtract to a number. */
const FAR = 1e20;

function fail(text) {
  console.error(`weed maps: ${text}`);
  process.exit(1);
}

function usage() {
  const text = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const head = text.slice(text.indexOf('/**') + 3, text.indexOf('*/'));
  console.log(head.split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim());
}

function parseArgs(argv) {
  const out = { inputs: [], directions: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out.inputs.push(a);
      continue;
    }
    let key = a.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (BOOLEAN_FLAGS.has(key)) {
      out[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) fail(`unknown option --${key} (see --help)`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) fail(`--${key} needs a value`);
    }
    if (key === 'directions') out.directions.push(value);
    else out[key] = value;
  }
  return out;
}

function numberArg(args, key, fallback, lo, hi) {
  if (args[key] === undefined) return fallback;
  const v = Number(args[key]);
  if (!Number.isFinite(v) || v < lo || v > hi) fail(`--${key} takes a number from ${lo} to ${hi} (got "${args[key]}")`);
  return v;
}

function choiceArg(args, key, choices) {
  const v = args[key] ?? choices[0];
  if (!choices.includes(v)) fail(`--${key} takes ${choices.join(' or ')} (got "${v}")`);
  return v;
}

/** `group:count[:startAngle[:cw|ccw[:anims]]]` as [group, spec]. */
function parseDirections(text) {
  const parts = text.split(':');
  const group = parts[0];
  const count = Number(parts[1]);
  if (!group || !Number.isInteger(count) || count < 1 || count > 255) {
    fail(`--directions "${text}": give group:count[:startAngle[:cw|ccw[:anims]]], count from 1 to 255`);
  }
  const startAngle = parts[2] === undefined || parts[2] === '' ? 0 : Number(parts[2]);
  if (!Number.isFinite(startAngle)) fail(`--directions "${text}": the start angle is degrees`);
  const turn = parts[3] === undefined || parts[3] === '' ? 'cw' : parts[3];
  if (turn !== 'cw' && turn !== 'ccw') fail(`--directions "${text}": the turn is cw or ccw`);
  const anims = parts.length > 4 ? parts.slice(4).join(':') : `${group}_{i}`;
  return [group, { count, startAngle, clockwise: turn === 'cw', anims }];
}

/** The sheet's files: its png, its json (or null) and the json's text. */
function sheetFiles(input) {
  if (!fs.existsSync(input)) fail(`no file ${input}`);
  let pngPath;
  let jsonPath = null;
  if (input.toLowerCase().endsWith('.json')) {
    jsonPath = input;
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const named = typeof json?.meta?.image === 'string' ? path.join(path.dirname(jsonPath), json.meta.image) : null;
    pngPath = named && fs.existsSync(named) ? named : jsonPath.replace(/\.json$/i, '.png');
    if (!fs.existsSync(pngPath)) fail(`${jsonPath}: no png beside it (${pngPath})`);
  } else {
    pngPath = input;
    const beside = input.replace(/\.png$/i, '.json');
    if (beside !== input && fs.existsSync(beside)) jsonPath = beside;
  }
  const jsonText = jsonPath ? fs.readFileSync(jsonPath, 'utf8') : null;
  return { pngPath, jsonPath, jsonText, json: jsonText ? JSON.parse(jsonText) : null };
}

/** The frames to give maps: { name, x, y, w, h, top (the rectangle's first row in its untrimmed frame), cellH }. */
function listFrames(json, width, height, grid) {
  const out = [];
  if (grid) {
    const m = /^(\d+)x(\d+)$/i.exec(grid);
    if (!m) fail(`--grid takes <w>x<h>, such as 64x64 (got "${grid}")`);
    const cw = Number(m[1]);
    const ch = Number(m[2]);
    if (!(cw > 0 && ch > 0)) fail('--grid cells need a size');
    for (let y = 0, k = 0; y + ch <= height; y += ch) {
      for (let x = 0; x + cw <= width; x += cw, k++) out.push({ name: `cell_${k}`, x, y, w: cw, h: ch, top: 0, cellH: ch });
    }
    return out;
  }
  if (!json) return [{ name: '(the picture)', x: 0, y: 0, w: width, h: height, top: 0, cellH: height }];
  const seen = new Set();
  for (const [key, fd] of Object.entries(json.frames ?? {})) {
    const name = typeof fd?.filename === 'string' ? fd.filename : key;
    const r = fd?.frame;
    if (!r) continue;
    if (fd.rotated) {
      console.warn(`  ${name}: a rotated frame, left out (the engine does not read rotated frames either)`);
      continue;
    }
    const x0 = r.x | 0;
    const y0 = r.y | 0;
    const x = Math.max(0, x0);
    const y = Math.max(0, y0);
    const w = Math.min(width, x0 + (r.w | 0)) - x;
    const h = Math.min(height, y0 + (r.h | 0)) - y;
    if (w <= 0 || h <= 0) continue;
    const at = `${x},${y},${w},${h}`;
    if (seen.has(at)) continue;
    seen.add(at);
    const top = (fd.spriteSourceSize?.y | 0) + (y - y0);
    out.push({ name, x, y, w, h, top, cellH: fd.sourceSize?.h | 0 || r.h | 0 });
  }
  return out;
}

/** 1 where the frame's alpha passes the threshold. */
function opaqueOf(rgba, imageWidth, f, threshold) {
  const out = new Uint8Array(f.w * f.h);
  for (let j = 0; j < f.h; j++) {
    const row = ((f.y + j) * imageWidth + f.x) * 4 + 3;
    for (let i = 0; i < f.w; i++) out[j * f.w + i] = rgba[row + i * 4] > threshold ? 1 : 0;
  }
  return out;
}

/** The row under the lowest opaque one (the engine's base bottom, frameBase.js); -1 for an empty frame. */
function bottomOf(opaque, w, h) {
  for (let j = h - 1; j >= 0; j--) {
    for (let i = 0; i < w; i++) if (opaque[j * w + i]) return j + 1;
  }
  return -1;
}

/** Felzenszwalb and Huttenlocher's squared distance along one line: d[q] = min over p of (q - p)² + f[p]. */
function squaredDistance1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Each pixel's exact distance to the nearest pixel outside the mask; outside the frame counts as outside. */
function distanceToEdge(mask, w, h) {
  const W = w + 2;
  const H = h + 2;
  const g = new Float64Array(W * H);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (mask[j * w + i]) g[(j + 1) * W + i + 1] = FAR;
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    squaredDistance1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    squaredDistance1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[y * W + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out[j * w + i] = Math.sqrt(g[(j + 1) * W + i + 1]);
  return out;
}

/** The largest value in the (2r + 1)² square around each pixel (values ≥ 0). */
function maxFilter(src, w, h, r) {
  if (r <= 0) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let m = 0;
      for (let t = Math.max(0, i - r), e = Math.min(w - 1, i + r); t <= e; t++) if (src[j * w + t] > m) m = src[j * w + t];
      tmp[j * w + i] = m;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let m = 0;
      for (let t = Math.max(0, j - r), e = Math.min(h - 1, j + r); t <= e; t++) if (tmp[t * w + i] > m) m = tmp[t * w + i];
      out[j * w + i] = m;
    }
  }
  return out;
}

/** The mask closed by r (dilated, then eroded) with its holes filled: a canopy's gaps become part of it. */
function closeMask(mask, w, h, r) {
  const grown = maxFilter(Float32Array.from(mask), w, h, r);
  const outside = new Float32Array(w * h);
  for (let q = 0; q < w * h; q++) outside[q] = grown[q] > 0 ? 0 : 1;
  const shrunk = maxFilter(outside, w, h, r);
  const out = new Uint8Array(w * h);
  for (let q = 0; q < w * h; q++) out[q] = mask[q] || shrunk[q] === 0 ? 1 : 0;
  // Holes: what no path of empty pixels joins to the frame's border.
  const reached = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const push = (q) => {
    if (!out[q] && !reached[q]) {
      reached[q] = 1;
      stack[top++] = q;
    }
  };
  for (let i = 0; i < w; i++) {
    push(i);
    push((h - 1) * w + i);
  }
  for (let j = 0; j < h; j++) {
    push(j * w);
    push(j * w + w - 1);
  }
  while (top > 0) {
    const q = stack[--top];
    const i = q % w;
    if (i > 0) push(q - 1);
    if (i < w - 1) push(q + 1);
    if (q >= w) push(q - w);
    if (q < (h - 1) * w) push(q + w);
  }
  for (let q = 0; q < w * h; q++) if (!out[q] && !reached[q]) out[q] = 1;
  return out;
}

/** A separable gaussian blur, zero outside the frame. */
function blur(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let t = -r; t <= r; t++) {
    k[t + r] = Math.exp(-(t * t) / (2 * sigma * sigma));
    sum += k[t + r];
  }
  for (let t = 0; t < k.length; t++) k[t] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) {
        const x = i + t;
        if (x >= 0 && x < w) acc += src[j * w + x] * k[t + r];
      }
      tmp[j * w + i] = acc;
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) {
        const y = j + t;
        if (y >= 0 && y < h) acc += tmp[y * w + i] * k[t + r];
      }
      out[j * w + i] = acc;
    }
  }
  return out;
}

/**
 * The dome, px towards the camera: each part of the silhouette rounded as a cylinder as thick as the part is there
 * (the light bench's "inflated" relief).
 */
function domeOf(opaque, w, h, s) {
  const mask = s.close > 0 ? closeMask(opaque, w, h, s.close) : opaque;
  const dist = distanceToEdge(mask, w, h);
  const thick = maxFilter(dist, w, h, s.neighbour);
  const dome = new Float32Array(w * h);
  const weight = new Float32Array(w * h);
  for (let q = 0; q < w * h; q++) {
    if (!mask[q]) continue;
    const t = Math.min(Math.max(thick[q], 1), s.radius);
    const u = 1 - Math.min(dist[q], t) / t;
    dome[q] = t * Math.sqrt(Math.max(0, 1 - u * u));
    weight[q] = 1;
  }
  if (s.smooth > 0) {
    const db = blur(dome, w, h, s.smooth);
    const wb = blur(weight, w, h, s.smooth);
    for (let q = 0; q < w * h; q++) dome[q] = mask[q] ? db[q] / Math.max(wb[q], 1e-3) : 0;
  }
  for (let q = 0; q < w * h; q++) dome[q] *= s.relief;
  return dome;
}

/** The commonest value of a list (the larger on a tie: the lower row). */
function commonest(values) {
  const count = new Map();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best = -1;
  let bestN = 0;
  for (const [v, n] of count) {
    if (n > bestN || (n === bestN && v > best)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** A json written back as it was written: its indent, its line ends, its last newline. */
function jsonLike(original, value) {
  const indent = /^\{[ \t]*\r?\n([ \t]+)"/.exec(original)?.[1];
  let text = JSON.stringify(value, null, indent);
  if (/\n\s*$/.test(original)) text += '\n';
  return original.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

function processSheet(input, s, args) {
  const { pngPath, jsonPath, jsonText, json } = sheetFiles(input);
  const img = decodePng(fs.readFileSync(pngPath));
  const W = img.width;
  const H = img.height;
  const frames = listFrames(args.grid ? null : json, W, H, args.grid);
  if (frames.length === 0) fail(`${input}: no frames`);

  // The foot rows: each frame's lowest opaque row, in its untrimmed frame's rows.
  for (const f of frames) {
    f.opaque = opaqueOf(img.data, W, f, s.alpha);
    f.bottom = bottomOf(f.opaque, f.w, f.h);
  }
  const common = new Map();
  if (s.base === 'auto') {
    const byHeight = new Map();
    for (const f of frames) {
      if (f.bottom < 0) continue;
      if (!byHeight.has(f.cellH)) byHeight.set(f.cellH, []);
      byHeight.get(f.cellH).push(f.top + f.bottom);
    }
    for (const [cellH, rows] of byHeight) common.set(cellH, commonest(rows));
  }

  const hs = s.heightScaleY;
  const fsy = s.floorScaleY;
  const towards = fsy / Math.sqrt(fsy * fsy + hs * hs);
  const heightOut = new Uint8Array(W * H * 4);
  const normalOut = s.writeNormal ? new Uint8Array(W * H * 4) : null;
  let done = 0;
  let tallest = 0;
  let raised = 0;
  for (const f of frames) {
    if (f.bottom < 0) continue;
    const { w, h, opaque } = f;
    const base = s.base === 'auto' ? common.get(f.cellH) - f.top : s.base === 'frame' ? f.bottom : s.base - f.top;
    const dome = domeOf(opaque, w, h, s);
    const heights = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const q = j * w + i;
        if (!opaque[q]) continue;
        const z = s.surface === 'floor' ? dome[q] : (base - (j + 0.5)) / hs + dome[q] * towards;
        heights[q] = z < 0 ? 0 : z > HEIGHT_MAX ? HEIGHT_MAX : z;
      }
    }
    raised += fixOutline(heights, opaque, w, h);
    const normals = normalOut ? normalsFromHeight(s.normals === 'relief' ? dome : heights, opaque, w, h, s.strength) : null;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const q = j * w + i;
        if (!opaque[q]) continue;
        const o = ((f.y + j) * W + f.x + i) * 4;
        if (heights[q] > tallest) tallest = heights[q];
        const z = Math.round(heights[q] * HEIGHT_UNITS);
        heightOut[o] = z >> 8;
        heightOut[o + 1] = z & 255;
        heightOut[o + 3] = 255;
        if (normals) {
          normalOut[o] = Math.round((normals[q * 3] + 1) * 127.5);
          normalOut[o + 1] = Math.round((normals[q * 3 + 1] + 1) * 127.5);
          normalOut[o + 2] = Math.round((normals[q * 3 + 2] + 1) * 127.5);
          normalOut[o + 3] = 255;
        }
      }
    }
    done++;
  }

  const stem = path.basename(pngPath, path.extname(pngPath));
  const dir = args.out ?? path.dirname(pngPath);
  const heightPath = path.join(dir, `${stem}_h.png`);
  const normalPath = path.join(dir, `${stem}_n.png`);
  for (const p of [heightPath, normalPath]) {
    if (path.resolve(p) === path.resolve(pngPath)) fail(`${p} is the sheet itself: give --out`);
  }

  // DX-DIRSPRITE: the json's directions, in the count form (spriteDirections.js), when asked.
  let jsonOut = null;
  if (args.directions.length > 0) {
    if (!json) fail(`${input}: --directions writes the sheet's json, and it has none`);
    // The engine reads json.directions, else json.meta.directions: the groups of either are kept.
    const directions = { ...(json.directions ?? json.meta?.directions ?? {}) };
    for (const text of args.directions) {
      const [group, spec] = parseDirections(text);
      if (!spec.anims.includes('{i}') && spec.count > 1) console.warn(`  --directions ${group}: "${spec.anims}" has no {i}: every direction draws it`);
      if (!json.animations) console.warn(`  ${jsonPath} has no animations: the engine finds a direction's animation there`);
      else {
        const missing = [];
        for (let i = 0; i < spec.count; i++) {
          const name = spec.anims.replace(/\{i\}/g, String(i));
          if (!json.animations[name]) missing.push(name);
        }
        if (missing.length > 0) console.warn(`  --directions ${group}: no animation ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}`);
      }
      directions[group] = spec;
    }
    jsonOut = { path: args.out ? path.join(args.out, path.basename(jsonPath)) : jsonPath, text: jsonLike(jsonText, { ...json, directions }) };
  }

  const bases = s.base === 'auto' ? [...common].map(([cellH, row]) => `${row} of ${cellH}`).join(', ') : String(s.base);
  console.log(
    `${input}: ${done} of ${frames.length} frames, foot row ${bases}, tallest ${tallest.toFixed(1)} px` +
      (raised > 0 ? `, ${raised} outline px raised` : ''),
  );
  const writes = [[heightPath, () => encodePng(W, H, heightOut)]];
  if (normalOut) writes.push([normalPath, () => encodePng(W, H, normalOut)]);
  if (jsonOut) writes.push([jsonOut.path, () => jsonOut.text]);
  if (!args['dry-run']) fs.mkdirSync(dir, { recursive: true });
  for (const [p, make] of writes) {
    if (args['dry-run']) {
      console.log(`  would write ${p}`);
      continue;
    }
    fs.writeFileSync(p, make());
    console.log(`  wrote ${p}`);
  }
  console.log(
    `  assets, beside ${path.basename(pngPath)}: heightMap: '${stem}_h.png'${normalOut ? `, normalMap: '${stem}_n.png'` : ''}`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.inputs.length === 0) {
    usage();
    if (!args.help) process.exitCode = 1;
    return;
  }
  const profileName = args.profile ?? 'person';
  const profile = PROFILES[profileName];
  if (!profile) fail(`--profile takes ${Object.keys(PROFILES).join(', ')} (got "${profileName}")`);
  const camera = {
    pitch: args.pitch === undefined ? undefined : numberArg(args, 'pitch', 0, 0, 90),
    heightScaleY: numberArg(args, 'height-scale-y', undefined, 0, 2),
    floorScaleY: numberArg(args, 'floor-scale-y', undefined, 0.01, 1),
  };
  let base = args.base ?? 'auto';
  if (base !== 'auto' && base !== 'frame') {
    base = Number(base);
    if (!Number.isInteger(base) || base < 0) fail(`--base takes auto, frame or a row (got "${args.base}")`);
  }
  const s = {
    relief: numberArg(args, 'relief', 1, 0, 100),
    radius: numberArg(args, 'radius', profile.radius, 1, 4096),
    neighbour: numberArg(args, 'neighbour', profile.neighbour, 0, 4096) | 0,
    smooth: numberArg(args, 'smooth', profile.smooth, 0, 64),
    close: numberArg(args, 'close', profile.close, 0, 256) | 0,
    surface: choiceArg(args, 'surface', ['standing', 'floor']),
    base,
    normals: choiceArg(args, 'normals', ['height', 'relief']),
    strength: numberArg(args, 'strength', 1, 0, 100),
    alpha: numberArg(args, 'alpha', 127, 0, 254) | 0,
    writeNormal: !args['no-normal'],
    heightScaleY: resolveHeightScaleY(camera),
    floorScaleY: resolveFloorScaleY(camera),
  };
  if (s.surface === 'standing' && !(s.heightScaleY > 1e-3)) {
    fail('a camera straight down shows no height: a standing card needs heightScaleY > 0 (or --surface floor)');
  }
  console.log(
    `weed maps: ${profileName} (radius ${s.radius}, neighbour ${s.neighbour}, smooth ${s.smooth}, close ${s.close}), ` +
      `relief ${s.relief}, ${s.surface}, heightScaleY ${+s.heightScaleY.toFixed(4)}, floorScaleY ${+s.floorScaleY.toFixed(4)}`,
  );
  for (const input of args.inputs) {
    try {
      processSheet(input, s, args);
    } catch (error) {
      fail(`${input}: ${error?.message ?? error}`);
    }
  }
}

main();
