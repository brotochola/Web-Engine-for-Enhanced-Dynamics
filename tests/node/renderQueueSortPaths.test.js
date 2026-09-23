import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const preRender = readFileSync(join(root, 'src/workers/preRenderWorker.js'), 'utf8');
const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');
const defaults = readFileSync(join(root, 'src/util/configDefaults.js'), 'utf8');

test('preRenderWorker only writes sortKey; never CPU-sorts the queue', () => {
  assert.doesNotMatch(preRender, /_heapsortRenderables|_heapsortCollector/);
  assert.doesNotMatch(preRender, /instancedSprites\s*!==\s*false/);
  assert.match(preRender, /sortTimeThisFrame = 0/);
  assert.match(preRender, /rqSortKey\[out\] = sk/);
  assert.match(preRender, /layerRef\.sortKey = rqSortKey/);
  assert.doesNotMatch(preRender, /Y-sort \(per-layer policy\)/);
});

test('pixi: main ENTITIES queue and Y-sorted custom layers share one painter path', () => {
  assert.match(pixi, /createPainterState,\s*orderPainterSlots\s*}\s*from\s*'\.\.\/util\/sortIndexByKey\.js'/);
  assert.match(pixi, /this\._painter = this\.ySorting \? createPainterState\(maxItems\) : null/);
  assert.match(pixi, /_uploadSortedSprites\(/);
  assert.match(pixi, /orderPainterSlots\(painter, idxE, ne, keysU32, this\.painterSort\)/);
  assert.match(pixi, /painter = layerYSort \? createPainterState\(maxItems\) : null/);
  assert.match(pixi, /this\._uploadSortedSprites\(cl\.batch, q, opts, cl\.painter, cl\.sortKeyU32, null, count\)/);
});

test('pixi: GPU two-pass is gone; ySorting maps off to reinsert', () => {
  assert.doesNotMatch(pixi, /entitiesParticleBatch/);
  assert.doesNotMatch(pixi, /coveragePass/);
  assert.doesNotMatch(pixi, /BATCH_DEPTH\.SORT_KEY/);
  assert.doesNotMatch(pixi, /spriteCoverageMesh/);
  assert.doesNotMatch(pixi, /spriteParticleMesh/);
  assert.match(pixi, /painterSort === 'radix' \|\| painterSort === 'decimate'/);
  assert.doesNotMatch(pixi, /this\.instancedSprites\s*=/);
});

test('preRender persist skips Adobe expansion (type 6 write-index mismatch)', () => {
  const fn = preRender.indexOf('_type0PersistHit(');
  assert.ok(fn >= 0);
  const body = preRender.slice(fn, preRender.indexOf('_rememberType0Set(', fn));
  assert.match(body, /if \(type === 6\) return false;/);
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
