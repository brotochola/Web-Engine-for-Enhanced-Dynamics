import test from 'node:test';
import assert from 'node:assert/strict';

import { bootEmitWorker, countPersistHits, oneAnimationMetadata } from '../helpers/preRenderEmitBoot.mjs';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';

// A persist frame (the sprite rows, their frames and animation states as this queue buffer last
// emitted them, nothing render-dirty) rewrites only the poses, and skipped the sprite rows in the
// full emit, the only place animations advanced. In a scene whose rows held still, every sprite
// animation stopped on the frame it showed when the persist path took over.

const N = 2;


test('an animated sprite keeps animating in a scene where nothing else changes', async () => {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    // One sheet (id 1) with one 4-frame animation; textures 0..3, 16 px.
    const { worker: w } = await bootEmitWorker(N, { textureMetadata: oneAnimationMetadata(4) });

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
// count it publishes and the poses the persist pass wrote must be what the loop gave.
// E-98d. With no Adobe root the collect writes poses straight into the queue; with one, into the
// stash the emit copies from. Both arrangements must publish the same queue.
for (const adobe of [null, [N + 7]]) test(`a persist frame of sprites only publishes every row and its pose (${adobe ? 'stash' : 'poses in the queue'})`, async () => {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    // The stash is in the memory with the Adobe regions, as a scene with Adobe characters has it.
    const { worker: w } = await bootEmitWorker(N, { adobe: adobe !== null });
    for (let e = 0; e < N; e++) {
      Transform.active[e] = 1;
      Transform.rotC[e] = 1;
      SpriteRenderer.active[e] = 1;
      SpriteRenderer.spritesheetId[e] = 1;
      SpriteRenderer.scaleX[e] = 1;
      SpriteRenderer.scaleY[e] = 1;
      SpriteRenderer.alpha[e] = 1;
    }
    const persist = countPersistHits(w);
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
    persist.restore();
    assert.equal(persist.hits, 4, 'frames 2 to 5 were persist frames');
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
    const { worker: w } = await bootEmitWorker(N);
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

// E-98g. The queue's two buffers alternate. When one buffer's frame moves an animated sprite on,
// the other still shows the old frame, and its persist check used to give up: in an animated scene
// nearly every frame became a full emit. The check now gives that row the current frame instead.
test('both queue buffers show the current frame, and an animated scene keeps its persist frames', async () => {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    // One sheet with one 4-frame animation, textures 0..3: a row's texture is its frame.
    const { worker: w } = await bootEmitWorker(N, { textureMetadata: oneAnimationMetadata(4) });
    for (let e = 0; e < N; e++) {
      Transform.active[e] = 1;
      Transform.x[e] = 100 + 50 * e;
      Transform.y[e] = 100;
      Transform.rotC[e] = 1;
      SpriteRenderer.active[e] = 1;
      SpriteRenderer.spritesheetId[e] = 1;
      SpriteRenderer.animationState[e] = 0;
      SpriteRenderer.isAnimated[e] = 1;
      SpriteRenderer.loop[e] = 1;
      SpriteRenderer.scaleX[e] = 1;
      SpriteRenderer.scaleY[e] = 1;
      SpriteRenderer.alpha[e] = 1;
    }
    SpriteRenderer.animationSpeed[0] = 0.25; // a frame every 4 ticks
    SpriteRenderer.animationSpeed[1] = 1 / 3; // every 3: the two change on different ticks

    const persist = countPersistHits(w);
    const shown = [[-1, -1], [-1, -1]]; // per buffer, the texture each row last showed
    for (let f = 0; f < 60; f++) {
      const buf = w._queueBuf;
      w.selectWriteBuffers();
      const gen = w._staticGen;
      w._renderableCount = 0;
      w._bindCollectPoses();
      for (let e = 0; e < N; e++) w.collectRenderable(0, e);
      w.buildRenderQueue(1000 / 60);
      let changed = false;
      for (let e = 0; e < N; e++) {
        assert.equal(w.renderQueueTextureId[e], w.entityFrameIndex[e], `tick ${f}, buffer ${buf}: row ${e} shows the current frame`);
        if (w.renderQueueTextureId[e] !== shown[buf][e]) changed = true;
        shown[buf][e] = w.renderQueueTextureId[e];
      }
      // New textures in this buffer are new statics: Pixi re-uploads them (E-82).
      if (changed) assert.notEqual(w._staticGen, gen, `tick ${f}: staticGen moved`);
      w._queueBuf ^= 1;
    }
    // The first frame of each buffer is a full emit; every later one keeps the rows.
    persist.restore();
    assert.equal(persist.hits, 58, `persist frames: ${persist.hits} of 60`);
  } finally {
    Layer.reset();
  }
});
