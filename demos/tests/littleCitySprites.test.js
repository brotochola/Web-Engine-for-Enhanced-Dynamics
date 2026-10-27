// VISUAL_EDITOR_PLAN.md ED-72: littleCity's houses and trees declare their picture as a sprite param, which the
// editor's picker sets; empty, the entity's seed picks one as before. The draw happens either way, so what is drawn
// after it (a tree's flip) is the same with a sprite set.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../tests/helpers/registerWebRoot.mjs';

const { CityHouse } = await import('../littleCity/gameObjects/cityHouse.js');
const { CityTree } = await import('../littleCity/gameObjects/cityTree.js');
const { describeSpawnParams, KIND_SPRITE } = await import('../../src/core/spawnParams.js');

/** An entity of the class with recording components, no engine behind it. */
function stub(EntityClass) {
  const entity = Object.create(EntityClass.prototype);
  entity.rigidBody = {};
  entity.collider = {};
  entity.lightEmitter = {};
  entity.spriteRenderer = {};
  entity.sprites = [];
  entity.scales = [];
  entity.setSprite = (name) => entity.sprites.push(name);
  entity.setScale = (x, y) => entity.scales.push([x, y]);
  return entity;
}

/** Spawn with `params`, the seed's stream giving `draws`; what it set and how many it drew. */
function spawn(EntityClass, params, draws) {
  let drawn = 0;
  const saved = globalThis.rng;
  globalThis.rng = () => draws[drawn++];
  try {
    const entity = stub(EntityClass);
    entity.onSpawned({ ...params, x: 0, y: 0 });
    return { sprites: entity.sprites, scales: entity.scales, drawn };
  } finally {
    globalThis.rng = saved;
  }
}

test('houses and trees declare a sprite param, empty by default', () => {
  const house = describeSpawnParams(CityHouse);
  assert.deepEqual([house.keys, [...house.kinds], house.defaults], [['sprite'], [KIND_SPRITE], ['']]);
  const tree = describeSpawnParams(CityTree);
  assert.deepEqual([tree.keys, tree.kinds[0], tree.defaults], [['sprite', 'radius'], KIND_SPRITE, ['', 18]]);
});

test('a house: its sprite param, else one of the 63 from its seed; one draw either way', () => {
  assert.deepEqual(spawn(CityHouse, { sprite: '' }, [0.5]), { sprites: ['house_32'], scales: [[1, 1]], drawn: 1 });
  assert.deepEqual(spawn(CityHouse, { sprite: '' }, [0]).sprites, ['house_01']);
  assert.deepEqual(spawn(CityHouse, { sprite: '' }, [0.9999]).sprites, ['house_63']);
  assert.deepEqual(spawn(CityHouse, { sprite: 'house_07' }, [0.5]), { sprites: ['house_07'], scales: [[1, 1]], drawn: 1 });
});

test('a tree: its sprite param, else one of the 18; the flip drawn after it is the same either way', () => {
  const seeded = spawn(CityTree, { sprite: '', radius: 18 }, [0.2, 0.7]);
  assert.deepEqual(seeded.sprites, ['tree_04']);
  const set = spawn(CityTree, { sprite: 'tree_11', radius: 18 }, [0.2, 0.7]);
  assert.deepEqual(set.sprites, ['tree_11']);
  assert.deepEqual([set.scales, set.drawn], [seeded.scales, seeded.drawn]);
  assert.deepEqual(seeded.scales, [[1, 1]], 'a draw over 0.5: not flipped');
  assert.deepEqual(spawn(CityTree, { sprite: 'tree_11', radius: 36 }, [0.2, 0.3]).scales, [[-2, 2]], 'flipped, scaled by the radius');
});
