import test from 'node:test';
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS, GPU_SPACE_WORLD, GPU_SPRITE_FLOATS, makePackContext } from '../../src/render/gpuQueueLayout.js';
import { bindGpuPack, packInstancedRowsWasm, SCATTER_MIN_ROWS } from '../../src/render/gpuPackClient.js';
import { packInstancedRows } from '../reference/gpuPackJs.mjs';

// E-76 W9b: a long index list packs through its inverse (the queue read in order, each row written
// to its slot), with the gather's bits; a list with a repeated or out-of-range row falls back to the
// gather, still with the JS pack's bits.

const N = Math.max(6000, SCATTER_MIN_ROWS + 1000);

async function setup() {
  const memory = new WebAssembly.Memory({ initial: 128, maximum: 8192, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 15) & ~15;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  let s = 99;
  const rng = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const f32 = () => alloc(Float32Array, N);
  const q = {
    count: N, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, N), textureId: alloc(Uint16Array, N), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, N), repeatY: alloc(Uint16Array, N), tileMulX: f32(), tileMulY: f32(),
    tileOffsetU: alloc(Uint16Array, N), tileOffsetV: alloc(Uint16Array, N),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N),
  };
  for (const [name, v] of Object.entries(q)) {
    if (!ArrayBuffer.isView(v)) continue;
    for (let i = 0; i < N; i++) v[i] = name === 'tint' ? (rng() * 0xffffffff) >>> 0 : name === 'type' ? (rng() * 4) | 0 : rng() * 1000;
  }
  for (let i = 0; i < N; i++) q.alpha[i] = rng();
  const order = alloc(Uint32Array, N);
  order.set(Array.from({ length: N }, (_, i) => i).sort(() => rng() - 0.5));
  const dst = alloc(Float32Array, N * GPU_CASTER_FLOATS);
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += N * 4;
  const inverseByte = (top = (top + 15) & ~15);
  top += N * 4;
  const particlesByte = top;
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, inverseByte, particlesByte });
  return { q, b, dst, order };
}

function check({ q, b, dst }, indices, count, shadowCast, label) {
  const fp = shadowCast ? GPU_CASTER_FLOATS : GPU_SPRITE_FLOATS;
  const opts = { space: GPU_SPACE_WORLD, indices, indexCount: count, type: q.type };
  const ref = new Float32Array(N * GPU_CASTER_FLOATS);
  const rctx = makePackContext(q, opts, N, {});
  const want = packInstancedRows(q, rctx, ref, new Uint32Array(ref.buffer), fp, N, shadowCast);
  dst.fill(-3);
  const ctx = makePackContext(q, opts, N, {});
  const got = packInstancedRowsWasm(b, q, ctx, dst, fp, N, shadowCast);
  assert.equal(got, want, `${label}: rows`);
  assert.equal(ctx.particleCount, rctx.particleCount, `${label}: particles`);
  const a = new Uint32Array(ref.buffer, 0, want * fp);
  const w = new Uint32Array(dst.buffer, dst.byteOffset, want * fp);
  for (let k = 0; k < a.length; k++) if (a[k] !== w[k]) assert.fail(`${label}: word ${k} ${a[k]} vs ${w[k]}`);
}

test('a long list packs through its inverse with the JS bits', async () => {
  const s = await setup();
  const ran = { sprites: 0, casters: 0 };
  for (const [key, name] of [['spritesScatter', 'sprites'], ['castersScatter', 'casters']]) {
    const real = s.b[key];
    s.b[key] = (...args) => {
      const out = real(...args);
      if (out >= 0) ran[name]++;
      return out;
    };
  }
  check(s, s.order, N, false, 'sprites, the whole queue');
  check(s, s.order, N, true, 'casters, the whole queue');
  check(s, s.order, N - 100, false, 'sprites, most of the queue');
  check(s, new Uint32Array(s.order), N, false, 'sprites, the list copied in');
  assert.equal(ran.sprites, 3, 'the sprite packs went through the inverse');
  assert.equal(ran.casters, 1, 'the caster pack went through the inverse');
});

test('a repeated or out-of-range row falls back to the gather', async () => {
  const s = await setup();
  const dup = new Uint32Array(s.order);
  dup[N - 1] = dup[0];
  check(s, dup, N, false, 'a repeated row');
  const shortQ = { ...s.q, count: N - 10 };
  // Rows past the queue's count appear in the list: the inverse cannot hold them.
  check({ ...s, q: shortQ }, s.order, N - 10, false, 'a row past the count');
  check(s, s.order, 100, false, 'a short list (gathered)');
});
