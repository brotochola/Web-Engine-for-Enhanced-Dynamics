import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { InstancedSpriteBatch, POSE_DYN_FLOATS, POSE_STATIC_FLOATS, BATCH_SPACE } from '../../src/render/instancedSpriteBatch.js';

// E-82: a pose batch packs two streams, the pose every upload and the statics only when the queue's
// staticGen (or the rows, filter, screen scale) changed. Each stream holds what the 17-float record
// held, and a static upload happens exactly when it must.

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
    tileMulX: f32(), tileMulY: f32(), type: new Uint8Array(N), staticGen: new Uint32Array([gen]),
  };
}

function makeBatch() {
  const batch = new InstancedSpriteBatch({ capacity: N, label: 'pose-test', poseInterp: true, useWebGpu: false, shaders });
  const uploads = { pose: 0, statics: 0 };
  for (const b of batch._buffers) b.update = () => { uploads.pose++; };
  for (const b of batch._staticBuffers) b.update = () => { uploads.statics++; };
  return { batch, uploads };
}

// As Pixi's entity upload sets them (includeType -1: no filter).
const opts = (q) => ({
  space: BATCH_SPACE.WORLD, includeType: -1, excludeType0: -1, excludeType1: -1, type: q.type,
  prevX: q.x.map((v) => v - 1), prevY: q.y.map((v) => v + 1), depthDenom: N,
});

test('the two streams hold what the 17-float pose record held', () => {
  const { batch } = makeBatch();
  const q = queue(7, 5);
  const o = opts(q);
  assert.equal(batch.upload(q, o), N);
  const d = batch.data;
  const st = batch.staticData;
  const stU32 = batch.staticDataU32;
  for (let k = 0; k < N; k++) {
    const b = k * POSE_DYN_FLOATS;
    const sb = k * POSE_STATIC_FLOATS;
    assert.equal(d[b], q.x[k]);
    assert.equal(d[b + 1], q.y[k]);
    assert.equal(d[b + 2], q.rotC[k]);
    assert.equal(d[b + 3], q.rotS[k]);
    assert.equal(d[b + 4], o.prevX[k]);
    assert.equal(d[b + 5], o.prevY[k]);
    assert.equal(st[sb], q.scaleX[k]);
    assert.equal(st[sb + 1], q.scaleY[k]);
    assert.equal(st[sb + 2], q.anchorX[k]);
    assert.equal(st[sb + 3], q.anchorY[k]);
    assert.equal(st[sb + 4], Math.fround(1 - (k + 1) / (N + 1))); // _beginUpload adds 1 to depthDenom
    const a8 = (Math.min(1, Math.max(0, q.alpha[k])) * 255 + 0.5) | 0;
    assert.equal(stU32[sb + 5], (((a8 & 255) << 24) | (q.tint[k] & 0xffffff)) >>> 0);
    assert.equal(st[sb + 6], q.textureId[k]);
    assert.equal(st[sb + 7], q.tileMulX[k]);
    assert.equal(st[sb + 8], q.tileMulY[k]);
    assert.equal(st[sb + 9], Math.fround(q.tileOffsetU[k] * (1 / 65535)));
  }
});

test('the statics go up once per ring slot while staticGen stays, and again when it moves', () => {
  const { batch, uploads } = makeBatch();
  const q = queue(9, 3);
  const o = opts(q);
  for (let f = 0; f < 6; f++) batch.upload(q, o);
  assert.equal(uploads.pose, 6, 'the pose every frame');
  assert.equal(uploads.statics, 2, 'the statics once into each of the two ring slots');
  q.scaleX[0] = 42; // a change pre-render would publish with a new staticGen
  q.staticGen[0] = 4;
  batch.upload(q, o);
  batch.upload(q, o);
  assert.equal(uploads.statics, 4, 'both slots again after the change');
  assert.equal(batch.staticData[0], 42);
  // A queue with no count of its own (0: unknown) rewrites every frame.
  q.staticGen[0] = 0;
  for (let f = 0; f < 3; f++) batch.upload(q, o);
  assert.equal(uploads.statics, 7);
  // An index list (a painter) may reorder rows: no reuse.
  q.staticGen[0] = 4;
  const idx = Uint32Array.from({ length: N }, (_, i) => N - 1 - i);
  batch.upload(q, { ...o, indices: idx, indexCount: N });
  batch.upload(q, { ...o, indices: idx, indexCount: N });
  assert.equal(uploads.statics, 9);
});
