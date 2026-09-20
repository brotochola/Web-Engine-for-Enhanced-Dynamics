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

test('fused sun shadow write is extracted once', () => {
  assert.match(preRender, /_writeFusedSunShadow\(/);
  const defs = preRender.match(/_writeFusedSunShadow\(/g);
  assert.ok(defs && defs.length >= 2);
});

test('skipCull defaults false and is opt-in on bunny playable only', () => {
  assert.equal(PRE_RENDER_DEFAULTS.skipCull, false);
  assert.match(bunny, /skipCull:\s*true/);
  assert.doesNotMatch(catalogRenderQueue, /skipCull:\s*true/);
});

test('entity collect uses a per-frame skipCull branch; default still AABBs; B skips screenXY', () => {
  assert.match(preRender, /this\.skipCull = preRenderConfig\.skipCull === true/);
  const collect = preRender.indexOf('collectVisibleEntities() {');
  const adobe = preRender.indexOf('collectVisibleAdobeAnimations() {');
  const adobeEnd = preRender.indexOf('collectVisibleDecorations() {');
  const body = preRender.slice(collect, adobe);
  const adobeBody = preRender.slice(adobe, adobeEnd);
  const skipIf = /if \(this\.skipCull\)/g;
  assert.equal(body.match(skipIf)?.length, 1);
  assert.equal(adobeBody.match(skipIf)?.length, 1);
  assert.equal(body.match(/for \(let idx = 0; idx < iterCount/g)?.length, 1);
  assert.match(body, /screenMinX/);
  assert.doesNotMatch(body, /screenX\[i\] = sx/);
  assert.doesNotMatch(adobeBody, /screenX\[i\] = sx/);
  const entitySkip = body.slice(body.indexOf('if (this.skipCull)'), body.indexOf('} else'));
  assert.doesNotMatch(entitySkip, /screenX\[i\]/);
  assert.doesNotMatch(entitySkip, /screenMinX/);
  assert.match(preRender, /const writeSortKey = !!\(rqSortKey && Layer\._ySorting/);
  assert.match(preRender, /rx0 !== 0 \|\| ry0 !== 0/);
});

test('persist static columns live on the champion worker', () => {
  assert.match(preRender, /_type0PersistHit\(/);
  assert.match(preRender, /_writeType0PosesOnly\(/);
  assert.doesNotMatch(preRender, /_emitType0At\(/);
});
