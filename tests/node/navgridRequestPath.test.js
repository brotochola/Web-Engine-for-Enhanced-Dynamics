import test from 'node:test';
import assert from 'node:assert/strict';
import { NavGrid } from '../../src/core/navGrid.js';

// E-38: localize why NavStressScene services zero flowfield requests.
//
// E-37's counter proves the fact (FLOWFIELDS_SERVICED = 0.0 while logic0 reports
// ENTITIES_PROCESSED = 256, so 256 agents tick every frame and `requestVector` runs
// 256 times a frame). What it cannot say is WHICH of the three guards in
// `requestVector` sent every one of those calls home with a zero vector, because the
// function has exactly three exits before `_requestFlowfield` and they are all silent.
//
// This exercises the path in-process, where each guard can be observed directly.

/**
 * A navigation SAB built exactly the way `sceneSharedBuffers.js:589-594` builds it.
 *
 * `maxPathLength` has to be supplied explicitly: `NavStressScene`'s `navigation` block
 * does not set it, so the real code path gets it from `NAVIGATION_DEFAULTS`, and
 * `calculateSABSize` computes `pathSlotSize = 20 + maxPathLength * 4`. Leave it
 * undefined and `pathsSize` is `NaN`, the `SharedArrayBuffer` allocation throws
 * "Invalid typed array length", and the test fails for a reason that has nothing to do
 * with navigation.
 */
const NAV_CONFIG = { cellSize: 32, maxFlowfields: 64, maxPaths: 64, maxPathLength: 128 };

function freshNavGrid({ worldWidth = 2048, worldHeight = 2048 } = {}) {
  NavGrid.reset();
  const gridWidth = Math.ceil(worldWidth / NAV_CONFIG.cellSize);
  const gridHeight = Math.ceil(worldHeight / NAV_CONFIG.cellSize);
  const buffer = new SharedArrayBuffer(
    NavGrid.calculateSABSize(NAV_CONFIG, gridWidth, gridHeight),
  );
  NavGrid.writeHeader(buffer, NAV_CONFIG, gridWidth, gridHeight);
  NavGrid.initialize(buffer, { worldWidth, worldHeight });
  return { buffer, gridWidth, gridHeight };
}

test('getCellAt maps the stress scene positions to valid cells', () => {
  freshNavGrid();
  // The agent spawns at x = 80 + (i%8)*40, y = 80 + floor(i/8)*40, i in 0..255.
  const spawn = NavGrid.getCellAt(80, 80);
  const farSpawn = NavGrid.getCellAt(360, 1320);
  const target = NavGrid.getCellAt(400, 400);
  console.log('cells: spawn', spawn, 'farSpawn', farSpawn, 'target', target);
  assert.ok(spawn >= 0 && farSpawn >= 0 && target >= 0, 'stress-scene positions must map to valid cells');
});

test('a miss on a warm grid posts exactly one REQUEST_FLOWFIELD', () => {
  freshNavGrid();
  const info = NavGrid.getGridInfo();
  console.log('grid', JSON.stringify(info));
  const posted = [];
  NavGrid.setNavWorkerPort({ postMessage: (m) => posted.push(m) });

  const out = { x: 0, y: 0 };
  NavGrid.requestVector(80, 80, 400, 400, out);

  console.log('posted', JSON.stringify(posted), 'out', JSON.stringify(out));
  assert.equal(posted.length, 1, `expected one REQUEST_FLOWFIELD, got ${JSON.stringify(posted)}`);
  assert.equal(posted[0].type, 'REQUEST_FLOWFIELD');
  assert.ok(posted[0].targetCell >= 0 && posted[0].targetCell < info.totalCells);
  assert.deepEqual(out, { x: 0, y: 0 }, 'a miss returns a zero vector by design');
});

test('the same target requested twice posts once (pending dedup)', () => {
  freshNavGrid();
  const posted = [];
  NavGrid.setNavWorkerPort({ postMessage: (m) => posted.push(m) });
  const out = { x: 0, y: 0 };
  NavGrid.requestVector(80, 80, 400, 400, out);
  NavGrid.requestVector(80, 80, 400, 400, out);
  NavGrid.requestVector(80, 80, 400, 400, out);
  console.log('posted after 3 identical requests', posted.length);
  assert.equal(posted.length, 1, 'pending dedup should collapse identical requests within a frame');
});

test('being already at the target posts nothing', () => {
  freshNavGrid();
  const posted = [];
  NavGrid.setNavWorkerPort({ postMessage: (m) => posted.push(m) });
  const out = { x: 0, y: 0 };
  NavGrid.requestVector(400, 400, 400, 400, out);
  assert.equal(posted.length, 0, 'currentCell === targetCell must short-circuit');
});

test('without a port a miss warns and posts nothing', () => {
  freshNavGrid();
  NavGrid.setNavWorkerPort(null);
  const out = { x: 0, y: 0 };
  NavGrid.requestVector(80, 80, 400, 400, out);
  assert.deepEqual(out, { x: 0, y: 0 });
});