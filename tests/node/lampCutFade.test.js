// N-212: a lamp near the cut of maxShadowCastingLights fades its map shadow too. Pre-render publishes each stamp light's
// fade beside its id (the GPU queue's stampLightFade); a real Pixi worker reads it with the lamp's tile and writes it in
// the light data's fourth row (1 for every other light), which lightingBasic's lampVisibility takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { lightDataTextureFloatCount } from '../../src/util/utils.js';
import { computeGpuQueueBufferSize, createGpuQueueViews, gpuQueueCaps, GPU_HDR_STAMP_LIGHTS } from '../../src/render/gpuQueueLayout.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 4;
const MAX_LIGHTS = 4;

function world() {
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  for (let i = 0; i < N; i++) {
    LightEmitter.brightness[i] = 1;
    LightEmitter.resetCone(i);
  }
  Transform.active = new Uint8Array(N).fill(1);
  Transform.x = new Float32Array([100, 300, 0, 0]);
  Transform.y = new Float32Array([100, 300, 0, 0]);
  Transform.rotC = new Float32Array([1, 1, 1, 1]);
  Transform.rotS = new Float32Array(N);
  Collider.visualRange = new Float32Array(N);
  LightEmitter.active.fill(1);
  LightEmitter.radius.set([400, 400, 0, 0]);
  LightEmitter.color.set([0xffffff, 0xffffff, 0, 0]);
  // Both raised (a lamp needs a height for a tile's tag).
  LightEmitter.elevation.set([80, 80, 0, 0]);
}

test('N-212: the GPU queue holds a fade a stamp light, after every other region', () => {
  const caps = gpuQueueCaps(64, { enabled: true, shadowsEnabled: true, maxLights: 16, maxShadowCastingLights: 8 });
  const bytes = computeGpuQueueBufferSize(caps);
  const views = createGpuQueueViews(new SharedArrayBuffer(bytes), caps);
  assert.equal(views.stampLightFade.length, 8);
  assert.equal(views.byteLength, bytes);
  const fadeEnd = views.stampLightFade.byteOffset + views.stampLightFade.byteLength;
  assert.equal(fadeEnd, bytes, 'last, so the regions before it stay where they were');
});

test('N-212: Pixi writes a lamp\'s fade in its fourth row, 1 for a light without a tile', async () => {
  world();
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.lightingEnabled = true;
  px._groundScaleY = 1;
  px._groundInvScaleY = 1;
  px.maxLights = MAX_LIGHTS;
  px._faceIdsOn = false;
  // Pre-render's stamp lights this frame: light 1 has tile 0 and fades at 0.25.
  const caps = gpuQueueCaps(64, { enabled: true, shadowsEnabled: true, maxLights: 16, maxShadowCastingLights: 4 });
  const gpu = createGpuQueueViews(new SharedArrayBuffer(computeGpuQueueBufferSize(caps)), caps);
  gpu.stampLightIds[0] = 1;
  gpu.stampLightFade[0] = 0.25;
  gpu.header[GPU_HDR_STAMP_LIGHTS] = 1;
  px._gpuQueueRead = gpu;
  px._uploadLampTiles = () => {};
  px._readLampTiles();
  assert.equal(px._lampTileOf[1], 0);
  assert.equal(px._lampFadeOf[1], 0.25);
  assert.equal(px._lampFadeOf[0], 1);

  px._lightDataFloats = new Float32Array(lightDataTextureFloatCount(MAX_LIGHTS));
  px._lightDataSource = null;
  px._visibleLightsAll = [{ entityId: 0, distSq: 0 }, { entityId: 1, distSq: 0 }];
  px._visibleLightsAllCount = 2;
  px._stampLightCamera = () => {};
  px._applyLightingViewport = () => {};
  px.lightingShader = { resources: { uniforms: { uniforms: { uLightCount: 0, uConeCount: 0 }, update() {} } } };
  px.updateLighting();
  const d = px._lightDataFloats;
  const slotOf = (x) => (d[0] === x ? 0 : 1);
  const lamp = slotOf(300);
  const plain = 1 - lamp;
  assert.equal(d[lamp * 4 + 3], -1, 'the lamp\'s tag: -(tile + 1)');
  assert.equal(d[MAX_LIGHTS * 12 + lamp * 4], 0.25, 'its fade in the fourth row');
  assert.equal(d[MAX_LIGHTS * 12 + plain * 4], 1, 'a light without a tile: 1');

  // The next frame, the lamp out of the cut's band: back to 1.
  gpu.stampLightFade[0] = 1;
  px._readLampTiles();
  px.updateLighting();
  assert.equal(d[MAX_LIGHTS * 12 + lamp * 4], 1);
});

test('N-212: a light that loses its tile goes back to fade 1', async () => {
  world();
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const caps = gpuQueueCaps(64, { enabled: true, shadowsEnabled: true, maxLights: 16, maxShadowCastingLights: 4 });
  const gpu = createGpuQueueViews(new SharedArrayBuffer(computeGpuQueueBufferSize(caps)), caps);
  gpu.stampLightIds[0] = 1;
  gpu.stampLightFade[0] = 0.5;
  gpu.header[GPU_HDR_STAMP_LIGHTS] = 1;
  px._gpuQueueRead = gpu;
  px._uploadLampTiles = () => {};
  px._readLampTiles();
  assert.equal(px._lampFadeOf[1], 0.5);
  gpu.stampLightIds[0] = 0;
  gpu.stampLightFade[0] = 0.75;
  px._readLampTiles();
  assert.equal(px._lampTileOf[1], -1);
  assert.equal(px._lampFadeOf[1], 1);
  assert.equal(px._lampFadeOf[0], 0.75);
});
