// DX-LIGHTOFFSET on a real Pixi worker: a light's offset turns with its entity and lands in the light data, with
// height on top. The kernel's glow rows are held to the JS by preRenderEmitWasm.test.js, offsets included.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { lightDataTextureFloatCount } from '../../src/util/utils.js';
import { loadWorker } from '../bench/workerHarness.mjs';
import { Collider } from '../../src/components/collider.js';

const N = 8;
const MAX_LIGHTS = 4;

function bind() {
  Transform.active = new Uint8Array(N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.visualRange = new Float32Array(N);
  LightEmitter.active = new Uint8Array(N);
  LightEmitter.lightColor = new Uint32Array(N);
  LightEmitter.lightIntensity = new Float32Array(N);
  LightEmitter.sqrtLightIntensity = new Float32Array(N);
  LightEmitter.height = new Float32Array(N);
  LightEmitter.sourceHeight = new Float32Array(N);
  LightEmitter.offsetX = new Float32Array(N);
  LightEmitter.offsetY = new Float32Array(N);
}

function light(e, x, y, rotation, offsetX, offsetY, height = 0) {
  Transform.active[e] = 1;
  Transform.x[e] = x;
  Transform.y[e] = y;
  Transform.rotC[e] = Math.cos(rotation);
  Transform.rotS[e] = Math.sin(rotation);
  LightEmitter.active[e] = 1;
  LightEmitter.lightColor[e] = 0xffffff;
  LightEmitter.lightIntensity[e] = 1000;
  LightEmitter.sqrtLightIntensity[e] = Math.sqrt(1000);
  LightEmitter.height[e] = height;
  LightEmitter.offsetX[e] = offsetX;
  LightEmitter.offsetY[e] = offsetY;
}

async function uploaded(lights) {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.lightingEnabled = true;
  px._groundScaleY = 1;
  px._groundInvScaleY = 1;
  px.maxLights = MAX_LIGHTS;
  px._lightDataFloats = new Float32Array(lightDataTextureFloatCount(MAX_LIGHTS));
  px._lightDataSource = null;
  px._visibleLightsAll = lights.map((entityId) => ({ entityId, distSq: 0 }));
  px._visibleLightsAllCount = lights.length;
  px._stampLightCamera = () => {};
  px._applyLightingViewport = () => {};
  px.lightingShader = { resources: { uniforms: { uniforms: { uLightCount: 0 }, update() {} } } };
  px.updateLighting();
  return px._lightDataFloats;
}

test('an offset of (10, 0) on an entity turned 90 degrees lands 10 px down from it', async () => {
  bind();
  light(0, 100, 200, Math.PI / 2, 10, 0);
  const d = await uploaded([0]);
  assert.ok(Math.abs(d[0] - 100) < 1e-4);
  assert.ok(Math.abs(d[1] - 210) < 1e-4);
});

test('an offset of (0, 10) turns the other way, and height lifts the result', async () => {
  bind();
  light(0, 100, 200, Math.PI / 2, 0, 10, 4);
  const d = await uploaded([0]);
  assert.ok(Math.abs(d[0] - 90) < 1e-4);
  assert.ok(Math.abs(d[1] - 196) < 1e-4);
});

test('offset 0 leaves the entity position exactly, whatever its rotation', async () => {
  bind();
  light(0, 100.25, 200.5, 1.2345, 0, 0, 7);
  const d = await uploaded([0]);
  assert.equal(d[0], Math.fround(100.25));
  assert.equal(d[1], Math.fround(193.5));
});

test('an unturned entity adds the offset as it is', async () => {
  bind();
  light(0, 100, 200, 0, 12, -5);
  const d = await uploaded([0]);
  assert.equal(d[0], 112);
  assert.equal(d[1], 195);
});
