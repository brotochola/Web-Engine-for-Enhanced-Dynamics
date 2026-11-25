// SST-1, the renderer's side: the page posts 'boot' (the config and the canvas) right after `new Worker`, then 'init'
// once its assets are in. The Pixi worker starts Pixi on the boot's canvas and starts linking the programs it can make
// from the config at boot; an 'init' that arrives first waits for boot, and carries no canvas. A fake page posts both
// through the worker's own message queue, and Pixi's init is faked (Node has no GPU): what is checked is what the worker
// does with the messages, and when.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Application, GlProgram, RendererType } from '../../src/vendor/pixi.min.js';
import { AbstractWorker } from '../../src/workers/abstractWorker.js';
import { coreComponentData, loadWorker, postedMessages, quietly } from '../bench/workerHarness.mjs';
import { readEngineShader } from './engineShaderSources.mjs';

// GlProgram probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.OffscreenCanvas ??= class {
  getContext() {
    return null;
  }
};


/** A WebGL2 context with what the worker's setup reads, and Pixi's shader system with E-475's links ahead (a log). */
function fakeRenderer(width, height) {
  const linked = [];
  const gl = {
    RENDERER: 0x1f01,
    getExtension: () => null,
    getParameter: (p) => (p === 0x1f01 ? 'Fake GPU' : 16),
    drawArrays() {},
    drawElements() {},
    drawArraysInstanced() {},
    drawElementsInstanced() {},
  };
  return {
    type: RendererType.WEBGL,
    gl,
    width,
    height,
    resize(w, h) {
      this.width = w;
      this.height = h;
    },
    shader: {
      linked,
      weedLinkAhead(program) {
        if (linked.includes(program)) return false;
        linked.push(program);
        return true;
      },
      weedLinksRunning: () => 0,
    },
  };
}

/**
 * Pixi's init, faked: it records each call and finishes when the test says (`release`), as a GPU's start would some
 * milliseconds later.
 */
function fakePixiInit() {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const saved = Application.prototype.init;
  Application.prototype.init = async function init(options) {
    calls.push(options);
    await gate;
    this.renderer = fakeRenderer(options.width, options.height);
  };
  return { calls, release: () => release(), restore: () => { Application.prototype.init = saved; } };
}

/**
 * Every engine shader a bundle embeds, as the boot message carries them: each one's own text (the renderer makes the
 * pose and additive variants from it, N-303 CR-14), a program that compiles nowhere for any other path.
 */
const SHADER_PATH = '/src/shaders/';
const embeddedShaders = new Proxy({}, {
  get: (_, path) => {
    if (typeof path !== 'string') return undefined;
    return path.startsWith(SHADER_PATH) ? readEngineShader(path.slice(SHADER_PATH.length)) : '#version 300 es\nvoid main() {}\n';
  },
});

function bootMessage(canvas) {
  return {
    msg: 'boot',
    workerName: 'renderer',
    config: { renderer: { backend: 'webgl' } },
    engineWasm: null,
    canvas,
    canvasWidth: 640,
    canvasHeight: 360,
    engineShaders: embeddedShaders,
  };
}

function initMessage() {
  const n = 16;
  return {
    msg: 'init',
    pageOrigin: '',
    config: { seed: 1, canvasWidth: 640, canvasHeight: 360, worldWidth: 1000, worldHeight: 1000, spatial: { numberOfSpatialWorkers: 1 }, debug: {} },
    globalEntityCount: n,
    buffers: { componentData: coreComponentData(n) },
    registeredClasses: [],
    componentPools: {},
    frameRateStride: 16,
    frameRateIndex: 0,
  };
}

/** The page's canvas: its WebGL2 context, which a test loses and gives back, and the listeners the worker adds. */
function pageCanvas(label = 'the page canvas') {
  const listeners = [];
  return {
    width: 640,
    height: 360,
    label,
    lost: false,
    getContext(kind) {
      return kind === 'webgl2' ? { isContextLost: () => this.lost } : null;
    },
    addEventListener: (type, fn) => listeners.push([type, fn]),
    say(type) {
      let prevented = false;
      for (const [t, fn] of listeners) if (t === type) fn({ preventDefault: () => { prevented = true; } });
      return prevented;
    },
  };
}

/** A renderer of its own: the worker's class, constructed as the worker module constructs it, on a self of its own. */
async function freshRenderer() {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  return new shared.constructor({ postMessage: (m) => self.postMessage(m), onmessage: null });
}

/** Post `data` as the page does: through the worker's message queue (AbstractWorker's onmessage). */
function post(worker, data) {
  worker.self.onmessage({ data });
}

function since(start, msg) {
  return postedMessages().slice(start).filter((m) => m && m.msg === msg);
}

