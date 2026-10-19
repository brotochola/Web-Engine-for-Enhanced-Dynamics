// The terrain manager seeds WorldGrid from inside the logic workers, and each
// worker imports the scene module (collectWorkerScriptsToLoad puts the scene
// URL first). The planet disk therefore has to be configured at module scope:
// a create()-only assignment only reaches the main thread, the workers keep
// disk === undefined and seed the flat destructible landscape instead. That
// regression looked like ghost/stale terrain in the planet demo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sceneUrl = new URL(
  '../../demos/planetPhysicsScene/planetPhysicsScene.js',
  import.meta.url,
);
const src = readFileSync(sceneUrl, 'utf8');

test('planet disk is assigned at module scope so workers seed a disk', () => {
  // Column 0 anchor: an assignment inside create() would be indented and the
  // search below returns -1, failing the test.
  const at = src.search(/^WorldGrid\.disk\s*=\s*\{/m);
  assert.notEqual(at, -1, 'planetPhysicsScene must assign WorldGrid.disk at module scope');

  const classAt = src.indexOf('export class PlanetPhysicsScene');
  assert.notEqual(classAt, -1, 'scene class not found');
  assert.ok(
    at < classAt,
    'WorldGrid.disk must be assigned before the class body (module scope, runs in workers)',
  );

  const block = src.slice(at, src.indexOf('};', at) + 2);
  assert.match(block, /cols:\s*N\b/, 'disk.cols must use the grid constant');
  assert.match(block, /rows:\s*N\b/, 'disk.rows must use the grid constant');
  assert.match(block, /radius:\s*RADIUS\b/, 'disk.radius must use the planet radius');
});

test('planet grid dimensions are set at module scope for every logic worker', () => {
  // These are plain statics (not shared memory), so the manager's assignment in
  // its onSpawned() only reaches logic worker 1. The ship is forced onto worker
  // 0 and raycasts with WorldGrid.castRay(); if worker 0 keeps the destructible
  // ROWS=200 bound, every ray fired from row >= 200 misses static terrain.
  const classAt = src.indexOf('export class PlanetPhysicsScene');
  assert.notEqual(classAt, -1, 'scene class not found');
  const moduleBlock = src.slice(0, classAt);
  assert.match(moduleBlock, /^WorldGrid\.cols\s*=\s*N\s*;/m, 'WorldGrid.cols must be set at module scope');
  assert.match(moduleBlock, /^WorldGrid\.rows\s*=\s*N\s*;/m, 'WorldGrid.rows must be set at module scope');
  assert.match(moduleBlock, /^WorldGrid\.cellSize\s*=\s*CELL\s*;/m, 'WorldGrid.cellSize must be set at module scope');
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

test('planet scene clears the main-thread disk on destroy', () => {
  const destroyAt = src.indexOf('async destroy()');
  assert.notEqual(destroyAt, -1, 'destroy() not found');
  const block = src.slice(destroyAt, destroyAt + 220);
  assert.match(block, /WorldGrid\.disk\s*=\s*null/, 'destroy() must clear WorldGrid.disk');
});
