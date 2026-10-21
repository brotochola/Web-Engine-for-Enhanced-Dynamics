import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Time } from '../../src/core/timeScale.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const abstractWorker = readFileSync(join(root, 'src/workers/abstractWorker.js'), 'utf8');

test('pixi blob workers resolve engine shaders against pageOrigin', () => {
  const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');
  const bootstrap = readFileSync(join(root, 'src/util/sceneWorkerBootstrap.js'), 'utf8');
  assert.match(pixi, /self\.__weedPageOrigin/);
  assert.match(abstractWorker, /self\.__weedPageOrigin = e\.data\.pageOrigin/);
  assert.match(bootstrap, /pageOrigin:/);
});

test('AbstractWorker updateFrameTiming freezes sim dt when fixedFps > 0', async () => {
  // Review M8: this ran on the source text; it now runs the shipped method.
  const worker = await loadWorker('logicWorker.js', 'logicWorker');
  const step = (wallMs) => {
    worker.lastFrameTime = performance.now() - wallMs;
    return worker.updateFrameTiming().deltaTime;
  };
  worker._injectedDeltaTime = 0;
  worker.fixedFps = 30;
  // fixedFps passes a constant 1000/fixedFps to update(), not the wall-clock dt...
  assert.equal(step(50), Time.scaleSimMs(1000 / 30));
  assert.equal(step(5), Time.scaleSimMs(1000 / 30));
  // ...while FPS readers still see the wall clock.
  // 5 ms of wall clock (a little more if the test is descheduled): about 200 FPS, never 30.
  assert.ok(worker.currentFPS > 50 && worker.currentFPS <= 200.01, `FPS from the wall clock: ${worker.currentFPS}`);
  // A lockstep step injects its dt ahead of fixedFps and the wall clock.
  worker._injectedDeltaTime = 7;
  assert.equal(step(50), Time.scaleSimMs(7));
  // With neither, the sim dt is the wall-clock delta.
  worker._injectedDeltaTime = 0;
  worker.fixedFps = 0;
  const wall = step(40);
  assert.ok(wall >= Time.scaleSimMs(40) - 1e-9 && wall <= Time.scaleSimMs(100), `wall-clock dt: ${wall}`);
});
