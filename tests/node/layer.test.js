import test from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/layer.js';
import {
  LAYER_DENSITY_SOURCE,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
  LAYER_FEEDER_KIND,
  LAYER_KIND,
  DEFAULT_LAYERS,
} from '../../src/util/configDefaults.js';

const BUILT_IN_LAYERS = DEFAULT_LAYERS;

test('scenery commands post for scenery layers, not pipeline', async () => {
  const previousWarn = console.warn;
  const warnings = [];
  const posted = [];

  console.warn = (message) => warnings.push(String(message));

  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        sky: { kind: LAYER_KIND.COVER, zIndex: 0 },
        ground: { kind: LAYER_KIND.TILEMAP, zIndex: 0.5 },
      },
      BUILT_IN_LAYERS,
      true
    );
    Layer._postToRenderer = (msg) => posted.push(msg);

    Layer.sky.setStatic('sky');
    Layer.sky.setCover({
      texture: 'landscape',
      parallax: { x: 0.2, y: 0.1 },
      margin: 0.25,
      zoomParallax: 0.35,
    });
    Layer.sky.setTiling('clouds', 0.5);
    const pendingTilemap = Layer.ground.setTilemap('roads', { scale: 1 });
    Layer.sky.clear();

    Layer.entities.setStatic('bad');
    Layer.entities.setTiling('bad', 2);
    await Layer.entities.setTilemap('bad-map', { scale: 3 });
    Layer.entities.clear();

    assert.equal(posted.length, 5);
    assert.ok(pendingTilemap instanceof Promise);
    assert.deepEqual(
      posted.map((msg) => ({ msg: msg.msg, type: msg.type, layerId: msg.layerId })),
      [
        { msg: 'setLayerContent', type: LAYER_KIND.STATIC, layerId: Layer.sky.id },
        { msg: 'setLayerContent', type: LAYER_KIND.COVER, layerId: Layer.sky.id },
        { msg: 'setLayerContent', type: LAYER_KIND.TILING, layerId: Layer.sky.id },
        { msg: 'setLayerContent', type: LAYER_KIND.TILEMAP, layerId: Layer.ground.id },
        { msg: 'setLayerContent', type: 'none', layerId: Layer.sky.id },
      ]
    );
    assert.equal(posted[1].textureId, 'landscape');
    assert.equal(posted[1].parallaxX, 0.2);
    assert.equal(posted[1].parallaxY, 0.1);
    assert.equal(posted[1].margin, 0.25);
    assert.equal(posted[1].zoomParallax, 0.35);
    assert.equal(warnings.length, 4);
    assert.ok(warnings.every((message) => message.includes('pipeline layer')));
    assert.equal(Layer.sky.kind, LAYER_KIND.TILING);
    assert.equal(Layer.ground.kind, LAYER_KIND.TILEMAP);
  } finally {
    console.warn = previousWarn;
    Layer.reset();
  }
});

test('applyConfiguredContent posts cover and tilemap from config', async () => {
  const posted = [];
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        sky: {
          kind: LAYER_KIND.COVER,
          texture: 'landscape',
          parallax: 0.15,
          zoomParallax: 0.35,
          margin: 0.2,
          zIndex: 0,
        },
        ground: {
          kind: LAYER_KIND.TILEMAP,
          tilemap: 'myTilemap',
          scale: 1,
          zIndex: 0.5,
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    Layer._postToRenderer = (msg) => {
      posted.push(msg);
      if (msg.msg === 'setLayerContent' && msg.type === 'tilemap') {
        Layer.resolveLayerContentReady(msg.layerId, msg.requestId);
      }
    };
    await Layer.applyConfiguredContent();
    assert.equal(posted.length, 2);
    assert.equal(posted[0].type, 'cover');
    assert.equal(posted[0].textureId, 'landscape');
    assert.equal(posted[1].type, 'tilemap');
    assert.equal(posted[1].tilemapId, 'myTilemap');
  } finally {
    Layer.reset();
  }
});

