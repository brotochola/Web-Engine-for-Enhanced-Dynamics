import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { collectInstanceFields, applyInstanceFields, ENGINE_INSTANCE_KEYS } from '../../src/core/save/instanceFields.js';
import { encodeBinarySaveBody, decodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';
import { requestInstanceFields, applySavePayloadToScene } from '../../src/core/save/saveGame.js';
import { SAVE_MAGIC } from '../../src/core/save/entitySaveSnapshot.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';

// A hot reload builds new instances. Plain JS fields game code keeps on them
// (U-Chain's scratch buffers, a branch's parent index, the terrain tool) must
// come back, or a tick that reads one throws.

class Tool {}

test('plain fields survive the trip (through JSON, as in a save); the rest stays behind', () => {
  const live = [
    null,
    {
      index: 1,
      _hasComponents: { Transform: true },
      tool: 'erase',
      drag: -1,
      grounded: true,
      nothing: null,
      far: Infinity,
      lost: NaN,
      pts: new Float32Array([1.5, -2, NaN]),
      ids: [3, [4, 5]],
      seen: Object.assign(Object.create(null), { a: 1 }),
      nested: { list: [{ x: 1 }], buf: new Int32Array([7, 8]) },
      fn: () => 1,
      inst: new Tool(),
      shared: new Float32Array(new SharedArrayBuffer(8)),
      half: [1, () => 2],
    },
    { index: 2, tool: 'sleeping' }, // inactive below
  ];
  const active = new Uint8Array([0, 1, 0]);
  const entries = JSON.parse(JSON.stringify(collectInstanceFields((i) => live[i], active)));
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], 1);
  assert.deepEqual(Object.keys(entries[0][1]).sort(), ['drag', 'far', 'grounded', 'ids', 'lost', 'nested', 'nothing', 'pts', 'seen', 'tool'].sort());

  const fresh = [null, { index: 1, kept: 'constructor value' }, null];
  assert.equal(applyInstanceFields((i) => fresh[i], entries), 1);
  const back = fresh[1];
  assert.equal(back.tool, 'erase');
  assert.equal(back.drag, -1);
  assert.equal(back.far, Infinity);
  assert.ok(Number.isNaN(back.lost));
  assert.ok(back.pts instanceof Float32Array);
  assert.deepEqual([...back.pts].slice(0, 2), [1.5, -2]);
  assert.ok(Number.isNaN(back.pts[2]));
  assert.deepEqual(back.ids, [3, [4, 5]]);
  assert.equal(back.seen.a, 1);
  assert.ok(back.nested.buf instanceof Int32Array);
  assert.equal(back.kept, 'constructor value');
  assert.equal(back.index, 1, 'engine fields are not written');
});

test('the engine sets no instance field outside ENGINE_INSTANCE_KEYS', () => {
  class Probe extends GameObject {}
  Probe.instances = [];
  const go = new Probe(0, {}, null, { view: true });
  const unknown = Object.keys(go).filter((k) => !ENGINE_INSTANCE_KEYS.has(k));
  assert.deepEqual(unknown, [], 'add new engine fields to ENGINE_INSTANCE_KEYS');
});

test('the save codec keeps instance fields, and writes no section without them', () => {
  const base = { sceneName: 'S', engineVersion: '0', layout: { types: [], totalEntityCount: 0 }, camera: null, sun: null, entities: [], joints: [] };
  const instanceFields = { perWorker: [[[3, { tool: 'draw', pts: { $typed: 'Float32Array', v: [1, 2] } }]], []] };
  const withFields = decodeBinarySaveBody(encodeBinarySaveBody({ ...base, instanceFields }));
  assert.deepEqual(withFields.instanceFields, instanceFields);
  assert.equal(decodeBinarySaveBody(encodeBinarySaveBody(base)).instanceFields, null);
});

