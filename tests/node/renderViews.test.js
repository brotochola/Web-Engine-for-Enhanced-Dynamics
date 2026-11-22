/**
 * DBG-5: render views. Which buffer each view samples, the views a scene has, the production stub's exports, and the
 * real Pixi worker (workerHarness): setRenderView sets the view only where its buffer exists, answers with the views it
 * has, makes no stage object while the view is Final, and releases the quad when the view goes back to Final.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as real from '../../src/render/renderViews.js';
import * as stub from '../../src/core/debug/stubs/renderViews.js';
import { loadWorker, postedMessages } from '../bench/workerHarness.mjs';

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
});

test('the production stub exports what renderViews.js does, and draws no view', () => {
  assert.deepEqual(Object.keys(stub).sort(), Object.keys(real).sort());
  assert.deepEqual(stub.RENDER_VIEW, real.RENDER_VIEW);
  assert.deepEqual(stub.availableRenderViews({ lightingRT: {} }), [0]);
  assert.deepEqual(stub.renderViewTextures({ lightingRT: {} }, RENDER_VIEW.LIGHT, [1, 2]), [null, null]);
});

test('the worker: setRenderView takes a view only where its buffer exists, and makes nothing while Final', async () => {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const px = Object.assign(Object.create(Object.getPrototypeOf(shared)), shared);
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
});
