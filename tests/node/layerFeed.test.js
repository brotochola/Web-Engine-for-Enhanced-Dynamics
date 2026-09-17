import test from 'node:test';
import assert from 'node:assert/strict';
import { Layer } from '../../src/core/layer.js';
import { Collider } from '../../src/components/collider.js';
import {
  LAYER_DENSITY_SOURCE,
} from '../../src/util/configDefaults.js';
import {
  syncColliderFeed,
  syncParticleFeed,
  colliderFeedCount,
  particleFeedCount,
  visitColliderFeed,
} from '../../src/util/layerFeed.js';

const BUILT_IN = {
  decals: {},
  castedShadows: {},
  entities: {},
  lighting: {},
};

function withLayers(custom, fn) {
  Layer.reset();
  Layer.initializeFromConfig(custom, BUILT_IN, true);
  try {
    fn();
  } finally {
    Layer.reset();
  }
}

function listOf(layerId) {
  const out = [];
  visitColliderFeed(layerId, (i) => out.push(i));
  return out;
}

test('syncColliderFeed: one body on two compute layers; swap-remove stays dense', () => {
  const n = 8;
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  withLayers(
    {
      sim: { shader: { fragment: 'f', compute: 's', maxBodies: 8 } },
      fire: { shader: { fragment: 'f', compute: 's', maxBodies: 8 } },
    },
    () => {
      const simId = Layer.getId('sim');
      const fireId = Layer.getId('fire');
      const both = (1 << simId) | (1 << fireId);
      syncColliderFeed(0, 0, both);
      syncColliderFeed(1, 0, both);
      syncColliderFeed(2, 0, 1 << simId);
      assert.equal(colliderFeedCount(simId), 3);
      assert.equal(colliderFeedCount(fireId), 2);
      const simBefore = listOf(simId);
      assert.deepEqual(simBefore.sort((a, b) => a - b), [0, 1, 2]);

      syncColliderFeed(1, both, 0);
      assert.equal(colliderFeedCount(simId), 2);
      assert.equal(colliderFeedCount(fireId), 1);
      const simAfter = listOf(simId);
      assert.equal(simAfter.length, 2);
      assert.ok(simAfter.includes(0));
      assert.ok(simAfter.includes(2));
      assert.ok(!simAfter.includes(1));
    },
  );
});

test('syncColliderFeed: overflow warns once and drops extra', () => {
  const n = 4;
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  const warns = [];
  const prev = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    withLayers(
      { sim: { shader: { fragment: 'f', compute: 's', maxBodies: 1 } } },
      () => {
        const id = Layer.getId('sim');
        syncColliderFeed(0, 0, 1 << id);
        syncColliderFeed(1, 0, 1 << id);
        syncColliderFeed(2, 0, 1 << id);
        assert.equal(colliderFeedCount(id), 1);
        assert.equal(listOf(id)[0], 0);
        assert.ok(warns.some((w) => w.includes('syncColliderFeed: overflow')));
      },
    );
  } finally {
    console.warn = prev;
  }
});

test('syncParticleFeed: density layer list; clear on mask 0', () => {
  withLayers(
    {
      oil: { shader: { fragment: 'f', densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN, maxParticles: 8 } },
    },
    () => {
      const oilId = Layer.getId('oil');
      const bit = 1 << oilId;
      syncParticleFeed(3, 0, bit);
      syncParticleFeed(4, 0, bit);
      assert.equal(particleFeedCount(oilId), 2);
      syncParticleFeed(3, bit, 0);
      assert.equal(particleFeedCount(oilId), 1);
    },
  );
});
