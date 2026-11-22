/**
 * DBG-5: render views. Which buffer each view samples, the views a scene has, the production stub's exports, and the
 * real Pixi worker (workerHarness): setRenderView sets the view only where its buffer exists, answers with the views it
 * has, makes no stage object while the view is Final, and releases the quad when the view goes back to Final.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as real from '../../src/render/renderViews.js';
import * as stub from '../../src/core/debug/stubs/renderViews.js';
import { loadWorker, postedMessages, cloneWorker } from '../bench/workerHarness.mjs';

const { RENDER_VIEW, availableRenderViews, renderViewTextures } = real;

test('each view samples its buffer; the flags read the face map and the ids map', () => {
  const t = (name) => ({ name });
  const w = { faceRT: t('face'), faceIdsRT: t('ids'), lightingRT: t('light'), unshadedRT: null, shadowRT: t('shadows'), sunMapRT: null, lampMapRT: t('lamps') };
  const out = [null, null];
  const names = (view) => renderViewTextures(w, view, out).map((x) => (x ? x.name : null));
  assert.deepEqual(names(RENDER_VIEW.NORMALS), ['face', null]);
  assert.deepEqual(names(RENDER_VIEW.HEIGHT), ['face', null]);
  assert.deepEqual(names(RENDER_VIEW.IDS), ['ids', null]);
  assert.deepEqual(names(RENDER_VIEW.FLAGS), ['face', 'ids']);
  assert.deepEqual(names(RENDER_VIEW.LIGHT), ['light', null]);
  assert.deepEqual(names(RENDER_VIEW.UNSHADED), [null, null]);
  assert.deepEqual(names(RENDER_VIEW.LAMP_MAP), ['lamps', null]);
  assert.deepEqual(names(RENDER_VIEW.FINAL), [null, null]);
  assert.deepEqual(availableRenderViews(w), [0, 1, 2, 3, 4, 5, 7, 9]);
  assert.deepEqual(availableRenderViews({}), [0]);
  // DBG-7: the tiles view reads the tiles' texture once the light pass by tiles has made it.
  const tiles = t('tiles');
  assert.deepEqual(names(RENDER_VIEW.LIGHT_TILES), [null, null]);
  Object.assign(w, { _lightTilesOn: true, _lightTilesMade: false, _lightTilesSource: tiles });
  assert.deepEqual(names(RENDER_VIEW.LIGHT_TILES), [null, null], 'not made yet');
  w._lightTilesMade = true;
  assert.deepEqual(names(RENDER_VIEW.LIGHT_TILES), ['tiles', null]);
  const gpu = { _useWebGpu: true, _lightTilesOn: true, _lightTilesMade: false, _lightTilesSource: tiles, _lightTiles: { texWidth: 0 } };
  assert.deepEqual(renderViewTextures(gpu, RENDER_VIEW.LIGHT_TILES, out).map((x) => (x ? x.name : null)), [null, null], 'WebGPU: no grid yet');
  gpu._lightTiles.texWidth = 64;
  assert.deepEqual(renderViewTextures(gpu, RENDER_VIEW.LIGHT_TILES, out).map((x) => (x ? x.name : null)), ['tiles', null], 'WebGPU: laid out');
  assert.deepEqual(availableRenderViews(w), [0, 1, 2, 3, 4, 5, 7, 9, 10]);
});

test('the production stub exports what renderViews.js does, and draws no view', () => {
  assert.deepEqual(Object.keys(stub).sort(), Object.keys(real).sort());
  assert.deepEqual(stub.RENDER_VIEW, real.RENDER_VIEW);
  assert.deepEqual(stub.availableRenderViews({ lightingRT: {} }), [0]);
  assert.deepEqual(stub.renderViewTextures({ lightingRT: {} }, RENDER_VIEW.LIGHT, [1, 2]), [null, null]);
});

test('the worker: setRenderView takes a view only where its buffer exists, and makes nothing while Final', async () => {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const px = cloneWorker(shared);
  assert.equal(px._renderView, 0);
  assert.ok(Number.isNaN(px._renderViewOpacity), 'a double field from the constructor');
  px.lightingRT = null;
  px.faceRT = null;
  px.faceIdsRT = null;
  px.unshadedRT = null;
  px.shadowRT = null;
  px.sunMapRT = null;
  px.lampMapRT = null;

  const before = postedMessages().length;
  px.handleCustomMessage({ msg: 'setRenderView', view: RENDER_VIEW.LIGHT, opacity: 0.5 });
  assert.equal(px._renderView, 0, 'no light buffer: the final picture');
  const answer = postedMessages().slice(before).find((m) => m && m.msg === 'renderViews');
  assert.deepEqual(answer, { msg: 'renderViews', views: [0], view: 0 });
  assert.equal(px._renderViewMesh, null);

  px.lightingRT = { source: {} };
  px.handleCustomMessage({ msg: 'setRenderView', view: RENDER_VIEW.LIGHT, opacity: 0.5 });
  assert.equal(px._renderView, RENDER_VIEW.LIGHT);
  assert.equal(px._renderViewOpacity, 0.5);
  assert.equal(px._renderViewMesh, null, 'the quad is made at the next present, not by the message');

  let removed = 0;
  let destroyed = 0;
  px._renderViewMesh = {
    parent: { removeChild: () => { removed++; } },
    geometry: { destroy: () => { destroyed++; } },
    destroy: () => { destroyed++; },
  };
  px.handleCustomMessage({ msg: 'setRenderView', view: RENDER_VIEW.FINAL, opacity: 1 });
  assert.equal(px._renderView, 0);
  assert.equal(px._renderViewMesh, null, 'Final releases the quad');
  assert.equal(removed, 1);
  assert.equal(destroyed, 2, 'the mesh and its geometry');

  // DBG-7: the tiles view has its own quad; Final releases it too.
  px._lightTilesOn = true;
  px._lightTilesMade = true;
  px._lightTilesSource = {};
  px.handleCustomMessage({ msg: 'setRenderView', view: RENDER_VIEW.LIGHT_TILES, opacity: 1 });
  assert.equal(px._renderView, RENDER_VIEW.LIGHT_TILES);
  assert.equal(px._renderTilesMesh, null, 'made at the next present');
  px._renderTilesMesh = {
    parent: { removeChild: () => { removed++; } },
    geometry: { destroy: () => { destroyed++; } },
    destroy: () => { destroyed++; },
  };
  px.handleCustomMessage({ msg: 'setRenderView', view: RENDER_VIEW.FINAL, opacity: 1 });
  assert.equal(px._renderTilesMesh, null, 'Final releases the tiles quad');
  assert.equal(removed, 2);
  assert.equal(destroyed, 4);
});

test('the worker: lightTileAt names the tile under a canvas point and the lights its words list (DBG-7)', async () => {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const px = cloneWorker(shared);
  // A hand-made grid: 4 x 3 tiles of 16 px, a border of 1, two words a tile, rows of 4 texels, 4 rows a word band.
  const t = { cols: 4, rows: 3, tilePx: 16, border: 1, wordsUsed: 2, rowsPerWord: 4, texWidth: 4, bits: new Uint32Array(4 * 8) };
  const word = (x, y, k, value) => {
    t.bits[(y + k * t.rowsPerWord) * t.texWidth + x] = value >>> 0;
  };
  word(2, 1, 0, (1 << 0) | (1 << 5) | (1 << 31));
  word(2, 1, 1, 1 << 2);
  px._lightTiles = t;
  px._lightTilesOn = true;
  px.lightingResolution = 0.5;
  // Canvas (40, 10) at half resolution is light-pass (20, 5): tile 1, 0 plus the border, 2, 1.
  const got = px._lightTileAt(40, 10);
  assert.equal(got.msg, 'lightTile');
  assert.deepEqual([got.x, got.y], [2, 1]);
  assert.deepEqual(got.lights, [0, 5, 31, 34]);
  assert.deepEqual([got.cols, got.rows, got.tilePx, got.wordsUsed], [4, 3, 16, 2]);
  const outside = px._lightTileAt(1000, 10);
  assert.deepEqual([outside.x, outside.y, outside.lights.length], [-1, -1, 0]);
  px._lightTilesOn = false;
  assert.equal(px._lightTileAt(40, 10).x, -1, 'no light pass by tiles: no tile');
});
