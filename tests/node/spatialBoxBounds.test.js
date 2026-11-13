// E-245: the spatial grid passes compute a box collider's bounds inline instead of calling getColliderBounds. On a real
// spatial worker, boxes at every angle class, with and without offsets, beside circles and loose sprites: the pose each
// pass writes (x, y, the larger half extent, as float32) is the one getColliderBounds gives, bit for bit, in the full
// rebuild (rebuildOwnedRows), the latched one that seeds the movers path, and the movers path itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { getColliderBounds } from '../../src/util/colliderUtils.js';
import { bindMovedBodies, createMovedBodiesSab, publishMovedBodies } from '../../src/box2d/box2dMovedBodies.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

const N = 3000;
const COLS = 60;

async function world() {
  const spatial = { worldWidth: COLS * 40 + 400, worldHeight: Math.ceil(N / COLS) * 40 + 400, cellSize: 128, maxNeighbors: 32, maxEntitiesPerCell: 64, rowsPerBlock: 2 };
  const k = await setupSpatialKernel({ n: N, workers: 1, spatial, publishMemory: 'product', wasm: {} });
  const worker = k.workers[0];
  worker.queryVersionData = new Int32Array(new SharedArrayBuffer(4));
  bindMovedBodies(createMovedBodiesSab(N));
  const r = mulberry32(0xe245);
  for (let i = 0; i < N; i++) {
    Transform.active[i] = 1;
    Transform.x[i] = 200 + (i % COLS) * 40 + r() * 8;
    Transform.y[i] = 200 + ((i / COLS) | 0) * 40 + r() * 8;
    const a = r() * 2 * Math.PI;
    Transform.rotC[i] = Math.cos(a);
    Transform.rotS[i] = Math.sin(a);
    Collider.active[i] = i % 7 === 6 ? 0 : 1; // every seventh a loose sprite
    Collider.shapeType[i] = i % 5 === 4 ? ShapeType.Circle : ShapeType.Box;
    Collider.width[i] = 4 + r() * 30;
    Collider.height[i] = 4 + r() * 30;
    Collider.radius[i] = i % 5 === 4 ? 3 + r() * 10 : 0;
    Collider.offsetX[i] = i % 3 === 0 ? 0 : (r() - 0.5) * 20;
    Collider.offsetY[i] = i % 3 === 0 ? 0 : (r() - 0.5) * 20;
    Collider.visualRange[i] = 0;
    SpriteRenderer.active[i] = 1;
    RigidBody.active[i] = 1;
  }
  const active = worker.activeEntitiesData;
  for (let i = 0; i < N; i++) active[1 + i] = i;
  active[0] = N;
  return { worker, r };
}

/** Every collider's pose against getColliderBounds, as the pass stores it (float32). */
function assertPoses(worker, label) {
  const pos = worker.entityPosData;
  const out = { posX: 0, posY: 0, halfW: 0, halfH: 0 };
  let boxes = 0;
  for (let i = 0; i < N; i++) {
    if (!Collider.active[i]) continue;
    getColliderBounds(i, out);
    const ext = out.halfW > out.halfH ? out.halfW : out.halfH;
    const want = [Math.fround(out.posX), Math.fround(out.posY), Math.fround(ext)];
    const got = [pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2]];
    if (!want.every((v, c) => Object.is(v, got[c]))) assert.fail(`${label}: entity ${i} (shape ${Collider.shapeType[i]}) pose ${got} != ${want}`);
    if (Collider.shapeType[i] === ShapeType.Box) boxes++;
  }
  assert.ok(boxes > 2000, `${label}: ${boxes} boxes checked`);
}

test('E-245: the full rebuild writes each box\'s getColliderBounds pose, bit for bit', async () => {
  const { worker } = await world();
  worker._gridMoversMode = 1; // the full rebuild every frame
  worker._rebuildGrid();
  assertPoses(worker, 'rebuildOwnedRows');
});

test('E-245: the latched rebuild and the movers path write the same poses as getColliderBounds', async () => {
  const { worker, r } = await world();
  worker._gridMoversMode = 2; // the movers path whenever it can run
  worker._rebuildGrid(); // seeds through _rebuildOwnedRowsLatched
  assertPoses(worker, '_rebuildOwnedRowsLatched');
  // A tenth of the bodies move and turn; physics publishes them; the movers path rewrites their rows.
  const moved = [];
  for (let i = 0; i < N; i += 10) {
    Transform.x[i] += (r() - 0.5) * 60;
    Transform.y[i] += (r() - 0.5) * 60;
    const a = r() * 2 * Math.PI;
    Transform.rotC[i] = Math.cos(a);
    Transform.rotS[i] = Math.sin(a);
    moved.push(i);
  }
  publishMovedBodies(Int32Array.from(moved), null, moved.length, null, 0, null);
  worker._rebuildGrid();
  assert.equal(worker._gridMoversThisFrame | 0, 1, 'the movers path ran');
  assertPoses(worker, '_rebuildMovedRows');
});