async function until(predicate, what) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("the renderer starts Pixi on the boot's canvas, and an 'init' that comes first waits for it", async () => {
  const pixi = fakePixiInit();
  try {
    const px = await freshRenderer();
    const canvas = pageCanvas();
    const start = postedMessages().length;
    // What had started linking when initialize reached the assets (its first step after boot).
    let linkedBeforeAssets = null;
    const loadTextures = px.assets.loadTextures;
    px.assets.loadTextures = function (textures) {
      linkedBeforeAssets = px.pixiApp.renderer.shader.linked.slice();
      return loadTextures.call(this, textures);
    };

    await quietly(async () => {
      post(px, bootMessage(canvas));
      // The page's assets take a while; Pixi's init has started meanwhile, on the boot's canvas and size.
      await until(() => pixi.calls.length === 1, "Pixi's init");
      assert.equal(pixi.calls[0].canvas, canvas, "the boot's canvas");
      assert.equal(pixi.calls[0].width, 640);
      assert.equal(pixi.calls[0].height, 360);
      assert.equal(pixi.calls[0].preference, 'webgl');

      // 'init' comes before Pixi is up: it waits (no GPU report, no ready).
      post(px, initMessage());
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(since(start, 'gpuInfo').length, 0, 'nothing reported before boot is done');
      assert.equal(since(start, 'workerReady').length, 0);

      pixi.release();
      await until(() => since(start, 'workerReady').length === 1, 'the worker ready');
    });

    const app = px.pixiApp;
    assert.ok(app && app.renderer, 'Pixi is up');
    assert.equal(px.canvasView, canvas, "the canvas is the boot's (the init message carries none)");
    const gpu = since(start, 'gpuInfo');
    assert.equal(gpu.length, 1, 'the GPU reported once, from initialize');
    assert.equal(gpu[0].name, 'Fake GPU');
    assert.equal(since(start, 'error').length, 0, 'no error');
    // The programs boot made from the config (the tilemap's, made from the fetched shaders) started linking at boot.
    const linked = linkedBeforeAssets;
    assert.ok(linked !== null, 'initialize loaded the assets');
    assert.ok(linked.some((p) => p instanceof GlProgram && p.fragment.includes('SHADER_NAME tilemap-gid')), 'the tilemap program linked ahead');
    assert.equal(GlProgram.weedMade, null, 'the capture of programs ends with initialize');
  } finally {
    pixi.restore();
  }
});

test("a boot that fails is reported by initialize, as Pixi's init failing was", async () => {
  const px = await freshRenderer();
  const start = postedMessages().length;
  const errors = [];
  const report = px.reportError;
  px.reportError = (what, error) => errors.push([what, String(error && error.message)]);
  try {
    await quietly(async () => {
      post(px, bootMessage(null));
      post(px, initMessage());
      await until(() => errors.length > 0, 'the error');
    });
  } finally {
    px.reportError = report;
  }
  assert.equal(errors[0][0], 'PIXI Initialization Failed');
  assert.match(errors[0][1], /no canvas/);
  assert.equal(since(start, 'gpuInfo').length, 0, 'no GPU to report');
});

// N-458: Pixi's start on a context that was lost meanwhile throws (its loop over ever smaller shaders ended: buildPixi.mjs).
test('N-458: a WebGL context lost while Pixi starts is waited for, and Pixi started again on it', async () => {
  const calls = [];
  const saved = Application.prototype.init;
  const canvas = pageCanvas();
  Application.prototype.init = async function init(options) {
    calls.push(options);
    if (calls.length === 1) {
      canvas.lost = true;
      throw new Error('Pixi: no fragment shader compiles (the WebGL context may be lost)');
    }
    this.renderer = fakeRenderer(options.width, options.height);
  };
  try {
    const px = await freshRenderer();
    const start = postedMessages().length;
    await quietly(async () => {
      post(px, bootMessage(canvas));
      post(px, initMessage());
      await until(() => calls.length === 1, "Pixi's first init");
      assert.equal(canvas.say('webglcontextlost'), true, 'the default prevented: the browser may restore it');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(calls.length, 1, 'nothing while it is lost');
      assert.equal(px.pixiApp, null);
      canvas.lost = false;
      canvas.say('webglcontextrestored');
      await until(() => since(start, 'workerReady').length === 1, 'the worker ready');
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].canvas, canvas);
    assert.ok(px.pixiApp && px.pixiApp.renderer, 'Pixi is up');
    assert.equal(since(start, 'error').length, 0);
    assert.equal(since(start, 'gpuLost').length, 0, "boot's own to mend: the page hears nothing");
    // From here on the page hears of a loss.
    await quietly(async () => canvas.say('webglcontextlost'));
    canvas.say('webglcontextrestored');
    assert.equal(since(start, 'gpuLost').length, 1);
    assert.equal(since(start, 'gpuRestored').length, 1);
  } finally {
    Application.prototype.init = saved;
  }
});

test('N-458: a context the browser does not restore ends the boot with an error that says so; another error ends it at once', async (t) => {
  for (const lost of [true, false]) {
    const saved = Application.prototype.init;
    const canvas = pageCanvas();
    Application.prototype.init = async function init() {
      canvas.lost = lost;
      throw new Error('Pixi failed');
    };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const px = await freshRenderer();
      px._fetchEngineShaders = async () => {};
      px.canvasView = canvas;
      px._useWebGpu = false;
      let error = null;
      await quietly(async () => {
        const started = px._startPixi({ renderer: {} }, 'webgl').catch((e) => { error = e; });
        for (let i = 0; i < 20; i++) await Promise.resolve();
        if (lost) {
          t.mock.timers.tick(9999);
          for (let i = 0; i < 20; i++) await Promise.resolve();
          assert.equal(error, null, 'still waiting');
          t.mock.timers.tick(1);
        }
        await started;
      });
      assert.match(error.message, lost ? /the WebGL context was lost while the game loaded/ : /Pixi failed/);
      // The page's 'start' after a boot that failed starts nothing (it threw over the message that says why).
      px.onCustomSchedulerStart();
    } finally {
      t.mock.timers.reset();
      Application.prototype.init = saved;
    }
  }
});
