import test from 'node:test';
import assert from 'node:assert/strict';

import { BulletComponent } from '../../src/components/bulletComponent.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { collectLiveBulletIndices, tickBulletsBuffers } from '../../src/util/bulletTick.js';
import { buildActiveListBuffers, updateParticlePhysicsBuffers } from '../../src/util/particleIntegrate.js';
import { Grid } from '../../src/core/grid.js';
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { Ray } from '../../src/core/ray.js';
import {
  tickDecorationSwayBuffers,
  checksumRot,
  SWAY_LOOP,
  NO_PARENT,
} from '../bench/decorationSwayKernel.mjs';

function assertApprox(actual, expected, eps, msg) {
  assert.ok(Math.abs(actual - expected) <= eps, msg || `${actual} vs ${expected}`);
}

function emptyGrid() {
  Grid.cellSize = 128;
  Grid.invCellSize = 1 / 128;
  Grid.gridWidth = 4;
  Grid.gridHeight = 4;
  Grid.totalCells = 16;
  Grid.maxEntitiesPerCell = 8;
  Grid.cellByteSize = 4 + 8 * 2;
  const buf = new ArrayBuffer(Grid.totalCells * Grid.cellByteSize);
  Grid._gridCounts = new Uint8Array(buf);
  Grid._gridEntities = new Uint16Array(buf);
  Transform.active = new Uint8Array(1);
  Transform.x = new Float32Array(1);
  Transform.y = new Float32Array(1);
  Collider.active = new Uint8Array(1);
  Collider.shapeType = new Uint8Array(1);
  Collider.offsetX = new Float32Array(1);
  Collider.offsetY = new Float32Array(1);
  Collider.radius = new Float32Array(1);
  Collider.width = new Float32Array(1);
  Collider.height = new Float32Array(1);
  Collider.collisionLayer = new Uint8Array(1);
  Ray._rayGenStamp = new Uint32Array(1);
}

function bulletArgs(pool, liveIndices, liveCount) {
  return {
    maxBullets: pool,
    dtRatio: 1,
    active: BulletComponent.active,
    x: BulletComponent.x,
    y: BulletComponent.y,
    prevX: BulletComponent.prevX,
    prevY: BulletComponent.prevY,
    vx: BulletComponent.vx,
    vy: BulletComponent.vy,
    speed: BulletComponent.speed,
    bulletRotC: BulletComponent.bulletRotC,
    bulletRotS: BulletComponent.bulletRotS,
    damage: BulletComponent.damage,
    ownerId: BulletComponent.ownerId,
    shooterEntityType: BulletComponent.shooterEntityType,
    activeData: new Uint16Array(1 + pool),
    impactHeader: null,
    impactData: null,
    maxImpacts: 0,
    excludeSet: null,
    liveIndices: liveIndices || null,
    liveCount: liveCount || 0,
    onDespawn: null,
  };
}

test('two-pass bullet collect matches fused scan checksum', () => {
  const pool = 32;
  emptyGrid();
  const sab = new SharedArrayBuffer(BulletComponent.getBufferSize(pool));
  BulletComponent.initializeArrays(sab, pool);
  BulletComponent.bulletCount = pool;
  BulletComponent.active.fill(0);
  const liveSlots = [1, 7, 19, 30];
  for (const i of liveSlots) {
    BulletComponent.active[i] = 1;
    BulletComponent.x[i] = 10 + i;
    BulletComponent.y[i] = 5;
    BulletComponent.prevX[i] = 10 + i;
    BulletComponent.prevY[i] = 5;
    BulletComponent.vx[i] = 600;
    BulletComponent.vy[i] = 0;
    BulletComponent.speed[i] = 600;
    BulletComponent.bulletRotC[i] = 1;
    BulletComponent.bulletRotS[i] = 0;
    BulletComponent.damage[i] = 1;
  }
  const xBefore = liveSlots.map((i) => BulletComponent.x[i]);
  tickBulletsBuffers(bulletArgs(pool, null, 0));
  const fusedX = liveSlots.map((i) => BulletComponent.x[i]);
  for (let n = 0; n < liveSlots.length; n++) {
    assertApprox(fusedX[n], xBefore[n] + 600 / 60, 1e-4, `fused x[${liveSlots[n]}]`);
  }

  for (const i of liveSlots) BulletComponent.x[i] = 10 + i;
  const scratch = new Uint16Array(pool);
  const n = collectLiveBulletIndices(BulletComponent.active, pool, scratch);
  assert.equal(n, liveSlots.length);
  tickBulletsBuffers(bulletArgs(pool, scratch, n));
  for (let k = 0; k < liveSlots.length; k++) {
    assertApprox(BulletComponent.x[liveSlots[k]], fusedX[k], 1e-4, `two-pass x[${liveSlots[k]}]`);
  }

  for (const i of liveSlots) BulletComponent.x[i] = 10 + i;
  const given = new Uint16Array(liveSlots);
  tickBulletsBuffers(bulletArgs(pool, given, given.length));
  for (let k = 0; k < liveSlots.length; k++) {
    assertApprox(BulletComponent.x[liveSlots[k]], fusedX[k], 1e-4, `live-given x[${liveSlots[k]}]`);
  }
});

