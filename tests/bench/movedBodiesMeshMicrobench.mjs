/**
 * Mesh pose refill: every instance vs 5% of entities.
 *   node tests/bench/movedBodiesMeshMicrobench.mjs
 */
import assert from 'node:assert/strict';

import { mulberry32, timeIt } from './microbenchHelpers.mjs';
import {
  COLLIDER_FILL_FLOATS,
  packColliderFill,
  packColliderFillPoseOnly,
  packColliderFillPoseOnlyEntities,
  buildMeshInstanceRanges,
  resetColliderFillMeshLayerWarn,
} from '../../src/render/colliderFillBatch.js';

const BODIES = 2048;
const MOVERS = (BODIES * 0.05) | 0;

function makeViews(rng) {
  const n = BODIES;
  const views = {
    entityCount: n,
    meshActive: new Uint8Array(n),
    meshVisible: new Uint8Array(n),
    meshLayerMask: new Uint16Array(n),
    meshTint: new Uint32Array(n),
    meshAlpha: new Float32Array(n),
    fixtureCount: new Uint16Array(n),
    primaryShapeType: new Uint8Array(n),
    primaryWidth: new Float32Array(n),
    primaryHeight: new Float32Array(n),
    offsetX: new Float32Array(n),
    offsetY: new Float32Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    rotC: new Float32Array(n),
    rotS: new Float32Array(n),
    rbStatic: new Uint8Array(n),
    meshBits: 1,
    instanceEntity: new Uint32Array(n * 2),
  };
  for (let i = 0; i < n; i++) {
    views.meshActive[i] = 1;
    views.meshVisible[i] = 1;
    views.meshLayerMask[i] = 1;
    views.meshTint[i] = 0xffffff;
    views.meshAlpha[i] = 1;
    views.primaryShapeType[i] = 0;
    views.primaryWidth[i] = 20;
    views.primaryHeight[i] = 16;
    views.x[i] = rng() * 1000;
    views.y[i] = rng() * 1000;
    views.rotC[i] = 1;
    views.rotS[i] = 0;
  }
  return views;
}

resetColliderFillMeshLayerWarn();
const views = makeViews(mulberry32(1));
const cap = BODIES * 2;
const out = new Float32Array(cap * COLLIDER_FILL_FLOATS);
const packed = packColliderFill(out, cap, 0, views);
assert.ok(packed > MOVERS);
const start = new Uint32Array(BODIES);
const count = new Uint32Array(BODIES);
assert.equal(buildMeshInstanceRanges(views.instanceEntity, packed, start, count), true);
const moverIds = new Uint32Array(MOVERS);
for (let i = 0; i < MOVERS; i++) moverIds[i] = i * 10;
for (let i = 0; i < MOVERS; i++) views.x[moverIds[i]] += 4;
const full = new Float32Array(out);
packColliderFillPoseOnly(full, cap, packed, views.instanceEntity, views);
const partial = new Float32Array(out);
const rewritten = packColliderFillPoseOnlyEntities(
  partial, cap, moverIds, MOVERS, start, count, views,
);
assert.equal(rewritten > 0, true);
for (let i = 0; i < MOVERS; i++) {
  const e = moverIds[i];
  const base = (start[e] | 0) * COLLIDER_FILL_FLOATS;
  assert.equal(partial[base + 6], full[base + 6]);
}
const quiet = start[moverIds[MOVERS - 1] + 1] ? start[3] : start[BODIES - 1];
if ((count[BODIES - 1] | 0) > 0 && moverIds[MOVERS - 1] !== BODIES - 1) {
  const base = (start[BODIES - 1] | 0) * COLLIDER_FILL_FLOATS;
  assert.equal(partial[base + 6], out[base + 6], 'static instance unchanged');
}
void quiet;

timeIt('mesh pose-only all', () => {
  packColliderFillPoseOnly(full, cap, packed, views.instanceEntity, views);
}, { iterations: 20, warmup: 4 });
timeIt('mesh pose-only movers', () => {
  packColliderFillPoseOnlyEntities(partial, cap, moverIds, MOVERS, start, count, views);
}, { iterations: 20, warmup: 4 });
console.log('movedBodiesMeshMicrobench: checksum passed');
