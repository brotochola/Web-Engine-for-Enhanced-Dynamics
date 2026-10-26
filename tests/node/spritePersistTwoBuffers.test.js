import test from 'node:test';
import assert from 'node:assert/strict';

import { bootEmitWorker, countPersistHits } from '../helpers/preRenderEmitBoot.mjs';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';

// The persist path (W4c, in the emit kernel): when the sprite set, frames and animation states match
// what this queue buffer last emitted and no entity is renderDirty, only poses are
// rewritten. The queue alternates two buffers each frame, but renderDirty is one flag
// per entity. A buffer that takes a change must leave the other one due a full emit.

const N = 4;

async function setup() {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  const { worker: w } = await bootEmitWorker(N);
  for (let e = 0; e < N; e++) {
    Transform.active[e] = 1;
    Transform.x[e] = 10 * e;
    Transform.rotC[e] = 1;
    SpriteRenderer.active[e] = 1;
    // No animation: a frame index stays where it is set (no full emit wraps it).
    SpriteRenderer.spritesheetId[e] = 0;
    SpriteRenderer.scaleX[e] = 1;
    SpriteRenderer.scaleY[e] = 1;
    SpriteRenderer.alpha[e] = 1;
  }
  return { w, persist: countPersistHits(w) };
}

// One frame of pre-render's: write buffer, collect, emit (the persist check, the emit, the remember), flip.
function frame({ w, persist }) {
  const before = persist.hits;
  w.selectWriteBuffers();
  w._renderableCount = 0;
  w._bindCollectPoses();
  for (let e = 0; e < N; e++) w.collectRenderable(0, e);
  w.buildRenderQueue(1000 / 60);
  w._queueBuf ^= 1;
  return persist.hits > before ? 'poses' : 'full';
}

test('a one-off change gives both queue buffers one full emit, then both persist', async () => {
  const k = await setup();
  try {
    assert.deepEqual([frame(k), frame(k)], ['full', 'full'], 'first fill of each buffer');
    assert.deepEqual([frame(k), frame(k)], ['poses', 'poses'], 'calm scene, both buffers persist');

    SpriteRenderer.renderDirty[2] = 1; // e.g. a tint change, landing before an even frame
    assert.equal(frame(k), 'full', 'buffer 0 takes the change');
    assert.equal(SpriteRenderer.renderDirty[2], 0);
    assert.equal(frame(k), 'full', 'buffer 1 still holds the old tint: it must not reuse it');
    assert.deepEqual([frame(k), frame(k)], ['poses', 'poses']);
  } finally {
    k.persist.restore();
    Layer.reset();
  }
});

test('a change landing before an odd frame is handled the same way', async () => {
  const k = await setup();
  try {
    frame(k);
    frame(k);
    frame(k); // buffer 0 persists; next is buffer 1
    SpriteRenderer.renderDirty[1] = 1;
    assert.equal(frame(k), 'full', 'buffer 1 takes the change');
    assert.equal(frame(k), 'full', 'buffer 0 is now behind');
    assert.deepEqual([frame(k), frame(k)], ['poses', 'poses']);
  } finally {
    k.persist.restore();
    Layer.reset();
  }
});

test('a frame or animation change misses only on the buffer that sees it', async () => {
  const k = await setup();
  try {
    frame(k);
    frame(k);
    k.w.entityFrameIndex[3] = 7;
    assert.equal(frame(k), 'full');
    assert.equal(frame(k), 'full', 'the other buffer compares its own remembered frame');
    assert.deepEqual([frame(k), frame(k)], ['poses', 'poses']);
  } finally {
    k.persist.restore();
    Layer.reset();
  }
});
