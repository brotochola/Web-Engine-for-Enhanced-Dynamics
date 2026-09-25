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
  assert.match(pixi, /createPainterState, orderPainterSlots/);
  assert.match(pixi, /this\._painter = \(!z && !bitonic && this\._ySort\) \? createPainterState\(maxItems\) : null/);
  assert.match(pixi, /_uploadSortedSprites\(/);
  assert.match(pixi, /orderPainterSlots\(painter, idxE, ne, keysU32\)/);
  assert.match(pixi, /painter = layerYSort \? createPainterState\(maxItems\) : null/);
  assert.match(pixi, /this\._uploadSortedSprites\(cl\.batch, q, opts, cl\.painter, cl\.sortKeyU32, null, count\)/);
});

test('useZBuffer alphaCut is the low discard; the high cut stays 0', () => {
  assert.match(defaults, /DEFAULT_ALPHA_CUT_OFF_U8 = 1/);
  assert.match(pixi, /alphaCut: \(this\._zBufferRequested \|\| bitonic\) \? new Float32Array\(\[this\._alphaCut, 0, 0, 0\]\) : null/);
  assert.match(pixi, /this\._alphaCut = DEFAULT_ALPHA_CUT_OFF_U8 \/ 255/);
});

test('pixi: WebGPU injects a device with timestamp-query and wraps beginRenderPass', () => {
  const timer = readFileSync(join(root, 'src/render/gpuFrameTimer.js'), 'utf8');
  const req = readFileSync(join(root, 'src/render/webgpu/requestGpuDevice.js'), 'utf8');
  const bitonic = readFileSync(join(root, 'src/render/webgpu/bitonicSort.js'), 'utf8');
  assert.match(req, /timestamp-query/);
  assert.match(pixi, /requestWeedGpu/);
  assert.match(pixi, /gpu: \{ adapter: weedGpu\.adapter, device: weedGpu\.device \}/);
  assert.match(timer, /encoder\.renderStart/);
  assert.match(timer, /timestampWrites/);
  assert.doesNotMatch(timer, /renderer\?\.gpu && !renderer\.gl/);
  assert.match(bitonic, /timer && timer\.computeStamp/);
  assert.match(bitonic, /timer\.resolveCompute/);
});

test('pixi: lighting binds uShadowSampler to the live shadow RT, not Texture.WHITE', () => {
  assert.match(pixi, /_lightingShadowResources\(\)/);
  assert.match(pixi, /res\.uShadowSampler = src\.style/);
  assert.match(pixi, /this\._unbindLightingShadowMap\(\)/);
  assert.match(pixi, /this\._bindLightingShadowMap\(\)/);
  assert.doesNotMatch(pixi, /uShadowMap: PIXI\.Texture\.WHITE\.source/);
});

test('pixi: bitonic cutout+blend share one entities root so layer zIndex cannot invert them', () => {
  assert.match(pixi, /this\._entitiesRoot = new Container\(\)/);
  assert.match(pixi, /this\._entitiesRoot\.addChild\(this\.spriteMesh\)/);
  assert.match(pixi, /this\._registerLayerDisplayObject\('entities', this\._entitiesRoot\)/);
});

test('pixi: GPU two-pass is gone; ySorting uses reinsert with no painterSort config', () => {
  assert.doesNotMatch(pixi, /entitiesParticleBatch/);
  assert.doesNotMatch(pixi, /coveragePass/);
  assert.doesNotMatch(pixi, /BATCH_DEPTH\.SORT_KEY/);
  assert.doesNotMatch(pixi, /spriteCoverageMesh/);
  assert.doesNotMatch(pixi, /spriteParticleMesh/);
  assert.doesNotMatch(pixi, /painterSort/);
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
  const packCall = preRender.indexOf('this._packGpuQueues(');
  const shadowFn = preRender.indexOf('buildShadowRenderQueue() {');
  assert.ok(updateCall >= 0 && packCall >= 0 && updateCall < packCall);
  assert.ok(shadowFn > packCall);
  const shadowBody = preRender.slice(shadowFn, shadowFn + 280);
  assert.match(shadowBody, /shadowRenderQueueCount\[0\] = 0/);
});

test('shadow RT clears transparent each frame (not opaque black)', () => {
  const fn = pixi.indexOf('updateShadowSprites() {');
  const body = pixi.slice(fn, pixi.indexOf('\n  loadTextures(', fn));
  assert.match(body, /rtOpts\.clear = true/);
  assert.match(body, /rtOpts\.clearColor = this\._clearTransparent/);
  assert.doesNotMatch(body, /_clearBlack|\[0,\s*0,\s*0,\s*1\]/);
});
