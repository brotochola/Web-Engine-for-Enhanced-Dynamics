// LiquidFunDensitySplat.upload's rows (E-241: the per-particle write takes its doubles through a module scratch, not as
// arguments, so it makes no heap number per particle). Each row is the particle on the density target's screen (x, y),
// its radius, and its colour with alpha packed RGBA8; a particle past the target by more than its radius is culled.
// upload and _writeInst run on a stand-in carrying the fields they use (no shader or GPU needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LiquidFunDensitySplat, LF_SPLAT_FLOATS } from '../../src/render/liquidFunDensitySplat.js';

function splat(capacity) {
  const s = Object.create(LiquidFunDensitySplat.prototype);
  s.capacity = capacity;
  s.data = new Float32Array(capacity * LF_SPLAT_FLOATS);
  s.dataU32 = new Uint32Array(s.data.buffer);
  s.buffer = { update() {} };
  s.geometry = { instanceCount: 0 };
  s.mesh = { visible: false };
  for (const k of ['_camX', '_camY', '_screenScale', '_canvasW', '_canvasH', '_resolution', '_rot', '_camC', '_camS', '_focusX',
    '_focusY', '_halfW', '_halfH', '_screenRadius', '_pad', '_intensity', '_out']) s[k] = 0;
  s._cull = false;
  s._useTint = true;
  return s;
}

const rgba = (r, g, b, a) => (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;

function rows(s, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const o = k * LF_SPLAT_FLOATS;
    out.push([s.data[o], s.data[o + 1], s.data[o + 2], s.dataU32[o + 3]]);
  }
  return out;
}

test('E-241: upload writes each particle\'s screen position, radius and packed colour; culls past the radius', () => {
  const s = splat(8);
  const views = {
    count: new Int32Array([3]),
    maxCount: 3,
    x: new Float32Array([110, 2000, 130]),
    y: new Float32Array([60, 60, 80]),
    color: new Uint32Array([0x112233, 0, 0]),
    tint: new Uint32Array([0, 0x445566, 0]),
    baseAlpha: new Float32Array([1, 1, 0.5]),
    alpha: new Float32Array([0.8, 1, 1]),
    layerMask: new Uint8Array([1, 1, 1]),
  };
  const n = s.upload(views, { zoom: 2, resolution: 0.5, radius: 48, cameraX: 100, cameraY: 50, canvasW: 800, canvasH: 600, layerId: 0 });
  assert.equal(n, 2, 'the particle at x 2000 is past the target');
  assert.deepEqual(rows(s, 2), [
    [10, 10, 48, rgba(0x11, 0x22, 0x33, 204)],
    [30, 30, 48, rgba(255, 255, 255, 128)],
  ]);
  assert.equal(s.geometry.instanceCount, 2);
  assert.equal(s.mesh.visible, true);
});

test('E-241: a rotated camera turns the particles about the view\'s centre; a layer mask leaves others out', () => {
  const s = splat(4);
  const views = {
    count: new Int32Array([2]),
    maxCount: 2,
    x: new Float32Array([450, 450]),
    y: new Float32Array([300, 300]),
    color: new Uint32Array([0xff0000, 0]),
    tint: null,
    baseAlpha: null,
    alpha: null,
    layerMask: new Uint8Array([2, 1]),
  };
  // Zoom 1, the view 800 x 600 from (50, 0): its centre is (450, 300); a particle there stays at the screen's centre.
  const n = s.upload(views, { zoom: 1, resolution: 1, radius: 10, cameraX: 50, cameraY: 0, cameraRot: Math.PI / 2, canvasW: 800, canvasH: 600, layerId: 1, intensity: 0.5 });
  assert.equal(n, 1, 'the second particle is on another layer');
  const [[x, y, r, c]] = rows(s, 1);
  assert.ok(Math.abs(x - 400) < 1e-3 && Math.abs(y - 300) < 1e-3, `${x}, ${y}`);
  assert.equal(r, 10);
  assert.equal(c, rgba(0xff, 0, 0, 128), 'intensity 0.5 halves the alpha');
});
