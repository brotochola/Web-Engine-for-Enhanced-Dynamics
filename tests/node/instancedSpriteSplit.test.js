import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BATCH_SPACE,
  INSTANCED_SPRITE_FLOATS,
  InstancedSpriteBatch,
  POSE_STATIC_FLOATS,
  SPLIT_POSE_FLOATS,
} from '../../src/render/instancedSpriteBatch.js';
import { GPU_POSE_FLOATS, GPU_STATIC_FLOATS } from '../../src/render/gpuQueueLayout.js';

// E-82b: a split batch holds a plain batch's 15-float rows as a 4-float pose stream and E-82's static stream,
// on every path (packSplitRows, the 15-float fallback, rows committed from a GPU queue in either form), and
// uploads its statics only when they change.

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

const N = 500;
// Where each stream's float sits in the 15-float row.
const POSE_FROM_ROW = [0, 1, 6, 7];
const STATIC_FROM_ROW = [2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14];

function queue(seed, gen) {
  let s = seed;
  const rng = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const f32 = () => new Float32Array(N).map(() => rng() * 100);
  return {
    count: N, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(),
    alpha: new Float32Array(N).map(() => rng()), tint: new Uint32Array(N).map(() => (rng() * 0xffffff) | 0),
    textureId: new Uint16Array(N).map(() => (rng() * 400) | 0), anchorX: f32(), anchorY: f32(),
    repeatX: new Uint16Array(N), repeatY: new Uint16Array(N), tileMode: new Uint8Array(N),
    tileOffsetU: new Uint16Array(N).map(() => (rng() * 65535) | 0), tileOffsetV: new Uint16Array(N),
    tileMulX: f32(), tileMulY: f32(), type: new Uint8Array(N).map(() => (rng() * 5) | 0), staticGen: new Uint32Array([gen]),
  };
}

function makeBatch(split) {
  const batch = new InstancedSpriteBatch({ capacity: N, label: 'split-test', split, useWebGpu: false, shaders });
  const uploads = { pose: 0, statics: 0 };
  for (const b of batch._buffers) b.update = () => { uploads.pose++; };
  if (batch._staticBuffers) for (const b of batch._staticBuffers) b.update = () => { uploads.statics++; };
  return { batch, uploads };
}

// As Pixi's entity upload sets them (includeType -1: no filter).
const opts = (q, extra = {}) => ({
  space: BATCH_SPACE.WORLD, includeType: -1, excludeType0: -1, excludeType1: -1, type: q.type, depthDenom: N, ...extra,
});

/** The split batch's two streams hold the plain batch's rows, word for word. */
function sameAsRows(plain, split, n, label) {
  const rows = plain.dataU32;
  const pose = split.dataU32;
  const stat = split.staticDataU32;
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < SPLIT_POSE_FLOATS; j++) {
      const want = rows[k * INSTANCED_SPRITE_FLOATS + POSE_FROM_ROW[j]];
      const got = pose[k * SPLIT_POSE_FLOATS + j];
      if (want !== got) assert.fail(`${label}: row ${k} pose ${j}: ${want} vs ${got}`);
    }
    for (let j = 0; j < POSE_STATIC_FLOATS; j++) {
      const want = rows[k * INSTANCED_SPRITE_FLOATS + STATIC_FROM_ROW[j]];
      const got = stat[k * POSE_STATIC_FLOATS + j];
      if (want !== got) assert.fail(`${label}: row ${k} static ${j}: ${want} vs ${got}`);
    }
  }
}

test('a split batch is a plain batch in two streams, on the fast path and the fallback', () => {
  const q = queue(3, 7);
  const idx = Uint32Array.from({ length: N }, (_, i) => (i * 7) % N);
  const cases = [
    ['dense', opts(q)],
    ['indices', opts(q, { indices: idx, indexCount: N })],
    ['screen space (the fallback)', opts(q, { space: BATCH_SPACE.SCREEN, zoom: 1.5, cameraX: 10, cameraY: -4 })],
    ['pixel snap (the fallback)', opts(q, { pixelSnap: true, snapZoom: 2, snapCameraX: 3, snapCameraY: 1 })],
    ['type filter (the fallback)', opts(q, { includeType: 2 })],
  ];
  for (const [label, o] of cases) {
    const { batch: plain } = makeBatch(false);
    const { batch: split } = makeBatch(true);
    const n = plain.upload(q, o);
    assert.ok(n > 0, `${label}: rows`);
    assert.equal(split.upload(q, o), n, `${label}: the same rows`);
    sameAsRows(plain, split, n, label);
  }
});

