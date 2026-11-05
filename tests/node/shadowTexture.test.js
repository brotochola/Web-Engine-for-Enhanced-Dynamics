// DX-SHADOWTEX on a real pre-render worker: the pass over the caster rows changes a row's frame, scale and anchor for a
// ShadowCaster with a texture, and leaves every other row as the pack wrote it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { GPU_CASTER_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const N = 6;
const SCALE_X = 2;
const SCALE_Y = 3;
const ANCHOR_X = 4;
const ANCHOR_Y = 5;
const TEXTURE = 10;

function bind() {
  ShadowCaster.textureId = new Uint16Array(N);
  ShadowCaster.textureScaleX = new Float32Array(N);
  ShadowCaster.textureScaleY = new Float32Array(N);
  ShadowCaster.textureAnchorX = new Float32Array(N).fill(NaN);
  ShadowCaster.textureAnchorY = new Float32Array(N).fill(NaN);
}

async function setup(rowsOfEntities) {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const count = rowsOfEntities.length;
  pre._gpuCasterIdx = Uint32Array.from(rowsOfEntities, (_, i) => i);
  pre._renderableType = new Uint8Array(count);
  pre._renderableIndex = Int32Array.from(rowsOfEntities);
  pre._collectedRows = count;
  const rows = new Float32Array(count * GPU_CASTER_FLOATS);
  for (let k = 0; k < count; k++) {
    const at = k * GPU_CASTER_FLOATS;
    rows[at + SCALE_X] = 2;
    rows[at + SCALE_Y] = 3;
    rows[at + ANCHOR_X] = 0.5;
    rows[at + ANCHOR_Y] = 1;
    rows[at + TEXTURE] = 40 + k;
  }
  return { pre, rows, q: { count } };
}

test('a caster with a texture changes frame, scale and anchor; its neighbours keep theirs', async () => {
  bind();
  ShadowCaster.textureId[1] = 8; // frame 7
  ShadowCaster.textureScaleX[1] = 5;
  ShadowCaster.textureScaleY[1] = 6;
  ShadowCaster.textureAnchorX[1] = 0.25;
  ShadowCaster.textureAnchorY[1] = 0.75;
  const { pre, rows, q } = await setup([0, 1, 2]);
  pre._applyShadowTextures(q, rows, 3);
  const at = GPU_CASTER_FLOATS;
  assert.equal(rows[at + TEXTURE], 7);
  assert.equal(rows[at + SCALE_X], 5);
  assert.equal(rows[at + SCALE_Y], 6);
  assert.equal(rows[at + ANCHOR_X], 0.25);
  assert.equal(rows[at + ANCHOR_Y], 0.75);
  assert.equal(rows[TEXTURE], 40);
  assert.equal(rows[2 * at + TEXTURE], 42);
  assert.equal(rows[2 * at + SCALE_X], 2);
});

test('options left out stay the sprite’s, and a flipped sprite’s shadow stays flipped', async () => {
  bind();
  ShadowCaster.textureId[0] = 1;
  ShadowCaster.textureId[1] = 1;
  ShadowCaster.textureScaleX[1] = 4;
  const { pre, rows, q } = await setup([0, 1]);
  rows[GPU_CASTER_FLOATS + SCALE_X] = -2;
  pre._applyShadowTextures(q, rows, 2);
  assert.equal(rows[TEXTURE], 0);
  assert.equal(rows[SCALE_X], 2);
  assert.equal(rows[ANCHOR_X], 0.5);
  assert.equal(rows[ANCHOR_Y], 1);
  assert.equal(rows[GPU_CASTER_FLOATS + SCALE_X], -4);
});

test('a row that is no sprite, and a queue that Adobe roots made longer than the collect, are left alone', async () => {
  bind();
  ShadowCaster.textureId.fill(5);
  const a = await setup([0, 1]);
  a.pre._renderableType[1] = 2;
  a.pre._applyShadowTextures(a.q, a.rows, 2);
  assert.equal(a.rows[TEXTURE], 4);
  assert.equal(a.rows[GPU_CASTER_FLOATS + TEXTURE], 41);

  const b = await setup([0, 1]);
  b.pre._applyShadowTextures({ count: 9 }, b.rows, 2);
  assert.equal(b.rows[TEXTURE], 40);
});

test('the keyed caster paths stay off in a scene with shadow textures', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  pre._keyedFrames = true;
  pre._keyedKeyBase = 1;
  pre._keyedHeader = new Int32Array(new SharedArrayBuffer(64));
  pre.renderQueueFrame = 1;
  pre._shadowTextures = true;
  assert.equal(pre._keyedCastersLive(), false);
  pre._shadowTextures = false;
  pre._keyedFrames = false;
});

test('setTexture writes the columns, with the frame + 1; clearTexture goes back to the sprite', () => {
  bind();
  ShadowCaster.texturesEnabled = true;
  const caster = Object.create(ShadowCaster.prototype);
  Object.defineProperty(caster, 'index', { value: 3 });
  const warn = console.warn;
  console.warn = () => {};
  assert.equal(caster.setTexture('no such frame', { scaleX: 2, anchorY: 0.5 }), caster);
  console.warn = warn;
  assert.equal(ShadowCaster.textureId[3], 0, 'an unknown frame casts the sprite');
  assert.equal(ShadowCaster.textureScaleX[3], 2);
  assert.equal(ShadowCaster.textureScaleY[3], 0);
  assert.ok(Number.isNaN(ShadowCaster.textureAnchorX[3]));
  assert.equal(ShadowCaster.textureAnchorY[3], 0.5);
  ShadowCaster.textureId[3] = 9;
  assert.equal(caster.clearTexture(), caster);
  assert.equal(ShadowCaster.textureId[3], 0);
  ShadowCaster.texturesEnabled = false;
});
