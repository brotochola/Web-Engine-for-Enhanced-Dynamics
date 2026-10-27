// A scene file's joints and decorations at load (VISUAL_EDITOR_PLAN.md ED-21, ED-25): the joints between the
// entities the file names, made once they are spawned, with their anchors and settings, the missing ones skipped
// with one warning naming the file, none on a restore; the decorations of each class in one spawnMany, with one
// value per decoration from the file's arrays and the rest from the scene's static decorations. logic0's world
// clear (the fast swap) leaves none of the file's joints, and the page's clear none of its decorations.
import test from 'node:test';
import assert from 'node:assert/strict';

import { registerOnLogicWorker, warnings } from '../helpers/logicWorkerEntities.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { Joint } from '../../src/core/joint.js';
import { JOINT_TYPE } from '../../src/box2d/box2dConstants.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { checkSceneFile } from '../../src/core/sceneFile.js';
import { spawnSceneFileJoints } from '../../src/core/sceneFileJoints.js';
import { spawnSceneFileDecorations, drawDecorationValue } from '../../src/core/sceneFileDecorations.js';

class Block extends GameObject {}
class Lamp extends GameObject {}

function bootJoints(maxJoints = 8, entities = 16) {
  Joint.reset();
  Joint.initializeArrays(new SharedArrayBuffer(Joint.getBufferSize(maxJoints, entities)), maxJoints, entities);
  const freeList = new SharedArrayBuffer(maxJoints * 2);
  const freeListTop = new SharedArrayBuffer(8);
  resetFreeList(new Int32Array(freeListTop), new Uint16Array(freeList), maxJoints, 1);
  Joint.initialize(maxJoints);
  Joint.initializeFreeList(freeList, freeListTop);
}

/** A Scene with what the loaders read: the file, its URL, the classes, the name map and the loaders' maps. */
function sceneWith(doc, extra = {}) {
  const scene = Object.create(Scene.prototype);
  Object.assign(scene, {
    sceneFile: checkSceneFile({ format: 1, script: 's.js', entities: [], ...doc }, 'test.scene.json'),
    sceneFileUrl: '/levels/test.scene.json',
    registeredClasses: [{ class: Block }, { class: Lamp }],
    _namedEntities: new Map(),
    _fileJoints: new Map(),
    _fileDecorations: new Map(),
    _restorePayload: null,
    _restoreAllTypes: false,
    ...extra,
  });
  return scene;
}

const ENTITIES = [
  { name: 'Door', class: 'Block', x: 100, y: 200 },
  { name: 'Frame', class: 'Block', x: 160, y: 200 },
  { name: 'Lamp1', class: 'Lamp', x: 100, y: 100 },
];

test('the file’s joints join the entities its names have, with their anchors and settings', async () => {
  const worker = await registerOnLogicWorker([[Block, 4], [Lamp, 4]]);
  bootJoints();
  try {
    const scene = sceneWith({
      entities: ENTITIES,
      joints: [
        { type: 'revolute', a: 'Door', b: 'Frame', anchorA: [30, 0], anchorB: [-30, 0], enableLimit: true, upperAngle: 0.5 },
        { name: 'Rope', type: 'distance', a: 'Lamp1', b: 'Door', anchorA: [0, 10], forceThreshold: 900 },
        { type: 'weld', a: 'Frame', b: 'Lamp1', linearHertz: 4 },
      ],
    });
    scene._spawnSceneFileEntities();
    const seen = warnings(() => assert.equal(spawnSceneFileJoints(scene), 3));
    assert.deepEqual(seen, []);
    const door = scene.getByName('Door').index;
    const frame = scene.getByName('Frame').index;
    const lamp = scene.getByName('Lamp1').index;
    assert.equal(Joint.getDenseActiveCount(), 3);

    const [hinge, rope, weld] = scene.sceneFile.joints.map((j) => scene._fileJoints.get(j));
    assert.deepEqual([hinge.entityA, hinge.entityB], [door, frame]);
    const i = hinge.index;
    assert.equal(Joint.type[i], JOINT_TYPE.REVOLUTE);
    assert.deepEqual([Joint.getEntityA(i), Joint.getEntityB(i)], [door, frame]);
    assert.deepEqual([Joint.localAnchorAX[i], Joint.localAnchorAY[i], Joint.localAnchorBX[i], Joint.localAnchorBY[i]], [30, 0, -30, 0]);
    assert.equal(Joint.enableLimit[i], 1);
    assert.equal(Joint.upperAngle[i], 0.5);
    assert.equal(Joint.forceThreshold[i], Infinity, 'left out: it never breaks');

    assert.equal(Joint.type[rope.index], JOINT_TYPE.DISTANCE);
    // Its anchors where the file places the entities: (100, 110) on the lamp, (100, 200) on the door.
    assert.equal(Joint.length[rope.index], 90, 'without a length: the distance as placed');
    assert.equal(Joint.forceThreshold[rope.index], 900);
    assert.equal(Joint.type[weld.index], JOINT_TYPE.WELD);
    assert.equal(Joint.linearHertz[weld.index], 4);

    // logic0's world clear (the fast swap) leaves none of them.
    worker.handleCustomMessage({ msg: 'clearScene' });
    assert.equal(Joint.getDenseActiveCount(), 0);
    assert.equal(Joint.active[hinge.index], 0);
  } finally {
    Joint.reset();
  }
});