test('a split batch uploads its statics once per ring slot while staticGen holds', () => {
  const { batch, uploads } = makeBatch(true);
  const q = queue(9, 3);
  const o = opts(q);
  for (let f = 0; f < 6; f++) batch.upload(q, o);
  assert.equal(uploads.pose, 6, 'the pose every frame');
  assert.equal(uploads.statics, 2, 'the statics once into each ring slot');
  q.x[0] = 1234; // a pose change: no new generation
  batch.upload(q, o);
  assert.equal(batch.data[0], 1234, 'the pose follows');
  assert.equal(uploads.statics, 2);
  q.scaleX[0] = 42;
  q.staticGen[0] = 4;
  batch.upload(q, o);
  batch.upload(q, o);
  assert.equal(uploads.statics, 4, 'both slots again after the change');
  assert.equal(batch.staticData[0], 42);
});

test('commitSplit copies the statics only when their generation or the rows move', () => {
  const { batch, uploads } = makeBatch(true);
  const pose = new Float32Array(N * SPLIT_POSE_FLOATS).map((_, i) => i);
  const stat = new Float32Array(N * POSE_STATIC_FLOATS).map((_, i) => -i);
  assert.equal(batch.commitSplit(pose, stat, N, 11), N);
  assert.equal(batch.staticData[5], -5);
  stat[5] = 99; // a stale stream: the generation says the batch already has its statics
  for (let f = 0; f < 4; f++) batch.commitSplit(pose, stat, N, 11);
  assert.equal(batch.staticData[5], -5, 'not copied while the generation holds');
  assert.equal(uploads.statics, 2, 'one upload per ring slot');
  assert.equal(uploads.pose, 5);
  batch.commitSplit(pose, stat, N - 1, 11);
  assert.equal(batch.staticData[5], 99, 'a new row count copies');
  stat[5] = 7;
  batch.commitSplit(pose, stat, N - 1, 0);
  assert.equal(batch.staticData[5], 7, 'generation 0 always copies');
  stat[5] = 8;
  batch.commitSplit(pose, stat, N - 1, 0);
  assert.equal(batch.staticData[5], 8);
  assert.equal(batch.commitSplit(pose, stat, 0, 12), 0, 'no rows hides the batch');
  assert.equal(batch.mesh.visible, false);
});

test('commitRowsSplit splits 15-float rows and forgets the generation', () => {
  const { batch: plain } = makeBatch(false);
  const { batch: split } = makeBatch(true);
  const q = queue(5, 2);
  const n = plain.upload(q, opts(q));
  split.commitSplit(new Float32Array(N * 4), new Float32Array(N * 11), N, 2);
  assert.equal(split.commitRowsSplit(plain.data, plain.dataU32, n), n);
  sameAsRows(plain, split, n, 'rows');
  // The generation it held before is no longer known to be on the GPU.
  const stat = new Float32Array(N * 11).fill(3);
  split.commitSplit(new Float32Array(N * 4), stat, N, 2);
  assert.equal(split.staticData[0], 3);
});

test('the batch\'s streams are the GPU queue\'s', () => {
  assert.equal(SPLIT_POSE_FLOATS, GPU_POSE_FLOATS);
  assert.equal(POSE_STATIC_FLOATS, GPU_STATIC_FLOATS);
});

test('a split batch reads the previous xy from the current one', () => {
  const { batch } = makeBatch(true);
  const attrs = batch.geometry.attributes;
  assert.equal(attrs.aInstPrevXY.offset, 0);
  assert.equal(attrs.aInstXY.offset, 0);
  assert.equal(attrs.aInstRotCS.offset, 8);
  assert.equal(attrs.aInstXY.stride, 16);
  assert.equal(attrs.aInstScale.stride, 44);
  const { batch: plain } = makeBatch(false);
  assert.equal(plain.split, false);
  assert.equal(plain.geometry.attributes.aInstPrevXY, undefined);
  const pose = new InstancedSpriteBatch({ capacity: 4, label: 'pose', poseInterp: true, split: true, useWebGpu: false, shaders });
  assert.equal(pose.split, false, 'a pose batch is never split');
});