test('decoration sway scan matches compact snapshot checksum', () => {
  const pool = 64;
  const liveCount = 6;
  const sab = new SharedArrayBuffer(DecorationComponent.getBufferSize(pool));
  DecorationComponent.initializeArrays(sab, pool);
  DecorationComponent.active.fill(0);
  DecorationComponent.parentEntityIndex.fill(NO_PARENT);
  DecorationComponent.baseRotC.fill(1);
  DecorationComponent.baseRotS.fill(0);
  DecorationComponent.rotC.fill(1);
  DecorationComponent.rotS.fill(0);
  const snapshot = new Uint16Array(liveCount);
  const slots = [2, 9, 17, 33, 40, 61];
  for (let n = 0; n < slots.length; n++) {
    const i = slots[n];
    snapshot[n] = i;
    DecorationComponent.active[i] = 1;
    DecorationComponent.sway[i] = SWAY_LOOP;
    DecorationComponent.swayAmplitude[i] = 0.05;
    DecorationComponent.swayFrequency[i] = 1.2;
  }
  const soa = {
    active: DecorationComponent.active,
    sway: DecorationComponent.sway,
    swayAmplitude: DecorationComponent.swayAmplitude,
    swayFrequency: DecorationComponent.swayFrequency,
    swayPhase: DecorationComponent.swayPhase,
    rotC: DecorationComponent.rotC,
    rotS: DecorationComponent.rotS,
    baseRotC: DecorationComponent.baseRotC,
    baseRotS: DecorationComponent.baseRotS,
    parentEntityIndex: DecorationComponent.parentEntityIndex,
  };
  const opts = {
    maxDecorations: pool,
    snapshot,
    snapshotCount: liveCount,
    accumulatedTimeMs: 1000,
    deltaTime: 16.6667,
  };
  const rotC0 = DecorationComponent.rotC.slice();
  const rotS0 = DecorationComponent.rotS.slice();
  tickDecorationSwayBuffers('scan', soa, opts);
  const scanSum = checksumRot(snapshot, liveCount, DecorationComponent.rotC, DecorationComponent.rotS);
  DecorationComponent.rotC.set(rotC0);
  DecorationComponent.rotS.set(rotS0);
  tickDecorationSwayBuffers('snapshot', soa, opts);
  assertApprox(
    checksumRot(snapshot, liveCount, DecorationComponent.rotC, DecorationComponent.rotS),
    scanSum,
    1e-6,
    'sway checksum'
  );
});

test('particle occupancy two-pass: flag scan then physics', () => {
  const max = 32;
  const sab = new SharedArrayBuffer(ParticleComponent.getBufferSize(max));
  ParticleComponent.initializeArrays(sab, max);
  ParticleEmitter.initialize(max);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(max * 2), new SharedArrayBuffer(8));
  ParticleEmitter.resetFreeListInterleaved();
  ParticleComponent.active.fill(0);
  const live = [];
  for (let i = 0; i < max; i++) {
    if (i % 5 !== 0) continue;
    const idx = ParticleEmitter.acquireIndex();
    ParticleComponent.active[idx] = 1;
    ParticleComponent.x[idx] = 10;
    ParticleComponent.vx[idx] = 60;
    ParticleComponent.flat[idx] = 1;
    ParticleComponent.lifespan[idx] = 65535;
    live.push(idx);
  }
  const localIndices = new Uint16Array(max);
  const built = buildActiveListBuffers({
    maxParticles: max,
    active: ParticleComponent.active,
    localIndices,
    activeData: null,
    expectedActive: live.length,
  });
  assert.equal(built, live.length);
  updateParticlePhysicsBuffers({
    activeIndices: localIndices,
    count: built,
    deltaTime: 1000 / 60,
    dtRatio: 1,
    decalsEnabled: false,
    particlesToStamp: null,
    components: {
      active: ParticleComponent.active,
      x: ParticleComponent.x,
      y: ParticleComponent.y,
      z: ParticleComponent.z,
      vx: ParticleComponent.vx,
      vy: ParticleComponent.vy,
      vz: ParticleComponent.vz,
      lifespan: ParticleComponent.lifespan,
      currentLife: ParticleComponent.currentLife,
      gravity: ParticleComponent.gravity,
      alpha: ParticleComponent.alpha,
      fadeOnTheFloor: ParticleComponent.fadeOnTheFloor,
      timeOnFloor: ParticleComponent.timeOnFloor,
      initialAlpha: ParticleComponent.initialAlpha,
      stayOnTheFloor: ParticleComponent.stayOnTheFloor,
      despawnOnGroundContact: ParticleComponent.despawnOnGroundContact,
      flat: ParticleComponent.flat,
    },
  });
  for (const i of live) {
    assertApprox(ParticleComponent.x[i], 10 + 60, 1e-3, `particle x[${i}]`);
  }
});
