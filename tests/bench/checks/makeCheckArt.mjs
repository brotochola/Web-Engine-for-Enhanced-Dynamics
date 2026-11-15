#!/usr/bin/env node
/**
 * The art of DX-LIGHT3D's checks against a formula (plan §8.2), ray-traced from checkShapes.js's geometry at the checks'
 * camera (pitch 45) into tests/bench/checks/art/: for each sheet `<name>.json` (frames in a row, animations, directions),
 * `<name>.png` (white, or the flame's colour; binary coverage, no soft edge), and for the solids `<name>_h.png` (height,
 * R·256 + G in 1/64 px) and `<name>_n.png` (normal, camera space, y up), the formats stressScenes/maps/makeShapes.mjs
 * writes. Deterministic: the same files every run.
 *
 *   node tests/bench/checks/makeCheckArt.mjs [--force]
 *
 * The check tools call ensureCheckArt() before they open a page: missing files are made.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { FLOOR_SCALE_Y, HEIGHT_SCALE_Y, PICTURES, PITCH, SOLIDS, pictureAlpha, rayHit, solidFrameName } from './checkShapes.js';
import { ART_URL } from './layouts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ART_DIR = path.join(here, 'art');
export { ART_URL };

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA8 pixels as a PNG (makeShapes.mjs's encoder). */
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function frameEntry(x, w, h) {
  return { frame: { x, y: 0, w, h }, sourceSize: { w, h }, spriteSourceSize: { x: 0, y: 0, w, h } };
}

/** A solid's sheet: one frame a facing, with its maps. */
function solidSheet(name) {
  const s = SOLIDS[name];
  const W = s.w * s.facings.length;
  const H = s.h;
  const color = new Uint8Array(W * H * 4);
  const height = new Uint8Array(W * H * 4);
  const normal = new Uint8Array(W * H * 4);
  const frames = {};
  const animations = {};
  s.facings.forEach((facing, i) => {
    const frameName = solidFrameName(name, facing);
    frames[frameName] = frameEntry(i * s.w, s.w, s.h);
    animations[frameName] = [frameName];
    for (let py = 0; py < s.h; py++) {
      for (let px = 0; px < s.w; px++) {
        const hit = rayHit(name, facing, px + 0.5 - s.footX, py + 0.5 - s.footY);
        if (hit === null) continue;
        const q = (py * W + i * s.w + px) * 4;
        color.set([255, 255, 255, 255], q);
        const z = Math.max(0, Math.min(65535, Math.round(hit.p[2] * 64)));
        height.set([z >> 8, z & 255, 0, 255], q);
        // Floor space to camera space: x, the screen's up (0, -S, C), towards the viewer (0, C, S).
        const [nx, ny, nz] = hit.n;
        const cy = -ny * FLOOR_SCALE_Y + nz * HEIGHT_SCALE_Y;
        const cz = ny * HEIGHT_SCALE_Y + nz * FLOOR_SCALE_Y;
        normal.set([Math.round((nx + 1) * 127.5), Math.round((cy + 1) * 127.5), Math.round((cz + 1) * 127.5), 255], q);
      }
    }
  });
  const json = { frames, animations, meta: { image: `${name}.png`, size: { w: W, h: H }, scale: 1, pitch: PITCH } };
  if (s.facings.length > 1) json.directions = { [name]: { count: s.facings.length, startAngle: 0, clockwise: true, anims: `${name}_{i}` } };
  return { json, files: { [`${name}.png`]: png(W, H, color), [`${name}_h.png`]: png(W, H, height), [`${name}_n.png`]: png(W, H, normal) } };
}

/** A picture's sheet: its frames in a row, no maps. */
function pictureSheet(name) {
  const p = PICTURES[name];
  const names = Object.keys(p.frames);
  const W = p.w * names.length;
  const H = p.h;
  const color = new Uint8Array(W * H * 4);
  const rgb = p.color || [255, 255, 255];
  const frames = {};
  const animations = {};
  names.forEach((frameName, i) => {
    frames[frameName] = frameEntry(i * p.w, p.w, p.h);
    animations[frameName] = [frameName];
    for (let py = 0; py < p.h; py++) {
      for (let px = 0; px < p.w; px++) {
        const a = pictureAlpha(name, frameName, px, py);
        if (a > 0) color.set([rgb[0], rgb[1], rgb[2], a], (py * W + i * p.w + px) * 4);
      }
    }
  });
  const json = { frames, animations, meta: { image: `${name}.png`, size: { w: W, h: H }, scale: 1, pitch: PITCH } };
  if (name === 'walker') json.directions = { stand: { up: 'stand_up', left: 'stand_left', down: 'stand_down', right: 'stand_right' } };
  return { json, files: { [`${name}.png`]: png(W, H, color) } };
}

/** Writes the checks' art (only what is missing, unless `force`). @returns {string[]} the files written */
export function ensureCheckArt({ force = false } = {}) {
  fs.mkdirSync(ART_DIR, { recursive: true });
  const written = [];
  const sheets = [...Object.keys(SOLIDS).map((n) => ['solid', n]), ...Object.keys(PICTURES).map((n) => ['picture', n])];
  for (const [kind, name] of sheets) {
    const json = path.join(ART_DIR, `${name}.json`);
    if (!force && fs.existsSync(json)) continue;
    const sheet = kind === 'solid' ? solidSheet(name) : pictureSheet(name);
    for (const [file, bytes] of Object.entries(sheet.files)) {
      fs.writeFileSync(path.join(ART_DIR, file), bytes);
      written.push(file);
    }
    fs.writeFileSync(json, `${JSON.stringify(sheet.json, null, 2)}\n`);
    written.push(`${name}.json`);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const written = ensureCheckArt({ force: process.argv.includes('--force') });
  console.log(written.length ? `wrote ${written.join(', ')} in ${ART_DIR}` : `the checks' art is already in ${ART_DIR} (--force to redo it)`);
}
