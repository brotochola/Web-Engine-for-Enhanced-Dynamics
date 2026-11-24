import test from 'node:test';
import assert from 'node:assert/strict';

import { bootEmitWorker, countPersistHits } from '../helpers/preRenderEmitBoot.mjs';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';
import { PIXI_KEYED_HEADER } from '../../src/util/wasmMemoryMap.js';

// N-459: logic writes the sprites' statics while pre-render works. On a persist frame the walk reads renderDirty first and
// the keyed marks are taken after it; a setter between the two has its keyed mark taken with the queue row still holding
// the old statics, so Pixi's texture gets those. The next frame misses on renderDirty and emits the new statics, but
// nothing marked the row any more: once Pixi had drawn the frame between, the new ones were never sent.

const N = 4;
const KEY_CHANGED = 0x80000000;

async function setup() {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  const { worker: w } = await bootEmitWorker(N, { keyed: true, config: { debug: { checks: false } } });
  for (let e = 0; e < N; e++) {
    Transform.active[e] = 1;
    Transform.x[e] = 10 * e;
    Transform.rotC[e] = 1;
    SpriteRenderer.active[e] = 1;
    SpriteRenderer.spritesheetId[e] = 0;
    SpriteRenderer.scaleX[e] = 1;
    SpriteRenderer.scaleY[e] = 1;
    SpriteRenderer.alpha[e] = 1;
  }
  return w;
}

/** One frame of pre-render's, Pixi having drawn the one before; Pixi's statics texture takes the marked rows' alpha. */
function frame(w, texture) {
  Atomics.store(w._keyedHeader, PIXI_KEYED_HEADER.DRAWN, w.renderQueueFrame >>> 0);
  w.selectWriteBuffers();
  w._renderableCount = 0;
  w._bindCollectPoses();
  for (let e = 0; e < N; e++) w.collectRenderable(0, e);
  w.buildRenderQueue(1000 / 60);
  for (let r = 0; r < N; r++) {
    const key = w.renderQueueKey[r] >>> 0;
    if (key >= KEY_CHANGED) texture[key & 0x3fffffff] = w.renderQueueAlpha[r];
  }
  w.renderQueueFrame++;
  w._queueBuf ^= 1;
}

test('N-459: a statics change whose keyed mark a persist frame took before it saw renderDirty reaches the texture', async () => {
  const w = await setup();
  const persist = countPersistHits(w);
  const texture = new Float32Array(N);
  try {
    for (let f = 0; f < 6; f++) frame(w, texture);
    assert.deepEqual([...texture], [1, 1, 1, 1]);
    assert.ok(persist.hits > 0, 'the scene persists');
    // The setter lands after the walk read entity 2's renderDirty and before the frame takes the keyed marks: in this
    // frame, for the kernel, the keyed mark alone.
    const hits = persist.hits;
    SpriteRenderer.alpha[2] = 0.25;
    SpriteRenderer.keyedDirty[2] = 1;
    frame(w, texture);
    assert.equal(persist.hits, hits + 1, 'a persist frame');
    SpriteRenderer.renderDirty[2] = 1;
    for (let f = 0; f < 4; f++) frame(w, texture);
    assert.deepEqual([...texture], [1, 1, 0.25, 1]);
  } finally {
    persist.restore();
    Layer.reset();
  }
});
