// config.lighting.groundScaleY and LightEmitter.elevation on a real Pixi worker: what updateLighting uploads, read
// back through the lighting shader's formula, is I / (I + h² + dx² + (dy / groundScaleY)²) with I = (radius / 10)²;
// the raycasted light batch carries the same terms and an umbra quad no taller than the pool. brightness scales the
// colour.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { LIGHTING_DEFAULTS } from '../../src/util/configDefaults.js';
import { GROUND_SCALE_Y_MIN, resolveGroundScaleY } from '../../src/util/lightRadius.js';
import { lightDataTextureFloatCount } from '../../src/util/utils.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 8;
const MAX_LIGHTS = 4;
const DISTANCE_SCALE = 1 / 1024;

function bindComponents() {
  Transform.active = new Uint8Array(N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Collider.visualRange = new Float32Array(N);
  LightEmitter.active = new Uint8Array(N);
  LightEmitter.color = new Uint32Array(N);
  LightEmitter.radius = new Float32Array(N);
  LightEmitter.brightness = new Float32Array(N).fill(1);
  LightEmitter.elevation = new Float32Array(N);
  // DX-SPOT: no cone (coneCos below every cosine).
  LightEmitter.coneCos = new Float32Array(N).fill(-2);
  LightEmitter.coneInvSpan = new Float32Array(N);
  LightEmitter.dirC = new Float32Array(N).fill(1);
  LightEmitter.dirS = new Float32Array(N);
  LightEmitter.offsetX = new Float32Array(N);
  LightEmitter.offsetY = new Float32Array(N);
}

function light(e, x, y, radius, color, { offsetY = 0, elevation = 0, brightness = 1 } = {}) {
  Transform.active[e] = 1;
  Transform.x[e] = x;
  Transform.y[e] = y;
  LightEmitter.active[e] = 1;
  LightEmitter.color[e] = color;
  LightEmitter.radius[e] = radius;
  LightEmitter.brightness[e] = brightness;
  LightEmitter.elevation[e] = elevation;
  LightEmitter.offsetY[e] = offsetY;
}

/** A Pixi worker with just enough lighting state for updateLighting (no GPU: the upload is skipped). */
async function lightingWorker(groundScaleY, lights) {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.lightingEnabled = true;
  px._groundScaleY = resolveGroundScaleY(groundScaleY);
  px._groundInvScaleY = 1 / px._groundScaleY;
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
  const fy = Math.fround(wy * Math.fround(px._groundInvScaleY)); // fragWorld.y *= uGroundInvScaleY
  const dx = (wx - lx) * DISTANCE_SCALE;
  const dy = (fy - ly) * DISTANCE_SCALE;
  const i = intensity * DISTANCE_SCALE * DISTANCE_SCALE;
  return red * (i / (i + dx * dx + dy * dy));
}

function expected(intensity, h, dx, dy, groundScaleY) {
  const fy = dy / groundScaleY;
  return intensity / (intensity + h * h + dx * dx + fy * fy);
}

test('groundScaleY: a positive number up to 1, clamped below; anything else is 1', () => {
  assert.equal(LIGHTING_DEFAULTS.groundScaleY, 1);
  assert.equal(resolveGroundScaleY(undefined), 1);
  assert.equal(resolveGroundScaleY(null), 1);
  assert.equal(resolveGroundScaleY('iso'), 1);
  assert.equal(resolveGroundScaleY(0), 1);
  assert.equal(resolveGroundScaleY(-0.5), 1);
  assert.equal(resolveGroundScaleY(2), 1);
  assert.equal(resolveGroundScaleY(0.5), 0.5);
  assert.equal(resolveGroundScaleY('0.7'), 0.7);
  assert.equal(resolveGroundScaleY(0.001), GROUND_SCALE_Y_MIN);
});

test('a floor light uploads I = (radius / 10)² and its colour untouched; offsetY -30 raises it 30 px', async () => {
  bindComponents();
  light(0, 100, 200, 1400, 0xff8040, { offsetY: -30 });
  const px = await lightingWorker(undefined, [0]);
  px.updateLighting();
  const d = px._lightDataFloats;
  assert.deepEqual(Array.from(d.subarray(0, 3)), [100, 170, 19600]);
  assert.deepEqual(Array.from(d.subarray(MAX_LIGHTS * 4, MAX_LIGHTS * 4 + 3)), [1, Math.fround(0x80 / 255), Math.fround(0x40 / 255)]);
  assert.equal(px.lightingShader.resources.uniforms.uniforms.uLightCount, 1);
});

test('the uploaded light shades I / (I + h² + dx² + (dy / groundScaleY)²) through the lighting shader', async () => {
  bindComponents();
  light(0, 300, 400, 1400, 0xff0000, { elevation: 110 });
  light(1, -50, 80, 950, 0xff0000, { offsetY: -25 });
  const g = 0.5;
  const px = await lightingWorker(g, [0, 1]);
  px.updateLighting();
  for (const [slot, e] of [[0, 0], [1, 1]]) {
    const lx = Transform.x[e];
    const ly = Transform.y[e] + LightEmitter.offsetY[e];
    const I = (LightEmitter.radius[e] * LightEmitter.radius[e]) / 100;
    const h = LightEmitter.elevation[e];
    for (const [dx, dy] of [[0, 0], [120, 0], [0, 60], [-200, -35], [500, 250]]) {
      const got = shadeRed(px, slot, lx + dx, ly + dy);
      const want = expected(I, h, dx, dy, g);
      assert.ok(Math.abs(got - want) < 2e-5, `light ${e} at (${dx}, ${dy}): ${got} vs ${want}`);
    }
  }
});

test('the pool is an ellipse: R across matches R * groundScaleY up and down', async () => {
  bindComponents();
  light(0, 0, 0, 1000, 0xff0000);
  const g = 0.6;
  const px = await lightingWorker(g, [0]);
  px.updateLighting();
  const across = shadeRed(px, 0, 250, 0);
  const down = shadeRed(px, 0, 0, 250 * g);
  const up = shadeRed(px, 0, 0, -250 * g);
  assert.ok(Math.abs(across - down) < 1e-6 && Math.abs(across - up) < 1e-6, `${across} ${down} ${up}`);
  assert.ok(shadeRed(px, 0, 0, 250) < across, 'R straight down is farther away on the floor');
});

test('elevation lowers the peak to I / (I + h²) and keeps the far field', async () => {
  bindComponents();
  light(0, 0, 0, 1400, 0xff0000, { elevation: 110 });
  light(1, 0, 0, 1400, 0xff0000);
  const px = await lightingWorker(1, [0, 1]);
  px.updateLighting();
  const raisedPeak = shadeRed(px, 0, 0, 0);
  assert.ok(Math.abs(raisedPeak - 19600 / (19600 + 110 * 110)) < 1e-6);
  assert.ok(Math.abs(shadeRed(px, 1, 0, 0) - 1) < 1e-6, 'a floor light peaks at 1');
  const far = 1000;
  const ratio = shadeRed(px, 0, far, 0) / shadeRed(px, 1, far, 0);
  assert.ok(ratio > 0.98 && ratio < 1, `far away the two match (${ratio})`);
});

test('the raycasted batch: an umbra quad R wide and R * groundScaleY tall, the light terms folded in', async () => {
  bindComponents();
  light(0, 500, 300, 1300, 0x00ff00, { offsetY: -10, elevation: 60 });
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px._groundScaleY = 0.5;
  px._groundInvScaleY = 2;
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
  f32[base + 2] = 290; // pre-render's light position, its offset included
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
      cbuf: null,
      coneData: null,
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

  const R = 1300;
  const I = 16900 + 60 * 60;
  const k = 16900 / I;
  const quadYs = [];
  for (let c = 0; c < 4; c++) {
    const o = c * 10;
    quadYs.push(batch.data[o + 1]);
    assert.equal(batch.data[o + 2], 500);
    assert.equal(batch.data[o + 3], 290, 'raised by its offset');
    assert.equal(batch.data[o + 4], I, "I' = I + h²");
    assert.equal(batch.data[o + 5], R, 'the rim stays at the reach of the floor light');
    assert.ok(Math.abs(batch.data[o + 7] - k) < 1e-6, 'green times I / I\'');
  }
  assert.deepEqual([...new Set(quadYs)].sort((a, b) => a - b), [290 - R * 0.5, 290 + R * 0.5]);
});

test('brightness scales the uploaded colour and nothing else', async () => {
  bindComponents();
  light(0, 100, 200, 1000, 0xff8040, { brightness: 0.5 });
  light(1, 100, 200, 1000, 0xff8040);
  const px = await lightingWorker(undefined, [0, 1]);
  px.updateLighting();
  const d = px._lightDataFloats;
  assert.deepEqual(Array.from(d.subarray(0, 3)), Array.from(d.subarray(4, 7)), 'position and I');
  for (let c = 0; c < 3; c++) {
    assert.equal(d[MAX_LIGHTS * 4 + c], Math.fround(d[MAX_LIGHTS * 4 + 4 + c] * 0.5));
  }
});

test('DX-SPOT: under raycast a cone light\'s umbra disc and fan go to the cone batch, its cone on every vertex', async () => {
  bindComponents();
  light(0, 200, 300, 900, 0xff0000);
  light(1, 700, 300, 1100, 0x00ff00);
  // Light 1: a cone along the entity's facing turned by its direction, on an entity turned 90 degrees.
  LightEmitter.coneCos[1] = Math.fround(Math.cos(0.5));
  LightEmitter.coneInvSpan[1] = 3;
  LightEmitter.dirC[1] = Math.cos(0.3);
  LightEmitter.dirS[1] = Math.sin(0.3);
  Transform.rotC[1] = 0;
  Transform.rotS[1] = 1;
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px._groundScaleY = 0.5;
  px._groundInvScaleY = 2;
  px._visPolyEnabled = true;
  px.renderQueueSync = null;
  const maxVerts = 8;
  const slotBytes = (4 + maxVerts * 2) * 4;
  const ab = new ArrayBuffer(4 + 2 * slotBytes);
  const i32 = new Int32Array(ab);
  const f32 = new Float32Array(ab);
  i32[0] = 2;
  for (const [slot, e, x, n] of [[0, 0, 200, 3], [1, 1, 700, 4]]) {
    const base = (4 + slot * slotBytes) >> 2;
    i32[base] = e;
    f32[base + 1] = x;
    f32[base + 2] = 300;
    i32[base + 3] = n;
    for (let v = 0; v < n; v++) {
      f32[base + 4 + v] = x + 50 * Math.cos(v);
      f32[base + 4 + maxVerts + v] = 300 + 50 * Math.sin(v);
    }
  }
  px._visPolyBuffers = [{ header: i32, i32, f32 }];
  px._visPolyMaxVerts = maxVerts;
  px._visPolySlotBytes = slotBytes;
  const children = [];
  px._visPolyContainer = { addChildAt(m) { children.unshift(m); m.parent = this; }, addChild(m) { children.push(m); m.parent = this; } };
  px._visPolyRT = {};
  const made = {};
  px._ensureVisBatch = (verts, idx, cone) => {
    made[cone ? 'cone' : 'point'] = {
      data: new Float32Array(verts * 10),
      cbuf: cone ? { update() {} } : null,
      coneData: cone ? new Float32Array(verts * 4) : null,
      indices: new Uint32Array(idx),
      idxUsed: 0,
      gpuReady: true,
      vbuf: { update() {} },
      geometry: { indexBuffer: { update() {} } },
      mesh: { visible: false, parent: null, cone: !!cone },
      uniforms: { uCanvasSize: new Float32Array(2) },
    };
    if (cone) px._visConeBatch = made.cone;
    else px._visBatch = made.point;
    return made[cone ? 'cone' : 'point'];
  };
  px._stampLightCamera = () => {};
  px._buildSelfLitBatch = () => false;
  px._submitRender = () => {};
  px.renderVisibilityLighting();

  // The point light: its disc (4) and fan (1 + 3), as alone; the cone light's disc and fan (4 + 1 + 4) in the cone batch.
  assert.equal(made.point.idxUsed, 6 + 3 * 3);
  assert.equal(made.cone.idxUsed, 6 + 4 * 3);
  for (let v = 0; v < 8; v++) assert.equal(made.point.data[v * 10 + 2], 200);
  for (let v = 0; v < 9; v++) assert.equal(made.cone.data[v * 10 + 2], 700);
  // Its direction: the entity's 90 degrees and the light's 0.3 radians, then on the floor (y times 2), unit length.
  const wx = Math.cos(Math.PI / 2 + 0.3);
  const wy = Math.sin(Math.PI / 2 + 0.3) * 2;
  const len = Math.sqrt(wx * wx + wy * wy);
  for (let v = 0; v < 9; v++) {
    const c = made.cone.coneData.subarray(v * 4, v * 4 + 4);
    assert.ok(Math.abs(c[0] - wx / len) < 1e-6 && Math.abs(c[1] - wy / len) < 1e-6, `direction ${c[0]}, ${c[1]}`);
    assert.equal(c[2], Math.fround(Math.cos(0.5)));
    assert.equal(c[3], 3);
  }
  assert.ok(made.point.mesh.visible && made.cone.mesh.visible);
  assert.deepEqual(children.map((m) => m.cone), [false, true], 'the point lights\' batch first, the cone lights\' after');
});

test('DX-SPOT: under raycast each slot\'s coneCos is read once: a light turned into a cone mid-frame draws as the count saw it', async () => {
  bindComponents();
  light(0, 200, 300, 900, 0xff0000);
  // No cone in view yet, so no cone batch exists; light 0 becomes a cone after its first read.
  const column = LightEmitter.coneCos;
  const reads = new Map();
  LightEmitter.coneCos = new Proxy(column, {
    get(t, k) {
      if (typeof k === 'string' && /^\d+$/.test(k)) {
        const i = +k;
        reads.set(i, (reads.get(i) || 0) + 1);
        if (i === 0 && reads.get(i) > 1) return Math.fround(Math.cos(0.5));
        return t[i];
      }
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  try {
    const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
    px._groundScaleY = 1;
    px._groundInvScaleY = 1;
    px._visPolyEnabled = true;
    px.renderQueueSync = null;
    const maxVerts = 8;
    const slotBytes = (4 + maxVerts * 2) * 4;
    const ab = new ArrayBuffer(4 + slotBytes);
    const i32 = new Int32Array(ab);
    const f32 = new Float32Array(ab);
    i32[0] = 1;
    i32[1] = 0;
    f32[2] = 200;
    f32[3] = 300;
    i32[4] = 3;
    for (let v = 0; v < 3; v++) {
      f32[5 + v] = 200 + 50 * Math.cos(v * 2);
      f32[5 + maxVerts + v] = 300 + 50 * Math.sin(v * 2);
    }
    px._visPolyBuffers = [{ header: i32, i32, f32 }];
    px._visPolyMaxVerts = maxVerts;
    px._visPolySlotBytes = slotBytes;
    px._visPolyContainer = { addChildAt(m) { m.parent = this; }, addChild(m) { m.parent = this; } };
    px._visPolyRT = {};
    const made = {};
    px._ensureVisBatch = (verts, idx, cone) => {
      made[cone ? 'cone' : 'point'] = {
        data: new Float32Array(verts * 10), cbuf: cone ? { update() {} } : null, coneData: cone ? new Float32Array(verts * 4) : null,
        indices: new Uint32Array(idx), idxUsed: 0, gpuReady: true, vbuf: { update() {} },
        geometry: { indexBuffer: { update() {} } }, mesh: { visible: false, parent: null }, uniforms: { uCanvasSize: new Float32Array(2) },
      };
      return made[cone ? 'cone' : 'point'];
    };
    px._stampLightCamera = () => {};
    px._buildSelfLitBatch = () => false;
    px._submitRender = () => {};
    px.renderVisibilityLighting();
    assert.equal(made.point.idxUsed, 6 + 3 * 3, 'drawn in the point batch the count sized');
    assert.equal(made.cone, undefined, 'no cone batch for it this frame');
    assert.equal(reads.get(0), 1, 'its coneCos read once');
  } finally {
    LightEmitter.coneCos = column;
  }
});
