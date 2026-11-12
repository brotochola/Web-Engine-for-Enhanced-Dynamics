import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { Query } from '../../src/core/query.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers, sceneEntitySlots } from '../../src/util/sceneSharedBuffers.js';
import { bindEntityIdWidth, resolveEntityIdWidth } from '../../src/util/entityIdWidth.js';

// N-145: a scene with no entity types (a menu, LiquidFun or decorations alone) failed to load: with zero entity slots
// the spatial publish memory was not made ("Cannot read properties of null (reading 'buffer')"), and then physics's
// Transform, RigidBody and Collider views were missing. Such a scene keeps one slot no type owns and nothing spawns.

function emptyScene(totalEntityCount) {
  Query.reset();
  const scene = {
    totalEntityCount,
    nextComponentId: 3,
    registeredClasses: [],
    componentPools: {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
    },
    config: {
      worldWidth: 4000,
      worldHeight: 2000,
      canvasWidth: 1280,
      canvasHeight: 720,
      particle: { maxParticles: 0, decals: false, swayFrequencyBuckets: 0 },
      decoration: { maxDecorations: 0, maxAttachedDecorationsPerEntity: 0, swayDecimation: 1 },
      bullet: { maxBullets: 0, maxImpactsPerFrame: 64 },
      physics: { maxJoints: 0 },
      spatial: { cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 8, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
      lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: 0 },
      layers: {},
      wasm: { ...WASM_DEFAULTS },
      entityIdWidth: resolveEntityIdWidth({}, Math.max(1, totalEntityCount)),
    },
    buffers: { componentData: {} },
    views: {},
    camera: { zoom: 1, x: 0, y: 0 },
    inputBufferSize: 1,
    keyMap: {},
    updateKeyboardBuffer() {},
    preInitializeEntityTypeArrays() {},
    constructor: { queries: [] },
  };
  bindEntityIdWidth(scene.config.entityIdWidth);
  const log = console.log;
  console.log = () => {};
  try {
    createSceneSharedBuffers(scene);
  } finally {
    console.log = log;
  }
  return scene;
}

test('a scene without entity types gets one slot; a scene with types, exactly theirs', () => {
  assert.equal(sceneEntitySlots(0), 1);
  assert.equal(sceneEntitySlots(37), 37);
});

test('with its one slot, a scene without entity types makes the spatial memory and the physics views', () => {
  const scene = emptyScene(sceneEntitySlots(0));
  assert.ok(scene.buffers.neighborData, 'the spatial publish memory');
  for (const name of ['Transform', 'RigidBody', 'Collider']) assert.ok(scene.buffers.componentData[name], `${name}'s buffer`);
});

