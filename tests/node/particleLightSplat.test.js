import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_TYPES } from '../../src/util/configDefaults.js';
import { lightInfluenceRadius } from '../../src/util/utils.js';
import {
  packParticleLights,
  PARTICLE_LIGHT_FLOATS,
} from '../../src/render/particleLightSplat.js';

function makeViews(n) {
  const active = new Uint16Array(n + 1);
  active[0] = n;
  for (let i = 0; i < n; i++) active[1 + i] = i;
  return {
    active,
    lightSqrt: new Float32Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    alpha: new Float32Array(n).fill(1),
    tint: new Uint32Array(n),
    flat: new Uint8Array(n),
    viewMode: new Uint8Array(n),
    renderOnly: new Uint8Array(n),
    layerMask: new Uint16Array(n),
  };
}

function pack(views, opts, cap = 16) {
  const data = new Float32Array(cap * PARTICLE_LIGHT_FLOATS);
  const dataU32 = new Uint32Array(data.buffer);
  const n = packParticleLights(data, dataU32, cap, views, {
    zoom: 1,
    cameraX: 0,
    cameraY: 0,
    resolution: 1,
    canvasW: 400,
    canvasH: 300,
    max: cap,
    ...opts,
  });
  return { n, data, dataU32 };
}

test('heighted topdown light sits at y+z; flat ignores z', () => {
  const views = makeViews(2);
  views.lightSqrt[0] = 1;
  views.lightSqrt[1] = 1;
  views.x[0] = 10;
  views.y[0] = 100;
  views.z[0] = -30;
  views.viewMode[0] = CAMERA_TYPES.TOPDOWN;
  views.x[1] = 20;
  views.y[1] = 80;
  views.z[1] = -30;
  views.flat[1] = 1;
  views.viewMode[1] = CAMERA_TYPES.TOPDOWN;

  const { n, data } = pack(views);
  assert.equal(n, 2);
  assert.equal(data[0], 10);
  assert.equal(data[1], 70);
  assert.equal(data[4], 20);
  assert.equal(data[5], 80);
  assert.equal(data[2], lightInfluenceRadius(1));
});

test('zenithal light stays on the floor and fades with height', () => {
  const views = makeViews(1);
  views.lightSqrt[0] = 1;
  views.x[0] = 5;
  views.y[0] = 40;
  views.z[0] = -25;
  views.viewMode[0] = CAMERA_TYPES.ZENITHAL;
  views.tint[0] = 0xff0000;

  const { n, data, dataU32 } = pack(views, {
    zenithalMaxHeight: 50,
    zenithalAlphaFade: 1,
  });
  assert.equal(n, 1);
  assert.equal(data[0], 5);
  assert.equal(data[1], 40);
  const ai = (dataU32[3] >>> 24) & 0xff;
  assert.equal(ai, 128);
});

test('rotated camera uses one sin/cos and moves the quad off the unrotated axis', () => {
  const views = makeViews(1);
  views.lightSqrt[0] = 1;
  views.x[0] = 60;
  views.y[0] = 50;
  const rot = Math.PI / 2;
  const { n, data } = pack(views, {
    cameraRot: rot,
    canvasW: 100,
    canvasH: 100,
  });
  assert.equal(n, 1);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const sx = 50 + (10 * c - 0 * s);
  const sy = 50 + (10 * s + 0 * c);
  assert.ok(Math.abs(data[0] - sx) < 1e-4);
  assert.ok(Math.abs(data[1] - sy) < 1e-4);
  assert.ok(Math.abs(data[0] - 60) > 1);
});

test('cap, low alpha, sub-pixel radius, and renderOnly are dropped', () => {
  const views = makeViews(5);
  for (let i = 0; i < 5; i++) {
    views.lightSqrt[i] = 1;
    views.x[i] = 10 + i;
    views.y[i] = 10;
  }
  views.alpha[0] = 0;
  views.lightSqrt[1] = 0.01;
  views.renderOnly[2] = 1;

  const { n, data } = pack(views, { max: 2 });
  assert.equal(n, 2);
  assert.equal(data[0], 13);
  assert.equal(data[4], 14);
});

test('a hidden layer drops the light; a visible layer scales alpha', () => {
  const views = makeViews(2);
  views.lightSqrt[0] = 1;
  views.lightSqrt[1] = 1;
  views.x[0] = 10;
  views.y[0] = 10;
  views.x[1] = 30;
  views.y[1] = 10;
  views.layerMask[0] = 1;
  views.layerMask[1] = 1;
  const visible = new Uint8Array([0, 1]);
  const alpha = new Float32Array([1, 0.5]);
  views.layerMask[1] = 2;

  const hidden = pack({ ...views, active: views.active }, {
    layerVisible: visible,
    layerAlpha: alpha,
  });
  assert.equal(hidden.n, 1);
  assert.equal(hidden.data[0], 30);
  assert.equal((hidden.dataU32[3] >>> 24) & 0xff, 128);
});

test('offscreen quads are culled by radius', () => {
  const views = makeViews(1);
  views.lightSqrt[0] = 1;
  views.x[0] = -1000;
  views.y[0] = 0;
  const { n } = pack(views);
  assert.equal(n, 0);
});
