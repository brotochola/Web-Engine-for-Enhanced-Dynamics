// SST-1 (SCENE_STARTUP_TIME_PLAN.md): every engine worker gets a 'boot' message as soon as it is made, before any asset
// loads, and its 'init' later carries only what depends on the assets and the shared buffers. Boot starts the game
// scripts (init waits for them and loads only what it adds), takes engine.wasm, and keeps the config; the renderer's
// boot carries the canvas, its init no longer does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Scene } from '../../src/core/scene.js';
import { bootSceneWorkers, createSceneWorkers, reserveBox2dBlock } from '../../src/util/sceneWorkerBootstrap.js';
import { sceneEntitySlots } from '../../src/util/sceneSharedBuffers.js';
import { collectWorkerScriptsToLoad } from '../../src/util/sceneScript.js';
import { compileWasmKernel } from '../../src/util/wasmKernel.js';
import { engineWasmUrl } from '../../src/wasm/engine.js';
import { takeLoadMarks } from '../../src/util/loadMarks.js';
import { coreComponentData, initWorker, loadWorker, quietly } from '../bench/workerHarness.mjs';

const names = (marks) => marks.filter((_, i) => i % 2 === 0);

/** The game scripts a worker loads, written to a folder of their own: name → file URL. */
function writeScripts(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weed-boot-'));
  const urls = {};
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    urls[name] = pathToFileURL(file).href;
  }
  return urls;
}

/** What a logic worker's init binds at least (tests/bench/contactFlowHarness.mjs). */
const logicBuffers = () => ({ componentData: coreComponentData(1), bodyGeneration: new SharedArrayBuffer(4) });

/** A logic worker of its own (the harness's self is shared: a fresh instance each test). */
async function freshLogicWorker() {
  const first = await loadWorker('logicWorker.js', 'logicWorker');
  return quietly(() => new first.constructor(globalThis.self));
}

test('boot starts the game scripts; init waits for them and loads only a script it adds', async () => {
  const urls = writeScripts({
    'bootScene.js': 'globalThis.__bootEvaluated = (globalThis.__bootEvaluated || 0) + 1;\nexport class BootSceneThing {}\n',
    'extra.js': 'export class InitOnlyThing {}\n',
  });
  const worker = await freshLogicWorker();
  takeLoadMarks();
  await quietly(() => worker.handleMessage({
    data: {
      msg: 'boot',
      workerName: 'logic0',
      config: { seed: 7, marker: 'boot' },
      engineWasm: null,
      sceneParams: 'level=3',
      scriptsToLoad: [urls['bootScene.js']],
    },
  }));
  assert.equal(worker.config.marker, 'boot', 'boot keeps the config');
  // The scripts run while the page loads the assets: done before any init.
  await worker._bootScripts;
  assert.equal(typeof globalThis.self.BootSceneThing, 'function', 'the scene module was evaluated at boot');
  assert.equal(globalThis.self.WEED?.params?.get('level'), '3', 'with the page\'s params set first');
  assert.equal(typeof globalThis.self.GameObject, 'function', 'and the engine names on self');

  await initWorker(worker, {
    config: { marker: 'init', logic: { numberOfLogicWorkers: 1 } },
    globalEntityCount: 1,
    buffers: logicBuffers(),
    extra: { scriptsToLoad: [urls['bootScene.js'], urls['extra.js']], workerIndex: 0, sceneParams: 'level=3' },
  });
  assert.equal(worker.config.marker, 'init', 'init\'s config replaces it');
  assert.equal(globalThis.__bootEvaluated, 1, 'evaluated once');
  assert.equal(typeof globalThis.self.InitOnlyThing, 'function', 'the script only init names is loaded there');
  const marks = names(takeLoadMarks());
  const at = (name) => marks.indexOf(name);
  assert.ok(at('boot') >= 0 && at('boot scripts') > at('boot') && at('init') > at('boot scripts'), `${marks}`);
  assert.ok(at('entity scripts') > at('init'), `${marks}`);
});

test('init without a boot loads its scripts itself, as before', async () => {
  const urls = writeScripts({ 'plain.js': 'export class PlainThing {}\n' });
  const worker = await freshLogicWorker();
  await initWorker(worker, {
    config: { logic: { numberOfLogicWorkers: 1 } },
    globalEntityCount: 1,
    buffers: logicBuffers(),
    extra: { scriptsToLoad: [urls['plain.js']], workerIndex: 0 },
  });
  assert.equal(typeof globalThis.self.PlainThing, 'function');
  assert.equal(worker._bootPromise, null);
});

test('a script that fails at boot fails the init, with the import it could not resolve', async () => {
  const urls = writeScripts({ 'bare.js': "import 'weed-not-a-package';\nexport class Never {}\n" });
  const worker = await freshLogicWorker();
  await quietly(() => worker.handleMessage({
    data: { msg: 'boot', workerName: 'logic0', config: {}, engineWasm: null, sceneParams: '', scriptsToLoad: [urls['bare.js']] },
  }));
  await assert.rejects(
    initWorker(worker, {
      config: { logic: { numberOfLogicWorkers: 1 } },
      globalEntityCount: 1,
      buffers: logicBuffers(),
      extra: { scriptsToLoad: [urls['bare.js']], workerIndex: 0 },
    }),
    /imports "weed-not-a-package", which a worker cannot resolve/,
  );
});

