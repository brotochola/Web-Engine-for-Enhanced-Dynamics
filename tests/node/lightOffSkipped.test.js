// E-531: a light at brightness 0 is off. Its colour, its glow and its shadow's strength are all its brightness, so it
// shows nothing; pre-render now leaves it out of the shadow stamp's lights (no tile in the lamps' map, no slot of
// maxShadowCastingLights) and out of the light pass's list. A light at any other brightness is kept as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { FlashComponent } from '../../src/components/flashComponent.js';
import { Query } from '../../src/core/query.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 4;

/** Four lights on screen, all casting shadows; their brightness 1, 0, 0.25 and 2. */
function bind() {
  Transform.active = new Uint8Array(N).fill(1);
  Transform.x = new Float32Array([100, 200, 300, 400]);
  Transform.y = new Float32Array(N).fill(100);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.visualRange = new Float32Array(N);
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  LightEmitter.active.fill(1);
  LightEmitter.radius.fill(300);
  LightEmitter.castShadows.fill(1);
  LightEmitter.brightness.set([1, 0, 0.25, 2]);
  // Off the floor: a lamp at elevation 0 casts nothing into the lamps' map (N-265).
  LightEmitter.elevation.fill(40);
  FlashComponent.active = new Uint8Array(N);
}

async function withLights(fn) {
  const savedActive = Query.queryActiveEntities;
  const savedFrame = Query.queryPublishedFrame;
  Query.queryActiveEntities = () => Uint32Array.from([0, 1, 2, 3]);
  Query.queryPublishedFrame = () => 1;
  try {
    return await fn();
  } finally {
    Query.queryActiveEntities = savedActive;
    Query.queryPublishedFrame = savedFrame;
  }
}

test('a light at brightness 0 is not one of the shadow stamp\'s lights; the others keep their shade', async () => {
  bind();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await withLights(async () => {
    pre._queryLightEmitter = 1;
    pre._stampLights = Array.from({ length: N }, () => ({
      id: 0, x: NaN, y: NaN, intensity: NaN, rangeSq: NaN, sqrtI: NaN, distSq: NaN, maxShadows: 0,
    }));
    pre._frameCameraZoom = 1;
    pre._frameCameraX = 0;
    pre._frameCameraY = 0;
    pre.canvasWidth = 800;
    pre.canvasHeight = 600;
    pre._collectStampLights();
    const kept = pre._stampLights.slice(0, pre._stampLightCount);
    assert.deepEqual(kept.map((L) => L.id).sort(), [0, 2, 3]);
    const shadeOf = new Map(kept.map((L) => [L.id, L.shade]));
    assert.equal(shadeOf.get(2), 0.25, 'a dim light keeps its lighter shadow');
    assert.equal(shadeOf.get(3), 1, 'a bright one casts at full strength');
  });
});

test('a light at brightness 0 takes no slot of the light pass', async () => {
  bind();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await withLights(async () => {
    pre._queryLightEmitter = 1;
    pre.visibleLightsData = new Uint16Array(1 + N);
    pre._sortedLightEntities = new Array(N);
    pre._lightPersistScratch = new Array(N);
    pre._lightFlashScratch = new Array(N);
    pre.cameraData = null;
    pre.canvasWidth = 800;
    pre.canvasHeight = 600;
    pre.cullingRatio = 1;
    pre._collectVisibleLights();
    assert.equal(pre.visibleLightsData[0], 3);
    assert.deepEqual(Array.from(pre.visibleLightsData.subarray(1, 4)).sort(), [0, 2, 3]);
  });
});
