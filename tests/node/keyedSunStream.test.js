/**
 * E-211: Pixi's keyed pack writes the entity batch's shadow terms only for a sun pass that will draw those instances:
 * one with no keyed caster rows from pre-render, on a frame whose shadow pass runs (shadowUpdateInterval), with the
 * casted-shadows layer shown. updateShadowSprites on the real Pixi worker, its pass and its batch stubbed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';

async function worker(interval, wanted) {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const calls = [];
  const passes = [];
  px.shadowSpritesEnabled = true;
  px.shadowBatch = {};
  px.shadowRT = {};
  px.shadowUpdateInterval = interval;
  px._shadowUpdateTick = 0;
  px._drawGpuCasterShadows = function draw() {
    passes.push(this._shadowUpdateTick - 1);
    this._keyedSunWanted = wanted();
  };
  px.entitiesBatch = { keyedShadows: true, setKeyedShadowStream: (on) => calls.push(on) };
  return { px, calls, passes };
}

test('every frame a sun pass: the stream is on while the pass has no keyed rows, off once it has them', async () => {
  let rows = false;
  const { px, calls } = await worker(1, () => !rows);
  px.updateShadowSprites();
  px.updateShadowSprites();
  rows = true;
  px.updateShadowSprites();
  px.updateShadowSprites();
  assert.deepEqual(calls, [true, true, false, false]);
});

test('a pass every other frame: the stream is on only for the frames whose pass runs', async () => {
  const { px, calls, passes } = await worker(2, () => true);
  for (let f = 0; f < 6; f++) px.updateShadowSprites();
  assert.deepEqual(passes, [0, 2, 4]);
  // After frame f, the setting for frame f + 1: on before a pass, off before a skipped frame.
  assert.deepEqual(calls, [false, true, false, true, false, true]);
});

test('the casted-shadows layer hidden: no pass and no stream', async () => {
  const { px, calls, passes } = await worker(1, () => true);
  const { Layer } = await import('../../src/core/layer.js');
  const byName = Layer._byName;
  const visible = Layer._visible;
  Layer._byName = { ...byName, castedShadows: { id: 2 } };
  Layer._visible = new Uint8Array(Layer.MAX_LAYERS).fill(1);
  Layer._visible[2] = 0;
  try {
    px.updateShadowSprites();
  } finally {
    Layer._byName = byName;
    Layer._visible = visible;
  }
  assert.deepEqual(passes, []);
  assert.deepEqual(calls, [false]);
});
