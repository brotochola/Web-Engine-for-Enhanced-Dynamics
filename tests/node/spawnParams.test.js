import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { registerOnLogicWorker as register, warnings } from '../helpers/logicWorkerEntities.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import {
  describeSpawnParams,
  createSpawnParamsState,
  fillSpawnParams,
  releaseSpawnParams,
  SPAWN_PARAMS_STACK_DEPTH,
} from '../../src/core/spawnParams.js';

// VISUAL_EDITOR_PLAN.md ED-41 and ED-42: static spawnParams. The classes register through the logic worker's own
// createGameObjectInstances, the path a scene takes, and spawn through the shipped GameObject.spawn → _spawnAt.

class Plank extends GameObject {
  static spawnParams = {
    width: { value: 220, min: 8, max: 4000, step: 1 },
    height: { value: 36, min: 8, max: 1000 },
    tint: { value: 0x495870, type: 'color' },
    alpha: { value: 1, min: 0, max: 1, step: 0.05 },
    shape: { value: 0, type: 'enum', options: { Box: 0, Circle: 1 } },
    solid: { value: true },
    label: { value: 'plank' },
    sprite: { value: 'square', type: 'sprite' },
  };

  speed = 0;

  onSpawned(params) {
    Plank.seen.push({ ...params });
    Plank.objects.push(params);
  }
}
Plank.seen = [];
Plank.objects = [];

class Plain extends GameObject {
  onSpawned(config) {
    Plain.seen.push(config);
  }
}
Plain.seen = [];

test('a class with spawnParams gets every default it was not given, and x and y', async () => {
  await register([[Plank, 4]]);
  Plank.seen.length = 0;
  Plank.spawn({ x: 10, y: 20, width: 600 });
  assert.deepEqual(Plank.seen[0], {
    width: 600,
    height: 36,
    tint: 0x495870,
    alpha: 1,
    shape: 0,
    solid: true,
    label: 'plank',
    sprite: 'square',
    x: 10,
    y: 20,
  });
  Plank.spawn({ x: 1.5, y: -2.25, width: 12.5, solid: false, label: 'other', alpha: null });
  assert.equal(Plank.seen[1].width, 12.5, 'a passed value wins');
  assert.equal(Plank.seen[1].solid, false);
  assert.equal(Plank.seen[1].label, 'other');
  assert.equal(Plank.seen[1].alpha, 1, 'null means the default');
  assert.equal(Plank.seen[1].x, 1.5);
  assert.equal(Plank.seen[1].y, -2.25);
});

test('the params object is the engine\'s, reused by the next spawn of the class', async () => {
  await register([[Plank, 4]]);
  Plank.objects.length = 0;
  const config = { x: 1, y: 2, width: 300 };
  Plank.spawn(config);
  Plank.spawn({ x: 3, y: 4 });
  assert.notEqual(Plank.objects[0], config, 'onSpawned does not get the caller\'s object');
  assert.equal(Plank.objects[0], Plank.objects[1], 'one object per class, refilled');
  assert.equal(Plank.objects[1].width, 220, 'a key the second spawn left out is back to its default');
  assert.deepEqual(config, { x: 1, y: 2, width: 300 }, 'the caller\'s config is not written to');
});

test('spawn() with no config: a class with spawnParams gets every default from one shared object (ED-42)', async () => {
  await register([[Plank, 4], [Plain, 4]]);
  Plank.seen.length = 0;
  Plank.spawn();
  Plank.spawn(null);
  assert.equal(Plank.seen[0].width, 220);
  assert.equal(Plank.seen[1].label, 'plank');
  assert.equal(Plank.seen[1].x, 0);
  // A class without params still gets a fresh object it may write into.
  Plain.seen.length = 0;
  Plain.spawn();
  Plain.spawn();
  assert.notEqual(Plain.seen[0], Plain.seen[1]);
  assert.equal(Object.isFrozen(Plain.seen[0]), false);
  Plain.seen[0].written = true;
});

test('a class without spawnParams gets the caller\'s object, as before', async () => {
  await register([[Plain, 2]]);
  Plain.seen.length = 0;
  const config = { x: 5, y: 6, anything: 1 };
  Plain.spawn(config);
  assert.equal(Plain.seen[0], config);
});

