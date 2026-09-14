import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const scene = readFileSync(join(root, 'src/core/scene.js'), 'utf8');
const abstractWorker = readFileSync(join(root, 'src/workers/abstractWorker.js'), 'utf8');
const physicsHost = readFileSync(join(root, 'src/box2d/physicsHostImpl.js'), 'utf8');
const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');
const defaults = readFileSync(join(root, 'src/util/configDefaults.js'), 'utf8');

test('SCENE_DEFAULTS.manualStep is false', () => {
  assert.match(defaults, /manualStep: false/);
});

test('Scene.init skips startMainLoop/startAllWorkers when manualStep', () => {
  assert.match(scene, /if \(!this\.config\.manualStep\) \{/);
  assert.match(scene, /this\.startMainLoop\(\);/);
  assert.match(scene, /this\.startAllWorkers\(\);/);
});

test('Scene.stepFrame posts step and waits for stepDone', () => {
  assert.match(scene, /async stepFrame\(deltaTimeMs = 16\.67\)/);
  assert.match(scene, /msg: 'step'/);
  assert.match(scene, /e\.data\.msg === 'stepDone'/);
  assert.match(scene, /hashActiveTransforms\(\)/);
  assert.match(scene, /hashLiquidFun\(\)/);
  assert.match(scene, /readWorkerStepMs\(\)/);
});

test('AbstractWorker step runs one _runFrame and does not schedule', () => {
  assert.match(abstractWorker, /case 'step':/);
  assert.match(abstractWorker, /this\._runFrame\(false\)/);
  assert.match(abstractWorker, /self\.postMessage\(\{ msg: 'stepDone'/);
  assert.match(
    abstractWorker,
    /const deltaTime = this\._injectedDeltaTime > 0/,
  );
});

test('physics_host stepOnce does not schedule the next frame', () => {
  assert.match(physicsHost, /function stepOnce\(deltaTimeMs\)/);
  assert.match(physicsHost, /data\.msg === 'step'/);
  assert.match(physicsHost, /self\.postMessage\(\{ msg: 'stepDone'/);
});

test('pixi presents the canvas after a manual step', () => {
  assert.match(pixi, /afterManualStep\(\)/);
  assert.match(pixi, /app\.renderer\.render\(app\.stage\)/);
  assert.match(pixi, /this\.config\?\.manualStep && this\.pixiApp\.ticker/);
});
