// N-301: a lost GPU restarts the scene from a save of the running world (GameEngine._onGpuLost / _onGpuRestored).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { GameEngine } from '../../src/core/gameEngine.js';

class LostScene {}

/** An engine with what the GPU-loss path uses: a current scene, a save that resolves, and loadScene recorded. */
function fakeEngine() {
  const fatal = [];
  const loads = [];
  const scene = Object.assign(new LostScene(), {
    sceneScriptUrl: 'http://x/scene.js',
    data: { level: 3 },
    _showFatalErrorMessage: (worker, title) => fatal.push(title),
  });
  const engine = {
    currentScene: scene,
    state: GameEngine.states.READY,
    _gpuLoss: null,
    _gpuRestartEnd: -Infinity,
    _captureGpuLossSave: async () => ({ sceneName: 'LostScene', entities: [] }),
    loadScene: async (source, options) => {
      loads.push({ source, options });
      return true;
    },
  };
  for (const name of ['_onGpuLost', '_onGpuRestored', '_restartAfterGpuLoss']) {
    engine[name] = GameEngine.prototype[name];
  }
  return { engine, scene, fatal, loads };
}

const settle = () => new Promise((r) => setImmediate(r));

test('a lost WebGPU device restarts the scene at once, from a save that says every entity is back', async () => {
  const { engine, scene, loads, fatal } = fakeEngine();
  engine._onGpuLost(scene, 'webgpu');
  await settle();
  assert.equal(loads.length, 1);
  assert.equal(loads[0].source, LostScene);
  assert.equal(loads[0].options.scriptUrl, 'http://x/scene.js');
  assert.deepEqual(loads[0].options.data, { level: 3 });
  assert.equal(loads[0].options.restorePayload.allEntitiesRestored, true);
  assert.equal(loads[0].options.restorePayload.restartReason, 'gpuLost');
  assert.equal(engine._gpuLoss, null);
  assert.deepEqual(fatal, []);
});

test('a lost WebGL context waits for the restore before restarting', async () => {
  const { engine, scene, loads } = fakeEngine();
  engine._onGpuLost(scene, 'webgl');
  await settle();
  assert.equal(loads.length, 0, 'no restart while the context is lost');
  engine._onGpuRestored(scene);
  await settle();
  assert.equal(loads.length, 1);
  assert.equal(loads[0].options.restorePayload.restartReason, 'gpuLost');
});

test('a WebGL context the browser does not restore shows the fatal error after the wait', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { engine, scene, loads, fatal } = fakeEngine();
    engine._onGpuLost(scene, 'webgl');
    mock.timers.tick(9999);
    assert.deepEqual(fatal, []);
    mock.timers.tick(1);
    assert.equal(fatal.length, 1);
    engine._onGpuRestored(scene);
    await settle();
    assert.equal(loads.length, 0, 'a late restore does not restart');
  } finally {
    mock.timers.reset();
  }
});

test('a second loss right after a restart is fatal, not another restart', async () => {
  const { engine, scene, loads, fatal } = fakeEngine();
  engine._onGpuLost(scene, 'webgpu');
  await settle();
  engine._onGpuLost(scene, 'webgpu');
  await settle();
  assert.equal(loads.length, 1);
  assert.equal(fatal.length, 1);
});

test('a loss reported by a scene that is not the current one, or during a load, is ignored', async () => {
  const { engine, loads, fatal } = fakeEngine();
  engine._onGpuLost({}, 'webgpu');
  engine.state = GameEngine.states.TRANSITIONING;
  engine._onGpuLost(engine.currentScene, 'webgpu');
  await settle();
  assert.equal(loads.length, 0);
  assert.deepEqual(fatal, []);
});

test('a restart that fails shows the fatal error', async () => {
  const { engine, scene, fatal } = fakeEngine();
  engine._captureGpuLossSave = async () => {
    throw new Error('no logic worker');
  };
  const quiet = mock.method(console, 'error', () => {});
  try {
    engine._onGpuLost(scene, 'webgpu');
    await settle();
    await settle();
  } finally {
    quiet.mock.restore();
  }
  assert.deepEqual(fatal, ['GPU lost']);
  assert.equal(engine._gpuLoss, null);
});
