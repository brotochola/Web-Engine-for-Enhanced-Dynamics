// LightEmitter.sourceHeight on a real Pixi worker: what updateLighting uploads, read back through the lighting
// shader's formula, is I / (I + h² + d²); the raycasted light batch carries the same terms. Defaults leave the
// old uploads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { lightInfluenceRadius } from '../../src/util/lightRadius.js';
import { lightDataTextureFloatCount } from '../../src/util/utils.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 8;
const MAX_LIGHTS = 4;
const DISTANCE_SCALE = 1 / 1024;

function bindComponents() {
  Transform.active = new Uint8Array(N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Collider.visualRange = new Float32Array(N);
  LightEmitter.active = new Uint8Array(N);
  LightEmitter.lightColor = new Uint32Array(N);
  LightEmitter.lightIntensity = new Float32Array(N);
  LightEmitter.sqrtLightIntensity = new Float32Array(N);
  LightEmitter.height = new Float32Array(N);
  LightEmitter.sourceHeight = new Float32Array(N);
}

function light(e, x, y, intensity, color, { height = 0, sourceHeight = 0 } = {}) {
  Transform.active[e] = 1;
  Transform.x[e] = x;
  Transform.y[e] = y;
  LightEmitter.active[e] = 1;
  LightEmitter.lightColor[e] = color;
  LightEmitter.lightIntensity[e] = intensity;
  LightEmitter.sqrtLightIntensity[e] = Math.sqrt(intensity);
  LightEmitter.height[e] = height;
  LightEmitter.sourceHeight[e] = sourceHeight;
}

/** A Pixi worker with just enough lighting state for updateLighting (no GPU: the upload is skipped). */
async function lightingWorker(lights) {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.lightingEnabled = true;
  px.maxLights = MAX_LIGHTS;
  px._lightDataFloats = new Float32Array(lightDataTextureFloatCount(MAX_LIGHTS));
  px._lightDataSource = null;
  px._visibleLightsAll = lights.map((entityId) => ({ entityId, distSq: 0 }));
  px._visibleLightsAllCount = lights.length;
  px._stampLightCamera = () => {};
  px._applyLightingViewport = () => {};
  px.lightingShader = { resources: { uniforms: { uniforms: { uLightCount: 0 }, update() {} } } };
  return px;
}

/** lightingBasic's loop for one light and one fragment at world (wx, wy): the red channel it adds. */
function shadeRed(px, slot, wx, wy) {
  const d = px._lightDataFloats;
  const lx = d[slot * 4];
  const ly = d[slot * 4 + 1];
  const intensity = d[slot * 4 + 2];
  const red = d[MAX_LIGHTS * 4 + slot * 4];
  const dx = (wx - lx) * DISTANCE_SCALE;
  const dy = (wy - ly) * DISTANCE_SCALE;
  const i = intensity * DISTANCE_SCALE * DISTANCE_SCALE;
  return red * (i / (i + dx * dx + dy * dy));
}

function expected(intensity, h, dx, dy) {
  return intensity / (intensity + h * h + dx * dx + dy * dy);
}

test('defaults upload the floor light as before: y raised by height, intensity and colour untouched', async () => {
  bindComponents();
  light(0, 100, 200, 20000, 0xff8040, { height: 30 });
  const px = await lightingWorker([0]);
  px.updateLighting();
  const d = px._lightDataFloats;
  assert.deepEqual(Array.from(d.subarray(0, 3)), [100, 170, 20000]);
  assert.deepEqual(Array.from(d.subarray(MAX_LIGHTS * 4, MAX_LIGHTS * 4 + 3)), [1, Math.fround(0x80 / 255), Math.fround(0x40 / 255)]);
  assert.equal(px.lightingShader.resources.uniforms.uniforms.uLightCount, 1);
});

test('the uploaded light shades I / (I + h² + d²) through the lighting shader', async () => {
  bindComponents();
  light(0, 300, 400, 20000, 0xff0000, { height: 0, sourceHeight: 110 });
  light(1, -50, 80, 9000, 0xff0000, { height: 25, sourceHeight: 0 });
  const px = await lightingWorker([0, 1]);
  px.updateLighting();
  for (const [slot, e] of [[0, 0], [1, 1]]) {
    const lx = Transform.x[e];
    const ly = Transform.y[e] - LightEmitter.height[e];
    const I = LightEmitter.lightIntensity[e];
    const h = LightEmitter.sourceHeight[e];
    for (const [dx, dy] of [[0, 0], [120, 0], [0, 60], [-200, -35], [500, 250]]) {
      const got = shadeRed(px, slot, lx + dx, ly + dy);
      const want = expected(I, h, dx, dy);
      assert.ok(Math.abs(got - want) < 2e-5, `light ${e} at (${dx}, ${dy}): ${got} vs ${want}`);
    }
  }
});

test('sourceHeight lowers the peak to I / (I + h²) and keeps the far field', async () => {
  bindComponents();
  light(0, 0, 0, 20000, 0xff0000, { sourceHeight: 110 });
  light(1, 0, 0, 20000, 0xff0000);
  const px = await lightingWorker([0, 1]);
  px.updateLighting();
  const raisedPeak = shadeRed(px, 0, 0, 0);
  assert.ok(Math.abs(raisedPeak - 20000 / (20000 + 110 * 110)) < 1e-6);
  assert.ok(Math.abs(shadeRed(px, 1, 0, 0) - 1) < 1e-6, 'a floor light peaks at 1');
  const far = 1000;
  const ratio = shadeRed(px, 0, far, 0) / shadeRed(px, 1, far, 0);
  assert.ok(ratio > 0.98 && ratio < 1, `far away the two match (${ratio})`);
});

test('the raycasted batch: the light terms folded in, the rim at the reach of the floor light', async () => {
  bindComponents();
  light(0, 500, 300, 16900, 0x00ff00, { height: 10, sourceHeight: 60 });
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px._visPolyEnabled = true;
  px.renderQueueSync = null;
  const maxVerts = 8;
  const slotBytes = (4 + maxVerts * 2) * 4;
  const ab = new ArrayBuffer(4 + slotBytes);
  const i32 = new Int32Array(ab);
  const f32 = new Float32Array(ab);
  i32[0] = 1; // one light
  const base = 1;
  i32[base] = 0;
  f32[base + 1] = 500;
  f32[base + 2] = 300; // pre-render's light position; Pixi raises it by `height`
  i32[base + 3] = 3;
  const xs = [400, 600, 500];
  const ys = [250, 250, 400];
  for (let v = 0; v < 3; v++) {
    f32[base + 4 + v] = xs[v];
    f32[base + 4 + maxVerts + v] = ys[v];
  }
  px._visPolyBuffers = [{ header: i32, i32, f32 }];
  px._visPolyMaxVerts = maxVerts;
  px._visPolySlotBytes = slotBytes;
  px._visPolyContainer = { addChildAt() {} };
  px._visPolyRT = {};
  let batch = null;
  px._ensureVisBatch = (verts, idx) => {
    batch = {
      data: new Float32Array(verts * 10),
      indices: new Uint32Array(idx),
      idxUsed: 0,
      gpuReady: true,
      vbuf: { update() {} },
      geometry: { indexBuffer: { update() {} } },
      mesh: { visible: false, parent: null },
      uniforms: { uCanvasSize: new Float32Array(2) },
    };
    return batch;
  };
  px._stampLightCamera = () => {};
  px._buildSelfLitBatch = () => false;
  px._submitRender = () => {};
  px.renderVisibilityLighting();

  const R = lightInfluenceRadius(Math.sqrt(16900));
  const I = 16900 + 60 * 60;
  const k = 16900 / I;
  const quadYs = [];
  for (let c = 0; c < 4; c++) {
    const o = c * 10;
    quadYs.push(batch.data[o + 1]);
    assert.equal(batch.data[o + 2], 500);
    assert.equal(batch.data[o + 3], 290, 'raised by height');
    assert.equal(batch.data[o + 4], I, "I' = I + h²");
    assert.equal(batch.data[o + 5], R, 'the rim stays at the reach of the floor light');
    assert.ok(Math.abs(batch.data[o + 7] - k) < 1e-6, 'green times I / I\'');
  }
  assert.deepEqual([...new Set(quadYs)].sort((a, b) => a - b), [290 - R, 290 + R]);
});
