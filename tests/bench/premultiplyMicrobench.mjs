#!/usr/bin/env node
/**
 * Kernel: copyPremultiplyRgba (pixi decal tile upload) on Predator-sized decal
 * tiles: decalsTileSize 256 × decalsResolution 0.5 = 128 px, RGBA8. Blood and
 * scorch decals are sparse: most texels transparent, a rim of partial alpha,
 * some opaque cores.
 *
 *   node tests/bench/premultiplyMicrobench.mjs
 *   node tests/bench/premultiplyMicrobench.mjs --output out.json
 */
import { copyPremultiplyRgba } from '../../src/render/webgpu/pinGpuTexture.js';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const VARIANTS = { base: copyPremultiplyRgba };

/** Sparse decal tile: blobs with an opaque core and a partial-alpha rim. */
export function decalTile(size, seed) {
  const rng = mulberry32(seed);
  const buf = new Uint8Array(new SharedArrayBuffer(size * size * 4));
  const blobs = 6 + ((rng() * 6) | 0);
  for (let b = 0; b < blobs; b++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const r = 4 + rng() * size * 0.12;
    const cr = (120 + rng() * 135) | 0;
    const cg = (rng() * 40) | 0;
    const cb = (rng() * 40) | 0;
    for (let y = Math.max(0, (cy - r) | 0); y < Math.min(size, (cy + r + 1) | 0); y++) {
      for (let x = Math.max(0, (cx - r) | 0); x < Math.min(size, (cx + r + 1) | 0); x++) {
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d > 1) continue;
        const a = d < 0.6 ? 255 : Math.round(255 * (1 - (d - 0.6) / 0.4));
        const i = (y * size + x) * 4;
        if (a > buf[i + 3]) {
          buf[i] = cr;
          buf[i + 1] = cg;
          buf[i + 2] = cb;
          buf[i + 3] = a;
        }
      }
    }
  }
  return buf;
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const fn = VARIANTS[variant];
  if (!fn) throw new Error(`unknown variant ${variant}`);
  const size = Number(args.size ?? 128);
  const tiles = Number(args.tiles ?? 16);
  const src = Array.from({ length: tiles }, (_, t) => decalTile(size, 0xdeca1 + t));
  const dst = Array.from({ length: tiles }, () => new Uint8ClampedArray(size * size * 4));
  let transparent = 0;
  let opaque = 0;
  for (const s of src) {
    for (let i = 3; i < s.length; i += 4) {
      if (s[i] === 0) transparent++;
      else if (s[i] === 255) opaque++;
    }
  }
  for (let t = 0; t < tiles; t++) fn(dst[t], src[t]);
  let checksum = 2166136261;
  for (const d of dst) checksum = Math.imul(checksum ^ checksumInts(new Uint32Array(d.buffer)), 16777619) >>> 0;
  const texels = tiles * size * size;
  const cases = {
    tiles: timeIt(`copyPremultiplyRgba ${variant} (${tiles} tiles ${size}²)`, () => {
      for (let t = 0; t < tiles; t++) fn(dst[t], src[t]);
    }, { iterations: 50, warmup: 20 }),
  };
  const report = {
    feature: 'decal-premultiply',
    functions: ['copyPremultiplyRgba'],
    variant,
    n: texels,
    seed: 0xdeca1,
    alphaMix: { transparent: transparent / texels, opaque: opaque / texels, partial: 1 - (transparent + opaque) / texels },
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify(report.alphaMix), checksum);
}

if (isCli(import.meta.url)) await main();