test('a joint whose entities are not there is skipped, all of them with one warning naming the file', async () => {
  await registerOnLogicWorker([[Block, 4]]);
  bootJoints();
  try {
    const scene = sceneWith(
      {
        entities: ENTITIES,
        joints: [
          { type: 'weld', a: 'Door', b: 'Frame' },
          { name: 'Rope', type: 'distance', a: 'Lamp1', b: 'Door' },
          { type: 'weld', a: 'Door', b: 'Ghost' },
        ],
      },
      { registeredClasses: [{ class: Block }] },
    );
    const seen = warnings(() => {
      scene._spawnSceneFileEntities(); // Lamp is not in this scene: one warning of its own
      assert.equal(spawnSceneFileJoints(scene), 1);
    }).filter((w) => w.includes('joint'));
    assert.equal(seen.length, 1);
    assert.match(
      seen[0],
      /\/levels\/test\.scene\.json: 2 joints are skipped, their entities are not there \(joint Rope: no Lamp1; joints\[2\] \(weld Door–Ghost\): no Ghost\)/,
    );
    assert.equal(Joint.getDenseActiveCount(), 1);
  } finally {
    Joint.reset();
  }
});

test('a restore makes none of the file’s joints (the save brings back every joint); no joint pool warns once', async () => {
  await registerOnLogicWorker([[Block, 4]]);
  bootJoints();
  try {
    const joints = [{ type: 'weld', a: 'Door', b: 'Frame' }];
    const restoring = sceneWith({ entities: ENTITIES.slice(0, 2), joints }, { _restorePayload: {} });
    restoring._spawnSceneFileEntities();
    assert.equal(spawnSceneFileJoints(restoring), 0);
    assert.equal(Joint.getDenseActiveCount(), 0);
  } finally {
    Joint.reset();
  }
  const scene = sceneWith({ entities: ENTITIES.slice(0, 2), joints: [{ type: 'weld', a: 'Door', b: 'Frame' }] });
  const seen = warnings(() => assert.equal(spawnSceneFileJoints(scene), 0));
  assert.deepEqual(seen, ['WeedJS: /levels/test.scene.json places 1 joint, and Scene has no joint pool: set its config.physics.maxJoints']);
});

// ---- decorations ----

class Meadow extends Scene {
  static decorations = {
    Grass: { texture: ['grass1', 'grass2'], scale: { min: 0.2, max: 0.4 }, anchorY: 1, alpha: 0.9, tint: 0x88ff88 },
    Rock: { texture: 'rock', scale: 0.5, rotation: { min: 0, max: 1 } },
    Broken: { texture: 'nowhere' },
  };
}

function meadowWith(decorations, maxDecorations = 16) {
  const scene = Object.create(Meadow.prototype);
  Object.assign(scene, {
    sceneFile: checkSceneFile({ format: 1, script: 's.js', entities: [], decorations }, 'meadow.scene.json'),
    sceneFileUrl: '/levels/meadow.scene.json',
    config: { decoration: { maxDecorations } },
    _fileDecorations: new Map(),
  });
  return scene;
}

function withAtlas(fn) {
  SpriteSheetRegistry.register('bigAtlas', { animations: { grass1: ['g1'], grass2: ['g2'], rock: ['r'] } });
  try {
    return fn();
  } finally {
    SpriteSheetRegistry.spritesheets.delete('bigAtlas');
  }
}

