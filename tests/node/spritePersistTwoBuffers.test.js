import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';

// emitSpriteQueue's pose-only path: when the type-0 set, frames and animation states match
// what this queue buffer last emitted and no entity is renderDirty, only poses are
// rewritten. The queue alternates two buffers each frame, but renderDirty is one flag
// per entity. A buffer that takes a change must leave the other one due a full emit.

const N = 4;

async function setup() {
  const w = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  w._persistEntity = [new Int32Array(N), new Int32Array(N)];
  w._persistType = [new Uint8Array(N), new Uint8Array(N)];
  w._persistFrame = [new Uint16Array(N), new Uint16Array(N)];
  w._persistAnim = [new Uint16Array(N), new Uint16Array(N)];
  w._persistCount = [0, 0];
  w.entityFrameIndex = new Uint16Array(N);
  w._queueBuf = 0;
  SpriteRenderer.renderDirty = new Uint8Array(N);
  SpriteRenderer.animationState = new Uint16Array(N);
  return w;
}

const types = new Uint8Array(N);
const indices = Int32Array.from({ length: N }, (_, i) => i);

// The caller's protocol (emitSpriteQueue): test the hit, emit, remember on a miss, flip.
function frame(w) {
  const buf = w._queueBuf;
  const hit = buf >= 0 ? w._type0PersistHit(buf, N, types, indices) : false;
  if (!hit) w._rememberType0Set(buf, N, types, indices);
  w._queueBuf ^= 1;
  return hit ? 'poses' : 'full';
}

test('a one-off change gives both queue buffers one full emit, then both persist', async () => {
  const w = await setup();
  assert.deepEqual([frame(w), frame(w)], ['full', 'full'], 'first fill of each buffer');
  assert.deepEqual([frame(w), frame(w)], ['poses', 'poses'], 'calm scene, both buffers persist');

  SpriteRenderer.renderDirty[2] = 1; // e.g. a tint change, landing before an even frame
  assert.equal(frame(w), 'full', 'buffer 0 takes the change');
  assert.equal(SpriteRenderer.renderDirty[2], 0);
  assert.equal(frame(w), 'full', 'buffer 1 still holds the old tint: it must not reuse it');
  assert.deepEqual([frame(w), frame(w)], ['poses', 'poses']);
});

test('a change landing before an odd frame is handled the same way', async () => {
  const w = await setup();
  frame(w);
  frame(w);
  frame(w); // buffer 0 persists; next is buffer 1
  SpriteRenderer.renderDirty[1] = 1;
  assert.equal(frame(w), 'full', 'buffer 1 takes the change');
  assert.equal(frame(w), 'full', 'buffer 0 is now behind');
  assert.deepEqual([frame(w), frame(w)], ['poses', 'poses']);
});

test('a frame or animation change misses only on the buffer that sees it', async () => {
  const w = await setup();
  frame(w);
  frame(w);
  w.entityFrameIndex[3] = 7;
  assert.equal(frame(w), 'full');
  assert.equal(frame(w), 'full', 'the other buffer compares its own remembered frame');
  assert.deepEqual([frame(w), frame(w)], ['poses', 'poses']);
});