test('_spawnAt still copies engine keys and entity fields from the caller\'s config', async () => {
  await register([[Plank, 4]]);
  const plank = Plank.spawn({ x: 7, y: 8, speed: 3 });
  assert.equal(plank.speed, 3, 'a field of the entity is set from the config, declared or not');
  assert.equal(Transform.x[plank.index], 7);
  assert.equal(Transform.y[plank.index], 8);
  Plank.objects.length = 0;
  Plank.spawn({ x: 1, y: 1, forceProcessOnLogicWorker: -1 });
  assert.equal('forceProcessOnLogicWorker' in Plank.objects[0], false, 'engine keys are not params');
  assert.equal('speed' in Plank.objects[0], false);
});

test('a key nothing reads, or a value of the wrong type, warns once per class and key', async () => {
  await register([[Plank, 8]]);
  const typo = warnings(() => {
    Plank.spawn({ x: 0, y: 0, widht: 5 });
    Plank.spawn({ x: 0, y: 0, widht: 6 });
  });
  assert.equal(typo.length, 1);
  assert.match(typo[0], /"widht" is not in Plank\.spawnParams/);
  const quiet = warnings(() => {
    Plank.spawn({ x: 0, y: 0, speed: 2, forceProcessOnLogicWorker: -1, _saveRestore: undefined });
  });
  assert.deepEqual(quiet, [], 'engine keys, entity fields and "_" keys are read by the engine');
  const wrongType = warnings(() => {
    Plank.spawn({ x: 0, y: 0, width: '200' });
    Plank.spawn({ x: 0, y: 0, width: '300' });
  });
  assert.equal(wrongType.length, 1);
  assert.match(wrongType[0], /"width" is a number param, got string "200"/);
});

class Chain extends GameObject {
  static spawnParams = { level: { value: 0 } };

  onSpawned(params) {
    const level = params.level;
    Chain.entered.push(level);
    if (level < SPAWN_PARAMS_STACK_DEPTH) Chain.spawn({ x: 0, y: 0, level: level + 1 });
    // The child spawned above filled another params object: this one still holds this spawn's values.
    Chain.after.push(params.level);
  }
}
Chain.entered = [];
Chain.after = [];

test('an onSpawned that spawns its own class, five deep, keeps each level\'s params', async () => {
  await register([[Chain, 8]]);
  const state = GameObject._spawnParamsByType[Chain.entityType];
  Chain.spawn({ x: 0, y: 0 });
  assert.deepEqual(Chain.entered, [0, 1, 2, 3, 4]);
  assert.deepEqual(Chain.after, [4, 3, 2, 1, 0]);
  assert.equal(state.depth, 0, 'every level gave its object back');
  assert.equal(state.overflow, 1, 'the fifth level needed an object past the stack of four');
});

test('a throwing onSpawned gives its params object back', async () => {
  class Throws extends GameObject {
    static spawnParams = { size: { value: 1 } };
    onSpawned() {
      throw new Error('boom');
    }
  }
  await register([[Throws, 2]]);
  // On a logic worker the error is reported and the spawn finishes (gameCodeErrors.test.js).
  const original = console.error;
  console.error = () => {};
  try {
    Throws.spawn({ x: 0, y: 0 });
  } finally {
    console.error = original;
  }
  assert.equal(GameObject._spawnParamsByType[Throws.entityType].depth, 0);
});

class Door extends GameObject {}
class Lever extends GameObject {
  static spawnParams = {
    door: { value: null, type: 'entity', class: 'Door' },
    path: { value: [0, 0, 10, 0], type: 'points' },
  };

  onSpawned(params) {
    Lever.got.push({ door: params.door, path: params.path });
  }
}
Lever.got = [];

test('entity params arrive as the instance, points as a Float64Array', async () => {
  await register([[Door, 2], [Lever, 6]]);
  const door = Door.spawn({ x: 0, y: 0 });
  Lever.got.length = 0;
  Lever.spawn({ x: 0, y: 0, door: door.index });
  Lever.spawn({ x: 0, y: 0, door });
  Lever.spawn({ x: 0, y: 0, door: 999 });
  Lever.spawn({ x: 0, y: 0 });
  assert.equal(Lever.got[0].door, door, 'an index');
  assert.equal(Lever.got[1].door, door, 'an instance');
  assert.equal(Lever.got[2].door, null, 'an index with no entity');
  assert.equal(Lever.got[3].door, null, 'the default');
  assert.ok(Lever.got[3].path instanceof Float64Array);
  assert.deepEqual([...Lever.got[3].path], [0, 0, 10, 0], 'the declared default');
  const path = new Float64Array([1, 2, 3, 4]);
  Lever.got.length = 0;
  Lever.spawn({ x: 0, y: 0, path });
  assert.equal(Lever.got[0].path, path, 'a Float64Array is passed as is');
  warnings(() => Lever.spawn({ x: 0, y: 0, path: [5, 6] }));
  assert.ok(Lever.got[1].path instanceof Float64Array, 'an array is copied');
  assert.deepEqual([...Lever.got[1].path], [5, 6]);
});

