import test from 'node:test';
import assert from 'node:assert/strict';

import { Scene } from '../../src/core/scene.js';
import { GameEngine } from '../../src/core/gameEngine.js';
import { clearSceneDirty, markSceneDirty } from '../../src/core/sceneDirty.js';

// VISUAL_EDITOR_PLAN.md ED-35: the fast swap's decisions and order, with stand-in workers. What each worker does
// on its side has its own tests (clearScene.test.js, swapClears.test.js, layer.test.js).

class Level extends Scene {}
class OtherLevel extends Scene {}

/** A stand-in worker: records what it is sent and answers the barrier, the clear and the step. */
class FakeWorker {
  constructor(name, scene, log) {
    this.name = name;
    this.scene = scene;
    this.log = log;
    this.listeners = new Set();
  }

  addEventListener(_type, fn) {
    this.listeners.add(fn);
  }

  removeEventListener(_type, fn) {
    this.listeners.delete(fn);
  }

  postMessage(message) {
    this.log.push(`${this.name}:${message.msg}`);
    const reply = (data) =>
      queueMicrotask(() => {
        const e = { data, currentTarget: this };
        for (const fn of [...this.listeners]) fn(e);
        this.scene.handleMessageFromWorker(e);
      });
    if (message.msg === 'barrier') reply({ msg: 'barrierDone', id: message.id });
    else if (message.msg === 'clearScene') reply({ msg: 'clearSceneComplete', workerIndex: 0 });
    else if (message.msg === 'step') reply({ msg: 'stepDone', id: message.id });
  }
}

/** A Level with only what the swap reads, and stand-in workers: logic0, logic1, physics, renderer. */
function runningLevel(log, config = {}) {
  const scene = Object.create(Level.prototype);
  Object.assign(scene, {
    config: { manualStep: false, physics: { subSteps: 4 }, navigation: { enabled: false }, ...config },
    state: { pause: false },
    buffers: { sharedResources: {} },
    views: { camera: null },
    debugFlags: null,
    _barrier: null,
    _barrierSeq: 0,
    _stepSeq: 0,
    _stepWaiters: new Map(),
    workerReadyStates: { physics: true },
    pendingPhysicsUpdates: [],
    _bootPhysicsConfig: { subSteps: 4 },
    sceneFile: null,
    sceneFileUrl: null,
    registeredClasses: [],
    data: 'level 1',
    _namedEntities: new Map([['old', 0]]),
    _eventListeners: new Map([['coin', [() => {}]]]),
    _restorePayload: { stale: true },
    _onProgressOption: null,
    _loadStepsDone: 0,
    _spawnBatchOpen: false,
    _createSpawnExtras: [],
    _createLogic0Spawns: 0,
    _createOwnerSpawns: new Set(),
    lastFrameTime: 0,
  });
  scene.workers = {
    logicWorkers: [new FakeWorker('logic0', scene, log), new FakeWorker('logic1', scene, log)],
    physics: new FakeWorker('physics', scene, log),
    renderer: new FakeWorker('renderer', scene, log),
    spatialWorkers: [],
    preRenderWorkers: [],
    particle: null,
  };
  scene.preload = (data) => log.push(`preload:${data}`);
  scene.create = (data) => log.push(`create:${data}`);
  scene.createNewGame = (data) => log.push(`createNewGame:${data}`);
  return scene;
}

test('_fastSwapBlocker: a swap needs the running class, no manual step, no LiquidFun, uploads or dirty scene', () => {
  const log = [];
  const scene = runningLevel(log);
  clearSceneDirty();
  assert.equal(scene._fastSwapBlocker(Level), null);
  assert.equal(scene._fastSwapBlocker(OtherLevel), 'OtherLevel is not the running Level');
  assert.match(runningLevel(log, { manualStep: true })._fastSwapBlocker(Level), /manualStep/);
  assert.equal(runningLevel(log, { physics: { liquidFun: { enabled: true } } })._fastSwapBlocker(Level), 'LiquidFun is on');
  markSceneDirty('layer "sky" changed its scenery (setStatic)');
  assert.equal(scene._fastSwapBlocker(Level), 'the scene is dirty: layer "sky" changed its scenery (setStatic)');
  clearSceneDirty();
});

