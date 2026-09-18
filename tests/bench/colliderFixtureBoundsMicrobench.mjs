/**
 * Kernel: getColliderBounds + pointInCollider on compound ColliderFixture bodies.
 * Checksum: sum(halfW+halfH) and a bit-pack of hits on a fixed probe grid.
 */
import path from 'node:path';

import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { getColliderBounds, pointInCollider, _boundsResult } from '../../src/util/colliderUtils.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { makeIslandPolys } from './stressScenes/compoundFixture/makeIslandPolys.js';

const args = parseArgs();
const BODIES = args.bodies ?? 64;
const TRIS = args.tris ?? 8;

function initPool(entityCount, maxFixtures) {
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(entityCount)), entityCount);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(entityCount)), entityCount);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(entityCount)), entityCount);
  Transform.x = new Float32Array(entityCount);
  Transform.y = new Float32Array(entityCount);
  Transform.rotC = new Float32Array(entityCount);
  Transform.rotS = new Float32Array(entityCount);
  for (let i = 0; i < entityCount; i++) {
    Collider.active[i] = 1;
    RigidBody.active[i] = 1;
    RigidBody.static[i] = 0;
    Transform.active[i] = 1;
    Transform.x[i] = (i % 8) * 80;
    Transform.y[i] = ((i / 8) | 0) * 80;
    const ang = i * 0.31;
    Transform.rotC[i] = Math.cos(ang);
    Transform.rotS[i] = Math.sin(ang);
  }
  const fSize = ColliderFixture.getBufferSize(maxFixtures, entityCount);
  ColliderFixture.initializeArrays(new SharedArrayBuffer(fSize), maxFixtures, entityCount);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxFixtures, 1);
  ColliderFixture.initialize(maxFixtures);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);
}

initPool(BODIES, BODIES * TRIS + 8);
const polys = makeIslandPolys(TRIS, 12);
for (let i = 0; i < BODIES; i++) {
  if (!Collider.replacePolygons(i, polys)) {
    throw new Error(`replacePolygons failed at body ${i}`);
  }
}

const probes = [];
for (let py = -4; py <= 40; py += 8) {
  for (let px = -4; px <= 80; px += 8) probes.push(px, py);
}

function checksum() {
  let extent = 0;
  let hits = 0;
  for (let i = 0; i < BODIES; i++) {
    const b = getColliderBounds(i, _boundsResult);
    extent += b.halfW + b.halfH;
    const ox = Transform.x[i];
    const oy = Transform.y[i];
    for (let p = 0; p < probes.length; p += 2) {
      if (pointInCollider(i, ox + probes[p], oy + probes[p + 1])) hits |= 1 << ((i + p) & 31);
    }
  }
  return { extent, hits };
}

const before = checksum();
const bounds = timeIt('getColliderBounds', (iterations) => {
  for (let n = 0; n < iterations; n++) {
    for (let i = 0; i < BODIES; i++) getColliderBounds(i, _boundsResult);
  }
}, { iterations: 400, warmup: 40, reps: 5 });

const points = timeIt('pointInCollider', (iterations) => {
  for (let n = 0; n < iterations; n++) {
    for (let i = 0; i < BODIES; i++) {
      const ox = Transform.x[i];
      const oy = Transform.y[i];
      for (let p = 0; p < probes.length; p += 2) {
        pointInCollider(i, ox + probes[p], oy + probes[p + 1]);
      }
    }
  }
}, { iterations: 80, warmup: 8, reps: 5 });

const after = checksum();
if (Math.abs(before.extent - after.extent) > 1e-4 || before.hits !== after.hits) {
  throw new Error(`checksum drifted extent ${before.extent}→${after.extent} hits ${before.hits}→${after.hits}`);
}

const payload = {
  name: 'collider-fixture-bounds',
  bodies: BODIES,
  tris: TRIS,
  checksum: before,
  getColliderBounds: bounds,
  pointInCollider: points,
};
writeReport(
  path.isAbsolute(args.output || '')
    ? args.output
    : path.resolve(process.cwd(), args.output || 'tests/results/multi-fixture/collider-fixture-bounds-kernel.json'),
  payload,
);
console.log(`checksum extent=${before.extent.toFixed(4)} hits=${before.hits}`);
