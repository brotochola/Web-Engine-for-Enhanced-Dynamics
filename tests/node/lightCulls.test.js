// DX-LIGHTAPI A5 on a real pre-render worker: N-151, over lighting.maxLights the visible lights kept are the nearest
// to the view's centre (they were the top of the screen's); N-150, a light's glow is culled by its own size (0.85 of
// its radius), so a big glow on a light whose entity is off screen is still drawn where it reaches the view.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { FlashComponent } from '../../src/components/flashComponent.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Query } from '../../src/core/query.js';
import { loadWorker } from '../bench/workerHarness.mjs';
import { DECORATION_Y_SORT_SCALE, ENTITY_GLOW_SORT_BIAS } from '../../src/util/configDefaults.js';
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';

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
  LightEmitter.brightness.fill(1); // a spawned light's (resetLightEmitterRow); 0 is off (E-531)
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

test('N-151: over maxLights, the lights nearest the view\'s centre are kept, whatever their height on the screen', async () => {
  // The view is 0..800 x 0..600 (centre 400, 300). Lights 0 and 1 sit at the top of the screen, far to the sides;
  // lights 2 and 3 near the centre, lower down.
  bind([20, 780, 410, 380, 0, 0], [10, 20, 320, 280, 0, 0]);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await withLights([0, 1, 2, 3], async () => {
    pre._queryLightEmitter = 1;
    pre.visibleLightsData = new Uint16Array(3); // [count, two lights]
    pre._sortedLightEntities = new Array(2);
    pre._lightPersistScratch = new Array(4);
    pre._lightFlashScratch = new Array(4);
    pre.cameraData = null;
    pre.canvasWidth = 800;
    pre.canvasHeight = 600;
    pre.cullingRatio = 1;
    const warn = console.warn;
    console.warn = () => {};
    try {
      pre._collectVisibleLights();
    } finally {
      console.warn = warn;
    }
    assert.equal(pre.visibleLightsData[0], 2);
    assert.deepEqual(Array.from(pre.visibleLightsData.subarray(1)).sort(), [2, 3]);
  });
});

test('N-151: the nearest are measured from where the light is, its offset included, as the cull does', async () => {
  // Lights 0 and 1 sit at the view's centre's sides; light 2's entity is far off to the left, but its light is
  // 600 px ahead of it (an arm's lamp, a headlight), at the centre: it is kept, light 1 (farther) is not.
  bind([300, 600, -200, 0, 0, 0], [300, 300, 300, 0, 0, 0]);
  LightEmitter.offsetX[2] = 600;
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await withLights([0, 1, 2], async () => {
    pre._queryLightEmitter = 1;
    pre.visibleLightsData = new Uint16Array(3);
    pre._sortedLightEntities = new Array(2);
    pre._lightPersistScratch = new Array(4);
    pre._lightFlashScratch = new Array(4);
    pre.cameraData = null;
    pre.canvasWidth = 800;
    pre.canvasHeight = 600;
    pre.cullingRatio = 1;
    const warn = console.warn;
    console.warn = () => {};
    try {
      pre._collectVisibleLights();
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(Array.from(pre.visibleLightsData.subarray(1)).sort(), [0, 2]);
  });
});

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

test("DX-GLOWRADIUS: a halo sorts right after its entity's sprite, on the sprite's own sort line", async () => {
  // Entity 0 has a sprite anchored above its foot (anchorY 0.75 of a 64 px frame): it sorts 16 px below its pose, so a
  // halo on the pose drew under it. Entity 1 has no sprite: its halo sorts on its pose.
  bind([100, 200, 0, 0, 0, 0], [300, 300, 0, 0, 0, 0]);
  const names = ['active', 'anchorX', 'anchorY', 'scaleX', 'scaleY', 'inheritTransformRotation', 'spriteRotC', 'spriteRotS'];
  const saved = names.map((name) => SpriteRenderer[name]);
  SpriteRenderer.active = Uint8Array.of(1, 0, 0, 0, 0, 0);
  SpriteRenderer.anchorX = new Float32Array(N).fill(0.5);
  SpriteRenderer.anchorY = Float32Array.of(0.75, 1, 1, 1, 1, 1);
  SpriteRenderer.scaleX = new Float32Array(N).fill(1);
  SpriteRenderer.scaleY = new Float32Array(N).fill(1);
  SpriteRenderer.inheritTransformRotation = new Uint8Array(N).fill(1);
  SpriteRenderer.spriteRotC = new Float32Array(N).fill(1);
  SpriteRenderer.spriteRotS = new Float32Array(N);
  try {
    const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    pre._spriteSortArrays = null;
    pre._displayPose = (i, out) => {
      out[0] = Transform.x[i];
      out[1] = Transform.y[i];
      out[2] = 1;
      out[3] = 0;
    };
    pre._entityTextureIdOrResolve = () => 0;
    pre.frameWidth = Float32Array.of(32);
    pre.frameHeight = Float32Array.of(64);
    const halo = new Float64Array(1);
    const sprite = new Float64Array(1);
    pre._storeGlowSortY(0, halo);
    pre._storeEntitySortY(0, 0, Float64Array.of(100, 300, 1, 0), sprite, 0);
    assert.equal(sprite[0], spriteYSortKey(316, DECORATION_Y_SORT_SCALE), "the sprite's line: its picture's bottom edge");
    assert.equal(halo[0], sprite[0] + ENTITY_GLOW_SORT_BIAS, 'its halo right after it');
    pre._storeGlowSortY(1, halo);
    assert.equal(halo[0], spriteYSortKey(300, DECORATION_Y_SORT_SCALE) + ENTITY_GLOW_SORT_BIAS, 'no sprite: its pose');
  } finally {
    names.forEach((name, k) => { SpriteRenderer[name] = saved[k]; });
  }
});
