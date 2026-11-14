/**
 * DX-MAPS test art: a sphere, a pillar and a crate, ray-traced from an orthographic camera at `pitch` degrees from the
 * horizon into a spritesheet (shapes.png, flat albedo), its height map (shapes_h.png, R·256 + G in 1/64 px above the
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

/** The first hit of the ray through screen px (sx, sy) (y down, from the foot) with a shape: { z, n } or null. */
const SHAPES = {
  sphere(sx, sy) {
    const R = SIZE * 0.3;
    // P(t) = (sx, sy·S - t·C, -sy·C - t·S), centre (0, 0, R).
    const ox = sx;
    const oy = sy * S;
    const oz = -sy * C - R;
    const b = -(oy * C + oz * S);
    const c = ox * ox + oy * oy + oz * oz - R * R;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    const p = [ox, oy - t * C, -sy * C - t * S];
    return { z: p[2], n: [p[0] / R, p[1] / R, (p[2] - R) / R] };
  },
  pillar(sx, sy) {
    const R = SIZE * 0.16;
    const H = SIZE * 0.75;
    if (Math.abs(sx) > R) return null;
    const yc = Math.sqrt(R * R - sx * sx);
    // The cap: z = H, where its y is within the circle.
    const tCap = (-sy * C - H) / S;
    const yCap = sy * S - tCap * C;
    if (Math.abs(yCap) <= yc) return { z: H, n: [0, 0, 1] };
    // The side, facing the camera: y = yc.
    const t = (sy * S - yc) / C;
    const z = -sy * C - t * S;
    if (z < 0 || z > H) return null;
    return { z, n: [sx / R, yc / R, 0] };
  },
  crate(sx, sy) {
    const A = SIZE * 0.3;
    const H = SIZE * 0.4;
    if (Math.abs(sx) > A) return null;
    const tTop = (-sy * C - H) / S;
    const yTop = sy * S - tTop * C;
    if (Math.abs(yTop) <= A) return { z: H, n: [0, 0, 1] };
    const t = (sy * S - A) / C;
    const z = -sy * C - t * S;
    if (z < 0 || z > H) return null;
    return { z, n: [0, 1, 0] };
  },
};
const ALBEDO = { sphere: [214, 120, 96], pillar: [200, 196, 186], crate: [176, 132, 82] };

const names = Object.keys(SHAPES);
const W = SIZE * names.length;
const H = SIZE;
const color = new Uint8Array(W * H * 4);
const height = new Uint8Array(W * H * 4);
const normal = new Uint8Array(W * H * 4);
const frames = {};
names.forEach((name, k) => {
  frames[name] = { frame: { x: k * SIZE, y: 0, w: SIZE, h: SIZE }, sourceSize: { w: SIZE, h: SIZE }, spriteSourceSize: { x: 0, y: 0, w: SIZE, h: SIZE } };
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const hit = SHAPES[name](px + 0.5 - SIZE / 2, py + 0.5 - SIZE * FOOT);
      if (hit === null) continue;
      const q = (py * W + k * SIZE + px) * 4;
      const [r, g, b] = ALBEDO[name];
      color.set([r, g, b, 255], q);
      const z = Math.max(0, Math.min(65535, Math.round(hit.z * 64)));
      height.set([z >> 8, z & 255, 0, 255], q);
      // Floor space to camera space: x, the screen's up (0, -S, C), towards the viewer (0, C, S).
      const [nx, ny, nz] = hit.n;
      const cy = -ny * S + nz * C;
      const cz = ny * C + nz * S;
      const l = Math.sqrt(nx * nx + cy * cy + cz * cz) || 1;
      normal.set([Math.round((nx / l + 1) * 127.5), Math.round((cy / l + 1) * 127.5), Math.round((cz / l + 1) * 127.5), 255], q);
    }
  }
});
const json = {
  frames,
  animations: Object.fromEntries(names.map((n) => [n, [n]])),
  meta: { image: 'shapes.png', size: { w: W, h: H }, scale: 1, pitch: PITCH },
};
fs.writeFileSync(path.join(here, 'shapes.png'), png(W, H, color));
fs.writeFileSync(path.join(here, 'shapes_h.png'), png(W, H, height));
fs.writeFileSync(path.join(here, 'shapes_n.png'), png(W, H, normal));
fs.writeFileSync(path.join(here, 'shapes.json'), JSON.stringify(json, null, 2) + '\n');
console.log(`shapes: ${names.join(', ')}, ${SIZE} px, pitch ${PITCH}`);
