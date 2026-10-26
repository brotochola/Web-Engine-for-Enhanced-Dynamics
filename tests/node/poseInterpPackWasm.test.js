import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BATCH_SPACE,
  InstancedSpriteBatch,
  POSE_DYN_FLOATS,
  POSE_STATIC_FLOATS,
} from '../../src/render/instancedSpriteBatch.js';
import { bindGpuPack, packPoseRowsWasm } from '../../src/render/gpuPackClient.js';
import { installBatchPackJs } from '../reference/gpuPackJs.mjs';

// W9e. A pose batch's upload (renderer.interpolation) through gpuPack.wasm's pack_pose: the pose stream and the
// statics must be the bits the batch's own _packPoseOnly and _packPoseAndStatics write, on every path they take:
// world and screen space, a turned camera, pixel snap in either, the previous pose present, absent or ignored
// (the pose snap), index lists in the memory and out of it, type filters, a capacity under the count.

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

const N = 3000;

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
  const prevX = f32();
  const prevY = f32();
  for (let i = 0; i < N; i++) {
    q.x[i] = (rng() - 0.5) * 9000;
    q.y[i] = (rng() - 0.5) * 9000;
    prevX[i] = q.x[i] + (rng() - 0.5) * 40;
    prevY[i] = q.y[i] + (rng() - 0.5) * 40;
    q.scaleX[i] = rng() * 3;
    q.scaleY[i] = rng() * 3;
    q.rotC[i] = rng() * 2 - 1;
    q.rotS[i] = rng() * 2 - 1;
    const a = rng();
    q.alpha[i] = a < 0.05 ? NaN : a < 0.1 ? -0.5 : a < 0.15 ? 1.7 : rng();
    q.tint[i] = (rng() * 0xffffffff) >>> 0;
    q.textureId[i] = (rng() * 65535) | 0;
    q.anchorX[i] = rng();
    q.anchorY[i] = rng();
    q.tileMulX[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileMulY[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileOffsetU[i] = (rng() * 65535) | 0;
    q.tileOffsetV[i] = (rng() * 65535) | 0;
    q.type[i] = (rng() * 5) | 0;
  }
  const pose = alloc(Float32Array, N * POSE_DYN_FLOATS);
  const stat = alloc(Float32Array, N * POSE_STATIC_FLOATS);
  // Pixi's pack region with interpolation: 17 floats a row, the pose stream then the statics.
  const region = alloc(Float32Array, N * (POSE_DYN_FLOATS + POSE_STATIC_FLOATS));
  const order = Uint32Array.from({ length: N }, (_, i) => i).sort(() => rng() - 0.5);
  const inMemory = alloc(Uint32Array, N);
  inMemory.set(order);
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += N * 4;
  const particlesByte = (top = (top + 15) & ~15);
  top += 160;
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  const batch = installBatchPackJs(new InstancedSpriteBatch({ capacity: N, label: 'w9e', poseInterp: true, useWebGpu: false, shaders }));
  return { q, prevX, prevY, pose, stat, region, inMemory, outside: Uint32Array.from(order), pack, batch };
}

function sameWords(a, b, floats, rows, label) {
  const wa = new Uint32Array(a.buffer, a.byteOffset, rows * floats);
  const wb = new Uint32Array(b.buffer, b.byteOffset, rows * floats);
  for (let k = 0; k < wa.length; k++) {
    if (wa[k] !== wb[k]) assert.fail(`${label}: word ${k} (row ${(k / floats) | 0}, float ${k % floats}) ${wa[k]} vs ${wb[k]}`);
  }
}

/** The batch's JS pack and the kernel on the same context, both streams or the pose alone. */
function compare(s, opts, capacity, statics, label) {
  const { batch, q } = s;
  batch.capacity = capacity;
  // Pixi's pack options: -1 for no include or exclude type.
  const ctx = batch._beginUpload(q, { includeType: -1, excludeType0: -1, excludeType1: -1, ...opts });
  assert.ok(ctx, `${label}: a context`);
  batch.data.fill(-7);
  batch.staticData.fill(-7);
  const want = statics ? batch._packPoseAndStatics(q, ctx) : batch._packPoseOnly(q, ctx);
  s.pose.fill(-9);
  s.stat.fill(-9);
  const got = packPoseRowsWasm(s.pack, q, ctx, s.pose, statics ? s.stat : null, capacity);
  assert.equal(got, want, `${label}: rows`);
  sameWords(s.pose, batch.data, POSE_DYN_FLOATS, want, `${label}: pose`);
  if (statics) sameWords(s.stat, batch.staticData, POSE_STATIC_FLOATS, want, `${label}: statics`);
  batch.capacity = N;
  return got;
}

test('pack_pose writes what the pose batch writes, both streams and the pose alone', async () => {
  const s = await setup(11);
  const cam = { zoom: 0.73, cameraX: -812.5, cameraY: 333.25, resolution: 1.5, canvasW: 1280, canvasH: 720 };
  const prev = { prevX: s.prevX, prevY: s.prevY };
  const cases = [
    ['world', { space: BATCH_SPACE.WORLD }],
    ['world, the previous pose', { space: BATCH_SPACE.WORLD, ...prev }],
    ['world, the pose snap', { space: BATCH_SPACE.WORLD, ...prev, snap: true }],
    ['world, pixel snap', { space: BATCH_SPACE.WORLD, ...prev, pixelSnap: true, snapCameraX: 17.3, snapCameraY: -9.75, snapZoom: 2.5 }],
    ['world, pixel snap without a zoom', { space: BATCH_SPACE.WORLD, ...prev, pixelSnap: true }],
    ['screen', { ...cam, space: BATCH_SPACE.SCREEN, ...prev }],
    ['screen, turned', { ...cam, space: BATCH_SPACE.SCREEN, cameraRot: 0.61, ...prev }],
    ['screen, snapped', { ...cam, space: BATCH_SPACE.SCREEN, pixelSnap: true, ...prev }],
    ['screen, turned, snapped', { ...cam, space: BATCH_SPACE.SCREEN, cameraRot: -1.2, pixelSnap: true, ...prev }],
    ['include a type', { space: BATCH_SPACE.WORLD, type: s.q.type, includeType: 3, ...prev }],
    ['exclude two types', { space: BATCH_SPACE.WORLD, type: s.q.type, excludeType0: 1, excludeType1: 4, ...prev }],
    ['screen, include, snapped', { ...cam, space: BATCH_SPACE.SCREEN, type: s.q.type, includeType: 2, pixelSnap: true, ...prev }],
    ['indices in the memory', { space: BATCH_SPACE.WORLD, indices: s.inMemory, indexCount: N, ...prev }],
    ['indices copied in', { ...cam, space: BATCH_SPACE.SCREEN, cameraRot: 0.3, indices: s.outside, indexCount: 2222, ...prev }],
    ['a depth denominator', { space: BATCH_SPACE.WORLD, depthDenom: 5000, ...prev }],
  ];
  for (const statics of [true, false]) {
    for (const [label, opts] of cases) {
      const tag = `${statics ? 'both' : 'pose'}: ${label}`;
      assert.ok(compare(s, opts, N, statics, tag) > 0, `${tag}: rows were written`);
      compare(s, opts, 1777, statics, `${tag}, capacity under count`);
    }
  }
});

test('pack_pose declines what is not in the memory', async () => {
  const s = await setup(12);
  const none = { includeType: -1, excludeType0: -1, excludeType1: -1 };
  const ctx = s.batch._beginUpload(s.q, { ...none, space: BATCH_SPACE.WORLD, prevX: new Float32Array(N), prevY: s.prevY });
  assert.equal(packPoseRowsWasm(s.pack, s.q, ctx, s.pose, s.stat, N), -1, 'a previous pose outside');
  const ctx2 = s.batch._beginUpload(s.q, { ...none, space: BATCH_SPACE.WORLD });
  assert.equal(packPoseRowsWasm(s.pack, s.q, ctx2, new Float32Array(N * POSE_DYN_FLOATS), null, N), -1, 'rows outside');
});

test('a pose batch on the Pixi region uploads through the kernel what the JS pose batch uploads', async () => {
  const s = await setup(13);
  let calls = 0;
  const kernel = s.pack.pose;
  s.pack.pose = (...a) => {
    calls++;
    return kernel(...a);
  };
  const base = { capacity: N, label: 'w9e-wired', poseInterp: true, useWebGpu: false, shaders };
  const wasm = new InstancedSpriteBatch({ ...base, data: s.region, gpuPack: s.pack });
  const js = installBatchPackJs(new InstancedSpriteBatch(base));
  for (const b of [...wasm._buffers, ...js._buffers]) b.update = () => {};
  assert.equal(wasm._gpuPack, s.pack, 'the batch packs through the kernel');
  assert.equal(wasm._sharedPose.buffer, s.region.buffer);
  assert.ok(!(wasm.data.buffer instanceof SharedArrayBuffer), 'and uploads a private copy (E-123)');
  const opts = {
    space: BATCH_SPACE.WORLD, includeType: -1, excludeType0: -1, excludeType1: -1,
    prevX: s.prevX, prevY: s.prevY, pixelSnap: true, snapCameraX: 3.5, snapCameraY: -2.25, snapZoom: 1.5,
  };
  // Three frames: the first packs the statics, then the pose alone (statics current), then both again after the
  // queue's statics generation would have moved (a row count that differs).
  for (const [frame, count] of [[0, N], [1, N], [2, N - 333]]) {
    s.q.count = count;
    for (let i = 0; i < N; i++) s.q.x[i] += frame;
    const nw = wasm.upload(s.q, opts);
    const nj = js.upload(s.q, { ...opts });
    assert.equal(nw, nj, `frame ${frame}: rows`);
    sameWords(wasm.data, js.data, POSE_DYN_FLOATS, nj, `frame ${frame}: pose`);
    sameWords(wasm.staticData, js.staticData, POSE_STATIC_FLOATS, nj, `frame ${frame}: statics`);
  }
  assert.equal(calls, 3, 'every frame through the kernel');
});
