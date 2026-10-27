// A scene file's entity record may give its rotation (radians) and its scale beside x and y (ED-53): the spawn config
// carries them as `_rotation`, `_scaleX`, `_scaleY` before `_seed`, and GameObject._spawnAt applies them after
// onSpawned: the file's rotation wins over a class that sets its own, and its scale multiplies the size the class gave
// (ED-77: the sprite's scale, a platform stretched to its width, and the collider's shape). Code spawns are unchanged;
// onSpawned never sees the keys.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { resetEntity } from '../../src/util/atomicFreeList.js';
import { checkSceneFile, serializeSceneFile, sceneFileSpawnConfig } from '../../src/core/sceneFile.js';

const spawnConfigOf = (record) => sceneFileSpawnConfig(record, 0, class Rock {}, () => -1, new Set());

test('the spawn config: rotation and scale before the seed, only when the record gives them', () => {
  assert.deepEqual(Object.keys(spawnConfigOf({ name: 'A', class: 'Rock', x: 1, y: 2 })), ['x', 'y', '_seed']);
  const config = spawnConfigOf({ name: 'A', class: 'Rock', x: 1, y: 2, rotation: 0.5, scaleX: 2, scaleY: 3, config: { size: 4 } });
  assert.deepEqual(Object.keys(config), ['x', 'y', 'size', '_rotation', '_scaleX', '_scaleY', '_seed']);
  assert.deepEqual([config._rotation, config._scaleX, config._scaleY], [0.5, 2, 3]);
});

test('the format: numbers; the writer puts them after x and y, before config and seed', () => {
  const doc = (extra) => ({ format: 1, script: 'a.js', entities: [{ name: 'A', class: 'Rock', x: 0, y: 0, ...extra }] });
  assert.doesNotThrow(() => checkSceneFile(doc({ rotation: -1.5, scaleX: 0.5 }), 'a.scene.json'));
  assert.throws(() => checkSceneFile(doc({ rotation: '90' }), 'a.scene.json'), /"rotation" must be a number/);
  assert.throws(() => checkSceneFile(doc({ scaleY: null }), 'a.scene.json'), /"scaleY" must be a number/);
  const text = serializeSceneFile({ format: 1, script: 'a.js', entities: [{ seed: 3, config: { k: 1 }, scaleX: 2, rotation: 1, y: 0, x: 0, class: 'Rock', name: 'A' }] });
  assert.match(text, /\{ "name": "A", "class": "Rock", "x": 0, "y": 0, "rotation": 1, "scaleX": 2, "config": \{ "k": 1 \}, "seed": 3 \}/);
});

test('_spawnAt: the file’s rotation over what the class set, its scale times the class’s; code spawns unchanged', () => {
  const N = 3;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  for (const k of ['x', 'y', 'rotation', 'rotC', 'rotS']) Transform[k] = new Float32Array(N);
  class House extends GameObject {}
  const seen = [];
  const pooled = Array.from({ length: N }, (_, index) => ({
    index,
    _hasComponents: {},
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    setScale(x, y) {
      this.scaleX = x;
      this.scaleY = y;
    },
    onSpawned(config) {
      seen[index] = Object.keys(config);
      this.rotation = 0; // a class that sets its own
      this.setScale(3, 1.5); // and sizes its sprite (a platform: its width over the texture's)
    },
  }));
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint16Array(new SharedArrayBuffer(N * 2));
  resetEntity(top, links, N, 1);
  Object.assign(House, { startIndex: 0, poolSize: N, entityType: 0, freeList: links, freeListTop: top, instances: pooled, _componentClassMap: {} });
  const prev = { nextTick: GameObject.nextTick, force: GameObject.forceProcessOnLogicWorker };
  GameObject.nextTick = null;
  GameObject.forceProcessOnLogicWorker = null;
  try {
    GameObject._spawnAt(House, spawnConfigOf({ name: 'H1', class: 'House', x: 0, y: 0, rotation: 0.75, scaleX: 2 }), 0);
    assert.deepEqual([pooled[0].rotation, pooled[0].scaleX, pooled[0].scaleY], [0.75, 6, 1.5], 'the file’s turn; twice the class’s width, its height as the class set it');
    assert.deepEqual(seen[0], ['x', 'y'], 'onSpawned sees none of the file’s keys');
    GameObject._spawnAt(House, { x: 0, y: 0, rotation: 0.75 }, 1);
    assert.equal(pooled[1].rotation, 0, 'a code spawn: onSpawned has the last word, as before');
  } finally {
    GameObject.nextTick = prev.nextTick;
    GameObject.forceProcessOnLogicWorker = prev.force;
  }
});
