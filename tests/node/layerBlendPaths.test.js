/**
 * DBG-2: a layer's blend modes and z change at run time, and stay changed. The Layer facade's setters write the config
 * SAB and a dirty flag (as alpha and visible); the real Pixi worker (workerHarness) applies them each frame to every
 * object that draws the layer, and registering a layer's object again reads the same SAB instead of the config's value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { Layer } from '../../src/core/layer.js';
import { BLEND_MODES } from '../../src/util/configDefaults.js';

const VIEWS = [
  '_zIndex', '_blendModeId', '_hasShader', '_ySorting', '_resolution', '_alpha', '_alphaDirty', '_containerBlendId',
  '_available', '_hasRenderQueue', '_visible', '_feederKind', '_visibleDirty', '_presentationDirty',
];

/** Fresh config views and two layers (entities, a custom fx), as a scene's init leaves them; put back by restore(). */
function withLayers() {
  const saved = { byName: Layer._byName, byId: Layer._byId, count: Layer.count };
  for (const k of VIEWS) saved[k] = Layer[k];
  Layer._createConfigViews(new SharedArrayBuffer(Layer._getConfigSABSize()));
  const entities = new Layer(0, 'entities');
  const fx = new Layer(1, 'fx');
  Layer._byName = { entities, fx };
  Layer._byId = [entities, fx];
  Layer.count = 2;
  return {
    entities,
    fx,
    restore() {
      for (const k of VIEWS) Layer[k] = saved[k];
      Layer._byName = saved.byName;
      Layer._byId = saved.byId;
      Layer.count = saved.count;
    },
  };
}

test('the blend list holds the modes this build draws, in BLEND_MODES order', () => {
  const names = Object.keys(BLEND_MODES).map((k) => k.toLowerCase().replace('_', '-'));
  assert.deepEqual(Layer._BLEND_MODE_STRINGS, names);
  assert.ok(!Layer._BLEND_MODE_STRINGS.includes('overlay'));
});

test('the setters write the SAB by name and mark the layer; an unknown mode or a non-finite z throws', () => {
  const layers = withLayers();
  try {
    layers.fx.blendMode = 'add';
    assert.equal(Layer._blendModeId[1], BLEND_MODES.ADD);
    assert.equal(layers.fx.blendMode, 'add');
    assert.equal(Layer._presentationDirty[1], 1);
    layers.fx.containerBlendMode = 'screen';
    assert.equal(layers.fx.containerBlendMode, 'screen');
    layers.fx.zIndex = 7.5;
    assert.equal(layers.fx.zIndex, 7.5);
    assert.throws(() => { layers.fx.blendMode = 'overlay'; }, /"fx" blendMode "overlay" is not a blend mode this build draws/);
    assert.throws(() => { layers.fx.zIndex = NaN; }, /zIndex must be a finite number/);
    assert.equal(layers.fx.blendMode, 'add', 'a refused mode leaves the last one');
    assert.throws(() => Layer._blendModeIdOf(18, 'old', 'blendMode'), /is not a blend mode this build draws/);
  } finally {
    layers.restore();
  }
});

async function pixi() {
  const shared = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const px = Object.assign(Object.create(Object.getPrototypeOf(shared)), shared);
  px.sorts = 0;
  px.pixiApp = { stage: { sortChildren: () => { px.sorts++; } } };
  return px;
}

test('the worker applies a run-time blend to the entities\' batch and a layer\'s pieces, and keeps it on re-registration', async () => {
  const layers = withLayers();
  try {
    const px = await pixi();
    const batchBlends = [];
    const root = { blendMode: 'normal', zIndex: 0, alpha: 1, visible: true };
    const fxSprite = { blendMode: 'normal', zIndex: 1, alpha: 1, visible: true };
    const fxPiece = { blendMode: 'normal' };
    px._layerRuntime = { entities: root, fx: fxSprite };
    px.entitiesBatch = { setLayerBlend: (mode) => batchBlends.push(mode) };
    px._lightEdges = null;
    px._unshadedComposite = null;
    px._customLayers = { 1: { batch: { mesh: fxPiece }, rt: {}, containerBlendSet: false } };

    layers.entities.blendMode = 'add';
    layers.fx.containerBlendMode = 'screen';
    layers.fx.zIndex = 9;
    px.syncLayerPresentationFromSharedState();
    assert.deepEqual(batchBlends, ['add'], 'the batch mesh takes it: its root\'s was never inherited');
    assert.equal(root.blendMode, 'add');
    assert.equal(fxPiece.blendMode, 'screen', 'a piece drawn into the layer\'s RT takes the container blend');
    assert.equal(fxSprite.blendMode, 'normal', 'the layer\'s picture keeps its own blend');
    assert.equal(fxSprite.zIndex, 9);
    assert.equal(px.sorts, 1);

    px.syncLayerPresentationFromSharedState();
    assert.deepEqual(batchBlends, ['add'], 'applied once per change');

    // A shader swap or a look composite registers the layer's object again: it reads the SAB, not the config.
    root.blendMode = 'normal';
    px._applyLayerPresentation('entities', root, false);
    assert.equal(root.blendMode, 'add');
    px._applyLayerPresentation('fx', fxSprite, false);
    assert.equal(fxSprite.zIndex, 9);
  } finally {
    layers.restore();
  }
});

test('setLayerProps keeps only the shader swap and the splat radius', async () => {
  const px = await pixi();
  const display = { blendMode: 'normal', zIndex: 0, visible: true };
  px.layerRefs = { fx: display };
  px.handleSetLayerProps({ layer: 'fx', blendMode: 'add', zIndex: 5, visible: false });
  assert.deepEqual(display, { blendMode: 'normal', zIndex: 0, visible: true });
});
