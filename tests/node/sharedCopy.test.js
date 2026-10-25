// W30: Pixi's copies out of the render-queue memory by memory.copy into a private WebAssembly.Memory
// (src/render/sharedCopy.js). The arena copies bit for bit, hands out aligned arrays until it is full, and is an
// ordinary ArrayBuffer (E-123: a batch never uploads from shared memory); a batch whose arrays live in it commits the
// same bytes as one with arrays of its own, and copies from anywhere else with TypedArray.set.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createPrivateArena } from '../../src/render/sharedCopy.js';
import { InstancedSpriteBatch, POSE_STATIC_FLOATS, SPLIT_POSE_FLOATS } from '../../src/render/instancedSpriteBatch.js';

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };
const shaderDir = path.resolve(import.meta.dirname, '../../src/shaders');
const read = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const SHADERS = {
  spriteVertPose: read('instancedSpritePose.vert.glsl'),
  spriteVert: read('instancedSprite.vert.glsl'),
  spriteFrag: read('instancedSprite.frag.glsl'),
  spriteFragAdd: read('instancedSpriteAdditive.frag.glsl'),
  spriteFragBlend: read('instancedSpriteBlend.frag.glsl'),
};

const sharedMemory = (pages) => new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });

test('the arena copies out of the shared memory bit for bit, into arrays of an ordinary ArrayBuffer', () => {
  const shared = sharedMemory(4);
  const arena = createPrivateArena(shared, 3 * 65536);
  assert.ok(arena, 'Node has multi-memory');
  assert.ok(!(arena.buffer instanceof SharedArrayBuffer), 'the arena is not shared');
  const a = arena.f32(1001);
  const b = arena.f32(7);
  assert.equal(a.byteOffset % 16, 0);
  assert.equal(b.byteOffset % 16, 0);
  assert.ok(b.byteOffset >= a.byteOffset + a.byteLength, 'no overlap');
  const src = new Float32Array(shared.buffer, 4096, 1001);
  const words = new Uint32Array(src.buffer, src.byteOffset, src.length);
  for (let i = 0; i < words.length; i++) words[i] = Math.imul(i + 1, 2654435761) >>> 0; // NaNs and -0 among them
  arena.copy(a.byteOffset, src.byteOffset, src.byteLength);
  assert.deepEqual(new Uint32Array(a.buffer, a.byteOffset, a.length), words);
  // Full: null, and the caller keeps an array of its own.
  assert.equal(arena.f32(3 * 65536), null);
  assert.equal(createPrivateArena(null, 1024), null, 'no shared memory, no arena');
});

/** A split batch with or without an arena, and the two streams of `n` rows in a shared memory. */
function splitBatch(withArena, n) {
  const shared = sharedMemory(Math.ceil((n * 15 * 4 * 2) / 65536) + 2);
  const arena = withArena ? createPrivateArena(shared, n * 17 * 4 + 4096) : null;
  const copies = { count: 0 };
  if (arena) {
    const copy = arena.copy;
    arena.copy = (dst, src, len) => {
      copies.count++;
      copy(dst, src, len);
    };
  }
  const batch = new InstancedSpriteBatch({ capacity: n, label: 'w30', split: true, useWebGpu: false, shaders: SHADERS, arena });
  const pose = new Float32Array(shared.buffer, 64, n * SPLIT_POSE_FLOATS);
  const stat = new Float32Array(shared.buffer, 64 + pose.byteLength, n * POSE_STATIC_FLOATS);
  const fill = (v, seed) => {
    const u = new Uint32Array(v.buffer, v.byteOffset, v.length);
    for (let i = 0; i < u.length; i++) u[i] = Math.imul(i + seed, 2246822519) >>> 0;
  };
  fill(pose, 1);
  fill(stat, 2);
  return { batch, arena, pose, stat, copies };
}

const bytes = (v, n) => Buffer.from(v.buffer, v.byteOffset, n * 4);

test('a batch in the arena commits what a batch with arrays of its own commits', () => {
  const n = 5000;
  const plain = splitBatch(false, n);
  const inArena = splitBatch(true, n);
  assert.equal(inArena.batch.data.buffer, inArena.arena.buffer, 'the pose stream lives in the arena');
  assert.equal(inArena.batch.staticData.buffer, inArena.arena.buffer, 'the statics too');
  for (const k of [plain, inArena]) k.batch.commitSplit(k.pose, k.stat, n - 3, 7);
  assert.equal(inArena.copies.count, 2, 'both streams by memory.copy');
  assert.deepEqual(bytes(inArena.batch.data, (n - 3) * SPLIT_POSE_FLOATS), bytes(plain.batch.data, (n - 3) * SPLIT_POSE_FLOATS));
  assert.deepEqual(bytes(inArena.batch.staticData, (n - 3) * POSE_STATIC_FLOATS), bytes(plain.batch.staticData, (n - 3) * POSE_STATIC_FLOATS));
  // A source outside the shared memory: TypedArray.set, the same bytes.
  const elsewhere = Float32Array.from({ length: 40 }, (_, i) => i * 0.5 - 3);
  inArena.batch.copyIn(inArena.batch.data, elsewhere, 40);
  assert.equal(inArena.copies.count, 2, 'not by memory.copy');
  assert.deepEqual(Array.from(inArena.batch.data.subarray(0, 40)), Array.from(elsewhere));
});
