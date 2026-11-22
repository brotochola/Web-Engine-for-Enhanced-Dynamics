/**
 * N-411: the casted shadows' composite (the sprite that multiplies the shadows' target over the canvas) draws only while
 * that target holds what a pass drew. In map mode the sun and the lamps go to their maps, so most frames draw nothing
 * there, and the composite multiplied a transparent target over the whole canvas. The real Pixi worker in Node
 * (workerHarness), its GPU passes stubbed: the target is cleared once when it empties, the composite turns off, and
 * the first frame that draws into it again (cookies here) turns the composite back on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, cloneWorker } from '../bench/workerHarness.mjs';
import { Layer } from '../../src/core/layer.js';
import { GPU_HDR_COOKIE, GPU_HDR_STAMP, GPU_HDR_SUN, GPU_HEADER_INTS } from '../../src/render/gpuQueueLayout.js';

/** Layer's statics with an entities layer shown (the casters' rows count only then); put back by the returned function. */
function withEntitiesShown() {
  const saved = { byName: Layer._byName, byId: Layer._byId, visible: Layer._visible, count: Layer.count, entitiesId: Layer.entitiesId };
  Layer._byName = { entities: { id: 0, name: 'entities' } };
  Layer._byId = [Layer._byName.entities];
  Layer._visible = new Uint8Array(Layer.MAX_LAYERS).fill(1);
  Layer.count = 1;
  Layer.entitiesId = 0;
  return () => Object.assign(Layer, { _byName: saved.byName, _byId: saved.byId, _visible: saved.visible, count: saved.count, entitiesId: saved.entitiesId });
}

/** A Pixi worker in map mode (the sun's and the lamps' maps on) whose shadow pass draws `cookie` cookie rows. */
async function mapModeWorker() {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const px = cloneWorker(shared);
  px.submits = [];
  px._submitRender = function submit(opts) { this.submits.push(opts.target === this.shadowRT ? 'shadowRT' : 'other'); };
  const header = new Int32Array(GPU_HEADER_INTS);
  px._gpuQueueRead = { header, sun: null, stamp: null, cookie: new Float32Array(64) };
  const uniforms = { uCam: [0, 0, 0], uSun: [0, 0, 0, 0], uLight: [0, 0, 0, 0], uSunK: [0, 0, 0, 0], uSunPerp: [0, 0] };
  px.gpuCasterBatch = {
    mesh: { shader: null, position: { set() {} }, scale: { set() {} }, geometry: {} },
    shadowShader: { resources: { uniforms: { uniforms } } },
    setTargetSpace() {},
  };
  px.shadowBatch = { mesh: {}, setTargetSpace() {} };
  px._commitPackedBatch = () => true;
  px.shadowRT = { name: 'shadowRT' };
  px.shadowDisplaySprite = { renderable: true };
  px._sunMapOn = true;
  px._lampMapOn = true;
  px.lampMap.tileCount = 0;
  px.lampMap.clearIfEmpty = () => {};
  px.shadowMaps._clearSunMapIfEmpty = () => {};
  px.shadowMaps._ensureKeyedCasters = () => {};
  px.lighting.shadowPixelScale = () => 1;
  const frame = (counts) => {
    header[GPU_HDR_SUN] = counts.sun | 0;
    header[GPU_HDR_STAMP] = counts.stamp | 0;
    header[GPU_HDR_COOKIE] = counts.cookie | 0;
    px.submits.length = 0;
    px.shadowMaps._drawGpuCasterShadows();
    return px.submits.filter((t) => t === 'shadowRT').length;
  };
  return { px, frame };
}

test('map mode with nothing for the shadows\' target: cleared once, its composite off until a pass draws there again', async () => {
  const restore = withEntitiesShown();
  try {
    const { px, frame } = await mapModeWorker();
    assert.equal(frame({}), 1, 'the first empty frame clears the target once');
    assert.equal(px.shadowDisplaySprite.renderable, false, 'and the composite no longer draws it');
    assert.equal(frame({}), 0, 'an empty target is not cleared again');
    assert.equal(px.shadowDisplaySprite.renderable, false);
    assert.equal(frame({ cookie: 3 }), 1, 'the cookies draw into it (their pass clears it first)');
    assert.equal(px.shadowDisplaySprite.renderable, true, 'and the composite draws it again');
    assert.equal(frame({}), 1, 'emptied again: cleared once');
    assert.equal(px.shadowDisplaySprite.renderable, false);
  } finally {
    restore();
  }
});