test('an engine module that arrives after the boot (engineWasm message) is the one the kernels use', async () => {
  const worker = await freshLogicWorker();
  const module = await WebAssembly.compile(fs.readFileSync(engineWasmUrl));
  await worker.handleMessage({ data: { msg: 'boot', workerName: 'logic0', config: {}, engineWasm: null } });
  await worker.handleMessage({ data: { msg: 'engineWasm', engineWasm: module } });
  assert.equal(await compileWasmKernel('spatialPublish', engineWasmUrl), module);
});

// The page's side, on a real Scene with workers that record what they are sent.
class RecordingWorker {
  static made = [];
  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.name = '';
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    RecordingWorker.made.push(this);
  }
  postMessage(data, transfer = []) {
    this.posted.push({ data, transfer });
  }
  terminate() {}
}

class BootOrderScene extends Scene {
  static config = {
    physics: { enabled: false },
    spatial: { numberOfSpatialWorkers: 2 },
    logic: { numberOfLogicWorkers: 2 },
  };
}

test('the page: a boot to every engine worker at once (the canvas in the renderer\'s), then an init without it', async () => {
  const savedWorker = globalThis.Worker;
  globalThis.Worker = RecordingWorker;
  RecordingWorker.made.length = 0;
  const offscreen = { offscreen: true };
  let transfers = 0;
  const canvas = {
    width: 640,
    height: 360,
    transferControlToOffscreen() {
      transfers++;
      return offscreen;
    },
  };
  try {
    const scene = await quietly(() => new BootOrderScene({ canvas }));
    scene.sceneScriptUrl = 'http://127.0.0.1/demos/boot/bootOrderScene.js';
    scene.config.canvasWidth = 640;
    scene.config.canvasHeight = 360;
    takeLoadMarks();
    await quietly(() => bootSceneWorkers(scene));

    const workers = RecordingWorker.made;
    const byName = Object.fromEntries(workers.map((w) => [w.name, w]));
    assert.deepEqual(Object.keys(byName).sort(), ['logic0', 'logic1', 'particle', 'preRender', 'renderer', 'spatial0', 'spatial1']);
    assert.equal(scene.workers.physics, null, 'no physics worker without physics');
    const scripts = collectWorkerScriptsToLoad(scene, '');
    for (const w of workers) {
      assert.equal(w.posted.length, 1, `${w.name}: one message so far`);
      const boot = w.posted[0].data;
      assert.equal(boot.msg, 'boot');
      assert.equal(boot.workerName, w.name);
      assert.equal(boot.config, scene.config);
      assert.deepEqual(boot.scriptsToLoad, scripts);
      assert.equal(boot.engineWasm, null, 'no page to compile engine.wasm on here');
      assert.equal(typeof w.onmessage, 'function', `${w.name}: its messages reach the scene from its boot`);
      if (w.name === 'renderer') {
        assert.equal(boot.canvas, offscreen);
        assert.deepEqual(w.posted[0].transfer, [offscreen]);
        assert.equal(boot.canvasWidth, 640);
        assert.equal(boot.canvasHeight, 360);
      } else {
        assert.equal(boot.canvas, undefined);
      }
    }
    assert.equal(transfers, 1);
    const pageMarks = names(takeLoadMarks());
    assert.ok(pageMarks.indexOf('boot sent') > pageMarks.indexOf('workers made'), `${pageMarks}`);

    // Init, as Scene.init sends it once the buffers exist (the assets stubbed: none).
    scene.totalEntityCount = sceneEntitySlots(scene.totalEntityCount);
    await quietly(() => reserveBox2dBlock(scene));
    await quietly(() => scene.createSharedBuffers());
    scene.preloadAssets = async function () {
      this.loadedTextures = {};
      this.loadedSpritesheets = {};
      this.loadedTilemaps = {};
    };
    scene.buildTextureMetadata = () => null;
    await quietly(() => createSceneWorkers(scene));
    assert.equal(RecordingWorker.made.length, workers.length, 'no worker made twice');
    for (const w of workers) {
      assert.deepEqual(w.posted.map((p) => p.data.msg), ['boot', 'init'], w.name);
      const init = w.posted[1].data;
      assert.equal(init.canvas, undefined);
      assert.equal(init.view, undefined, `${w.name}: the canvas is not in init`);
      assert.equal(init.engineWasm, undefined, `${w.name}: engine.wasm is not in init`);
      assert.ok(!w.posted[1].transfer.includes(offscreen));
    }
    assert.equal(transfers, 1, 'the canvas moved once, with the boot');
  } finally {
    if (savedWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = savedWorker;
  }
});