test('densitySource liquidFun: metadata + no render queue + splat defaults', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        dulceDeLeche: {
          zIndex: 5,
          maxItems: 0,
          shader: {
            fragment: 'dulceDeLeche',
            densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
            splat: { radius: 40, falloff: LAYER_SPLAT_FALLOFF.QUADRATIC },
            uniforms: {
              uCutoff: { value: 0.28, type: 'f32' },
            },
          },
        },
        waterSprites: {
          zIndex: 4,
          maxItems: 100,
          shader: {
            fragment: 'liquid',
            uniforms: {
              uCutoff: { value: 0.3, type: 'f32' },
            },
          },
        },
      },
      BUILT_IN_LAYERS,
      true
    );

    const dulce = Layer.get('dulceDeLeche');
    const water = Layer.get('waterSprites');
    assert.ok(dulce);
    assert.equal(dulce.densitySource, LAYER_DENSITY_SOURCE.LIQUID_FUN);
    assert.equal(dulce.hasRenderQueue, false);
    assert.equal(Layer.isLiquidFunDensityLayer(dulce.id), true);
    assert.equal(dulce.splat.radius, 40);
    assert.equal(dulce.splat.falloff, LAYER_SPLAT_FALLOFF.QUADRATIC);
    assert.equal(dulce.splat.useParticleTint, true);
    assert.equal(dulce.splat.intensity, 1);
    assert.equal(dulce.scaleMode, LAYER_SCALE_MODE.LINEAR);
    assert.equal(Layer._metadata.layers[dulce.id].scaleMode, LAYER_SCALE_MODE.LINEAR);

    assert.equal(water.densitySource, LAYER_DENSITY_SOURCE.SPRITES);
    assert.equal(water.hasRenderQueue, true);
    assert.equal(Layer.isLiquidFunDensityLayer(water.id), false);

    const meta = Layer._metadata.layers[dulce.id];
    assert.equal(meta.densitySource, LAYER_DENSITY_SOURCE.LIQUID_FUN);
    assert.equal(meta.hasRenderQueue, false);
    assert.equal(meta.maxItems, 0);
    assert.equal(meta.splat.radius, 40);

    const posted = [];
    Layer._postToRenderer = (msg) => posted.push(msg);
    dulce.setSplatRadius(64);
    assert.equal(dulce.splat.radius, 64);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].msg, 'setLayerProps');
    assert.equal(posted[0].splatRadius, 64);
  } finally {
    Layer.reset();
  }
});

test('densitySource omit defaults to sprites and keeps render queue', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        fluids: {
          shader: { fragment: 'liquid' },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const layer = Layer.get('fluids');
    assert.equal(layer.densitySource, LAYER_DENSITY_SOURCE.SPRITES);
    assert.equal(layer.hasRenderQueue, true);
    assert.equal(layer.splat, null);
    assert.equal(layer.scaleMode, LAYER_SCALE_MODE.LINEAR);
    assert.equal(Layer._metadata.layers[layer.id].densitySource, LAYER_DENSITY_SOURCE.SPRITES);
  } finally {
    Layer.reset();
  }
});

test('scaleMode NEAREST round-trips in metadata', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        pixelFluid: {
          resolution: 0.25,
          scaleMode: LAYER_SCALE_MODE.NEAREST,
          shader: { fragment: 'dulceDeLeche' },
        },
      },
      BUILT_IN_LAYERS,
      true
    );
    const layer = Layer.get('pixelFluid');
    assert.equal(layer.scaleMode, LAYER_SCALE_MODE.NEAREST);
    assert.equal(Layer._metadata.layers[layer.id].scaleMode, LAYER_SCALE_MODE.NEAREST);
  } finally {
    Layer.reset();
  }
});

test('feederKind is an int enum; visible SAB round-trips', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        oil: { shader: { fragment: 'f', densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN } },
        fire: { shader: { fragment: 'f', compute: 's' } },
        fx: { zIndex: 8 },
      },
      BUILT_IN_LAYERS,
      true
    );
    assert.equal(Layer.feederKind(Layer.entitiesId), LAYER_FEEDER_KIND.SPRITES);
    assert.equal(Layer.feederKind(Layer.getId('oil')), LAYER_FEEDER_KIND.DENSITY);
    assert.equal(Layer.feederKind(Layer.getId('fire')), LAYER_FEEDER_KIND.COMPUTE);
    assert.equal(Layer.feederKind(Layer.getId('fx')), LAYER_FEEDER_KIND.SPRITES);
    assert.equal(Layer.feederKind(Layer.decals.id), LAYER_FEEDER_KIND.BUILTIN);
    assert.equal(typeof Layer.feederKind(Layer.entitiesId), 'number');

    const oil = Layer.get('oil');
    assert.equal(oil.visible, true);
    oil.visible = false;
    assert.equal(oil.visible, false);
    assert.equal(Layer._visible[oil.id], 0);
    assert.equal(Atomics.load(Layer._visibleDirty, oil.id), 1);
    oil.visible = true;
    assert.equal(oil.visible, true);
  } finally {
    Layer.reset();
  }
});

test('densitySource string alias liquidFun still normalizes to int enum', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig(
      {
        oil: { shader: { fragment: 'f', densitySource: 'liquidFun' } },
      },
      BUILT_IN_LAYERS,
      true
    );
    const oil = Layer.get('oil');
    assert.equal(oil.densitySource, LAYER_DENSITY_SOURCE.LIQUID_FUN);
    assert.equal(Layer.feederKind(oil.id), LAYER_FEEDER_KIND.DENSITY);
  } finally {
    Layer.reset();
  }
});
