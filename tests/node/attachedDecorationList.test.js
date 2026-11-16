// E-334: the particle worker's attached pass walks the snapshot's attached decorations, listed when the snapshot is
// copied, and skips the pass while the pool's header counts none attached. Behaviour on a real worker: a decoration
// attached after the snapshot was copied is placed from the next frame on, follows its parent, is despawned with its
// parent, and a detached (despawned) or reused slot is left alone; the header's count follows spawns, despawns and a
// clear; a header without the word places the same decorations.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import { DecorationPool, decorationNoParent } from '../../src/core/decorationPool.js';
import { setupAttachedScan } from '../bench/attachedDecorationScanMicrobench.mjs';
import { setupAttachedSway } from '../bench/attachedSwayMicrobench.mjs';

const D = DecorationComponent;

/** Active decorations with a parent, counted from the columns. */
function attachedInColumns(n) {
  const none = decorationNoParent();
  let c = 0;
  for (let i = 0; i < n; i++) if (D.active[i] && D.parentEntityIndex[i] !== none) c++;
  return c;
}

/** Where the pass places decoration `i` under unturned or turned parent `p` (inheritParentRotation on). */
function placed(i, p) {
  const c = Transform.rotC[p];
  const s = Transform.rotS[p];
  return [
    Math.fround(Transform.x[p] + c * D.localX[i] - s * D.localY[i]),
    Math.fround(Transform.y[p] + s * D.localX[i] + c * D.localY[i]),
  ];
}

test('E-334: none attached, the pass writes nothing; one attached after the copy is placed from the next frame', async () => {
  const s = await setupAttachedScan({ n: 2000 });
  const { worker, n } = s;
  assert.equal(DecorationPool.attachedCount(), 0);
  const x0 = D.x.slice(0, n);
  const y0 = D.y.slice(0, n);
  s.frame();
  s.frame();
  assert.deepEqual(D.x.slice(0, n), x0);
  assert.deepEqual(D.y.slice(0, n), y0);

  // Attach one after the snapshot was copied: free a slot, spawn it hung from parent 3.
  const victim = worker._activeDecorationSnapshot[5];
  DecorationPool.despawn(victim);
  const i = DecorationPool.spawn({ parent: 3, localX: 12, localY: -30, scaleX: 1, scaleY: 1 });
  assert.ok(i >= 0);
  assert.equal(DecorationPool.attachedCount(), 1);
  s.frame();
  assert.deepEqual([D.x[i], D.y[i]], placed(i, 3), 'placed the frame after it was attached');

  // It follows its parent while the list does not change.
  Transform.x[3] += 40;
  Transform.y[3] -= 25;
  s.frame();
  assert.deepEqual([D.x[i], D.y[i]], placed(i, 3), 'follows its parent');

  // Its parent gone: despawned by the pass, and the count goes back to 0.
  Transform.active[3] = 0;
  s.frame();
  assert.equal(D.active[i], 0, 'despawned with its parent');
  assert.equal(DecorationPool.attachedCount(), 0);
  Transform.active[3] = 1;

  // The slot reused by a world-owned decoration: the pass leaves it where it was spawned.
  const j = DecorationPool.spawn({ x: 777, y: 333 });
  assert.equal(j, i, 'the freed slot comes back first');
  s.frame();
  s.frame();
  assert.deepEqual([D.x[j], D.y[j]], [777, 333]);
  assert.equal(DecorationPool.attachedCount(), 0);
});

test('E-334: a despawned (detached) decoration is left alone; the count follows spawns, despawns and a clear', async () => {
  const s = await setupAttachedScan({ n: 2000, attached: 64 });
  const { worker, n } = s;
  assert.equal(DecorationPool.attachedCount(), 64);
  assert.equal(attachedInColumns(n), 64);
  s.frame();
  const hung = [];
  for (let k = 0; k < worker._activeDecorationSnapshotCount; k++) {
    const i = worker._activeDecorationSnapshot[k];
    if (D.parentEntityIndex[i] < 16) hung.push(i);
  }
  assert.equal(hung.length, 64);
  for (const i of hung) assert.deepEqual([D.x[i], D.y[i]], placed(i, D.parentEntityIndex[i]));

  // Despawn every other one: the count drops, the rest still follow their parents, the despawned stay put.
  const gone = hung.filter((_, k) => k % 2 === 0);
  const kept = hung.filter((_, k) => k % 2 === 1);
  for (const i of gone) DecorationPool.despawn(i);
  assert.equal(DecorationPool.attachedCount(), 32);
  assert.equal(attachedInColumns(n), 32);
  const goneAt = gone.map((i) => [D.x[i], D.y[i]]);
  for (let p = 0; p < 16; p++) Transform.x[p] += 9;
  s.frame();
  for (const i of kept) assert.deepEqual([D.x[i], D.y[i]], placed(i, D.parentEntityIndex[i]));
  gone.forEach((i, k) => assert.deepEqual([D.x[i], D.y[i]], goneAt[k]));

  // An entity's attachment row despawned at once (clearAttachedAndDespawnAll): one fewer per decoration.
  const e = 40;
  DecorationPool.initializeAttachmentSlots(new SharedArrayBuffer(64), new SharedArrayBuffer(64 * 4 * 4), 64, 4);
  Transform.active[e % 16] = 1;
  const a = DecorationPool.spawn({ parent: e % 16, localX: 1, localY: 1 });
  const b = DecorationPool.spawn({ parent: e % 16, localX: 2, localY: 2 });
  assert.ok(DecorationPool.pushAttached(e, a) && DecorationPool.pushAttached(e, b));
  assert.equal(DecorationPool.attachedCount(), 34);
  DecorationPool.clearAttachedAndDespawnAll(e);
  assert.equal(DecorationPool.attachedCount(), 32);
  assert.equal(attachedInColumns(n), 32);

  // A clear: none attached.
  DecorationPool.despawnAll();
  assert.equal(DecorationPool.attachedCount(), 0);
  s.frame();
  assert.equal(worker._activeDecorationSnapshotCount, 0);
});

test('E-334: a list header without the count word still places every attached decoration', async () => {
  // setupAttachedSway's header is the 4-byte lock alone: no epoch, no count; the snapshot is copied every frame.
  const s = await setupAttachedSway({ n: 600, parents: 12 });
  assert.equal(DecorationPool.attachedCount(), -1);
  for (let p = 0; p < 12; p++) Transform.x[p] += 17;
  s.frame();
  for (let i = 0; i < s.n; i++) {
    const p = D.parentEntityIndex[i];
    assert.deepEqual([D.x[i], D.y[i]], placed(i, p), `decoration ${i}`);
  }
});
