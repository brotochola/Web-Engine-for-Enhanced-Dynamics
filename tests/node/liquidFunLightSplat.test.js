import test from 'node:test';
import assert from 'node:assert/strict';
import { packLiquidFunLightSlabs, LF_LIGHT_SPLAT_FLOATS } from '../../src/render/liquidFunLightSplat.js';
import { lightInfluenceRadius } from '../../src/util/utils.js';
import { packParticleLights } from '../../src/render/particleLightSplat.js';

function makeViews(n) {
  return {
    x: new Float32Array(n),
    y: new Float32Array(n),
    tint: new Uint32Array(n),
    alpha: new Float32Array(n).fill(1),
    baseAlpha: new Float32Array(n).fill(1),
    layerId: new Uint8Array(n).fill(3),
    maxCount: n,
  };
}

function makeGroups(maxGroups) {
  return {
    count: new Int32Array(1),
    id: new Int32Array(maxGroups),
    particleCount: new Int32Array(maxGroups),
    firstIndex: new Int32Array(maxGroups),
    lastIndex: new Int32Array(maxGroups),
    lightIntensity: new Float32Array(maxGroups),
    sqrtLightIntensity: new Float32Array(maxGroups),
    maxGroups,
  };
}

function setGroupLight(groups, gid, intensity) {
  groups.lightIntensity[gid] = intensity;
  groups.sqrtLightIntensity[gid] = intensity > 0 ? Math.sqrt(intensity) : 0;
}

test('a turned camera places LiquidFun light splats where the particle lights go (N-27)', () => {
  // The other two splat packers turned their points with cameraRot; this one
  // had no rotation and its caller passed none, so lit water drew its light
  // off the water under a turned camera.
  const n = 3;
  const views = makeViews(n);
  const pViews = {
    active: new Uint16Array([n, 0, 1, 2]),
    lightSqrt: new Float32Array(n).fill(10),
    x: views.x,
    y: views.y,
    alpha: new Float32Array(n).fill(1),
  };
  const pts = [[830, 440], [900, 500], [760, 400]]; // near the view focus (826.7, 440)
  for (let i = 0; i < n; i++) {
    views.x[i] = pts[i][0];
    views.y[i] = pts[i][1];
  }
  const groups = makeGroups(2);
  groups.count[0] = 1;
  groups.id[0] = 1;
  groups.particleCount[0] = n;
  groups.firstIndex[0] = 0;
  groups.lastIndex[0] = n;
  setGroupLight(groups, 1, 100);
  const opts = { zoom: 1.5, cameraX: 400, cameraY: 200, cameraRot: 0.7, resolution: 0.5, canvasW: 1280, canvasH: 720 };
  const lf = new Float32Array(8 * LF_LIGHT_SPLAT_FLOATS);
  const pl = new Float32Array(8 * 4);
  assert.equal(packLiquidFunLightSlabs(lf, new Uint32Array(lf.buffer), 8, views, groups, opts), n);
  assert.equal(packParticleLights(pl, new Uint32Array(pl.buffer), 8, pViews, opts), n);
  for (let i = 0; i < n; i++) {
    const at = i * 4;
    assert.ok(
      Math.abs(lf[at] - pl[at]) < 1e-3 && Math.abs(lf[at + 1] - pl[at + 1]) < 1e-3,
      `point ${i}: LiquidFun at ${lf[at]},${lf[at + 1]}, particle light at ${pl[at]},${pl[at + 1]}`,
    );
  }
});

test('packLiquidFunLightSlabs packs lit group slab and skips unlit', () => {
  const views = makeViews(8);
  for (let i = 0; i < 8; i++) {
    views.x[i] = i * 10;
    views.y[i] = 0;
    views.tint[i] = 0xff0000;
  }
  const groups = makeGroups(4);
  groups.count[0] = 2;
  groups.id[0] = 1;
  groups.particleCount[0] = 3;
  groups.firstIndex[0] = 0;
  groups.lastIndex[0] = 3;
  setGroupLight(groups, 1, 100);
  groups.id[1] = 2;
  groups.particleCount[1] = 4;
  groups.firstIndex[1] = 3;
  groups.lastIndex[1] = 7;
  setGroupLight(groups, 2, 0);

  const data = new Float32Array(16 * LF_LIGHT_SPLAT_FLOATS);
  const dataU32 = new Uint32Array(data.buffer);
  const n = packLiquidFunLightSlabs(data, dataU32, 16, views, groups, {
    zoom: 1,
    cameraX: 0,
    cameraY: 0,
    resolution: 1,
    canvasW: 1000,
    canvasH: 1000,
  });
  assert.equal(n, 3);
  assert.equal(data[0], 0);
  assert.equal(data[2], lightInfluenceRadius(10));
  const rgba = dataU32[3];
  assert.equal(rgba & 0xff, 255);
  assert.equal((rgba >>> 24) & 0xff, 255);
});

