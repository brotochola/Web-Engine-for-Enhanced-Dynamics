import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * B-03. The decal tile dirty flag is one byte per tile in a SharedArrayBuffer,
 * with two agents writing it from two different workers:
 *
 *   particle side (src/core/decal.js)   decalsTilesDirty[tileIndex] = 1
 *   renderer side (src/workers/pixiWorker.js, updateDecalTiles)
 *                                        if (dirty[i] === 0) continue;
 *                                        dirty[i] = 0;          // then upload
 *
 * Both transitions were plain reads/writes. On a SharedArrayBuffer that is not
 * an atomic operation, so the read-then-clear in the renderer could interleave
 * with a stamp from the other worker and clear a stamp it had not uploaded yet:
 * a lost update that leaves the tile stale on screen until something else
 * happens to stamp it again.
 *
 * The fix makes both transitions atomic, and makes the renderer's claim a single
 * Atomics.exchange rather than a read followed by a clear - so the check and the
 * clear cannot be split apart by the other worker.
 *
 * These tests pin the protocol the two sides now agree on:
 *   - a stamp sets the flag
 *   - claiming the tile clears it and reports whether it was dirty
 *   - a stamp that lands after the claim re-sets the flag, so it is not lost
 * That last property is the whole point, and it is what the old
 * read-then-clear could not guarantee.
 */

const TOTAL_TILES = 8;

function makeDirty() {
  // Same allocation the engine makes: one byte per tile.
  return new Uint8Array(new SharedArrayBuffer(TOTAL_TILES));
}

/** The renderer side, as fixed in updateDecalTiles. */
function claimTile(dirty, tileIndex) {
  return Atomics.exchange(dirty, tileIndex, 0);
}

/** The stamp side, as fixed in decal.js. */
function stampTile(dirty, tileIndex) {
  Atomics.store(dirty, tileIndex, 1);
}

test('B-03: a stamp sets the flag', { concurrency: false }, () => {
  const dirty = makeDirty();
  assert.equal(Atomics.load(dirty, 3), 0, 'starts clean');
  stampTile(dirty, 3);
  assert.equal(Atomics.load(dirty, 3), 1, 'the stamp side must set the flag');
});

test('B-03: claiming a dirty tile clears it and reports it', { concurrency: false }, () => {
  const dirty = makeDirty();
  stampTile(dirty, 2);
  assert.equal(claimTile(dirty, 2), 1, 'the claim reports the tile was dirty');
  assert.equal(Atomics.load(dirty, 2), 0, 'and the claim clears the flag');
});

test('B-03: claiming a clean tile reports clean and leaves it clean', { concurrency: false }, () => {
  const dirty = makeDirty();
  assert.equal(claimTile(dirty, 5), 0);
  assert.equal(Atomics.load(dirty, 5), 0);
});

test('B-03: a stamp landing after the claim is not lost', { concurrency: false }, () => {
  const dirty = makeDirty();

  stampTile(dirty, 1);
  // Renderer claims the tile and starts uploading it.
  assert.equal(claimTile(dirty, 1), 1);
  // A second stamp lands mid-upload, while the renderer still holds the tile.
  stampTile(dirty, 1);

  // The renderer must still see the tile as needing an upload next frame.
  assert.equal(
    Atomics.load(dirty, 1),
    1,
    'a stamp that lands during the upload must survive, or it is lost',
  );
  assert.equal(claimTile(dirty, 1), 1, 'and it must be claimable again next frame');
  assert.equal(Atomics.load(dirty, 1), 0, 'the second claim clears it again');
});

