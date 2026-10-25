import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PRE_RENDER_DEFAULTS } from '../../src/util/configDefaults.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const preRender = readFileSync(join(root, 'src/workers/preRenderWorker.js'), 'utf8');
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

test('skipCull defaults false; the render-queue catalog scene leaves it off', () => {
  assert.equal(PRE_RENDER_DEFAULTS.skipCull, false);
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
  // H-19 hoisted `this.skipCull` into a local in both collect loops, so the
  // literal `if (!this.skipCull)` no longer appears twice. What this test is
  // really protecting - that each collect loop still has its OWN per-frame cull
  // branch, and that neither reads it from `this` inside the loop - is asserted
  // directly below instead of by counting a string that an optimisation removed.
  assert.equal(body.match(skipIf)?.length ?? 0, 0);
  assert.equal(adobeBody.match(skipIf)?.length ?? 0, 1);
  // One hoisted read per loop...
  assert.match(body, /const skipCull = this\.skipCull;/);
  // ...used by the loop, and the loop guarded by it.
  assert.match(body, /if \(!skipCull\) \{/);
  // The glow collector hoists too, including the static-array lookups that were
  // a property chain per light.
  // Slice by the method DEFINITION, not a bare name: `advanceAdobeAnimations(` also
  // matches an earlier call site, and indexOf would then return an index before
  // the start, producing an empty slice rather than a useful failure.
  const glow = preRender.slice(
    preRender.indexOf('_collectEntityGlow('),
    preRender.indexOf('advanceAdobeAnimations(deltaTime) {'),
  );
  assert.ok(glow.length > 0, 'glow collector slice must not be empty');
  assert.match(glow, /const skipCull = this\.skipCull;/);
  assert.match(glow, /const glowHalfW = SpriteRenderer\.boundsHalfW;/);
  assert.match(glow, /glowHalfW\[i\]/);
  // Against CODE, not prose. The H-19 comment quotes the removed
  // `SpriteRenderer.boundsHalfW?.[i]` verbatim to explain what it replaced, and a
  // naive doesNotMatch on the raw text flags that comment as a regression. The
  // comment is worth keeping - so strip line comments and assert on what runs.
  const glowCode = glow.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(glowCode, /SpriteRenderer\.boundsHalfW\?\./);
  assert.doesNotMatch(glowCode, /this\.skipCull\)/);
  // Two loops: the turned-camera copy (E-51, exact view-space cull) and the one
  // rotation 0 runs; turnedCameraCull.test.js checks what the copy keeps.
  assert.equal(body.match(/for \(let idx = 0; idx < iterCount/g)?.length, 2);
  assert.match(body, /screenMinX/);
  assert.doesNotMatch(body, /screenX\[i\] = sx/);
  assert.doesNotMatch(adobeBody, /screenX\[i\] = sx/);
  // Same reason as the glow slice: indexOf on a removed literal returns -1, and
  // slice(-1, n) silently yields one character instead of failing loudly.
  const cullStart = body.indexOf('if (!skipCull)');
  assert.ok(cullStart >= 0, 'the entity cull branch must be findable');
  const entityCull = body.slice(cullStart, body.indexOf('isItOnScreen[i] = 1'));
  assert.match(entityCull, /screenMinX/);
  assert.doesNotMatch(entityCull, /screenX\[i\]/);
  assert.match(preRender, /const ySorting = !!\(Layer\._ySorting && Layer\._ySorting\[entry\.layerId\]\)/);
  assert.match(preRender, /const writeSortKey = !!\(this\.renderQueueSortKey && source\.hasOrder\)/);
});

test('stamp light range falls back to influence when visualRange is 0', () => {
  const start = preRender.indexOf('_collectStampLights()');
  const end = preRender.indexOf('_packGpuSprites(', start);
  const body = preRender.slice(start, end);
  assert.match(body, /vrRange > 0 \? vrRange : influence/);
});

test('gpu pack reuses one pack context', () => {
  assert.match(preRender, /makePackContext\(q, opts, cap, this\._gpuPackCtx\)/);
});
