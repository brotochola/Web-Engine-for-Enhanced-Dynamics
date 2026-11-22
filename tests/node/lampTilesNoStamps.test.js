// OL-5: with lighting.lampShadows 'map', a lamp's tile in the lamps' map came from the ids pre-render publishes, and
// it published them only in a frame with a stamp row (a sprite caster stamped for some lamp). A scene whose only casters
// in the lamps' reach are volumes (a street of houses with nobody near) gave no lamp a tile, and the houses cast no lamp
// shadow at all. On real workers: pre-render names and orders the casting lamps without a stamp row when the lamps cast
// into their map, and only then; Pixi gives them tiles when a stamp row or a casting volume is there, and no tile with
// neither (an empty tile is read by every pixel of its lamp).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Query } from '../../src/core/query.js';
import {
  computeGpuQueueBufferSize, createGpuQueueViews, gpuQueueCaps, GPU_HDR_STAMP, GPU_HDR_STAMP_LIGHTS,
} from '../../src/render/gpuQueueLayout.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 4;
const CAST_LIGHTS = 2;

/** Three raised lamps at 300, 40 and 150 px from the view's centre (400, 300), and an entity that is no light. */
function world() {
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  for (let i = 0; i < N; i++) {
    LightEmitter.brightness[i] = 1;
    LightEmitter.resetCone(i);
  }
  Transform.active = new Uint8Array(N).fill(1);
  Transform.x = new Float32Array([700, 440, 250, 0]);
  Transform.y = new Float32Array([300, 300, 300, 0]);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.visualRange = new Float32Array(N);
  LightEmitter.active.set([1, 1, 1, 0]);
  LightEmitter.radius.set([200, 200, 200, 0]);
  LightEmitter.castShadows.set([1, 1, 1, 0]);
  LightEmitter.elevation.set([80, 80, 80, 0]);
}

function queue() {
  const caps = gpuQueueCaps(64, { enabled: true, shadowsEnabled: true, maxLights: 16, maxShadowCastingLights: CAST_LIGHTS });
  return { caps, views: createGpuQueueViews(new SharedArrayBuffer(computeGpuQueueBufferSize(caps)), caps) };
}

/** A pre-render worker ready to choose its casting lamps: the fields its init gives it from a scene with shadows. */
async function preRender(lampShadows) {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  pre.config = { ...(pre.config || {}), lighting: { lampShadows } };
  pre._lampMapCasts = lampShadows === 'map';
  pre._queryLightEmitter = 1;
  pre._stampLights = Array.from({ length: N }, () => ({
    id: 0, x: NaN, y: NaN, intensity: NaN, rangeSq: NaN, sqrtI: NaN, distSq: NaN, maxShadows: 0,
    coneDirX: NaN, coneDirYW: NaN, coneCos: NaN, coneInvSpan: NaN, invG2: NaN, shade: NaN, fade: NaN,
  }));
  pre._frameCameraZoom = 1;
  pre._frameCameraX = 0;
  pre._frameCameraY = 0;
  pre.canvasWidth = 800;
  pre.canvasHeight = 600;
  pre.maxShadowCastingLights = CAST_LIGHTS;
  return pre;
}

async function withLights(run) {
  const savedActive = Query.queryActiveEntities;
  const savedFrame = Query.queryPublishedFrame;
  Query.queryActiveEntities = () => Uint32Array.from([0, 1, 2]);
  Query.queryPublishedFrame = () => 1;
  try {
    await run();
  } finally {
    Query.queryActiveEntities = savedActive;
    Query.queryPublishedFrame = savedFrame;
  }
}