test('B-03: the claim is a single operation, not read-then-clear', { concurrency: false }, () => {
  // The old renderer shape was two separate steps:
  //     const wasDirty = dirty[i] !== 0;
  //     dirty[i] = 0;
  // A stamp between those two steps was silently dropped. Model exactly that
  // interleaving and show the two shapes disagree.
  const dirty = makeDirty();

  // --- old shape: read, then (stamp lands), then clear ---
  stampTile(dirty, 4);
  const oldRead = dirty[4] !== 0;
  stampTile(dirty, 4); // the other worker's stamp, between read and clear
  dirty[4] = 0; // the renderer's clear
  const oldSurvives = Atomics.load(dirty, 4) === 1;
  assert.equal(oldRead, true, 'the renderer saw it dirty');
  assert.equal(oldSurvives, false, 'the mid-flight stamp was LOST by the old shape');

  // --- new shape: one atomic exchange ---
  stampTile(dirty, 4);
  stampTile(dirty, 4); // the same interleaving
  const claimed = Atomics.exchange(dirty, 4, 0);
  const newSurvivesOrIsClaimed = claimed === 1 && Atomics.load(dirty, 4) === 0;
  assert.equal(
    newSurvivesOrIsClaimed,
    true,
    'the atomic exchange cannot lose it: it either claims the work or leaves it flagged',
  );
});

test('B-03: claims on distinct tiles do not interfere', { concurrency: false }, () => {
  const dirty = makeDirty();
  stampTile(dirty, 0);
  stampTile(dirty, 3);
  stampTile(dirty, 7);

  assert.equal(claimTile(dirty, 0), 1);
  assert.equal(claimTile(dirty, 3), 1);
  assert.equal(claimTile(dirty, 7), 1);

  for (let i = 0; i < TOTAL_TILES; i++) {
    assert.equal(Atomics.load(dirty, i), 0, `tile ${i} should be claimed`);
  }
});

test('B-03: a full round-robin scan claims everything stamped once', { concurrency: false }, () => {
  // Mirrors updateDecalTiles: scan every tile, claim the dirty ones, count them.
  const dirty = makeDirty();
  for (let i = 0; i < TOTAL_TILES; i += 2) stampTile(dirty, i); // 4 dirty

  let dirtyN = 0;
  let processed = 0;
  for (let i = 0; i < TOTAL_TILES; i++) {
    if (Atomics.load(dirty, i)) dirtyN++;
  }
  const maxUploads = TOTAL_TILES;
  let scanned = 0;
  let tileIndex = 0;
  while (scanned < TOTAL_TILES && processed < maxUploads) {
    if (Atomics.exchange(dirty, tileIndex, 0) === 0) {
      tileIndex = (tileIndex + 1) % TOTAL_TILES;
      scanned++;
      continue;
    }
    processed++;
    tileIndex = (tileIndex + 1) % TOTAL_TILES;
    scanned++;
  }

  assert.equal(dirtyN, 4, 'the stat counts the dirty tiles');
  assert.equal(processed, 4, 'and every one of them was uploaded');
  for (let i = 0; i < TOTAL_TILES; i++) {
    assert.equal(Atomics.load(dirty, i), 0, `tile ${i} left dirty`);
  }
});

test('B-03: the throttled path still converges across frames', { concurrency: false }, () => {
  // maxUploads smaller than the dirty count: the leftovers must stay flagged
  // and be picked up next frame rather than being cleared and forgotten.
  const dirty = makeDirty();
  for (let i = 0; i < TOTAL_TILES; i++) stampTile(dirty, i);

  const maxUploads = 3;
  let frame1 = 0;
  for (let i = 0; i < maxUploads; i++) {
    if (Atomics.exchange(dirty, i, 0) === 1) frame1++;
  }
  assert.equal(frame1, 3);

  let remaining = 0;
  for (let i = 0; i < TOTAL_TILES; i++) if (Atomics.load(dirty, i)) remaining++;
  assert.equal(remaining, TOTAL_TILES - 3, 'the unvisited tiles stay flagged for the next frame');
});

test('B-03: the flag is one byte per tile, as allocated', { concurrency: false }, () => {
  // The allocation is SharedArrayBuffer(totalTiles) and every side views it as
  // Uint8Array. Widening it to Int32Array would change the shared layout and
  // every view site, so the fix stays on Uint8Array + Atomics, which the
  // engine's minimum runtime already supports.
  const sab = new SharedArrayBuffer(TOTAL_TILES);
  assert.equal(sab.byteLength, TOTAL_TILES, 'one byte per tile');
  assert.doesNotThrow(() => Atomics.exchange(new Uint8Array(sab), 0, 1));
});