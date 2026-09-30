import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { SoundManager } from '../../src/core/soundManager.js';

// Four threads claim slots from one SAB at once (the logic workers calling
// SoundManager.play). No slot may be claimed twice, every free slot must end
// up claimed, and every failed claim must be counted as dropped.
if (!isMainThread) {
  SoundManager.initializeSlotSAB({ sab: workerData.sab, maxSlots: workerData.maxSlots });
  const go = new Int32Array(workerData.go);
  Atomics.wait(go, 0, 0);
  const claimed = [];
  for (let i = 0; i < workerData.calls; i++) {
    const s = SoundManager._writeSlot(workerData.id + 1, 0.5, 1, 0, false);
    if (s >= 0) claimed.push(s);
  }
  parentPort.postMessage(claimed);
} else {
  test('concurrent _writeSlot never claims a slot twice', async () => {
    const maxSlots = 512;
    const threads = 4;
    const calls = 200;
    const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + maxSlots * SoundManager.SLOT_SIZE) * 4);
    const i32 = new Int32Array(sab);
    let free = 0;
    for (let s = 0; s < maxSlots; s++) {
      const busy = s % 3 === 0;
      i32[SoundManager.HEADER_SIZE + s * SoundManager.SLOT_SIZE] = busy ? SoundManager.STATE_PLAYING : SoundManager.STATE_FREE;
      if (!busy) free++;
    }
    const go = new Int32Array(new SharedArrayBuffer(4));
    const results = [];
    const workers = [];
    for (let t = 0; t < threads; t++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { sab, maxSlots, calls, go: go.buffer, id: t } });
      workers.push(w);
      results.push(new Promise((res, rej) => {
        w.once('message', res);
        w.once('error', rej);
      }));
    }
    await new Promise((r) => setTimeout(r, 200));
    Atomics.store(go, 0, 1);
    Atomics.notify(go, 0);
    const claimed = (await Promise.all(results)).flat();
    for (const w of workers) await w.terminate();
    assert.equal(new Set(claimed).size, claimed.length, 'a slot was claimed twice');
    assert.equal(claimed.length, free, 'every free slot is claimed');
    assert.equal(Atomics.load(i32, SoundManager.HEADER_DROPPED), threads * calls - free);
    for (const s of claimed) {
      assert.equal(i32[SoundManager.HEADER_SIZE + s * SoundManager.SLOT_SIZE], SoundManager.STATE_PLAYING);
    }
  });
}