test('a fast swap settles, clears, resets, steps physics, then runs the new content and resumes', async () => {
  const log = [];
  const scene = runningLevel(log);
  const progress = [];
  await scene._fastSwap({
    data: 'level 2',
    sceneFile: { format: 1, script: 'x.js', entities: [] },
    sceneFileUrl: 'http://host/levels/1-2.scene.json',
    restorePayload: null,
    onProgress: (done, total, stage) => progress.push([done, total, stage]),
  });
  const firstIndex = (entry) => log.indexOf(entry);
  // Settled before anything else: every worker paused and past the barrier.
  for (const w of ['logic0', 'logic1', 'physics', 'renderer']) {
    assert.ok(firstIndex(`${w}:pause`) < firstIndex(`${w}:barrier`), `${w} paused, then settled`);
    assert.ok(firstIndex(`${w}:barrier`) < firstIndex('logic0:clearScene'), `${w} settled before the clear`);
  }
  assert.ok(firstIndex('logic1:clearScene') >= 0, 'every logic worker clears');
  // The physics settings go back, then the tiny step flushes the clear, before any content.
  assert.ok(firstIndex('logic0:clearScene') < firstIndex('physics:updatePhysicsConfig'));
  assert.ok(firstIndex('physics:updatePhysicsConfig') < firstIndex('physics:step'));
  assert.ok(firstIndex('physics:step') < firstIndex('preload:level 2'));
  assert.deepEqual(
    log.filter((e) => /^(preload|create|createNewGame):/.test(e)),
    ['preload:level 2', 'create:level 2', 'createNewGame:level 2'],
  );
  for (const w of ['logic0', 'logic1', 'physics', 'renderer']) {
    assert.ok(firstIndex(`${w}:resume`) > firstIndex('createNewGame:level 2'), `${w} resumes after the content`);
  }
  // This load's fields, as a new scene has them.
  assert.equal(scene.data, 'level 2');
  assert.equal(scene.sceneFileUrl, 'http://host/levels/1-2.scene.json');
  assert.equal(scene._namedEntities.size, 0);
  assert.equal(scene._eventListeners.size, 0, 'scene.on listeners go, as with a new scene');
  assert.equal(scene._restorePayload, null);
  assert.equal(scene._spawnBatchOpen, false);
  assert.equal(scene.state.pause, false);
  assert.deepEqual(progress, [[Scene.LOAD_STEPS.length, Scene.LOAD_STEPS.length, 'world']]);
});

test('a hook that throws during the swap still resumes the workers', async () => {
  const log = [];
  const scene = runningLevel(log);
  scene.create = () => {
    throw new Error('level broke');
  };
  await assert.rejects(
    scene._fastSwap({ data: null, sceneFile: null, sceneFileUrl: null, restorePayload: null, onProgress: null }),
    /level broke/,
  );
  assert.ok(log.includes('renderer:resume'), 'the game is not left frozen');
  assert.equal(scene._spawnBatchOpen, false);
});

/** An engine whose running scene is `scene`; a full load fails at its destroy, with a marker error. */
function engineRunning(scene) {
  const engine = Object.create(GameEngine.prototype);
  Object.assign(engine, {
    _isolation: Promise.resolve('isolated'),
    state: GameEngine.states.READY,
    currentScene: scene,
    debugEnabled: false,
    debugUI: null,
    transitionCooldown: 0,
  });
  scene.destroy = async () => {
    throw new Error('full load');
  };
  return engine;
}

