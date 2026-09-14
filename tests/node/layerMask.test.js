import test from 'node:test';
import assert from 'node:assert/strict';
import { Layer } from '../../src/core/Layer.js';
import { LAYER_DENSITY_SOURCE, LAYER_SUBSCRIBE_KIND, LAYER_FEEDER_KIND } from '../../src/core/ConfigDefaults.js';

const BUILT_IN_LAYERS = {
  BACKGROUND: {},
  DECALS: {},
  CASTED_SHADOWS: {},
  ENTITIES: {},
  LIGHTING: {},
};

function withLayers(custom, fn) {
  Layer.reset();
  Layer.initializeFromConfig(custom, BUILT_IN_LAYERS, true);
  try {
    fn();
  } finally {
    Layer.reset();
  }
}

function collectSpriteBits(mask) {
  const ids = [];
  for (let id = 0; id < Layer.count; id++) {
    if (!(mask & (1 << id))) continue;
    if (Layer.isLiquidFunDensityLayer(id)) continue;
    if (!Layer.hasSpriteQueue(id)) continue;
    ids.push(id);
  }
  return ids;
}

test('Layer.resolveSubscriptions: omit, empty, one name, oil+fire, unknown, builtin skip', () => {
  withLayers(
    {
      oil: { shader: { fragment: 'f', densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN } },
      fire: { shader: { fragment: 'f', compute: 's' } },
      fx: { zIndex: 8 },
    },
    () => {
      const entities = Layer.entitiesMask();
      const oilId = Layer.getId('oil');
      const fireId = Layer.getId('fire');
      const fxId = Layer.getId('fx');
      assert.ok(entities);
      assert.equal(Layer.resolveSubscriptions(null, LAYER_SUBSCRIBE_KIND.PARTICLE), entities);
      assert.equal(Layer.resolveSubscriptions({}, LAYER_SUBSCRIBE_KIND.PARTICLE), entities);
      assert.equal(Layer.resolveSubscriptions({ layers: [] }, LAYER_SUBSCRIBE_KIND.PARTICLE), 0);
      assert.equal(Layer.resolveSubscriptions({ layers: [] }, LAYER_SUBSCRIBE_KIND.GAME_OBJECT), entities);
      assert.equal(Layer.resolveSubscriptions({ layer: 'oil' }, LAYER_SUBSCRIBE_KIND.PARTICLE), 1 << oilId);
      assert.equal(
        Layer.resolveSubscriptions({ layers: ['oil', 'fire'] }, LAYER_SUBSCRIBE_KIND.PARTICLE),
        (1 << oilId) | (1 << fireId),
      );
      assert.equal(
        Layer.resolveSubscriptions({ layer: 'fire' }, LAYER_SUBSCRIBE_KIND.GAME_OBJECT),
        entities | (1 << fireId),
      );
      assert.equal(Layer.resolveSubscriptions({ layer: 'fx' }, LAYER_SUBSCRIBE_KIND.PARTICLE), 1 << fxId);
      assert.equal(Layer.resolveSubscriptions({ layer: 'nope' }, LAYER_SUBSCRIBE_KIND.PARTICLE), 0);
      assert.equal(Layer.feederKind(oilId), LAYER_FEEDER_KIND.DENSITY);
      assert.equal(Layer.feederKind(fireId), LAYER_FEEDER_KIND.COMPUTE);
      assert.equal(Layer.feederKind(fxId), LAYER_FEEDER_KIND.SPRITES);
      assert.equal(typeof Layer.feederKind(oilId), 'number');
    },
  );
});

test('Layer.maskFromLegacy: layerId 0 is ENTITIES; feed bit ORs', () => {
  withLayers({}, () => {
    const entities = Layer.entitiesMask();
    const mask = Layer.maskFromLegacy(new Uint8Array([0, 5]), new Uint8Array([3, 255]));
    assert.equal(mask[0], entities | (1 << 3));
    assert.equal(mask[1], 1 << 5);
    const already = Layer.maskFromLegacy(new Uint16Array([7, 9]), null);
    assert.deepEqual([...already], [7, 9]);
  });
});

test('collect writes once per sprite-queue bit', () => {
  withLayers(
    {
      fx: { zIndex: 8 },
      canopy: { zIndex: 9 },
    },
    () => {
      const fxId = Layer.getId('fx');
      const canopyId = Layer.getId('canopy');
      const mask = (1 << fxId) | (1 << canopyId);
      assert.deepEqual(collectSpriteBits(mask), [fxId, canopyId]);
    },
  );
});

test('Layer.bit clamps out of range', () => {
  assert.equal(Layer.bit(-1), 0);
  assert.equal(Layer.bit(16), 0);
  assert.equal(Layer.bit(3), 1 << 3);
});
