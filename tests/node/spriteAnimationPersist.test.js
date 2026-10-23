import test from 'node:test';
import assert from 'node:assert/strict';

import { bindPoseColumns, coreComponentData, initWorker, loadWorker } from '../bench/workerHarness.mjs';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';
import { computeBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../../src/render/renderQueueLayout.js';

// A persist frame (the sprite rows, their frames and animation states as this queue buffer last
// emitted them, nothing render-dirty) rewrites only the poses, and skipped the sprite rows in the
// full emit, the only place animations advanced. In a scene whose rows held still, every sprite
// animation stopped on the frame it showed when the persist path took over.

const N = 2;

function renderQueuePayload(maxItems) {
  const bytes = computeBufferSize(maxItems);
  return {
    maxItems,
    sync: new SharedArrayBuffer(8),
    dataA: new SharedArrayBuffer(bytes),
    dataB: new SharedArrayBuffer(bytes),
    cameraA: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
    cameraB: new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES),
    entityTextureData: new SharedArrayBuffer(maxItems * 2),
  };
}

test('an animated sprite keeps animating in a scene where nothing else changes', async () => {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    const w = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    const componentData = coreComponentData(N);
    await initWorker(w, {
      config: { worldWidth: 1000, worldHeight: 1000, preRender: { interpolation: false } },
      globalEntityCount: N,
      buffers: { componentData },
      extra: { renderQueue: renderQueuePayload(8) },
    });
    for (const C of [Transform, SpriteRenderer]) C.initializeArrays(componentData[C.name], N);
    bindPoseColumns(N);
    // One sheet (id 1) with one 4-frame animation; textures 0..3, 16 px.
    w.proxyToGlobalAnim = [null, [0]];
    w.animationFrameStart = [0];
    w.animationFrameCount = [4];
    w.frameWidth = new Uint16Array(4).fill(16);
    w.frameHeight = new Uint16Array(4).fill(16);

    Transform.active[0] = 1;
    Transform.x[0] = 100;
    Transform.y[0] = 100;
    Transform.rotC[0] = 1;
    SpriteRenderer.active[0] = 1;
    SpriteRenderer.spritesheetId[0] = 1;
    SpriteRenderer.animationState[0] = 0;
    SpriteRenderer.isAnimated[0] = 1;
    SpriteRenderer.loop[0] = 1;
    SpriteRenderer.animationSpeed[0] = 0.25; // a frame every 4 ticks of 1/60 s
    SpriteRenderer.scaleX[0] = 1;
    SpriteRenderer.scaleY[0] = 1;
    SpriteRenderer.alpha[0] = 1;
    SpriteRenderer.anchorX[0] = 0.5;
    SpriteRenderer.anchorY[0] = 0.5;

    const seen = new Set();
    let frame = w.entityFrameIndex[0];
    let gen = w._staticGen;
    for (let f = 0; f < 60; f++) {
      w._renderableCount = 0;
      w._bindCollectPoses();
      w.collectRenderable(0, 0);
      w.buildRenderQueue(1000 / 60);
      seen.add(w.entityFrameIndex[0]);
      assert.equal(w.renderQueueTextureId[0], w.entityFrameIndex[0], `tick ${f}: the queue shows the current frame`);
      // A new frame is a new texture, a static column: Pixi re-uploads the statics (E-82).
      if (w.entityFrameIndex[0] !== frame) assert.notEqual(w._staticGen, gen, `tick ${f}: staticGen moved`);
      frame = w.entityFrameIndex[0];
      gen = w._staticGen;
      w._queueBuf ^= 1;
    }
    assert.equal(seen.size, 4, `a second at 15 frames a second shows every frame; saw ${[...seen]}`);
  } finally {
    Layer.reset();
  }
});