test('packLiquidFunLightSlabs fades via HEAP alpha (not I/10000)', () => {
  const views = makeViews(2);
  views.x[0] = 0;
  views.y[0] = 0;
  views.alpha[0] = 0.5;
  views.tint[0] = 0x00ff00;
  const groups = makeGroups(2);
  groups.count[0] = 1;
  groups.id[0] = 1;
  groups.particleCount[0] = 1;
  groups.firstIndex[0] = 0;
  groups.lastIndex[0] = 1;
  setGroupLight(groups, 1, 100);

  const data = new Float32Array(4);
  const dataU32 = new Uint32Array(data.buffer);
  const n = packLiquidFunLightSlabs(data, dataU32, 1, views, groups, {
    canvasW: 100,
    canvasH: 100,
  });
  assert.equal(n, 1);
  const a = (dataU32[3] >>> 24) & 0xff;
  assert.equal(a, 128);
});

test('packLiquidFunLightSlabs viewport-culls and respects cap', () => {
  const views = makeViews(4);
  views.x[0] = 0;
  views.y[0] = 0;
  views.x[1] = 5000;
  views.y[1] = 0;
  views.x[2] = 10;
  views.y[2] = 0;
  const groups = makeGroups(2);
  groups.count[0] = 1;
  groups.id[0] = 1;
  groups.particleCount[0] = 3;
  groups.firstIndex[0] = 0;
  groups.lastIndex[0] = 3;
  setGroupLight(groups, 1, 100);

  const data = new Float32Array(8);
  const dataU32 = new Uint32Array(data.buffer);
  const n = packLiquidFunLightSlabs(data, dataU32, 1, views, groups, {
    zoom: 1,
    cameraX: 0,
    cameraY: 0,
    resolution: 1,
    canvasW: 100,
    canvasH: 100,
  });
  assert.equal(n, 1);
  assert.equal(data[0], 0);
});

test('packLiquidFunLightSlabs uses distinct radii per group intensity', () => {
  const views = makeViews(2);
  views.x[0] = 0;
  views.y[0] = 0;
  views.x[1] = 1;
  views.y[1] = 0;
  const groups = makeGroups(4);
  groups.count[0] = 2;
  groups.id[0] = 1;
  groups.particleCount[0] = 1;
  groups.firstIndex[0] = 0;
  groups.lastIndex[0] = 1;
  setGroupLight(groups, 1, 100);
  groups.id[1] = 2;
  groups.particleCount[1] = 1;
  groups.firstIndex[1] = 1;
  groups.lastIndex[1] = 2;
  setGroupLight(groups, 2, 400);

  const data = new Float32Array(8);
  const dataU32 = new Uint32Array(data.buffer);
  const n = packLiquidFunLightSlabs(data, dataU32, 8, views, groups, {
    zoom: 1,
    resolution: 1,
    canvasW: 1000,
    canvasH: 1000,
  });
  assert.equal(n, 2);
  assert.equal(data[2], lightInfluenceRadius(10));
  assert.equal(data[6], lightInfluenceRadius(20));
});

test('packLiquidFunLightSlabs returns 0 when intensity is 0', () => {
  const views = makeViews(1);
  const groups = makeGroups(2);
  groups.count[0] = 1;
  groups.id[0] = 1;
  groups.particleCount[0] = 1;
  setGroupLight(groups, 1, 0);
  const data = new Float32Array(4);
  const dataU32 = new Uint32Array(data.buffer);
  assert.equal(packLiquidFunLightSlabs(data, dataU32, 4, views, groups, {}), 0);
});

test('packLiquidFunLightSlabs returns 0 when intensity is set but sqrtI is 0', () => {
  const views = makeViews(1);
  views.x[0] = 0;
  views.y[0] = 0;
  const groups = makeGroups(2);
  groups.count[0] = 1;
  groups.id[0] = 1;
  groups.particleCount[0] = 1;
  groups.firstIndex[0] = 0;
  groups.lastIndex[0] = 1;
  groups.lightIntensity[1] = 5330;
  groups.sqrtLightIntensity[1] = 0;
  const data = new Float32Array(4);
  const dataU32 = new Uint32Array(data.buffer);
  assert.equal(
    packLiquidFunLightSlabs(data, dataU32, 4, views, groups, {
      zoom: 1,
      resolution: 1,
      canvasW: 100,
      canvasH: 100,
    }),
    0,
  );
});
