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

test('sun casters pack from sprite shadowH, not a fused CPU queue', () => {
  assert.doesNotMatch(preRender, /_writeFusedSunShadow\(/);
  assert.match(preRender, /compactShadowCasterIndices/);
  assert.match(preRender, /_packGpuShadows\(/);
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
  const skipIf = /if \(!this\.skipCull\)/g;
  assert.equal(body.match(skipIf)?.length, 2);
  assert.equal(adobeBody.match(skipIf)?.length, 1);
  assert.equal(body.match(/for \(let idx = 0; idx < iterCount/g)?.length, 1);
  assert.match(body, /screenMinX/);
  assert.doesNotMatch(body, /screenX\[i\] = sx/);
  assert.doesNotMatch(adobeBody, /screenX\[i\] = sx/);
  const entityCull = body.slice(body.indexOf('if (!this.skipCull)'), body.indexOf('isItOnScreen[i] = 1'));
  assert.match(entityCull, /screenMinX/);
  assert.doesNotMatch(entityCull, /screenX\[i\]/);
  assert.match(preRender, /const writeSortKey = !!\(rqSortKey && Layer\._ySorting/);
  assert.match(preRender, /rx0 !== 0 \|\| ry0 !== 0/);
});

test('persist static columns live on the champion worker', () => {
  assert.match(preRender, /_type0PersistHit\(/);
  assert.match(preRender, /_writeType0PosesOnly\(/);
  assert.doesNotMatch(preRender, /_emitType0At\(/);
});

test('persist pose rewrite also restores shadowH for GPU casters', () => {
  const start = preRender.indexOf('_writeType0PosesOnly(');
  const end = preRender.indexOf('_spriteSortY(', start);
  const body = preRender.slice(start, end);
  assert.match(body, /_writeQueueShadow\(i, idx\)/);
});

test('adobe writes one shadow row on the lowest piece', () => {
  const start = preRender.indexOf('_emitAdobePieces(');
  const end = preRender.indexOf('_syncGlowLayer(', start);
  const body = preRender.slice(start, end);
  assert.match(body, /feetSlot/);
  assert.match(body, /_writeQueueShadow\(feetSlot, entityIndex, ref\)/);
  assert.equal((body.match(/_writeQueueShadow\(/g) || []).length, 1);
});

test('sharded GPU shadows pack sun per worker and stamp after the sun join', () => {
  assert.match(preRender, /_stampJoinedSun\(/);
  assert.match(preRender, /_packCopyJoinedShadows\(/);
  const pubAt = preRender.lastIndexOf('_publishGpuQueue(bufIdx)');
  const pub = preRender.slice(pubAt, preRender.indexOf('_collectVisibleLights()', pubAt));
  assert.doesNotMatch(pub, /_packGpuShadows\(/);
  assert.match(pub, /_packJoinedGpuSprites\(/);
});

test('sharded y-sort / zIndex re-packs sprites from the joined SoA, not per id-block', () => {
  assert.match(preRender, /_joinedPainterNeeded\(\)/);
  assert.match(preRender, /_packJoinedGpuSprites\(dst, views\)/);
  assert.match(preRender, /_mergePackedGpuStream\(/);
  assert.match(preRender, /SORT_SPRITES_PRERENDER_MERGE/);
});

test('stamp light range falls back to influence when visualRange is 0', () => {
  const start = preRender.indexOf('_collectStampLights()');
  const end = preRender.indexOf('_packGpuSprites(', start);
  const body = preRender.slice(start, end);
  assert.match(body, /vrRange > 0 \? vrRange : influence/);
});

test('gpu pack reuses pack context and sprite-window scratch', () => {
  assert.match(preRender, /makePackContext\(q, opts, caps.maxSprites, this\._gpuPackCtx\)/);
  assert.match(preRender, /this\._gpuWin \|\| \(this\._gpuWin = \{\}\)/);
});
