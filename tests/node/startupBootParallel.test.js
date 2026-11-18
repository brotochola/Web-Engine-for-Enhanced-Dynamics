// SST-4 (SCENE_STARTUP_TIME_PLAN.md): Scene.init starts every piece of the start that needs nothing from the rest at
// its top (the workers and their boot, the Adobe assets, the audio worklet, every asset's fetch and decode) and awaits
// each where it is consumed: the asset loads run while the Box2D block and the shared buffers are made, and are
// installed (the atlas into the registries) only after the buffers, as before.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Scene } from '../../src/core/scene.js';
import { loadMark, takeLoadMarks } from '../../src/util/loadMarks.js';
import { quietly } from '../bench/workerHarness.mjs';

const names = (marks) => marks.filter((_, i) => i % 2 === 0);

class SilentWorker {
  constructor() {
    this.name = '';
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(data) {
    this.posted.push(data.msg);
  }
  terminate() {}
}

class ParallelStartScene extends Scene {
  static config = { physics: { enabled: false }, spatial: { numberOfSpatialWorkers: 1 }, logic: { numberOfLogicWorkers: 1 } };
  static assets = { shaders: { glow: '/demos/parallel/glow.frag' } };
}

const STOP = new Error('the test stops before the workers\' init');

test('the asset loads start at the top of init, run under the Box2D block and the buffers, and are installed after', async () => {
  const saved = { Worker: globalThis.Worker, fetch: globalThis.fetch, self: globalThis.self };
  globalThis.Worker = SilentWorker;
  // No page here: SoundManager takes this for a worker (no AudioContext), as the engine's other Node tests run it.
  globalThis.self = globalThis;
  globalThis.fetch = async (url) => {
    loadMark(`fetch ${url}`);
    return new Response('void main() {}', { status: 200 });
  };
  const offscreen = {};
  try {
    const scene = await quietly(() => new ParallelStartScene({ canvas: { transferControlToOffscreen: () => offscreen } }));
    scene.config.canvasWidth = 640;
    scene.config.canvasHeight = 360;
    // The atlas pack and install need a page (a 2D canvas, the registries' sheets): stand-ins that record when.
    const atlas = { json: { frames: {}, animations: {}, meta: {} } };
    scene._packBigAtlas = async () => {
      loadMark('test atlas packed');
      return atlas;
    };
    let installed = null;
    scene._installBigAtlas = (loaded) => {
      loadMark('test atlas installed');
      installed = loaded;
    };
    let atCreateWorkers = null;
    scene.createWorkers = async function () {
      atCreateWorkers = names(takeLoadMarks());
      // What createSceneWorkers does first: the loads, installed.
      await this.preloadAssets(this.imageUrls, this.imageUrls.spritesheets || {}, this.audioUrls);
      throw STOP;
    };
    takeLoadMarks();
    await assert.rejects(quietly(() => scene.init()), (err) => err === STOP);

    const at = (name) => atCreateWorkers.indexOf(name);
    for (const name of ['assets started', 'fetch /demos/parallel/glow.frag', 'box2d block', 'buffers', 'boot sent']) {
      assert.ok(at(name) >= 0, `${name} in ${atCreateWorkers}`);
    }
    assert.ok(at('assets started') < at('box2d block'), `the loads start before the Box2D block: ${atCreateWorkers}`);
    assert.ok(at('fetch /demos/parallel/glow.frag') < at('buffers'), `a fetch runs before the buffers: ${atCreateWorkers}`);
    assert.ok(at('test atlas installed') < 0, 'nothing installed before the buffers');
    const after = names(takeLoadMarks());
    assert.ok(after.includes('test atlas installed'), `installed by preloadAssets: ${after}`);
    assert.equal(installed, atlas);
    assert.equal(scene._loadedShaderSources['glow'], 'void main() {}', 'the shader source loaded');
    assert.equal(scene._assetLoads, null, 'taken once');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
