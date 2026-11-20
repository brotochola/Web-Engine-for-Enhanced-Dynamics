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


/** Flash's static onSpawned on entity 1 (E-536: Flash is written the ECS way), its components' columns bound. */
async function flashSpawned(config) {
  const { Flash } = await import('../../src/core/flash.js');
  const { FlashComponent } = await import('../../src/components/flashComponent.js');
  const { Transform } = await import('../../src/components/transform.js');
  if (!FlashComponent.lifespan) FlashComponent.initializeArrays(new SharedArrayBuffer(FlashComponent.getBufferSize(4)), 4);
  if (!Transform.x || !Transform.entityType) Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(4)), 4);
  Flash.onSpawned(1, config);
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

test('E-518: a light off the view casts for the stamp only when its shadows reach the view, not its radius', async () => {
  bind();
  LightEmitter.castShadows.fill(1);
  // All four 1 000 px left of the 800 x 600 view, their radius 1 200 reaching into it.
  Transform.x.set([-1000, -1000, -1000, 400]);
  LightEmitter.radius.fill(1200);
  // 0: a reach of 160 (a headlight): its shadows end 840 px short of the view. 1: a reach of 1 100 reaches it.
  // 2: shadowRange 0, the radius. 3: in the view.
  LightEmitter.shadowRange.set([160, 1100, 0, 160]);
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
    assert.deepEqual(ids, [1, 2, 3]);
  } finally {
    Query.queryActiveEntities = savedActive;
    Query.queryPublishedFrame = savedFrame;
  }
});

test('Flash.spawn({ castShadows: false }) writes LightEmitter.castShadows 0, and its default casts', async () => {
  bind();
  const le = new LightEmitter(1);
  LightEmitter.castShadows[1] = 1;
  await flashSpawned({ x: 0, y: 0, castShadows: false });
  assert.equal(LightEmitter.castShadows[1], 0);
  await flashSpawned({ x: 0, y: 0 });
  assert.equal(LightEmitter.castShadows[1], 1);
});

test('DX-GLOWRADIUS: Flash.spawn({ glowRadius }) gives the flash a halo of its own size; a later spawn without one is the wide one', async () => {
  bind();
  LightEmitter.glowRadius = new Float32Array(4);
  const le = new LightEmitter(1);
  await flashSpawned({ x: 0, y: 0, glowRadius: 24 });
  assert.equal(LightEmitter.glowRadius[1], 24);
  await flashSpawned({ x: 0, y: 0 });
  assert.equal(LightEmitter.glowRadius[1], 0, 'a pooled flash does not keep the last one\'s halo');
});

test('DX-SPOT: Flash.spawn({ coneAngle, coneSoftness, direction }) gives the flash a cone; a later spawn without one is round', async () => {
  bind();
  for (const [k, T] of Object.entries({ dirC: Float32Array, dirS: Float32Array, coneHalf: Float32Array, coneSoftness: Float32Array, coneCos: Float32Array, coneInvSpan: Float32Array, followFlip: Uint8Array })) {
    LightEmitter[k] = new T(4);
  }
  const le = new LightEmitter(1);
  await flashSpawned({ x: 0, y: 0, coneAngle: Math.PI / 2, coneSoftness: 0.5, direction: Math.PI / 3 });
  assert.equal(LightEmitter.coneCos[1], Math.fround(Math.cos(Math.PI / 4)));
  assert.equal(LightEmitter.dirC[1], Math.fround(Math.cos(Math.PI / 3)));
  assert.equal(LightEmitter.dirS[1], Math.fround(Math.sin(Math.PI / 3)));
  assert.ok(Math.abs(le.coneSoftness - 0.5) < 1e-7);
  await flashSpawned({ x: 0, y: 0 });
  assert.equal(LightEmitter.coneCos[1], -2, 'round again');
  assert.equal(LightEmitter.dirC[1], 1);
  assert.equal(LightEmitter.dirS[1], 0);
});
