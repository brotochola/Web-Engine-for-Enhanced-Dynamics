import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadWorker } from '../bench/workerHarness.mjs';

globalThis.window = globalThis.window || {};
const { Scene } = await import('../../src/core/scene.js');
const { saveGame, SaveStore } = await import('../../src/core/save/saveGame.js');

// B23 (part). saveGame read every SAB on main while the workers ran, so a save
// could catch a re-mesh, a joint or a physics step half done, with LiquidFun
// particles and bodies from different frames. It now captures inside
// Scene.pauseAndSettle(): pause, then a barrier each worker answers between
// frames, so every worker is idle while the save reads.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function fakeScene(replyDelays) {
  const log = [];
  const scene = {
    state: { pause: false },
    config: {},
    _barrier: null,
    _barrierSeq: 0,
    workers: {},
  };
  scene.workers.list = replyDelays.map((delay, w) => ({
    postMessage(m) {
      log.push(`${w}:${m.msg}`);
      if (m.msg === 'barrier' && delay >= 0) {
        setTimeout(() => {
          log.push(`${w}:done`);
          Scene.prototype.handleMessageFromWorker.call(scene, { data: { msg: 'barrierDone', id: m.id } });
        }, delay);
      }
    },
  }));
  scene.getAllWorkers = () => scene.workers.list;
  scene.pause = Scene.prototype.pause;
  scene.resume = Scene.prototype.resume;
  scene.pauseAndSettle = Scene.prototype.pauseAndSettle;
  return { scene, log };
}

test('pauseAndSettle resolves once every worker has answered after pausing', async () => {
  const { scene, log } = fakeScene([5, 1, 10]);
  await scene.pauseAndSettle();
  assert.equal(scene.state.pause, true);
  for (let w = 0; w < 3; w++) {
    assert.ok(log.indexOf(`${w}:pause`) < log.indexOf(`${w}:barrier`), `worker ${w} paused before the barrier`);
    assert.ok(log.includes(`${w}:done`), `worker ${w} answered`);
  }
  assert.equal(scene._barrier, null);
});

test('a worker that never answers is waited for only up to the timeout', async () => {
  const { scene } = fakeScene([1, -1]);
  const warn = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  try {
    const t0 = Date.now();
    await scene.pauseAndSettle(50);
    assert.ok(Date.now() - t0 >= 45);
  } finally {
    console.warn = warn;
  }
  assert.ok(warns.some((w) => /1 worker\(s\) did not answer/.test(w)));
});

test('workers answer the barrier', async () => {
  const worker = await loadWorker('spatialWorker.js', 'spatialWorker');
  const posted = [];
  const prev = self.postMessage;
  self.postMessage = (m) => posted.push(m);
  try {
    await worker.handleMessage({ data: { msg: 'barrier', id: 7 } });
  } finally {
    self.postMessage = prev;
  }
  assert.deepEqual(posted.find((m) => m.msg === 'barrierDone'), { msg: 'barrierDone', id: 7 });

  const host = readFileSync(join(root, 'src/box2d/physicsHostImpl.js'), 'utf8');
  assert.match(host, /data\.msg === 'barrier'\) \{[\s\S]{0,200}msg: 'barrierDone', id: data\.id \| 0/);
});

test('saveGame reads the world only while it is settled, then resumes', async () => {
  const { scene, log } = fakeScene([1, 2]);
  let settledDuringCapture = null;
  Object.defineProperty(scene, 'registeredClasses', {
    get() {
      settledDuringCapture = scene.state.pause && log.filter((l) => l.endsWith(':done')).length === 2;
      return [];
    },
  });
  scene.totalEntityCount = 0;
  const put = SaveStore.put;
  SaveStore.put = async (id) => {
    log.push('put');
    return { id };
  };
  try {
    await saveGame(scene, 'slot-settle');
  } finally {
    SaveStore.put = put;
  }
  assert.equal(settledDuringCapture, true, 'captured while every worker was idle');
  assert.equal(scene.state.pause, false, 'resumed');
  assert.ok(log.indexOf('0:resume') < log.indexOf('put'), 'resumed before storing');
});

test('a manual-step scene is not paused or resumed by a save', async () => {
  const { scene, log } = fakeScene([1]);
  scene.config.manualStep = true;
  scene.registeredClasses = [];
  scene.totalEntityCount = 0;
  const put = SaveStore.put;
  SaveStore.put = async (id) => ({ id });
  try {
    await saveGame(scene, 'slot-manual');
  } finally {
    SaveStore.put = put;
  }
  assert.deepEqual(log, []);
});
