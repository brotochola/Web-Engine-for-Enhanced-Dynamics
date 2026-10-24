import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InstancedSpriteBatch, INSTANCED_SPRITE_FLOATS, BATCH_SPACE } from '../../src/render/instancedSpriteBatch.js';
import { bindGpuPack } from '../../src/render/gpuPackClient.js';

// W9d. Pixi's plain sprite batch packs through gpuPack.wasm when its rows live in the render-queue
// memory: the rows must be the bits the JS pack writes, and anything the kernel declines (a type
// filter here) must still pack, in JS.

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };

const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const read = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const shaders = {
  spriteVertPose: read('instancedSpritePose.vert.glsl'),
  spriteVert: read('instancedSprite.vert.glsl'),
  spriteFrag: read('instancedSprite.frag.glsl'),
  spriteFragAdd: read('instancedSpriteAdditive.frag.glsl'),
  spriteFragBlend: read('instancedSpriteBlend.frag.glsl'),
};

const N = 2000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function setup(seed) {
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 8192, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 15) & ~15;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(seed);
  const f32 = () => alloc(Float32Array, N);
  const q = {
    count: N, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, N), textureId: alloc(Uint16Array, N), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, N), repeatY: alloc(Uint16Array, N), tileMode: alloc(Uint8Array, N),
    tileMulX: f32(), tileMulY: f32(), tileOffsetU: alloc(Uint16Array, N), tileOffsetV: alloc(Uint16Array, N),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N),
  };
  for (let i = 0; i < N; i++) {
    q.x[i] = (rng() - 0.5) * 9000;
    q.y[i] = (rng() - 0.5) * 9000;
    q.scaleX[i] = rng() * 3;
    q.scaleY[i] = rng() * 3;
    q.rotC[i] = rng() * 2 - 1;
    q.rotS[i] = rng() * 2 - 1;
    q.alpha[i] = rng();
    q.tint[i] = (rng() * 0xffffff) >>> 0;
    q.textureId[i] = (rng() * 400) | 0;
    q.anchorX[i] = rng();
    q.anchorY[i] = rng();
    q.tileMulX[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileMulY[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileOffsetU[i] = (rng() * 65535) | 0;
    q.tileOffsetV[i] = (rng() * 65535) | 0;
    q.type[i] = rng() < 0.1 ? 3 : 0;
  }
  const rows = alloc(Float32Array, N * INSTANCED_SPRITE_FLOATS);
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += N * 4;
  const particlesByte = top;
  top += 16;
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  let kernelCalls = 0;
  const sprites = pack.sprites;
  pack.sprites = (...a) => {
    kernelCalls++;
    return sprites(...a);
  };
  const order = Uint32Array.from({ length: N }, (_, i) => i).sort(() => rng() - 0.5);
  return { q, rows, pack, order, calls: () => kernelCalls };
}

function batches(s) {
  const opts = { capacity: N, label: 'w9d', useWebGpu: false, shaders };
  const wasm = new InstancedSpriteBatch({ ...opts, data: s.rows, gpuPack: s.pack });
  const js = new InstancedSpriteBatch(opts);
  for (const b of [...wasm._buffers, ...js._buffers]) b.update = () => {};
  assert.equal(wasm._sharedRows, s.rows, 'the kernel packs into the shared rows');
  assert.ok(!(wasm.data.buffer instanceof SharedArrayBuffer), 'and the upload reads a private copy (E-123)');
  return { wasm, js };
}

function sameRows(a, b, n, label) {
  const wa = new Uint32Array(a.data.buffer, a.data.byteOffset, n * INSTANCED_SPRITE_FLOATS);
  const wb = new Uint32Array(b.data.buffer, b.data.byteOffset, n * INSTANCED_SPRITE_FLOATS);
  for (let k = 0; k < wa.length; k++) {
    if (wa[k] !== wb[k]) assert.fail(`${label}: word ${k} (row ${(k / INSTANCED_SPRITE_FLOATS) | 0}) ${wa[k]} vs ${wb[k]}`);
  }
}

test('a painter-ordered world upload packs through the kernel, with the JS rows', async () => {
  const s = await setup(5);
  const { wasm, js } = batches(s);
  const opts = { space: BATCH_SPACE.WORLD, type: s.q.type, indices: s.order, indexCount: N, depthDenom: N };
  const nw = wasm.upload(s.q, opts);
  const nj = js.upload(s.q, { ...opts });
  assert.equal(nw, nj);
  assert.ok(s.calls() > 0, 'the kernel packed it');
  sameRows(wasm, js, nj, 'indexed');
});

test('a type-filtered upload the kernel declines still packs, in JS', async () => {
  const s = await setup(6);
  const { wasm, js } = batches(s);
  const opts = { space: BATCH_SPACE.WORLD, type: s.q.type, excludeType0: 3, depthDenom: N };
  const nw = wasm.upload(s.q, opts);
  const nj = js.upload(s.q, { ...opts });
  assert.equal(nw, nj);
  assert.equal(s.calls(), 0, 'declined: no kernel call');
  sameRows(wasm, js, nj, 'filtered');
});

test('a pose batch and a caster batch keep their own rows', async () => {
  const s = await setup(7);
  const pose = new InstancedSpriteBatch({ capacity: N, label: 'p', useWebGpu: false, shaders, poseInterp: true, data: s.rows, gpuPack: s.pack });
  assert.notEqual(pose.data, s.rows);
  assert.equal(pose._sharedRows.length, 0);
  assert.equal(pose._gpuPack, null);
});