test('loadScene swaps for the running class, and loads fully for another class or fullLoad: true', async () => {
  const swaps = [];
  const scene = runningLevel([]);
  scene._fastSwap = async (load) => swaps.push(load.data);
  const engine = engineRunning(scene);
  const info = [];
  const quiet = { info: console.info, error: console.error };
  console.info = (m) => info.push(String(m));
  console.error = () => {};
  try {
    clearSceneDirty();
    assert.equal(await engine.loadScene(Level, { scriptUrl: '/x/level.js', data: { score: 3 } }), true);
    assert.deepEqual(swaps, [{ score: 3 }]);
    await assert.rejects(engine.loadScene(OtherLevel, { scriptUrl: '/x/other.js' }), /full load/);
    assert.match(info.at(-1), /\[WeedJS\] loadScene: full load \(OtherLevel is not the running Level\)/);
    const logged = info.length;
    await assert.rejects(engine.loadScene(Level, { scriptUrl: '/x/level.js', fullLoad: true }), /full load/);
    assert.equal(info.length, logged, 'a full load the caller asked for is not explained');
    assert.equal(swaps.length, 1);
  } finally {
    console.info = quiet.info;
    console.error = quiet.error;
  }
});

test('loadScene with a sceneFile: that content in place of the file, checked and copied; the URL still names the file', async () => {
  class FileLevel extends Level {
    static defaultSceneFile = './levels/a.scene.json';
  }
  const loads = [];
  const scene = runningLevel([]);
  Object.setPrototypeOf(scene, FileLevel.prototype);
  scene._fastSwap = async (load) => loads.push(load);
  const engine = engineRunning(scene);
  const quiet = { error: console.error, fetch: globalThis.fetch };
  console.error = () => {};
  globalThis.fetch = () => {
    throw new Error('the file was fetched');
  };
  try {
    clearSceneDirty();
    const doc = { format: 1, script: '../level.js', entities: [{ name: 'Rock1', class: 'Rock', x: 1, y: 2 }] };
    assert.equal(await engine.loadScene(FileLevel, { scriptUrl: '/x/level.js', sceneFile: doc }), true);
    assert.equal(loads.length, 1, 'a fast swap, with no fetch');
    assert.deepEqual(loads[0].sceneFile, doc);
    assert.notEqual(loads[0].sceneFile, doc, 'a copy: the scene edits its own');
    assert.notEqual(loads[0].sceneFile.entities[0], doc.entities[0]);
    assert.equal(loads[0].sceneFileUrl, 'http://localhost/x/levels/a.scene.json');

    await assert.rejects(
      engine.loadScene(FileLevel, { scriptUrl: '/x/level.js', sceneFile: { format: 2, script: 'x.js' } }),
      /format 2 is not supported/,
    );
    assert.equal(engine.state, GameEngine.states.READY, 'a refused load leaves the engine ready');

    // A level built in code, for a class that names no file: no format, no script, no names; nothing to save to.
    Object.setPrototypeOf(scene, Level.prototype);
    loads.length = 0;
    const built = { entities: [{ class: 'Rock', x: 0, y: 0 }, { name: 'Rock1', class: 'Rock', x: 64, y: 0 }, { class: 'Rock', x: 128, y: 0 }] };
    assert.equal(await engine.loadScene(Level, { scriptUrl: '/x/level.js', sceneFile: built }), true);
    assert.equal(loads[0].sceneFileUrl, null, 'no file');
    assert.deepEqual(
      loads[0].sceneFile.entities.map((e) => e.name),
      ['Rock2', 'Rock1', 'Rock3'],
      'the names the file has are kept, the others are its class and a free number',
    );
    assert.equal(loads[0].sceneFile.format, 1);
    assert.equal(built.entities[0].name, undefined, 'the caller’s object is not touched');
    await assert.rejects(
      engine.loadScene('/x/levels/b.scene.json', { sceneFile: { entities: [] } }),
      /"script" must name the scene's module/,
      'a scene file URL names its class through the file: its script is needed',
    );
  } finally {
    console.error = quiet.error;
    globalThis.fetch = quiet.fetch;
  }
});
