import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { GameObject } from '../../src/core/gameObject.js';
import { getFreeListCount, popEntity, popFl4 } from '../../src/util/atomicFreeList.js';
import {
  bindEntityIdWidth,
  entityIdWidth,
  MAX_ENTITIES_U32,
  maxEntitiesForWidth,
} from '../../src/util/entityIdWidth.js';
import { collisionPairKey, collisionPairUnpack } from '../../src/util/utils.js';
import { createContactWorker } from '../bench/contactFlowHarness.mjs';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { bindPoseColumns } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';

// DX-ENT1M: 32-bit entity ids up to 1 048 575 (2^20 - 1: FL4's 20-bit index, the spatial stamp's 20 id bits; 500 000
// before). A scene of that many entities builds its buffers (createSceneSharedBuffers, 'auto' width), its class's free
// list hands out every slot once, the spawn path takes the last slots, a despawn gives one back and the next spawn reuses
// it; pair keys round-trip at the top ids and the logic worker's contact table finds them.

const N = MAX_ENTITIES_U32;

/**
 * The class's pool as a scene registers it (scene.js registerEntityClass) and its instances made on first use, as a
 * logic worker makes them (LogicWorker._makeInstance); the pose columns as the worker harness binds them (they live in
 * Box2D's heap or the engine block in a scene).
 */
function bindPool(scene) {
  const Holder = scene.registeredClasses[0].class;
  Holder.poolSize = N;
  Holder.endIndex = N;
  Holder.instances = new Array(N).fill(null);
  GameObject._assignComponentClassMap(Holder);
  GameObject._makeAt = (i) => (Holder.instances[i] = new Holder(i, scene.config, null, { lazy: true }));
  bindPoseColumns(N);
  Transform.rotation = new Float32Array(N);
  return Holder;
}

test('the 32-bit ceiling is 1 048 575 and a scene of that many entities builds', { timeout: 120000 }, (t) => {
  assert.equal(N, 1048575);
  assert.equal(maxEntitiesForWidth(32), N);
  const scene = buildPoolScene({ entities: N });
  t.after(() => bindEntityIdWidth(16));
  assert.equal(entityIdWidth(), 32);
  const Holder = scene.registeredClasses[0].class;
  assert.ok(Holder.freeList instanceof Uint32Array && Holder.freeList.length === N);
  assert.equal(Holder.freeListTop.length, 4, 'the FL4 head');
  assert.equal(popEntity, popFl4, 'entities pop through FL4');
  assert.ok(GameObject.activeEntitiesData instanceof Uint32Array && GameObject.activeEntitiesData.length === N + 1);
  assert.equal(Holder._activeList.length, N + 1);
  assert.equal(getFreeListCount(Holder.freeListTop), N);
  assert.throws(() => buildPoolScene({ entities: N + 1 }), /totalEntityCount must be an integer in \[0, 1048575\]/);
});