test('a malformed declaration throws, naming the class and the key', () => {
  const declare = (spawnParams) => {
    const C = class Bad extends GameObject {};
    C.spawnParams = spawnParams;
    return () => describeSpawnParams(C);
  };
  assert.throws(declare({ x: { value: 1 } }), /Bad\.spawnParams\.x: "x" is not a param/);
  assert.throws(declare({ layer: { value: 'a' } }), /"layer" is not a param/);
  assert.throws(declare({ width: 220 }), /Bad\.spawnParams\.width must be \{ value/);
  assert.throws(declare({ width: { valeu: 220 } }), /unknown field "valeu"/);
  assert.throws(declare({ width: { value: 5000, max: 4000 } }), /value 5000 is above max 4000/);
  assert.throws(declare({ tint: { value: 0x495870, type: 'colour' } }), /type "colour" is not one of/);
  assert.throws(declare({ tint: { value: 0x495870, type: 'color', min: 0 } }), /a color param has no "min"/);
  assert.throws(declare({ shape: { value: 2, type: 'enum', options: { Box: 0, Circle: 1 } } }), /one of the options/);
  assert.throws(declare({ target: { value: null } }), /say its type/);
  assert.throws(declare({ path: { value: [1, 2, 3], type: 'points' } }), /x, y pairs/);
  assert.throws(declare({ '0': { value: 1 } }), /a param's name is letters/);
  assert.throws(declare([]), /must be an object/);
});

test('describeSpawnParams: keys, kinds and defaults in declaration order, cached per class', () => {
  const d = describeSpawnParams(Plank);
  assert.equal(describeSpawnParams(Plank), d);
  assert.deepEqual(d.keys, ['width', 'height', 'tint', 'alpha', 'shape', 'solid', 'label', 'sprite']);
  assert.deepEqual(d.kindNames, ['number', 'number', 'color', 'number', 'enum', 'bool', 'string', 'sprite']);
  assert.deepEqual(d.defaults, [220, 36, 0x495870, 1, 0, true, 'plank', 'square']);
  assert.equal(d.indexOf.tint, 2);
  assert.equal(d.entries[0].max, 4000);
  assert.equal(describeSpawnParams(Plain), null);
});

test('fillSpawnParams reads the caller\'s keys without writing them', () => {
  const state = createSpawnParamsState(Plank);
  const config = Object.freeze({ x: 1, y: 2, width: 3 });
  const params = fillSpawnParams(state, config, []);
  assert.equal(params.width, 3);
  releaseSpawnParams(state);
  assert.equal(state.depth, 0);
});

test('a params object keeps one hidden class whatever numbers a spawn writes', () => {
  // %HaveSameMap needs --allow-natives-syntax, so this runs in a child process.
  const spawnParamsUrl = new URL('../../src/core/spawnParams.js', import.meta.url).href;
  const script = `
    const { createSpawnParamsState, fillSpawnParams, releaseSpawnParams, newParamsObject } = await import(${JSON.stringify(spawnParamsUrl)});
    class Plank {}
    Plank.spawnParams = {
      width: { value: 220, min: 8, max: 4000 },
      tint: { value: 0x495870, type: 'color' },
      alpha: { value: 1, min: 0, max: 1 },
      solid: { value: true },
      label: { value: 'plank' },
    };
    const state = createSpawnParamsState(Plank);
    const fresh = newParamsObject(state);
    const fill = (config) => { const p = fillSpawnParams(state, config, []); releaseSpawnParams(state); return p; };
    const p = fill({ x: 1, y: 2, width: 300, tint: 255, alpha: 0 });
    fill({ x: 1.5, y: -2.25, width: 12.75, alpha: 0.5 });
    fill({ x: 3, y: 4, width: 7 });
    const same = [%HaveSameMap(p, fresh), %HaveSameMap(state.stack[0], state.stack[3])];
    process.stdout.write(JSON.stringify(same));
  `;
  const out = execFileSync(process.execPath, ['--allow-natives-syntax', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(out), [true, true]);
});