function fakeScene(workerCount) {
  const posted = workerCount ? Array.from({ length: workerCount }, () => []) : [];
  return {
    posted,
    constructor: { name: 'Hot' },
    registeredClasses: [],
    workers: { logicWorkers: posted.map((box) => ({ postMessage: (m) => box.push(m) })) },
  };
}

test('requestInstanceFields asks every logic worker and keeps each answer by worker', async () => {
  const scene = fakeScene(2);
  const asking = requestInstanceFields(scene);
  assert.deepEqual(scene.posted.map((b) => b[0].msg), ['collectInstanceFields', 'collectInstanceFields']);
  scene._pendingInstanceFields(1, [[9, { b: 2 }]]);
  scene._pendingInstanceFields(0, [[4, { a: 1 }]]);
  assert.deepEqual(await asking, { perWorker: [[[4, { a: 1 }]], [[9, { b: 2 }]]] });
  assert.equal(await requestInstanceFields(fakeScene(0)), null);
});

async function restoreWith(scene, instanceFields, idPairs) {
  const payload = { magic: SAVE_MAGIC, sceneName: 'Hot', entities: [], joints: [], instanceFields };
  const done = applySavePayloadToScene(scene, payload, { allTypes: true });
  const logic0 = scene.posted[0];
  assert.equal(logic0[0].msg, 'restoreSave');
  scene._pendingRestoreComplete.resolve({ restored: 0, failed: 0, idPairs });
  await new Promise((r) => setTimeout(r, 0));
  const applied = scene.posted.map((b) => b.find((m) => m.msg === 'applyInstanceFields'));
  for (let w = 0; w < scene.posted.length; w++) scene._pendingInstanceFieldsApplied();
  await done;
  return applied.map((m) => m.entries);
}

test('a hot restore gives each worker its own fields back, at the restored indices', async () => {
  const saved = { perWorker: [[[4, { a: 1 }], [5, { gone: 1 }]], [[9, { b: 2 }]]] };
  const entries = await restoreWith(fakeScene(2), saved, [4, 4, 9, 12]);
  assert.deepEqual(entries, [[[4, { a: 1 }]], [[12, { b: 2 }]]], 'index 5 was not restored; 9 came back as 12');

  const merged = await restoreWith(fakeScene(3), saved, [4, 4, 5, 5, 9, 9]);
  assert.equal(merged.length, 3);
  for (const list of merged) assert.deepEqual(list, [[4, { a: 1 }], [5, { gone: 1 }], [9, { b: 2 }]], 'worker count changed: everyone gets all');
});

test('a logic worker reports and applies its own instances’ fields', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  worker.workerIndex = 1;
  const N = 3;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  class Chain {}
  Chain.startIndex = 0;
  Chain.instances = [{ index: 0 }, { index: 1, _pts: new Float32Array([1, 2]), _drag: 2 }, { index: 2 }];
  const prevClasses = GameObject.classByType.slice();
  GameObject.classByType.length = 0;
  GameObject.classByType[0] = Chain;
  Transform.active[1] = 1;
  const posted = [];
  const prevPost = self.postMessage;
  self.postMessage = (m) => posted.push(m);
  try {
    worker.handleCustomMessage({ msg: 'collectInstanceFields' });
    const report = posted.find((m) => m.msg === 'instanceFields');
    assert.equal(report.workerIndex, 1);
    assert.deepEqual(report.entries.map((e) => e[0]), [1]);

    Chain.instances[1] = { index: 1 }; // a new page: new instances
    worker.handleCustomMessage({ msg: 'applyInstanceFields', entries: report.entries });
    assert.ok(posted.some((m) => m.msg === 'instanceFieldsApplied'));
    assert.ok(Chain.instances[1]._pts instanceof Float32Array);
    assert.equal(Chain.instances[1]._drag, 2);
  } finally {
    self.postMessage = prevPost;
    GameObject.classByType.length = 0;
    GameObject.classByType.push(...prevClasses);
  }
});
