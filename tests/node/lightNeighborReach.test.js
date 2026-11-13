// DX-LIGHTAPI A4 and its review: under raycasted lighting a light that casts searches its own reach (shadowRange, or
// its radius, past its offset), so no Collider.visualRange has to cover it. That row is also the entity's neighbour
// list, which its class may read: a class that reads its neighbours keeps the list its visualRange gives, as if it
// carried no light, and only a light no code reads widens. On real spatial workers (spatialWorkerMicrobench's
// setupSpatialKernel), every list rebuilt each frame.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Transform } from '../../src/components/transform.js';
import { Grid } from '../../src/core/grid.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

const N = 600;

/** The set of entity L's neighbours after a frame. */
function row(k, L) {
  k.frame();
  const base = L * Grid._stride;
  const out = [];
  for (let i = 0; i < Grid.neighborData[base]; i++) out.push(Grid.neighborData[base + 1 + i]);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

test('a casting light widens its row only when its class does not read its neighbours', async () => {
  const k = await setupSpatialKernel({
    n: N,
    workers: 1,
    still: true,
    spatial: { worldWidth: 3000, worldHeight: 2000, neighborReuseSkin: 0, neighborReuseMaxFrames: 1, neighborTickInterval: 1 },
  });
  for (const w of k.workers) w._raycastLights = true;
  // Entity L: a light of radius 600 on an entity whose own visualRange is 100.
  const L = 7;
  Collider.visualRange[L] = 100;
  // The scene registers LightEmitter; the kernel's layout does not: its columns, all off.
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  LightEmitter.active.fill(0);
  LightEmitter.castShadows.fill(1);
  LightEmitter.shadowRange.fill(0);
  LightEmitter.offsetX.fill(0);
  LightEmitter.offsetY.fill(0);
  const type = Transform.entityType[L];
  const readers = new Uint8Array(256).fill(1);
  Grid.neighborReaders = readers;

  // No light: the list its visualRange gives.
  const plain = row(k, L);
  assert.ok(plain.length > 0, 'the entity has neighbours within its visualRange');

  LightEmitter.active[L] = 1;
  LightEmitter.radius[L] = 600;
  // Its class reads its neighbours: the same list.
  readers[type] = 1;
  assert.deepEqual(row(k, L), plain, 'a reading class keeps the list its visualRange gives');

  // Its class reads none: the light's reach.
  readers[type] = 0;
  const lit = row(k, L);
  assert.ok(lit.length > plain.length * 4, `the light's reach (${lit.length} against ${plain.length})`);
  for (const id of plain) assert.ok(lit.includes(id), 'what was in range still is');

  // A light that casts nothing takes no row for itself, and with a reading class keeps its visualRange list.
  LightEmitter.castShadows[L] = 0;
  readers[type] = 1;
  assert.deepEqual(row(k, L), plain);
});
