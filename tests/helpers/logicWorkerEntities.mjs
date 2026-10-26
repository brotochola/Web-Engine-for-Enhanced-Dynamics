/**
 * Entity classes registered on a real logic worker in Node, through the worker's own createGameObjectInstances (the
 * path a scene takes): pools, instances, compiled spawnParams. Spawns then go through the shipped GameObject.spawn →
 * _spawnAt, and despawns through the shipped despawn. Used by the spawnParams and scene-file tests.
 */
import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { Messages } from '../../src/core/messages.js';
import { resetEntity } from '../../src/util/atomicFreeList.js';

/**
 * Register `specs` ([EntityClass, poolSize] pairs, entity types in that order) on the logic worker.
 * @returns {Promise<object>} the worker
 */
export async function registerOnLogicWorker(specs) {
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const total = specs.reduce((sum, [, n]) => sum + n, 0);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(total)), total);
  for (const k of ['x', 'y', 'rotation', 'rotC', 'rotS']) Transform[k] = new Float32Array(total);
  // The spawn generation column, as every scene has it (a despawn bumps it; Scene.getByName reads it).
  Messages.bind({ inboxes: [], spawnGen: Messages.createSpawnGenBuffer(total) }, []);
  GameObject.instances = [];
  GameObject.nextTick = null;
  GameObject.forceProcessOnLogicWorker = null;
  worker.globalEntityCount = total;
  worker.gameObjects = new Array(total).fill(null);
  worker.config = {};
  worker.registeredClasses = [];
  let start = 0;
  specs.forEach(([C, n], type) => {
    globalThis.self[C.name] = C;
    worker.registeredClasses.push({ name: C.name, poolSize: n, startIndex: start, endIndex: start + n, entityType: type });
    const links = new Uint16Array(new SharedArrayBuffer(n * 2));
    const top = new Int32Array(new SharedArrayBuffer(16));
    resetEntity(top, links, n, 1);
    C.freeList = links;
    C.freeListTop = top;
    C.instances = [];
    start += n;
  });
  await quietly(() => worker.createGameObjectInstances());
  return worker;
}

/** The console.warn messages written while `fn` runs. */
export function warnings(fn) {
  const seen = [];
  const original = console.warn;
  console.warn = (message) => seen.push(String(message));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
}
