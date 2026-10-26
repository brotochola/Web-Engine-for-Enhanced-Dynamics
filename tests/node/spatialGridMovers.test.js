import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

// E-126: the spatial grid rewritten for the entities that changed (SpatialWorker._rebuildMovedRows)
// must leave the bytes the full rebuild (rebuildOwnedRows) leaves, frame after frame: the cells
// (and their bytes past the count), poses, owned lists and cell counts, and so the neighbour rows,
// candidates and markers the gather and the publish write from them. One scripted world
// (tests/helpers/spatialGridMoversWorker.mjs): three workers, every shape, sprites without a body,
// a cell over its cap and one at it, spawns, despawns, pooled respawns, collider switches (one
// before physics lists the body), reshapes, NaN poses, a -0 pose, a Y that rounds to the next row
// in float32, bodies falling asleep and waking and changing cell and owner, phases where most
// bodies move, a lost publish, a header read mid-publish, frames physics does not step. Each run is
// its own thread (Grid is static state).

const OFF = 1;
const AUTO = 0;
const FORCE = 2;

function run(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../helpers/spatialGridMoversWorker.mjs', import.meta.url), { workerData });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', reject);
  });
}

function firstDiff(a, b) {
  return a.sums.findIndex((s, i) => s !== b.sums[i]);
}

function transitions(path) {
  let toFull = 0;
  let toMovers = 0;
  for (let f = 1; f < path.length; f++) {
    if (path[f - 1] === 1 && path[f] === 0) toFull++;
    if (path[f - 1] === 0 && path[f] === 1) toMovers++;
  }
  return { toFull, toMovers };
}

test('the grid rewritten for what changed is the full rebuild, byte for byte (auto and forced)', async () => {
  const [base, auto, forced] = await Promise.all([run({ mode: OFF }), run({ mode: AUTO }), run({ mode: FORCE })]);
  assert.ok(base.paths.every((p) => p.every((v) => v === 0)), 'mode 1 rebuilds every frame');
  assert.ok(base.overfull === 0, 'mode 1 latches nothing');

  assert.equal(firstDiff(base, auto), -1, `auto differs from the full rebuild from frame ${firstDiff(base, auto)}`);
  assert.equal(firstDiff(base, forced), -1, `forced differs from the full rebuild from frame ${firstDiff(base, forced)}`);

  // The switch ran both ways in auto: the moved share crosses the threshold up and down.
  for (const path of auto.paths) {
    const movers = path.reduce((s, v) => s + v, 0);
    assert.ok(movers >= path.length / 3, `auto rewrote ${movers} of ${path.length} frames`);
    const { toFull, toMovers } = transitions(path);
    assert.ok(toFull >= 2 && toMovers >= 2, `auto switched to the rebuild ${toFull}× and back ${toMovers}×`);
  }
  // Forced: the rewrite on most frames, the rebuild on the ones it gives up (the lost publish, the
  // header mid-publish, a held entity leaving the cell over its cap) and the latch after each.
  for (const path of forced.paths) {
    const movers = path.reduce((s, v) => s + v, 0);
    assert.ok(movers >= path.length * 0.6, `forced rewrote ${movers} of ${path.length} frames`);
    assert.ok(movers < path.length - 1, 'forced gave up at least once');
  }
  assert.ok(forced.overfull > 0, 'some cell held more entities than its cap');
});

test('with detailed stats (the no-body count) the rewrite is the full rebuild', async () => {
  const [base, forced] = await Promise.all([run({ mode: OFF, detailed: true }), run({ mode: FORCE, detailed: true })]);
  assert.ok(base.noBody > 0, 'there are sprites without a body');
  assert.equal(firstDiff(base, forced), -1, `forced differs from the full rebuild from frame ${firstDiff(base, forced)}`);
});

// A variant of _rebuildMovedRows compiled from its own source (tests/bench/methodVariant.mjs). With
// no edit it must match: that proves the variant's scope. With one edit it must not: the test sees it.
const OVERFLOW_ANCHOR = 'if (total > maxPerCell ? heldLeaves !== 0 : heldLeaves !== leaves[cell]) return false;';
const MUTANTS = {
  identity: [],
  // Forget that a cell over its cap holds only the first maxEntitiesPerCell.
  overflow: [[OVERFLOW_ANCHOR, 'if (total <= maxPerCell && heldLeaves !== leaves[cell]) return false;']],
  // Do not count the entities that join a cell, so a cell over its cap looks complete.
  trueCount: [['trueCount[cell] = total - leaves[cell] + joins;', 'trueCount[cell] = total - leaves[cell];']],
  // Append a cell's joins in the order they came, not by id.
  joinOrder: [['while (at >= 0 && joinId[at] < i) {', 'while (false) {']],
  // Keep the owned list when an entity enters or leaves it.
  ownedList: [['if (ownedChanged) {', 'if (false) {']],
  // The home row from the double Y, not the float32 one findNeighbors reads back.
  homeRow: [['let homeRow = (Math.fround(posY) * invCellSize) | 0;', 'let homeRow = (posY * invCellSize) | 0;']],
  // Compare a sprite's bin position with ===, so 0 and -0 look alike.
  signOfZero: [
    ['(px !== lx ? px === px || lx === lx : px === 0 && 1 / px !== 1 / lx)', '(px !== lx && (px === px || lx === lx))'],
  ],
  // Miss a sprite that gets a collider before physics lists its body.
  looseCollider: [['        colliderActive[e] !== 0 ||\n', '']],
};

test('a mutant of the rewrite is caught, the unedited variant is not', async () => {
  const names = Object.keys(MUTANTS);
  const [base, ...runs] = await Promise.all([
    run({ mode: OFF }),
    ...names.map((name) => run({ mode: FORCE, patches: [{ method: '_rebuildMovedRows', edits: MUTANTS[name] }] })),
  ]);
  for (let m = 0; m < names.length; m++) {
    const diff = firstDiff(base, runs[m]);
    if (names[m] === 'identity') assert.equal(diff, -1, `the unedited variant differs from frame ${diff}: its scope is stale`);
    else assert.notEqual(diff, -1, `mutant ${names[m]} was not caught`);
  }
});
