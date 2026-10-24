// E-76 W21c: the decal tile premultiply kernel (wasm/test/decalPremultiply.c, a test module) against the shipped
// copyPremultiplyRgba, byte for byte: random bytes, decal-like tiles (mostly alpha 0 and 255, partial edges),
// every alpha for every colour, and pixel counts that leave a scalar tail. Nothing outside dst is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { copyPremultiplyRgba } from '../../src/render/webgpu/pinGpuTexture.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const KERNEL_URL = pathToFileURL(path.join(repoRoot, 'tests/fixtures/wasm/decalPremultiply.wasm'));

async function bind(maxPixels) {
  const bytes = maxPixels * 4;
  const pages = Math.ceil((64 + bytes * 2 + 128) / 65536) + 1;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const k = await loadWasmKernel('decalPremultiply', KERNEL_URL, memory, ['premultiply_scalar', 'premultiply_simd']);
  const srcByte = 64;
  const dstByte = srcByte + bytes + 64;
  return { memory, k, srcByte, dstByte, bytes };
}

function cases() {
  const rng = mulberry32(0x9e3779b9);
  const out = [];
  // Every (colour, alpha) pair: 256 × 256 pixels, the colour in all three channels.
  const all = new Uint8Array(256 * 256 * 4);
  for (let a = 0; a < 256; a++) {
    for (let c = 0; c < 256; c++) {
      const i = (a * 256 + c) * 4;
      all[i] = c;
      all[i + 1] = 255 - c;
      all[i + 2] = (c * 7) & 255;
      all[i + 3] = a;
    }
  }
  out.push(['every colour and alpha', all]);
  for (const pixels of [1, 2, 3, 4, 5, 7, 16 * 16, 128 * 128, 128 * 128 + 3]) {
    const raw = new Uint8Array(pixels * 4);
    for (let i = 0; i < raw.length; i++) raw[i] = (rng() * 256) | 0;
    out.push([`random bytes, ${pixels} px`, raw]);
    const decal = new Uint8Array(pixels * 4);
    for (let p = 0; p < pixels; p++) {
      const r = rng();
      const a = r < 0.6 ? 0 : r < 0.85 ? 255 : 1 + ((rng() * 254) | 0);
      decal[p * 4] = (rng() * 256) | 0;
      decal[p * 4 + 1] = (rng() * 256) | 0;
      decal[p * 4 + 2] = (rng() * 256) | 0;
      decal[p * 4 + 3] = a;
    }
    out.push([`decal-like, ${pixels} px`, decal]);
  }
  return out;
}

test('the premultiply kernel writes what copyPremultiplyRgba writes, scalar and SIMD', async () => {
  const list = cases();
  const max = Math.max(...list.map(([, c]) => c.length / 4));
  const b = await bind(max);
  const u8 = new Uint8Array(b.memory.buffer);
  for (const [name, src] of list) {
    const pixels = src.length / 4;
    const want = new Uint8ClampedArray(src.length);
    copyPremultiplyRgba(want, new Uint8ClampedArray(src));
    for (const v of ['premultiply_scalar', 'premultiply_simd']) {
      u8.fill(0xa5);
      u8.set(src, b.srcByte);
      b.k[v](b.srcByte, b.dstByte, pixels);
      const got = u8.subarray(b.dstByte, b.dstByte + src.length);
      assert.deepEqual(Buffer.from(got), Buffer.from(want), `${v}: ${name}`);
      assert.ok(u8[b.dstByte + src.length] === 0xa5 && u8[b.dstByte - 1] === 0xa5, `${v}: ${name} wrote outside dst`);
      assert.deepEqual(Buffer.from(u8.subarray(b.srcByte, b.srcByte + src.length)), Buffer.from(src), `${v}: ${name} changed src`);
    }
  }
});
