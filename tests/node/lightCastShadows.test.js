// DX-LIGHTAPI A3 (N-149) and A4: LightEmitter.castShadows and shadowRange on a real pre-render worker. A light that
// casts no shadow is not among the shadow stamp's lights (no cookie, no casters), and Flash.spawn({ castShadows: false })
// reaches it: it used to write FlashComponent.castShadows, which nothing read. A light's stamp range is its shadowRange,
// or its radius when that is 0, whatever its Collider's visualRange.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Query } from '../../src/core/query.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 4;

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
  LightEmitter.castShadows.set([1, 0, 1, 0]);
}

test('a light with castShadows 0 is not one of the shadow stamp\'s lights', async () => {
  bind();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const savedActive = Query.queryActiveEntities;
  const savedFrame = Query.queryPublishedFrame;
  Query.queryActiveEntities = () => Uint32Array.from([0, 1, 2, 3]);
  Query.queryPublishedFrame = () => 1;
  try {
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
    const ids = pre._stampLights.slice(0, pre._stampLightCount).map((L) => L.id).sort();
    assert.deepEqual(ids, [0, 2]);
    assert.equal(pre._stampLights[0].intensity, 900, 'I = (radius / 10)²');
  } finally {
    Query.queryActiveEntities = savedActive;
    Query.queryPublishedFrame = savedFrame;
  }
});

test('the stamp range is shadowRange, or the radius when it is 0, whatever the Collider\'s visualRange', async () => {
  bind();
  LightEmitter.castShadows.fill(1);
  LightEmitter.shadowRange.set([0, 120, 0, 900]);
  Collider.visualRange.set([50, 50, 0, 0]);
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const savedActive = Query.queryActiveEntities;
  const savedFrame = Query.queryPublishedFrame;
  Query.queryActiveEntities = () => Uint32Array.from([0, 1, 2, 3]);
  Query.queryPublishedFrame = () => 1;
  try {
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
    const range = {};
    for (const L of pre._stampLights.slice(0, pre._stampLightCount)) range[L.id] = Math.sqrt(L.rangeSq);
    assert.deepEqual(range, { 0: 300, 1: 120, 2: 300, 3: 900 });
  } finally {
    Query.queryActiveEntities = savedActive;
    Query.queryPublishedFrame = savedFrame;
  }
});

test('Flash.spawn({ castShadows: false }) writes LightEmitter.castShadows 0, and its default casts', async () => {
  const { Flash } = await import('../../src/core/flash.js');
  bind();
  const flash = Object.create(Flash.prototype);
  Object.defineProperty(flash, 'index', { value: 1 });
  const le = new LightEmitter(1);
  Object.defineProperty(flash, 'lightEmitter', { value: le });
  Object.defineProperty(flash, 'flashComponent', { value: { set lifespan(v) {}, set currentLife(v) {}, set initialRadius(v) {}, set initialGlow(v) {}, set active(v) {} } });
  Object.defineProperty(flash, 'x', { set() {}, configurable: true });
  Object.defineProperty(flash, 'y', { set() {}, configurable: true });
  LightEmitter.castShadows[1] = 1;
  flash.onSpawned({ x: 0, y: 0, castShadows: false });
  assert.equal(LightEmitter.castShadows[1], 0);
  flash.onSpawned({ x: 0, y: 0 });
  assert.equal(LightEmitter.castShadows[1], 1);
});