// E-98b. A persist frame of sprites only skips the emit loop, which would only count the rows: the
// count it publishes and the poses _writeType0PosesOnly wrote must be what the loop gave.
// E-98d. With no Adobe root the collect writes poses straight into the queue; with one, into the
// stash the emit copies from. Both arrangements must publish the same queue.
for (const adobe of [null, [N + 7]]) test(`a persist frame of sprites only publishes every row and its pose (${adobe ? 'stash' : 'poses in the queue'})`, async () => {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    const w = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    const componentData = coreComponentData(N);
    await initWorker(w, {
      config: { worldWidth: 1000, worldHeight: 1000, preRender: { interpolation: false } },
      globalEntityCount: N,
      buffers: { componentData },
      extra: { renderQueue: renderQueuePayload(8) },
    });
    for (const C of [Transform, SpriteRenderer]) C.initializeArrays(componentData[C.name], N);
    bindPoseColumns(N);
    w.proxyToGlobalAnim = [null, [0]];
    w.animationFrameStart = [0];
    w.animationFrameCount = [1];
    w.frameWidth = new Uint16Array(1).fill(16);
    w.frameHeight = new Uint16Array(1).fill(16);
    for (let e = 0; e < N; e++) {
      Transform.active[e] = 1;
      Transform.rotC[e] = 1;
      SpriteRenderer.active[e] = 1;
      SpriteRenderer.spritesheetId[e] = 1;
      SpriteRenderer.scaleX[e] = 1;
      SpriteRenderer.scaleY[e] = 1;
      SpriteRenderer.alpha[e] = 1;
    }
    const hit = w._type0PersistHit;
    let hits = 0;
    w._type0PersistHit = function (...args) {
      const h = hit.apply(this, args);
      if (h) hits++;
      return h;
    };
    for (let f = 0; f < 6; f++) {
      for (let e = 0; e < N; e++) {
        Transform.x[e] = 10 * e + f;
        Transform.y[e] = 5 * e;
      }
      w._renderableCount = 0;
      w._frameAdobeEntities = adobe;
      w._bindCollectPoses();
      assert.equal(w._collectPx === w.renderQueueX, adobe === null, 'where the collect writes poses');
      for (let e = 0; e < N; e++) w.collectRenderable(0, e);
      w.buildRenderQueue(1000 / 60);
      assert.equal(w.renderQueueCount[0], N, `frame ${f}: every row published`);
      for (let e = 0; e < N; e++) assert.equal(w.renderQueueX[e], 10 * e + f, `frame ${f}: row ${e} pose`);
      w._queueBuf ^= 1;
    }
    delete w._type0PersistHit; // the shared worker gets its own method back
    assert.equal(hits, 4, 'frames 2 to 5 were persist frames');
  } finally {
    Layer.reset();
  }
});

// E-102b. Rows only clear the tile columns once a repeating sprite has written this queue's: a row
// that held one must be back to zero when a plain sprite takes it.
test('a row a repeating sprite left is cleared when a plain sprite takes it', async () => {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    const w = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    const componentData = coreComponentData(N);
    await initWorker(w, {
      config: { worldWidth: 1000, worldHeight: 1000, preRender: { interpolation: false } },
      globalEntityCount: N,
      buffers: { componentData },
      extra: { renderQueue: renderQueuePayload(8) },
    });
    for (const C of [Transform, SpriteRenderer]) C.initializeArrays(componentData[C.name], N);
    bindPoseColumns(N);
    w.proxyToGlobalAnim = [null, [0]];
    w.animationFrameStart = [0];
    w.animationFrameCount = [1];
    w.frameWidth = new Uint16Array(1).fill(16);
    w.frameHeight = new Uint16Array(1).fill(16);
    Transform.active[0] = 1;
    Transform.rotC[0] = 1;
    SpriteRenderer.active[0] = 1;
    SpriteRenderer.spritesheetId[0] = 1;
    SpriteRenderer.scaleX[0] = 1;
    SpriteRenderer.scaleY[0] = 1;
    SpriteRenderer.alpha[0] = 1;
    SpriteRenderer.repeatX[0] = 32;
    SpriteRenderer.repeatY[0] = 16;
    const frame = () => {
      SpriteRenderer.renderDirty[0] = 1; // a full emit every frame
      w._renderableCount = 0;
      w._frameAdobeEntities = null;
      w._bindCollectPoses();
      w.collectRenderable(0, 0);
      w.buildRenderQueue(1000 / 60);
    };
    for (let f = 0; f < 2; f++) {
      frame();
      assert.ok(w.renderQueueTileMulX[0] > 0, `frame ${f}: the repeating sprite's row tiles`);
      w._queueBuf ^= 1;
    }
    SpriteRenderer.repeatX[0] = 0;
    SpriteRenderer.repeatY[0] = 0;
    for (let f = 2; f < 4; f++) {
      frame();
      assert.equal(w.renderQueueTileMulX[0], 0, `frame ${f}: the plain sprite's row stretches`);
      assert.equal(w.renderQueueTileMulY[0], 0);
      assert.equal(w.renderQueueRepeatX[0], 0);
      w._queueBuf ^= 1;
    }
  } finally {
    Layer.reset();
  }
});
