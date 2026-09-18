/**
 * Kernel: Collider.replacePolygons from {x,y}[][] (object-graph).
 * Phase 7 adds replacePolygonsFlat and the A/B.
 * Checksum: fixtureCount + first vertex.
 */
import path from 'node:path';

import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { makeIslandPolys } from './stressScenes/compoundFixture/makeIslandPolys.js';

const args = parseArgs();
const BODIES = args.bodies ?? 64;
const TRIS = args.tris ?? 8;
const INCLUDE_FLAT = !!args.flat;

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
    Transform.rotC[i] = 1;
    Transform.rotS[i] = 0;
  }
  const fSize = ColliderFixture.getBufferSize(maxFixtures, entityCount);
  ColliderFixture.initializeArrays(new SharedArrayBuffer(fSize), maxFixtures, entityCount);
  const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, maxFixtures, 1);
  ColliderFixture.initialize(maxFixtures);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);
}

initPool(BODIES, BODIES * TRIS * 2 + 8);
const polysA = makeIslandPolys(TRIS, 12);
const polysB = makeIslandPolys(TRIS, 12.35);
for (let i = 0; i < BODIES; i++) {
  if (!Collider.replacePolygons(i, polysA)) throw new Error(`seed replace failed ${i}`);
}

function checksum() {
  let first = 0;
  let count = 0;
  for (let i = 0; i < BODIES; i++) {
    count += Collider.fixtureCount[i];
    const head = ColliderFixture.headOf(i);
    if (head !== ColliderFixture.INVALID_INDEX) {
      first += ColliderFixture.vertexX[ColliderFixture.vertBase(head)];
    }
  }
  return { fixtureCount: count, firstVertex: first };
}

const objectGraph = timeIt('replacePolygons_objectGraph', (iterations) => {
  for (let n = 0; n < iterations; n++) {
    const polys = n & 1 ? polysB : polysA;
    for (let i = 0; i < BODIES; i++) {
      if (!Collider.replacePolygons(i, polys)) throw new Error('replacePolygons failed in timed loop');
    }
  }
}, { iterations: 40, warmup: 4, reps: 5 });

const afterObjects = checksum();
if (afterObjects.fixtureCount !== BODIES * TRIS) {
  throw new Error(`checksum fixtureCount ${afterObjects.fixtureCount} expected ${BODIES * TRIS}`);
}

const payload = {
  name: 'replace-polygons',
  bodies: BODIES,
  tris: TRIS,
  checksum: afterObjects,
  objectGraph,
};

if (INCLUDE_FLAT && typeof Collider.replacePolygonsFlat === 'function') {
  const pack = (polys) => {
    const counts = new Uint8Array(polys.length);
    let n = 0;
    for (let i = 0; i < polys.length; i++) {
      counts[i] = polys[i].length;
      n += polys[i].length * 2;
    }
    const xy = new Float32Array(n);
    let o = 0;
    for (let i = 0; i < polys.length; i++) {
      for (let v = 0; v < polys[i].length; v++) {
        xy[o++] = polys[i][v].x;
        xy[o++] = polys[i][v].y;
      }
    }
    return { xy, counts, polygonCount: polys.length };
  };
  const flatA = pack(polysA);
  const flatB = pack(polysB);
  const flat = timeIt('replacePolygonsFlat', (iterations) => {
    for (let n = 0; n < iterations; n++) {
      const src = n & 1 ? flatB : flatA;
      for (let i = 0; i < BODIES; i++) {
        if (!Collider.replacePolygonsFlat(i, src.xy, src.counts, src.polygonCount)) {
          throw new Error('replacePolygonsFlat failed in timed loop');
        }
      }
    }
  }, { iterations: 40, warmup: 4, reps: 5 });
  const afterFlat = checksum();
  if (afterFlat.fixtureCount !== BODIES * TRIS) {
    throw new Error(`flat checksum fixtureCount ${afterFlat.fixtureCount}`);
  }
  payload.flat = flat;
  payload.checksumFlat = afterFlat;
  const delta = (flat.opsPerSec - objectGraph.opsPerSec) / objectGraph.opsPerSec;
  payload.delta = delta;
  payload.status = delta >= 0.03 ? 'KEEP' : delta <= -0.03 ? 'WORSE' : 'TIE';
  console.log(`flat vs object ${(delta * 100).toFixed(1)}% → ${payload.status}`);
}

writeReport(
  path.isAbsolute(args.output || '')
    ? args.output
    : path.resolve(process.cwd(), args.output || 'tests/results/multi-fixture/replace-polygons-kernel.json'),
  payload,
);
console.log(`checksum fixtureCount=${afterObjects.fixtureCount} first=${afterObjects.firstVertex}`);
