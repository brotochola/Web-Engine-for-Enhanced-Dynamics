import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { collectSerializableEntities, applyEntitySaveRestore, SAVE_MAGIC } from '../../src/core/save/entitySaveSnapshot.js';
import { Transform } from '../../src/components/transform.js';
import { applySavePayloadToScene } from '../../src/core/save/saveGame.js';
import { GameObject } from '../../src/core/gameObject.js';
import { resetEntity, popEntity } from '../../src/util/atomicFreeList.js';
import { savePopulation } from '../bench/saveEncodeMicrobench.mjs';

// A hot reload must bring the whole scene back: every entity, serializable or
// not (Boids lost all 40000 boids, Predator its barrels), each at its own index.

test('a save with allEntities keeps every type; a plain save only the serializable ones', () => {
  const scene = savePopulation(16, 7);
  scene.registeredClasses[1].class.serializable = false;
  const types = (records) => [...new Set(records.map((r) => r.typeName))].sort();
  assert.deepEqual(types(collectSerializableEntities(scene)), ['Unit0', 'Unit2', 'Unit3']);
  assert.deepEqual(types(collectSerializableEntities(scene, { allEntities: true })), ['Unit0', 'Unit1', 'Unit2', 'Unit3']);
});

function sceneWith(classes) {
  const posted = [];
  return {
    posted,
    constructor: { name: 'Hot' },
    registeredClasses: classes.map((C) => ({ class: C, name: C.name })),
    workers: { logicWorkers: [{ postMessage: (m) => posted.push(m) }] },
  };
}

test('an allTypes restore replaces every type, asks for own indices, and skips a type the scene lost', async () => {
  class Kept {
    static serializable = true;
  }
  class Plain {}
  const scene = sceneWith([Kept, Plain]);
  const payload = {
    magic: SAVE_MAGIC,
    sceneName: 'Hot',
    entities: [
      { typeName: 'Kept', entityIndex: 1, components: {} },
      { typeName: 'Plain', entityIndex: 5, components: {} },
      { typeName: 'Gone', entityIndex: 8, components: {} },
      { typeName: 'Gone', entityIndex: 9, components: {} },
    ],
    joints: [],
  };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const done = applySavePayloadToScene(scene, payload, { allTypes: true });
    scene._pendingRestoreComplete.resolve({ restored: 2, failed: 0, idPairs: [1, 1, 5, 5] });
    await done;
  } finally {
    console.warn = realWarn;
  }
  const msg = scene.posted[0];
  assert.deepEqual(msg.serializableClassNames, ['Kept', 'Plain']);
  assert.deepEqual(msg.entities.map((r) => r.typeName), ['Kept', 'Plain']);
  assert.equal(msg.exactIndices, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Gone \(2\)/);

  // A player's save stays strict: a non-serializable type in it is an error.
  assert.throws(() => applySavePayloadToScene(sceneWith([Kept, Plain]), { ...payload, entities: payload.entities.slice(0, 2) }), /not serializable/);
});

test('_takeFreeIndices takes only the free wanted indices and keeps the order of the rest', () => {
  const count = 8;
  const start = 100;
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint16Array(new SharedArrayBuffer(count * 2));
  resetEntity(top, links, count, 1);
  const order = [];
  for (let i = popEntity(top, links, start); i >= 0; i = popEntity(top, links, start)) order.push(i);
  resetEntity(top, links, count, 1);
  const busy = popEntity(top, links, start); // in use: not free, cannot be taken
  const C = { startIndex: start, poolSize: count, freeList: links, freeListTop: top };

  const taken = GameObject._takeFreeIndices(C, new Set([busy, order[3], order[5]]));
  assert.deepEqual([...taken].sort(), [order[3], order[5]].sort());
  const rest = [];
  for (let i = popEntity(top, links, start); i >= 0; i = popEntity(top, links, start)) rest.push(i);
  assert.deepEqual(rest, order.filter((i) => i !== busy && i !== order[3] && i !== order[5]));
});

