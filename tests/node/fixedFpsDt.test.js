import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const abstractWorker = readFileSync(join(root, 'src/workers/abstractWorker.js'), 'utf8');

test('pixi blob workers resolve engine shaders against pageOrigin', () => {
  const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');
  const bootstrap = readFileSync(join(root, 'src/util/sceneWorkerBootstrap.js'), 'utf8');
  assert.match(pixi, /self\.__weedPageOrigin/);
  assert.match(abstractWorker, /self\.__weedPageOrigin = e\.data\.pageOrigin/);
  assert.match(bootstrap, /pageOrigin:/);
});

test('AbstractWorker updateFrameTiming freezes sim dt when fixedFps > 0', () => {
  assert.match(
    abstractWorker,
    /this\.fixedFps > 0\s*\n\s*\? 1000 \/ this\.fixedFps/,
    'fixedFps must pass constant 1000/fixedFps to update(), not wall-clock dt',
  );
  assert.match(
    abstractWorker,
    /this\._injectedDeltaTime > 0/,
    'lockstep step may inject dt ahead of fixedFps / wall clock',
  );
  assert.match(
    abstractWorker,
    /const instantaneousFPS = 1000 \/ Math\.max\(wallDelta, FPS_MIN_DELTA_MS\);/,
    'FPS / STEP_MS readers must still use wall-clock delta',
  );
});