test('the file’s decorations: one spawnMany per class, a value per decoration from the file, the rest from the class', () => {
  buildPoolScene({ decorations: 16 });
  const C = DecorationComponent;
  withAtlas(() => {
    const scene = meadowWith([
      { class: 'Grass', x: [10, 20, 30], y: [40, 41, 42], frame: [1, 0, 1], scale: [0.25, 0.3, 0.35] },
      { class: 'Rock', x: [500, 600], y: [50, 60] },
    ]);
    let calls = 0;
    const spawnMany = DecorationPool.spawnMany;
    DecorationPool.spawnMany = (config) => {
      calls++;
      return spawnMany.call(DecorationPool, config);
    };
    const sceneRng = globalThis.rng;
    globalThis.rng = () => 0.25; // the scene's random numbers
    try {
      assert.deepEqual(warnings(() => assert.equal(spawnSceneFileDecorations(scene), 5)), []);
    } finally {
      DecorationPool.spawnMany = spawnMany;
      globalThis.rng = sceneRng;
    }
    assert.equal(calls, 2, 'one call per class');
    assert.equal(DecorationPool.getActiveCount(), 5);

    const [grass, rock] = scene.sceneFile.decorations.map((r) => scene._fileDecorations.get(r));
    const read = (i) => [C.x[i], C.y[i], C.textureId[i], Math.round(C.scaleX[i] * 100) / 100, C.scaleY[i] === C.scaleX[i], C.anchorY[i]];
    assert.deepEqual(grass.map(read), [
      [10, 40, 1, 0.25, true, 1],
      [20, 41, 0, 0.3, true, 1],
      [30, 42, 1, 0.35, true, 1],
    ]);
    for (const i of grass) {
      assert.ok(Math.abs(C.alpha[i] - 0.9) < 1e-6);
      assert.equal(C.tint[i], 0x88ff88);
    }
    // The rocks: the class's scale, and a rotation drawn per decoration from its range with the scene's random
    // numbers (the file has none).
    assert.deepEqual(rock.map((i) => [C.x[i], C.y[i], C.textureId[i], C.scaleX[i]]), [[500, 50, 2, 0.5], [600, 60, 2, 0.5]]);
    for (const i of rock) assert.ok(Math.abs(Math.atan2(C.rotS[i], C.rotC[i]) - 0.25) < 1e-6);

    // The page's clear in a fast swap (Scene._clearWorldForSwap) leaves none.
    DecorationPool.despawnAll();
    assert.equal(DecorationPool.getActiveCount(), 0);
  });
});

test('a class the scene lacks or cannot draw, no pool, a full pool: each warns once, naming the file', () => {
  buildPoolScene({ decorations: 4 });
  withAtlas(() => {
    const scene = meadowWith([
      { class: 'Fern', x: [1, 2], y: [1, 2] },
      { class: 'Broken', x: [1], y: [1] },
      { class: 'Rock', x: [1, 2, 3, 4, 5, 6], y: [1, 2, 3, 4, 5, 6] },
    ]);
    const seen = warnings(() => assert.equal(spawnSceneFileDecorations(scene), 4)).filter((w) => w.startsWith('WeedJS'));
    assert.deepEqual(seen, [
      'WeedJS: /levels/meadow.scene.json: "Fern" is not in Meadow.decorations; its decorations are skipped',
      'WeedJS: /levels/meadow.scene.json: decoration class Broken: its texture "nowhere" is not in the atlas; its decorations are skipped',
      "WeedJS: /levels/meadow.scene.json: the decoration pool is full: 2 of its 6 Rock are not drawn; raise Meadow's config.decoration.maxDecorations",
    ]);
    const rock = scene._fileDecorations.get(scene.sceneFile.decorations[2]);
    assert.equal(rock.filter((i) => i >= 0).length, 4);
    assert.deepEqual(rock.slice(4), [-1, -1]);
    DecorationPool.despawnAll();
    const none = meadowWith([{ class: 'Rock', x: [1], y: [1] }], 0);
    assert.deepEqual(warnings(() => spawnSceneFileDecorations(none)), [
      'WeedJS: /levels/meadow.scene.json places decorations, and Meadow has no decoration pool: set its config.decoration.maxDecorations',
    ]);
  });
});

test('drawDecorationValue: a class’s number, a draw from its range, a texture among several', () => {
  const decl = Meadow.decorations.Grass;
  assert.equal(drawDecorationValue(decl, 'alpha', () => 0.5), 0.9);
  assert.equal(drawDecorationValue(decl, 'scale', () => 0.5), 0.30000000000000004);
  assert.equal(drawDecorationValue(decl, 'frame', () => 0.99), 1);
  assert.equal(drawDecorationValue(Meadow.decorations.Rock, 'frame', () => 0.99), 0, 'one texture');
  assert.equal(drawDecorationValue(decl, 'rotation', () => 0.5), 0, 'left out: the default');
  assert.equal(drawDecorationValue({ tint: { min: 0x000000, max: 0x204060 } }, 'tint', () => 0.5), 0x102030);
});
