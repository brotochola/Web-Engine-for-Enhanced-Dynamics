// E-129: the bullet pool sizes its slot ids from bullet.maxBullets. On a scene's shared buffers
// (createSceneSharedBuffers, tests/helpers/poolScene.mjs) and a real particle worker booted on them:
// - at 65 535 bullets the 16-bit free list and [count, index, ...] lists it always had, viewed as Uint16Array;
// - at 200 000: FL4 and u32 lists; every slot spawns once, the particle worker's tick lists all 200 000 live
//   bullets and culls a visible list past 65 535 (what pre-render draws), despawned slots spawn again;
// - past MAX_POOL_SLOTS the scene refuses the pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BulletComponent } from '../../src/components/bulletComponent.js';
import { BulletPool } from '../../src/core/bulletPool.js';
import { Camera } from '../../src/core/camera.js';
import { popFl4, popU16 } from '../../src/util/atomicFreeList.js';
import { MAX_POOL_SLOTS } from '../../src/util/poolSlotWidth.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { initWorker, loadWorker } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';

async function bootWorker(scene) {
  const b = scene.buffers;
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  await initWorker(worker, {
    config: scene.config,
    globalEntityCount: scene.totalEntityCount,
    buffers: { componentData: { BulletComponent: b.componentData.BulletComponent } },
    extra: {
      maxBullets: scene.config.bullet.maxBullets,
      bulletFreeList: b.bulletFreeList,
      bulletFreeListTop: b.bulletFreeListTop,
      activeBulletsData: b.activeBulletsData,
      visibleBulletsData: b.visibleBulletsData,
      impactBuffer: b.impactBuffer,
    },
  });
  return worker;
}

test('at 65 535 bullets the pool keeps its 16-bit free list and lists', async () => {
  const n = 65535;
  const scene = buildPoolScene({ bullets: n });
  const b = scene.buffers;
  assert.equal(b.bulletFreeList.byteLength, n * 2);
  assert.equal(b.bulletFreeListTop.byteLength, 8);
  assert.equal(b.activeBulletsData.byteLength, (1 + n) * 2);
  assert.equal(b.visibleBulletsData.byteLength, (1 + n) * 2);
  assert.ok(BulletPool.freeList instanceof Uint16Array && BulletPool._popSlot === popU16);
  const worker = await bootWorker(scene);
  assert.ok(worker.activeBulletsData instanceof Uint16Array && worker.visibleBulletsData instanceof Uint16Array);
});

test('200 000 bullets: 32-bit slots through the pool, the tick and the visible list', async (t) => {
  const n = 200000;
  const scene = buildPoolScene({ bullets: n });
  const b = scene.buffers;
  assert.equal(b.bulletFreeList.byteLength, n * 4);
  assert.equal(b.bulletFreeListTop.byteLength, 16);
  assert.equal(b.activeBulletsData.byteLength, (1 + n) * 4);
  assert.ok(BulletPool.freeList instanceof Uint32Array && BulletPool._popSlot === popFl4);
  const worker = await bootWorker(scene);
  assert.ok(worker.activeBulletsData instanceof Uint32Array && worker.visibleBulletsData instanceof Uint32Array);

  // Still bullets (no velocity: the tick moves nothing and casts no ray) all over the world.
  const r = mulberry32(0x129b1);
  const seen = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const i = BulletPool.spawn({ x: r() * 4000, y: r() * 3000, vx: 0, vy: 0, damage: 1, ownerId: 0 });
    assert.ok(i >= 0 && !seen[i], `spawn ${k}: slot ${i}`);
    seen[i] = 1;
  }
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(BulletPool.spawn({ x: 1, y: 1, vx: 0, vy: 0, damage: 1, ownerId: 0 }), -1, 'the pool is full');
  } finally {
    console.warn = warn;
  }
  const cam = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(cam, 1920, 1080);
  cam[0] = 0.3;
  cam[5] = 0.3;
  worker.canvasWidth = 1920;
  worker.canvasHeight = 1080;
  worker.cameraData = cam;
  const tick = () => {
    worker._frameCamValid = false;
    worker.tickAllBullets(1000 / 60, 1);
  };
  tick();
  const active = worker.activeBulletsData;
  const visible = worker.visibleBulletsData;
  assert.equal(active[0], n, 'every bullet in the active list');
  const listed = new Uint8Array(n);
  for (let k = 1; k <= active[0]; k++) listed[active[k]]++;
  assert.ok(listed.every((c) => c === 1), 'each slot once');
  let maxVisible = -1;
  for (let k = 1; k <= visible[0]; k++) {
    const i = visible[k];
    assert.equal(BulletComponent.isItOnScreen[i], 1);
    if (i > maxVisible) maxVisible = i;
  }
  assert.ok(visible[0] > 1000 && maxVisible > 65535, `${visible[0]} in view, up to slot ${maxVisible}`);
  // Despawn the slots past 65 535 and spawn them again.
  for (let i = 65536; i < n; i++) BulletPool.despawn(i);
  tick();
  assert.equal(active[0], 65536);
  const again = new Set();
  for (let k = 65536; k < n; k++) again.add(BulletPool.spawn({ x: 10, y: 10, vx: 0, vy: 0, damage: 1, ownerId: 0 }));
  assert.equal(again.size, n - 65536);
  assert.ok([...again].every((i) => i >= 65536 && i < n), 'the returned slots');
  tick();
  assert.equal(active[0], n);
  t.diagnostic(`${visible[0]} of ${n} in view, up to slot ${maxVisible}`);
});

test('the scene refuses a bullet pool past MAX_POOL_SLOTS', () => {
  assert.throws(() => buildPoolScene({ bullets: MAX_POOL_SLOTS + 1 }), /bullet\.maxBullets must be an integer in \[0, 524287\]/);
});
