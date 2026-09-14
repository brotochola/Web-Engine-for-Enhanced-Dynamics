import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const preRender = readFileSync(join(root, 'src/workers/preRenderWorker.js'), 'utf8');
const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');
const defaults = readFileSync(join(root, 'src/util/configDefaults.js'), 'utf8');

test('main ENTITIES queue does not CPU-heapsort; GPU sortKey path', () => {
  assert.doesNotMatch(preRender, /_heapsortRenderables|_heapsortCollector/);
  assert.doesNotMatch(preRender, /instancedSprites\s*!==\s*false/);
  assert.match(preRender, /sortTimeThisFrame = 0/);
  assert.match(preRender, /rqSortKey\[out\] = sk/);
});

test('custom layers write sortKey and skip CPU heapsort', () => {
  assert.match(preRender, /layerRef\.sortKey = rqSortKey/);
  assert.doesNotMatch(preRender, /Y-sort \(per-layer policy\)/);
});

test('pixi custom layers use sortKey depth when layer.ySorting', () => {
  assert.match(pixi, /depthTest: layerYSort/);
  assert.match(pixi, /depthMode = useSortKey \? BATCH_DEPTH\.SORT_KEY : BATCH_DEPTH\.INDEX/);
  assert.doesNotMatch(pixi, /this\.instancedSprites\s*=/);
});

test('instancedSprites config flag removed (always instanced)', () => {
  assert.doesNotMatch(defaults, /instancedSprites/);
});

test('visible lights SAB fills even when cookie shadows are off', () => {
  assert.match(preRender, /_collectVisibleLights\(\)/);
  const updateCall = preRender.indexOf('this._collectVisibleLights();');
  const shadowFn = preRender.indexOf('buildShadowRenderQueue() {');
  const earlyReturn = preRender.indexOf(
    'if (!this.shadowsEnabled || !this.shadowRenderQueueCount)',
    shadowFn,
  );
  assert.ok(updateCall >= 0 && updateCall < shadowFn);
  assert.ok(earlyReturn > shadowFn);
});

test('shadow RT clears transparent each frame (not opaque black)', () => {
  const fn = pixi.indexOf('updateShadowSprites() {');
  const body = pixi.slice(fn, pixi.indexOf('\n  loadTextures(', fn));
  assert.match(body, /rtOpts\.clear = true/);
  assert.match(body, /rtOpts\.clearColor = this\._clearTransparent/);
  assert.doesNotMatch(body, /_clearBlack|\[0,\s*0,\s*0,\s*1\]/);
});
