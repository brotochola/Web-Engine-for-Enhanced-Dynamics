import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Collider } from '../../src/components/collider.js';
import { Layer } from '../../src/core/layer.js';

// E-98c. The sprite collect sends a sprite with no layer mask straight to the entities collector,
// past collectRenderable's type dispatch and bit scan. That has to be where collectRenderable
// itself would have sent it, and a masked sprite still goes through collectRenderable.

const N = 6;

function setup(pre) {
  Transform.x = new Float32Array(N).map((_, i) => 100 + i);
  Transform.y = new Float32Array(N).fill(100);
  Transform.active = new Uint8Array(N).fill(1);
  SpriteRenderer.active = new Uint8Array(N).fill(1);
  SpriteRenderer.renderVisible = new Uint8Array(N).fill(1);
  SpriteRenderer.spritesheetId = new Uint16Array(N).fill(1);
  SpriteRenderer.boundsHalfW = new Float32Array(N).fill(4);
  SpriteRenderer.boundsHalfH = new Float32Array(N).fill(4);
  SpriteRenderer.layerMask = new Uint16Array(N);
  Collider.visualRange = new Float32Array(N);
  pre.globalEntityCount = N;
  pre.cameraData = {};
  pre._querySpriteRenderer = null;
  pre.canvasWidth = 1280;
  pre.canvasHeight = 720;
  pre.cullingRatio = 0.05;
  pre.skipCull = true;
  pre._frameCameraZoom = 1;
  pre._frameCameraX = 640;
  pre._frameCameraY = 360;
  pre._frameCameraRot = 0;
  pre.visibleEntitiesCount = 0;
  pre.renderQueueEnabled = true;
  pre._collectEntityGlow = () => {};
}

test('an unmasked sprite goes where collectRenderable sends it; a masked one through it', async () => {
  Layer.reset();
  Layer.initializeFromConfig({ fx: {} }, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const realCollect = pre.collectRenderable;
  const realWrite = pre._writeRenderable;
  try {
    setup(pre);
    const fx = Layer.get('fx').id;
    SpriteRenderer.layerMask[2] = 1 << fx;
    SpriteRenderer.layerMask[4] = (1 << fx) | Layer.entitiesMask();
    const writes = [];
    const generic = [];
    pre._writeRenderable = (type, i, layerId) => writes.push([type, i, layerId]);
    pre.collectRenderable = (type, i) => {
      generic.push(i);
      realCollect.call(pre, type, i);
    };
    pre.collectVisibleEntities();
    assert.deepEqual(generic, [2, 4], 'only the masked sprites take the generic path');
    const direct = writes.filter(([, i]) => i !== 2 && i !== 4);
    assert.deepEqual(direct, [0, 1, 3, 5].map((i) => [0, i, Layer.entitiesId]));
    assert.deepEqual(writes.filter(([, i]) => i === 4).map(([, , l]) => l).sort(), [Layer.entitiesId, fx].sort());

    // The generic path, for an unmasked sprite, picks the same collector the shortcut does.
    writes.length = 0;
    realCollect.call(pre, 0, 1);
    assert.deepEqual(writes, [[0, 1, Layer.entitiesId]]);
  } finally {
    delete pre.collectRenderable;
    delete pre._writeRenderable;
    if (pre.collectRenderable !== realCollect || pre._writeRenderable !== realWrite) throw new Error('worker not restored');
    Layer.reset();
  }
});
