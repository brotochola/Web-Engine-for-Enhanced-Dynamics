// DX-LIGHTAPI A5 (N-150) on a real pre-render worker: a light's glow is culled by its own size (0.85 of its radius), so
// a big glow on a light whose entity is off screen is still drawn where it reaches the view.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { FlashComponent } from '../../src/components/flashComponent.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Query } from '../../src/core/query.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 6;

function bind(xs, ys) {
  Transform.active = new Uint8Array(N).fill(1);
  Transform.x = new Float32Array(xs);
  Transform.y = new Float32Array(ys);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.visualRange = new Float32Array(N);
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  LightEmitter.active.fill(1);
  LightEmitter.radius.fill(100);
  FlashComponent.active = new Uint8Array(N);
}

async function withLights(ids, fn) {
  const savedActive = Query.queryActiveEntities;
  const savedFrame = Query.queryPublishedFrame;
  Query.queryActiveEntities = () => Uint32Array.from(ids);
  Query.queryPublishedFrame = () => 1;
  try {
    return await fn();
  } finally {
    Query.queryActiveEntities = savedActive;
    Query.queryPublishedFrame = savedFrame;
  }
}

test('N-150: a light whose entity is off screen still has its glow collected when the glow reaches the view', async () => {
  // Light 0 is 300 px left of a 0..800 view with a radius of 1000: its glow (850 px) covers the view. Light 1 is as far
  // with a radius of 100 (85 px): its glow does not reach.
  bind([-300, -300, 0, 0, 0, 0], [300, 300, 0, 0, 0, 0]);
  LightEmitter.radius.set([1000, 100]);
  LightEmitter.glow.set([0.5, 0.5]);
  LightEmitter.active.set([1, 1, 0, 0, 0, 0]);
  const savedHalfW = SpriteRenderer.boundsHalfW;
  const savedHalfH = SpriteRenderer.boundsHalfH;
  SpriteRenderer.boundsHalfW = new Float32Array(N).fill(8);
  SpriteRenderer.boundsHalfH = new Float32Array(N).fill(8);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const collected = [];
  try {
    await withLights([0, 1], async () => {
      pre._queryLightEmitter = 1;
      pre.config = { lighting: { lightGlow: 'add' } };
      pre.skipCull = false;
      pre.collectRenderable = (type, i) => collected.push([type, i]);
      pre._collectEntityGlowRows(Transform.x, Transform.y, 1, 0, 0, 0, 800, 0, 600);
    });
  } finally {
    SpriteRenderer.boundsHalfW = savedHalfW;
    SpriteRenderer.boundsHalfH = savedHalfH;
  }
  assert.deepEqual(collected, [[3, 0]]);
});
