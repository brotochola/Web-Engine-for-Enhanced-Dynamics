// The terrain manager seeds WorldGrid from inside the logic workers, and each
// worker imports the scene module (collectWorkerScriptsToLoad puts the scene
// URL first). The planet disk therefore has to be configured at module scope:
// a create()-only assignment only reaches the main thread, the workers keep
// disk === undefined and seed the flat destructible landscape instead. That
// regression looked like ghost/stale terrain in the planet demo.
//
// These import the scene module the way a worker does (through the web-root
// hook, review M8) and read the result; they used to be regexes over the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/registerWebRoot.mjs';

test('importing the scene module configures the planet disk and grid', async () => {
  const { WorldGrid, ROWS } = await import('../../demos/destructibleTerrainScene/worldGrid.js');
  assert.ok(!WorldGrid.disk, 'no disk before the scene module runs');
  assert.equal(WorldGrid.rows, ROWS, 'the flat level bound before the scene module runs');
  await import('../../demos/planetPhysicsScene/planetPhysicsScene.js');
  const { N, CELL, RADIUS } = await import('../../demos/planetPhysicsScene/planetGravity.js');
  // A worker never calls create(); module evaluation alone has to do this.
  assert.deepEqual(WorldGrid.disk, { cols: N, rows: N, cell: CELL, cx: N >> 1, cy: N >> 1, radius: RADIUS, bedrock: 4 });
  // Plain statics, one copy per realm: the ship's worker raycasts with them.
  assert.equal(WorldGrid.cols, N);
  assert.equal(WorldGrid.rows, N);
  assert.equal(WorldGrid.cellSize, CELL);
});

test('castRay is bounded by the realm-local rows static', async () => {
  const { WorldGrid, ISO, CELL } = await import('../../demos/destructibleTerrainScene/worldGrid.js');
  WorldGrid.attach(64, 64, CELL);
  const col = 50;
  const row = 40;
  WorldGrid.amount[row * 64 + col] = ISO;
  const ox = 10 * CELL;
  const oy = (row + 0.5) * CELL;
  WorldGrid.rows = 20; // stale destructible bound in a realm that never seeded
  assert.equal(WorldGrid.castRay(ox, oy, 1, 0, 2000).hit, false);
  WorldGrid.rows = 64; // same buffer, correct planet bound
  const hit = WorldGrid.castRay(ox, oy, 1, 0, 2000);
  assert.equal(hit.hit, true);
  assert.equal(hit.gx, col);
  assert.equal(hit.gy, row);
});

test('planet scene clears the main-thread disk on destroy', async () => {
  const { WorldGrid } = await import('../../demos/destructibleTerrainScene/worldGrid.js');
  const { PlanetPhysicsScene } = await import('../../demos/planetPhysicsScene/planetPhysicsScene.js');
  const { Scene } = await import('../../src/core/scene.js');
  WorldGrid.disk = { cols: 1 };
  const superDestroy = Scene.prototype.destroy;
  Scene.prototype.destroy = async function () {};
  try {
    await PlanetPhysicsScene.prototype.destroy.call({ _removePanel() {} });
  } finally {
    Scene.prototype.destroy = superDestroy;
  }
  assert.equal(WorldGrid.disk, null);
});
