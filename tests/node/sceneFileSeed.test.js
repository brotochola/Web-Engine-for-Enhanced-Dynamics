// A scene file's entity draws its spawn's random numbers from a stream of its own (sceneFile.js placedSeed,
// GameObject._spawnAt): the record's `seed`, else a hash of its name, mixed with the scene's seed. So an entity that
// picks its look at random (the little city's houses, 63 sprites) keeps it when the editor respawns it to apply a
// move, and when other entities are added or deleted; the thread's own stream is not drawn from.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { resetEntity } from '../../src/util/atomicFreeList.js';
import { rng, seededRandom, setPlacedSeedBase } from '../../src/util/utils.js';
import { checkSceneFile, serializeSceneFile, placedSeed, sceneFileSpawnConfig } from '../../src/core/sceneFile.js';
import { renamePlaced } from '../../src/core/debug/editor/sceneDocument.js';

/** A pool of N real slots of a GameObject class whose onSpawned draws three numbers and keeps the config it got. */
function housePool(N) {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  for (const k of ['x', 'y', 'rotation', 'rotC', 'rotS']) Transform[k] = new Float32Array(N);
  class House extends GameObject {}
  const draws = [];
  const configs = [];
  const pooled = Array.from({ length: N }, (_, index) => ({
    index,
    _hasComponents: {},
    onSpawned: (config) => {
      draws[index] = [rng(), rng(), rng()];
      configs[index] = config;
    },
  }));
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint16Array(new SharedArrayBuffer(N * 2));
  resetEntity(top, links, N, 1);
  Object.assign(House, { startIndex: 0, poolSize: N, entityType: 0, freeList: links, freeListTop: top, instances: pooled, _componentClassMap: {} });
  return { House, draws, configs };
}

function withSpawnSetup(fn) {
  const prev = { nextTick: GameObject.nextTick, force: GameObject.forceProcessOnLogicWorker, rng: globalThis.rng };
  GameObject.nextTick = null;
  GameObject.forceProcessOnLogicWorker = null;
  try {
    fn();
  } finally {
    GameObject.nextTick = prev.nextTick;
    GameObject.forceProcessOnLogicWorker = prev.force;
    globalThis.rng = prev.rng;
    setPlacedSeedBase(0);
  }
}

test("an entity of a file draws from its own stream: the same at every spawn, apart from the thread's", () => {
  withSpawnSetup(() => {
    const { House, draws, configs } = housePool(5);
    globalThis.rng = seededRandom(7, 'logic0');
    setPlacedSeedBase(7);
    const spawn = (record, index) =>
      GameObject._spawnAt(House, sceneFileSpawnConfig(record, 0, House, () => -1, new Set()), index);

    const house1 = { name: 'CityHouse1', class: 'House', x: 10, y: 20 };
    spawn(house1, 0);
    spawn({ ...house1, x: 300 }, 1); // the editor's respawn after a move
    assert.deepEqual(draws[1], draws[0], 'a move keeps what it drew');
    spawn({ name: 'CityHouse2', class: 'House', x: 10, y: 20 }, 2);
    assert.notDeepEqual(draws[2], draws[0], 'another name, other numbers');
    spawn({ ...house1, seed: 1234 }, 3);
    spawn({ name: 'Renamed', class: 'House', x: 0, y: 0, seed: 1234 }, 4);
    assert.notDeepEqual(draws[3], draws[0], 'a seed replaces the name');
    assert.deepEqual(draws[4], draws[3], 'the same seed, the same numbers');

    assert.equal(rng(), seededRandom(7, 'logic0')(), "the thread's stream drew nothing for them");
    for (const config of configs) assert.equal('_seed' in config, false, 'onSpawned does not see the seed');
    assert.deepEqual(configs[1], { x: 300, y: 20 });
  });
});

test("the scene's seed changes every entity's stream", () => {
  withSpawnSetup(() => {
    const { House, draws } = housePool(2);
    const record = { name: 'Tree1', class: 'House', x: 0, y: 0 };
    for (const [seed, index] of [[1, 0], [2, 1]]) {
      globalThis.rng = seededRandom(seed, 'logic0');
      setPlacedSeedBase(seed);
      GameObject._spawnAt(House, sceneFileSpawnConfig(record, 0, House, () => -1, new Set()), index);
    }
    assert.notDeepEqual(draws[1], draws[0]);
  });
});

test('the spawn config carries the seed last; a file may give one, an integer; the writer keeps it after config', () => {
  const record = { name: 'Rock3', class: 'Rock', x: 1, y: 2, config: { size: 3 } };
  const config = sceneFileSpawnConfig(record, 0, class Rock {}, () => -1, new Set());
  assert.deepEqual(Object.keys(config), ['x', 'y', 'size', '_seed']);
  assert.equal(config._seed, placedSeed(record));
  assert.equal(placedSeed({ name: 'Rock3', seed: -5 }), -5);
  assert.equal(placedSeed({ name: 'Rock3' }), placedSeed({ name: 'Rock3', seed: 1.5 }), 'only an integer is a seed');

  const doc = (seed) => ({ format: 1, script: 'a.js', entities: [{ name: 'A', class: 'Rock', x: 0, y: 0, seed }] });
  assert.doesNotThrow(() => checkSceneFile(doc(12), 'a.scene.json'));
  assert.throws(() => checkSceneFile(doc('12'), 'a.scene.json'), /"seed" must be an integer/);
  const text = serializeSceneFile({ format: 1, script: 'a.js', entities: [{ seed: 9, config: { size: 1 }, y: 0, x: 0, class: 'Rock', name: 'A' }] });
  assert.match(text, /\{ "name": "A", "class": "Rock", "x": 0, "y": 0, "config": \{ "size": 1 \}, "seed": 9 \}/);
});

test("a rename keeps the old name's seed, so the next load shows what the editor does; undone, the seed goes", () => {
  const record = { name: 'CityHouse33', class: 'CityHouse', x: 0, y: 0 };
  const scene = { sceneFile: { format: 1, entities: [record] }, _namedEntities: new Map([['CityHouse33', 5 * 65536]]), registeredClasses: [] };
  const seed = placedSeed(record);
  assert.equal(renamePlaced(scene, 'CityHouse33', 'Bar'), true);
  assert.equal(record.seed, seed);
  assert.equal(placedSeed(record), seed);
  assert.equal(renamePlaced(scene, 'Bar', 'CityHouse33'), true);
  assert.equal('seed' in record, false, 'its own name gives that seed again');
});
