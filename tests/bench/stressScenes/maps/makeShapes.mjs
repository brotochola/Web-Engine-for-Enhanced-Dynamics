/**
 * DX-MAPS test art: a sphere, a pillar and a crate, each from 8 directions (DX-DIRSPRITE: the json says so), ray-traced from
 * an orthographic camera at `pitch` degrees from the horizon into a spritesheet (shapes.png, flat albedo), its height map (shapes_h.png, R·256 + G in 1/64 px above the
 * floor) and its normal map (shapes_n.png, camera space, y up), with the sheet's json. spriteMapsStressScene draws them.
 *
 *   node tests/bench/stressScenes/maps/makeShapes.mjs [--pitch 45] [--size 96]
 *
 * Space: x right, y on the floor towards the camera, z up; a px of height rises cos(pitch) px on the screen and a px of
 * floor depth sin(pitch). Each frame's foot is at its centre, FOOT of the way down.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const PITCH = arg('pitch', 45);
const SIZE = arg('size', 96) | 0;
const S = Math.sin((PITCH * Math.PI) / 180);
const C = Math.cos((PITCH * Math.PI) / 180);
/** The foot's row, as a share of the frame's height (the sprites' anchorY). */
const FOOT = 0.75;

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
/** RGBA8 pixels as a PNG. */
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

/** Directions each shape is drawn from: frame i shows it facing i·360/DIRECTIONS degrees (0 east, 90 south). */
const DIRECTIONS = 8;

/**
 * The first hit of a ray (o + t·d, floor space) with a shape standing at the origin in its own frame (its front looking
 * south, +y): { t, z, n } or null.
 */
const SHAPES = {
  sphere(o, d) {
    const R = SIZE * 0.3;
    const oz = o[2] - R;
    const b = o[0] * d[0] + o[1] * d[1] + oz * d[2];
    const c = o[0] * o[0] + o[1] * o[1] + oz * oz - R * R;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    const p = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
    return { t, z: p[2], n: [p[0] / R, p[1] / R, (p[2] - R) / R] };
  },
  pillar(o, d) {
    const R = SIZE * 0.16;
    const H = SIZE * 0.75;
    let best = null;
    const a = d[0] * d[0] + d[1] * d[1];
    if (a > 1e-12) {
      const b = o[0] * d[0] + o[1] * d[1];
      const c = o[0] * o[0] + o[1] * o[1] - R * R;
      const disc = b * b - a * c;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        const z = o[2] + t * d[2];
        if (z >= 0 && z <= H) best = { t, z, n: [(o[0] + t * d[0]) / R, (o[1] + t * d[1]) / R, 0] };
      }
    }
    if (Math.abs(d[2]) > 1e-12) {
      const t = (H - o[2]) / d[2];
      const x = o[0] + t * d[0];
      const y = o[1] + t * d[1];
      if (x * x + y * y <= R * R && (best === null || t < best.t)) best = { t, z: H, n: [0, 0, 1] };
    }
    return best;
  },
  crate(o, d) {
    const lo = [-SIZE * 0.22, -SIZE * 0.3, 0];
    const hi = [SIZE * 0.22, SIZE * 0.3, SIZE * 0.4];
    let tIn = -Infinity;
    let tOut = Infinity;
    let axis = -1;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-12) {
        if (o[k] < lo[k] || o[k] > hi[k]) return null;
        continue;
      }
      let t0 = (lo[k] - o[k]) / d[k];
      let t1 = (hi[k] - o[k]) / d[k];
      if (t0 > t1) [t0, t1] = [t1, t0];
      if (t0 > tIn) {
        tIn = t0;
        axis = k;
      }
      if (t1 < tOut) tOut = t1;
    }
    if (tIn > tOut || axis < 0) return null;
    const n = [0, 0, 0];
    n[axis] = d[axis] > 0 ? -1 : 1;
    return { t: tIn, z: o[2] + tIn * d[2], n };
  },
};
const ALBEDO = { sphere: [214, 120, 96], pillar: [200, 196, 186], crate: [176, 132, 82] };

const names = Object.keys(SHAPES);
const W = SIZE * DIRECTIONS;
const H = SIZE * names.length;
const color = new Uint8Array(W * H * 4);
const height = new Uint8Array(W * H * 4);
const normal = new Uint8Array(W * H * 4);
const frames = {};
const animations = {};
const directions = {};
names.forEach((name, row) => {
  directions[name] = { count: DIRECTIONS, startAngle: 0, clockwise: true, anims: `${name}_{i}` };
  for (let i = 0; i < DIRECTIONS; i++) {
    const frameName = `${name}_${i}`;
    frames[frameName] = {
      frame: { x: i * SIZE, y: row * SIZE, w: SIZE, h: SIZE },
      sourceSize: { w: SIZE, h: SIZE },
      spriteSourceSize: { x: 0, y: 0, w: SIZE, h: SIZE },
    };
    animations[frameName] = [frameName];
    // Facing i·45°: the shape turned from its own south-looking pose by θ (y down: θ turns +x towards +y).
    const th = ((i * 360) / DIRECTIONS - 90) * (Math.PI / 180);
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const toShape = (v) => [v[0] * ct + v[1] * st, -v[0] * st + v[1] * ct, v[2]];
    const fromShape = (v) => [v[0] * ct - v[1] * st, v[0] * st + v[1] * ct, v[2]];
    const dWorld = [0, -C, -S];
    const d = toShape(dWorld);
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const sx = px + 0.5 - SIZE / 2;
        const sy = py + 0.5 - SIZE * FOOT;
        const hit = SHAPES[name](toShape([sx, sy * S, -sy * C]), d);
        if (hit === null) continue;
        const q = ((row * SIZE + py) * W + i * SIZE + px) * 4;
        const [r, g, b] = ALBEDO[name];
        color.set([r, g, b, 255], q);
        const z = Math.max(0, Math.min(65535, Math.round(hit.z * 64)));
        height.set([z >> 8, z & 255, 0, 255], q);
        // Shape space to floor space, then to camera space: x, the screen's up (0, -S, C), towards the viewer (0, C, S).
        const [nx, ny, nz] = fromShape(hit.n);
        const cy = -ny * S + nz * C;
        const cz = ny * C + nz * S;
        const l = Math.sqrt(nx * nx + cy * cy + cz * cz) || 1;
        normal.set([Math.round((nx / l + 1) * 127.5), Math.round((cy / l + 1) * 127.5), Math.round((cz / l + 1) * 127.5), 255], q);
      }
    }
  }
});
// The json carries the sheet's directions (what an exporter writes): DirectionalSprite reads them.
const json = { frames, animations, directions, meta: { image: 'shapes.png', size: { w: W, h: H }, scale: 1, pitch: PITCH } };
fs.writeFileSync(path.join(here, 'shapes.png'), png(W, H, color));
fs.writeFileSync(path.join(here, 'shapes_h.png'), png(W, H, height));
fs.writeFileSync(path.join(here, 'shapes_n.png'), png(W, H, normal));
fs.writeFileSync(path.join(here, 'shapes.json'), JSON.stringify(json, null, 2) + '\n');
console.log(`shapes: ${names.join(', ')}, ${DIRECTIONS} directions each, ${SIZE} px, pitch ${PITCH}`);
