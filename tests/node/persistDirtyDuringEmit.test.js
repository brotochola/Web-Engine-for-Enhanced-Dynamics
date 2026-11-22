import test from 'node:test';
import assert from 'node:assert/strict';

import { bootEmitWorker, countPersistHits } from '../helpers/preRenderEmitBoot.mjs';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';

// Logic writes the sprites' statics while pre-render emits them (the workers run side by side). A setter that lands after
// the full emit read its sprite's row and before the emit's end, which clears renderDirty (persist_remember), loses its
// mark: the buffer that emitted keeps the old value on its persist frames while the other buffer, due a full emit, draws
// the new one.

const N = 4;

async function setup() {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  const { worker: w } = await bootEmitWorker(N, { config: { debug: { checks: false } } });
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

/** One frame of pre-render's; the alpha its queue buffer holds for entity 2 (row 2: the collector's order). */
function frame(w) {
  w.selectWriteBuffers();
  w._renderableCount = 0;
  w._bindCollectPoses();
  for (let e = 0; e < N; e++) w.collectRenderable(0, e);
  w.buildRenderQueue(1000 / 60);
  const alpha = w.renderQueueAlpha[2];
  w._queueBuf ^= 1;
  return alpha;
}

test('a statics change marked while the emit runs is drawn by both queue buffers', async () => {
  const w = await setup();
  const persist = countPersistHits(w);
  const b = w._emitWasm;
  const emitRows = b.emitRows;
  let duringEmit = null;
  b.emitRows = (...args) => {
    const written = emitRows(...args);
    if (duringEmit !== null) {
      duringEmit();
      duringEmit = null;
    }
    return written;
  };
  try {
    for (let f = 0; f < 4; f++) frame(w);
    // Something else changes (a full emit this frame), and entity 2's alpha is set by a setter during that emit.
    SpriteRenderer.alpha[0] = 0.5;
    SpriteRenderer.renderDirty[0] = 1;
    SpriteRenderer.keyedDirty[0] = 1;
    duringEmit = () => {
      SpriteRenderer.alpha[2] = 0.25;
      SpriteRenderer.renderDirty[2] = 1;
      SpriteRenderer.keyedDirty[2] = 1;
    };
    const first = frame(w);
    assert.equal(first, 1, 'the emit read the row before the setter');
    const after = [];
    for (let f = 0; f < 6; f++) after.push(frame(w));
    assert.ok(persist.hits > 0, 'the scene persists again');
    assert.deepEqual(after, after.map(() => 0.25), `every frame after the change draws it: ${after.join(' ')}`);
  } finally {
    b.emitRows = emitRows;
    persist.restore();
    Layer.reset();
  }
});
