import test from 'node:test';
import assert from 'node:assert/strict';

import { createSceneSharedBuffers } from '../../src/core/sceneSharedBuffers.js';

function createValidationScene(overrides = {}) {
  const scene = {
    totalEntityCount: 10,
    nextComponentId: 3,
    registeredClasses: [
      { class: class TestEntityA {}, startIndex: 0, count: 5 },
      { class: class TestEntityB {}, startIndex: 5, count: 5 },
    ],
    config: {
      worldWidth: 1024,
      worldHeight: 1024,
      canvasWidth: 800,
      canvasHeight: 600,
      particle: { maxParticles: 10 },
      decoration: { maxDecorations: 10 },
      bullet: { maxBullets: 10 },
      physics: { maxConstraints: 10 },
      spatial: {
        cellSize: 128,
        maxNeighbors: 32,
        maxEntitiesPerCell: 64,
        rowsPerBlock: 2,
        numberOfSpatialWorkers: 1,
      },
      lighting: { enabled: false, maxLights: 10, shadowsEnabled: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: 100 },
      layers: {},
    },
    buffers: { componentData: {} },
    views: {},
    camera: { zoom: 1, x: 0, y: 0 },
    inputBufferSize: 1,
    keyMap: {},
    updateKeyboardBuffer() {},
  };

  return {
    ...scene,
    ...overrides,
    config: {
      ...scene.config,
      ...(overrides.config || {}),
      particle: { ...scene.config.particle, ...(overrides.config?.particle || {}) },
      decoration: { ...scene.config.decoration, ...(overrides.config?.decoration || {}) },
      bullet: { ...scene.config.bullet, ...(overrides.config?.bullet || {}) },
      physics: { ...scene.config.physics, ...(overrides.config?.physics || {}) },
      spatial: { ...scene.config.spatial, ...(overrides.config?.spatial || {}) },
      lighting: { ...scene.config.lighting, ...(overrides.config?.lighting || {}) },
    },
  };
}

test('createSceneSharedBuffers rejects entity counts that exceed Uint16 storage', () => {
  const scene = createValidationScene({ totalEntityCount: 65536 });

  assert.throws(
    () => createSceneSharedBuffers(scene),
    /totalEntityCount must be an integer in \[0, 65535\]/
  );
});

test('createSceneSharedBuffers rejects maxEntitiesPerCell values that exceed Uint8 cell counts', () => {
  const scene = createValidationScene({
    config: { spatial: { maxEntitiesPerCell: 256 } },
  });

  assert.throws(
    () => createSceneSharedBuffers(scene),
    /spatial\.maxEntitiesPerCell must be an integer in \[1, 255\]/
  );
});

test('createSceneSharedBuffers rejects spatial grids with too many cells for Uint16 caches', () => {
  const scene = createValidationScene({
    config: {
      worldWidth: 70000,
      worldHeight: 70000,
      spatial: { cellSize: 1 },
    },
  });

  assert.throws(
    () => createSceneSharedBuffers(scene),
    /spatial grid columns must be an integer in \[1, 65535\]/
  );
});