test('spawn, despawn and reuse at 1 048 575: every slot once, the last slots spawned, a despawned slot back first', { timeout: 120000 }, (t) => {
  const scene = buildPoolScene({ entities: N });
  t.after(() => {
    GameObject._makeAt = null;
    bindEntityIdWidth(16);
  });
  const Holder = bindPool(scene);
  const top = Holder.freeListTop;
  const links = Holder.freeList;
  const edge = [N - 1, 524288, 524287, 65536, 0];
  // Through the whole list: every free index popped and the others pushed back (hot reload's restore path).
  const taken = GameObject._takeFreeIndices(Holder, new Set(edge));
  assert.deepEqual([...taken].sort((a, b) => a - b), [...edge].sort((a, b) => a - b));
  assert.equal(getFreeListCount(top), N - edge.length);

  const spawned = edge.map((i) => GameObject._spawnAt(Holder, { x: 10 + (i % 1000), y: 20 }, i));
  for (let k = 0; k < edge.length; k++) {
    const i = edge[k];
    assert.ok(spawned[k], `spawn at ${i}`);
    assert.equal(spawned[k].index, i);
    assert.equal(Transform.active[i], 1, `entity ${i} active`);
    assert.equal(Transform.x[i], 10 + (i % 1000));
  }

  // The top slot goes back and is the next one handed out.
  spawned[0].despawn();
  assert.equal(Transform.active[N - 1], 0);
  assert.equal(getFreeListCount(top), N - edge.length + 1);
  assert.equal(popEntity(top, links, Holder.startIndex), N - 1, 'the despawned slot comes back first');
  const again = GameObject._spawnAt(Holder, { x: 7, y: 8 }, N - 1);
  assert.equal(again.index, N - 1);
  assert.equal(Transform.active[N - 1], 1);
  assert.equal(Transform.x[N - 1], 7);

  // The rest of the pool: each index once, none of the live ones.
  const seen = new Uint8Array(N);
  for (const i of edge) seen[i] = 1;
  let popped = 0;
  for (let i = popEntity(top, links, Holder.startIndex); i >= 0; i = popEntity(top, links, Holder.startIndex)) {
    if (seen[i]) assert.fail(`index ${i} handed out twice`);
    seen[i] = 1;
    popped++;
  }
  assert.equal(popped, N - edge.length);
  assert.equal(seen.indexOf(0), -1, 'every index of the pool handed out');
  assert.equal(GameObject._spawnAt(Holder, { x: 1, y: 1 }, -1) ?? null, null, 'an empty pool spawns nothing');
});

test('pair keys round-trip and stay distinct at the top ids; the logic worker\'s contact table finds them', async (t) => {
  const { worker } = await createContactWorker({ n: 64, totalWorkers: 1 });
  bindEntityIdWidth(32);
  t.after(() => bindEntityIdWidth(16));
  const out = { a: 0, b: 0 };
  const pairs = [[N - 2, N - 1], [0, N - 1], [524287, 524288], [1, 1 + 524288], [65535, 65536 + 524288]];
  const rng = mulberry32(0x9a1);
  for (let k = 0; k < 20000; k++) {
    const a = N - 1 - ((rng() * 4096) | 0);
    const b = (rng() * N) | 0;
    if (a !== b) pairs.push([Math.min(a, b), Math.max(a, b)]);
  }
  const keys = new Map();
  for (const [a, b] of pairs) {
    const key = collisionPairKey(a, b);
    assert.ok(Number.isSafeInteger(key), `key of (${a}, ${b}) is an exact integer`);
    collisionPairUnpack(key, out);
    if (out.a !== a || out.b !== b) assert.fail(`(${a}, ${b}) unpacked as (${out.a}, ${out.b})`);
    const was = keys.get(key);
    if (was !== undefined && was !== `${a},${b}`) assert.fail(`(${a}, ${b}) and ${was} share a key`);
    keys.set(key, `${a},${b}`);
  }
  // E-282's table: put, find, find through the key (isCollidingWith's path), delete.
  const unique = [...keys.values()].map((s) => s.split(',').map(Number));
  unique.forEach(([a, b], slot) => worker._pairPut(a, b, slot));
  unique.forEach(([a, b], slot) => {
    if (worker._pairFind(a, b) !== slot) assert.fail(`(${a}, ${b}) found at ${worker._pairFind(a, b)}, not ${slot}`);
  });
  const named = unique.slice(0, 5);
  for (const [a, b] of named) assert.equal(worker._hasPair(collisionPairKey(a, b)), true, `(${a}, ${b}) found by its key`);
  for (const [a, b] of named) worker._pairDelete(a, b);
  for (const [a, b] of named) assert.equal(worker._hasPair(collisionPairKey(a, b)), false, `(${a}, ${b}) deleted`);
  unique.slice(5).forEach(([a, b], k) => assert.equal(worker._pairFind(a, b), k + 5));
  assert.equal(worker._hasPair(collisionPairKey(N - 3, N - 1)), false, 'a pair never put');
});