test('logic0 puts each entity back at its own index on a hot restore, and warns once per type', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  worker.workerIndex = 0;
  class Boid {
    static startIndex = 10;
    static poolSize = 4;
    static _componentClassMap = {};
  }
  self.Boid = Boid;
  const spawns = [];
  const hotFlags = [];
  const real = {
    spawn: GameObject.spawn,
    despawnAll: GameObject.despawnAll,
    take: GameObject._takeFreeIndices,
    flush: worker.processListUpdates,
    warn: console.warn,
  };
  const warnings = [];
  GameObject.despawnAll = () => 0;
  GameObject._takeFreeIndices = (C, wanted) => new Set(wanted);
  let full = 0;
  GameObject.spawn = (C, config, at = -1) => {
    spawns.push(at);
    hotFlags.push(config._hotRestore);
    if (at < 0 && ++full > 1) return null; // pool full after one
    return { index: at >= 0 ? at : 13 };
  };
  worker.processListUpdates = () => {};
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const records = [11, 12, 99, 98, 97].map((entityIndex) => ({ typeName: 'Boid', entityIndex, components: {} }));
    const reply = worker._restoreSave({ serializableClassNames: ['Boid'], entities: records, exactIndices: true });
    assert.deepEqual(spawns, [11, 12, -1, -1, -1], 'own index when it is the class’s, else from the pool');
    assert.equal(reply.restored, 3);
    assert.equal(reply.failed, 2);
    assert.equal(warnings.filter((w) => /could not spawn 2 Boid/.test(w)).length, 1);

    spawns.length = 0;
    full = -10;
    worker._restoreSave({ serializableClassNames: ['Boid'], entities: records.slice(0, 2) });
    assert.deepEqual(spawns, [-1, -1], 'a player save lets the pool choose');
    assert.deepEqual(hotFlags, [true, true, true, true, true, false, false], 'onSpawned is skipped on a hot restore only');
  } finally {
    GameObject.spawn = real.spawn;
    GameObject.despawnAll = real.despawnAll;
    GameObject._takeFreeIndices = real.take;
    worker.processListUpdates = real.flush;
    console.warn = real.warn;
    delete self.Boid;
  }
});

test('spawn skips onSpawned for a hot restore and runs it otherwise', () => {
  const N = 2;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  for (const k of ['x', 'y', 'rotation', 'rotC', 'rotS']) Transform[k] = new Float32Array(N);
  class Hot extends GameObject {}
  let calls = 0;
  const pooled = [0, 1].map((index) => ({ index, _hasComponents: {}, onSpawned: () => calls++ }));
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint16Array(new SharedArrayBuffer(N * 2));
  resetEntity(top, links, N, 1);
  Object.assign(Hot, { startIndex: 0, poolSize: N, entityType: 0, freeList: links, freeListTop: top, instances: pooled, _componentClassMap: {} });
  const prev = { nextTick: GameObject.nextTick, force: GameObject.forceProcessOnLogicWorker };
  GameObject.nextTick = null;
  GameObject.forceProcessOnLogicWorker = null;
  try {
    assert.equal(GameObject.spawn(Hot, { _saveRestore: {}, _hotRestore: true }, 1), pooled[1]);
    assert.equal(calls, 0, 'the saved components already hold what onSpawned did');
    GameObject.spawn(Hot, {});
    assert.equal(calls, 1);
  } finally {
    GameObject.nextTick = prev.nextTick;
    GameObject.forceProcessOnLogicWorker = prev.force;
  }
});

test('a schema drift warns once per class and component, not once per entity', () => {
  const N = 3;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  const Drifty = { name: 'Drifty', _componentClassMap: { transform: Transform } };
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    for (let i = 0; i < N; i++) applyEntitySaveRestore(i, Drifty, { Transform: { fingerprint: 1, fields: {} } });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.filter((w) => /schema drift for Transform on Drifty/.test(w)).length, 1);
});

test('a hot reload save ignores shouldSaveEntity (a player save keeps using it)', () => {
  const scene = savePopulation(8, 3);
  const C = scene.registeredClasses[0].class;
  C.shouldSaveEntity = () => false; // e.g. static terrain a normal load re-meshes
  const typesOf = (recs) => new Set(recs.map((r) => r.typeName));
  assert.equal(typesOf(collectSerializableEntities(scene)).has(C.name), false);
  assert.equal(typesOf(collectSerializableEntities(scene, { allEntities: true })).has(C.name), true);
});