test('OL-5: with the lamps\' map, pre-render names the casting lamps in a frame with no stamp row, the nearest first', async () => {
  world();
  await withLights(async () => {
    const pre = await preRender('map');
    const { caps, views } = queue();
    pre.gpuQueueCaps = caps;
    // No sun caster: nothing to stamp.
    const stamped = pre._stampAgainstSun(views, views.sun, 0, 0, 0, 1);
    assert.equal(stamped, 0);
    const named = pre._writeStampLightIds(views, stamped);
    assert.equal(named, CAST_LIGHTS, 'as many as lighting.maxShadowCastingLights keeps');
    assert.deepEqual(Array.from(views.stampLightIds.subarray(0, named)), [1, 2], 'the two nearest the view\'s centre, in order');
    // N-212: the kept ones fade towards the first light left out (300 px away): the one at 150 px is whole, as the nearest.
    assert.equal(views.stampLightFade[0], 1);
    assert.equal(views.stampLightFade[1], 1);
  });
});

test('OL-5: a lamp near the cut fades in a frame with no stamp row too', async () => {
  world();
  // The second nearest at 280 px, the first left out at 300: inside the band of 60 px before the cut.
  Transform.x[2] = 120;
  await withLights(async () => {
    const pre = await preRender('map');
    const { caps, views } = queue();
    pre.gpuQueueCaps = caps;
    const named = pre._writeStampLightIds(views, pre._stampAgainstSun(views, views.sun, 0, 0, 0, 1));
    assert.equal(named, CAST_LIGHTS);
    assert.deepEqual(Array.from(views.stampLightIds.subarray(0, named)), [1, 2]);
    assert.equal(views.stampLightFade[0], 1);
    assert.ok(Math.abs(views.stampLightFade[1] - 20 / 60) < 1e-5, `fade ${views.stampLightFade[1]}`);
  });
});

test('OL-5: with the shadows\' layer, a frame with no stamp row names no lamp, as before', async () => {
  world();
  await withLights(async () => {
    const pre = await preRender('layer');
    const { caps, views } = queue();
    pre.gpuQueueCaps = caps;
    const stamped = pre._stampAgainstSun(views, views.sun, 0, 0, 0, 1);
    assert.equal(pre._writeStampLightIds(views, stamped), 0);
    // And with a stamp row it names them, in either mode.
    assert.equal(pre._writeStampLightIds(views, 1), CAST_LIGHTS);
  });
});

test('OL-5: Pixi gives the named lamps tiles for a stamp row or a casting volume, and none with neither', async () => {
  world();
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const { views: gpu } = queue();
  gpu.stampLightIds[0] = 1;
  gpu.stampLightIds[1] = 2;
  gpu.stampLightFade[0] = 1;
  gpu.stampLightFade[1] = 1;
  gpu.header[GPU_HDR_STAMP_LIGHTS] = 2;
  px._gpuQueueRead = gpu;
  px._groundInvScaleY = 1;
  px._uploadLampTiles = () => {};

  // No stamp row and no volume: nothing would be drawn into a tile.
  px._readLampTiles();
  assert.equal(px._lampTileCount, 0);
  assert.equal(px._lampTileOf[1], -1);
  assert.equal(px._lampTileOf[2], -1);

  // A volumes' layer with triangles (a house): each named lamp takes its tile, in pre-render's order.
  const volumes = { sunProjected: true, uvFillBatch: { geometry: { instanceCount: 1 } } };
  px.customLayers.list = [volumes];
  px._readLampTiles();
  assert.equal(px._lampTileCount, 2);
  assert.equal(px._lampTileOf[1], 0);
  assert.equal(px._lampTileOf[2], 1);
  assert.equal(px._lampTileOf[0], -1, 'the lamp past the cut has none');

  // The layer empty again (the houses left the view): the tiles go.
  volumes.uvFillBatch.geometry.instanceCount = 0;
  px._readLampTiles();
  assert.equal(px._lampTileCount, 0);
  assert.equal(px._lampTileOf[1], -1);

  // A stamp row alone, as ever.
  gpu.header[GPU_HDR_STAMP] = 3;
  px._readLampTiles();
  assert.equal(px._lampTileCount, 2);
  assert.equal(px._lampTileOf[2], 1);
});
