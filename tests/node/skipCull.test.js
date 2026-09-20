import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PRE_RENDER_DEFAULTS } from '../../src/util/configDefaults.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const preRender = readFileSync(join(root, 'src/workers/preRenderWorker.js'), 'utf8');
const bunny = readFileSync(join(root, 'demos/bunnyMarkScene/bunnyMarkScene.js'), 'utf8');
const renderQueue = readFileSync(join(root, 'tests/bench/stressScenes/renderQueueStressScene.js'), 'utf8');
const catalogRenderQueue = renderQueue.slice(
  0,
  renderQueue.indexOf('const HIGH_REJECT_ZOOM'),
);

test('skipCull defaults false and is opt-in on bunny playable only', () => {
  assert.equal(PRE_RENDER_DEFAULTS.skipCull, false);
  assert.match(bunny, /skipCull:\s*true/);
  assert.doesNotMatch(catalogRenderQueue, /skipCull:\s*true/);
});

test('entity collect uses a per-frame skipCull branch; default loop still writes screenXY', () => {
  assert.match(preRender, /this\.skipCull = preRenderConfig\.skipCull === true/);
  const collect = preRender.indexOf('collectVisibleEntities() {');
  const adobe = preRender.indexOf('collectVisibleAdobeAnimations() {');
  const body = preRender.slice(collect, adobe);
  assert.match(body, /if \(this\.skipCull\)/);
  assert.match(body, /screenX\[i\] = sx/);
  const skipBlock = body.slice(body.indexOf('if (this.skipCull)'), body.indexOf('} else for'));
  assert.doesNotMatch(skipBlock, /screenX\[i\]/);
  assert.doesNotMatch(skipBlock, /screenMinX/);
});
