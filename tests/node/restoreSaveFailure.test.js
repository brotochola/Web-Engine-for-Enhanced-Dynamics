import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';

globalThis.window = globalThis.window || {};
const { Scene } = await import('../../src/core/scene.js');

// B23 (part). The logic worker's restoreSave handler had no try/catch. A throw
// anywhere in it (a user onSpawned, a bad chain or fixture record, joint
// restore) skipped the restoreSaveComplete reply, so main's pending promise
// never settled and the load hung. It must reply with the error, and main must
// reject.

test('a throw during restoreSave still answers, with the error', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const posted = [];
  const prevPost = self.postMessage;
  self.postMessage = (m) => posted.push(m);
  worker.workerIndex = 0;
  const prevFlush = worker.processListUpdates;
  worker.processListUpdates = () => {
    throw new Error('boom in restore');
  };
  try {
    try {
      worker.handleCustomMessage({ msg: 'restoreSave', serializableClassNames: [], entities: [] });
    } catch {
      // The old handler let it escape; the reply below is what matters.
    }
  } finally {
    worker.processListUpdates = prevFlush;
    self.postMessage = prevPost;
  }
  const reply = posted.find((m) => m && m.msg === 'restoreSaveComplete');
  assert.ok(reply, 'restoreSaveComplete was posted');
  assert.match(String(reply.error), /boom in restore/);
});

test('main rejects the restore when logic0 reports an error', async () => {
  let settled = null;
  const scene = {
    _pendingRestoreComplete: {
      resolve: (v) => (settled = { ok: v }),
      reject: (e) => (settled = { err: e }),
    },
  };
  Scene.prototype.handleMessageFromWorker.call(scene, {
    data: { msg: 'restoreSaveComplete', error: 'Error: boom in restore', restored: 1, failed: 0 },
  });
  assert.ok(settled && settled.err, 'rejected');
  assert.match(settled.err.message, /boom in restore/);
  assert.equal(scene._pendingRestoreComplete, null);
});

test('a clean restore still resolves', async () => {
  let settled = null;
  const scene = {
    _pendingRestoreComplete: {
      resolve: (v) => (settled = { ok: v }),
      reject: (e) => (settled = { err: e }),
    },
  };
  Scene.prototype.handleMessageFromWorker.call(scene, {
    data: { msg: 'restoreSaveComplete', restored: 3, failed: 1, idPairs: [5, 9] },
  });
  assert.deepEqual(settled, { ok: { restored: 3, failed: 1, idPairs: [5, 9] } });
});