test('readForcedWorkers lists the active entities pinned to a logic worker', async () => {
  const { readForcedWorkers } = await import('../../src/core/save/saveGame.js');
  const N = 4;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  const prev = GameObject.forceProcessOnLogicWorker;
  GameObject.forceProcessOnLogicWorker = Int16Array.from([1, -1, 0, 1]);
  Transform.active.set([1, 1, 1, 0]);
  try {
    assert.deepEqual(readForcedWorkers(), [[0, 1], [2, 0]]);
  } finally {
    GameObject.forceProcessOnLogicWorker = prev;
  }
});

test('a hot restore pins each entity to its saved worker; unpinned ones are unpinned', async () => {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  worker.workerIndex = 0;
  class Manager {
    static startIndex = 0;
    static poolSize = 2;
    static _componentClassMap = {};
  }
  self.Manager = Manager;
  const configs = [];
  const real = { spawn: GameObject.spawn, despawnAll: GameObject.despawnAll, take: GameObject._takeFreeIndices, flush: worker.processListUpdates };
  GameObject.despawnAll = () => 0;
  GameObject._takeFreeIndices = (C, wanted) => new Set(wanted);
  GameObject.spawn = (C, config, at) => (configs.push(config), { index: at });
  worker.processListUpdates = () => {};
  try {
    const entities = [0, 1].map((entityIndex) => ({ typeName: 'Manager', entityIndex, components: {} }));
    worker._restoreSave({ serializableClassNames: ['Manager'], entities, exactIndices: true, forcedWorkers: [[0, 1]] });
    assert.deepEqual(configs.map((c) => c.forceProcessOnLogicWorker), [1, -1]);
    configs.length = 0;
    worker._restoreSave({ serializableClassNames: ['Manager'], entities, exactIndices: true });
    assert.deepEqual(configs.map((c) => c.forceProcessOnLogicWorker), [undefined, undefined], 'no pins saved: classes decide');
  } finally {
    GameObject.spawn = real.spawn;
    GameObject.despawnAll = real.despawnAll;
    GameObject._takeFreeIndices = real.take;
    worker.processListUpdates = real.flush;
    delete self.Manager;
  }
});

test('a hot restore spawns a pinned class right here; a normal spawn hands it to its worker', () => {
  const N = 2;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  for (const k of ['x', 'y', 'rotation', 'rotC', 'rotS']) Transform[k] = new Float32Array(N);
  class Pinned extends GameObject {
    static forceProcessOnLogicWorker = 1;
  }
  const pooled = [0, 1].map((index) => ({ index, _hasComponents: {} }));
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint16Array(new SharedArrayBuffer(N * 2));
  resetEntity(top, links, N, 1);
  Object.assign(Pinned, { startIndex: 0, poolSize: N, entityType: 0, freeList: links, freeListTop: top, instances: pooled, _componentClassMap: {} });
  const sent = [];
  const prev = { nextTick: GameObject.nextTick, force: GameObject.forceProcessOnLogicWorker, self: globalThis.self };
  GameObject.nextTick = null;
  GameObject.forceProcessOnLogicWorker = new Int16Array(N).fill(-1);
  globalThis.self = { ...(globalThis.self || {}), logicWorker: { workerIndex: 0, totalLogicWorkers: 2, sendDataToWorker: (to) => sent.push(to), queueSpawnListUpdate() {} } };
  try {
    assert.equal(GameObject.spawn(Pinned, { _saveRestore: {}, _hotRestore: true }, 1), pooled[1]);
    assert.equal(sent.length, 0);
    assert.equal(GameObject.forceProcessOnLogicWorker[1], 1, 'still pinned to logic1');
    assert.equal(GameObject.spawn(Pinned, { y: 1 }), null);
    assert.deepEqual(sent, ['logic1']);
  } finally {
    GameObject.nextTick = prev.nextTick;
    GameObject.forceProcessOnLogicWorker = prev.force;
    globalThis.self = prev.self;
  }
});
