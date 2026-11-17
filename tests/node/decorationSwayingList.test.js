/**
 * E-506: the sway kernels walk the snapshot's swaying decorations (ParticleWorker._swayKernelCount), a list made again
 * when the snapshot is copied or the pool's sway epoch moves, which the facade moves when a decoration starts swaying
 * after its spawn (sway = true, impulseSway). A list outside the kernel's memory leaves the kernels on the whole
 * snapshot. That the swaying list sways the bytes the whole snapshot did is decorationSwayWasm.test.js's (its worker
 * path walks the list since E-506).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { Decoration } from '../../src/core/decoration.js';
import { SWAY_LOOP } from '../../src/util/decorationSway.js';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { loadWorker } from '../bench/workerHarness.mjs';

test("the sway epoch moves when the facade starts a sway, not when it stops one; a spawn moves the list's own", () => {
  buildPoolScene({ decorations: 8 });
  const i = DecorationPool.spawn({ x: 1, y: 1 });
  const e0 = DecorationPool.swayEpoch();
  assert.ok(e0 >= 0, 'the header has the word');
  Decoration.get(i).sway = true;
  assert.equal(DecorationPool.swayEpoch(), e0 + 1);
  Decoration.get(i).sway = false;
  assert.equal(DecorationPool.swayEpoch(), e0 + 1, 'stopping needs no new list: the kernel skips it');
  Decoration.get(i).impulseSway(0.2, 1);
  assert.equal(DecorationPool.swayEpoch(), e0 + 2);
});

test('the kernels walk the swaying list, made again on a new copy or a moved epoch, the whole snapshot without one', async () => {
  buildPoolScene({ decorations: 16 });
  const D = DecorationComponent;
  const ids = [];
  for (let k = 0; k < 6; k++) ids.push(DecorationPool.spawn({ x: 10 * k, y: 10, sway: k < 2 }));
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  const memory = new SharedArrayBuffer(64);
  worker._swayWasm = { buffer: memory, slotBytes: 2 }; // the kernel's memory, as far as swayingInMemory looks
  worker._activeDecorationSnapshot = new Uint16Array(ids);
  worker._activeDecorationSnapshotCount = ids.length;
  worker._swayingDecorations = new Uint16Array(memory, 0, 16);
  worker._decoSnapshotCopies = 1;
  const listed = () => [...worker._swayingDecorations.slice(0, worker._swayingCount)];

  assert.equal(worker._swayKernelCount(), 2);
  assert.deepEqual(listed(), ids.slice(0, 2), 'the swaying ones, in the snapshot\'s order');
  D.sway[ids[4]] = SWAY_LOOP; // a write past the facade: seen at the next copy or epoch
  assert.equal(worker._swayKernelCount(), 2);
  Decoration.get(ids[5]).sway = true;
  assert.equal(worker._swayKernelCount(), 4, 'the epoch moved: listed again, the one written past the facade too');
  assert.deepEqual(listed(), [ids[0], ids[1], ids[4], ids[5]]);
  Decoration.get(ids[3]).impulseSway(0.1, 1);
  assert.equal(worker._swayKernelCount(), 5);
  Decoration.get(ids[0]).sway = false;
  assert.equal(worker._swayKernelCount(), 5, 'a stopped one stays listed until the next list (the kernel skips it)');
  worker._decoSnapshotCopies++;
  assert.equal(worker._swayKernelCount(), 4, 'a new copy lists again');

  worker._swayingDecorations = new Uint16Array(16); // not in the kernel's memory
  assert.equal(worker._swayKernelCount(), ids.length, 'the whole snapshot');
});
