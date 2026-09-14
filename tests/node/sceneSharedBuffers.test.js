import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSceneSharedBuffers,
  computeAutoMaxVisibleRenderables,
  resolveMaxVisibleRenderables,
} from '../../src/util/sceneSharedBuffers.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { AdobeAnimRegistry } from '../../src/core/adobeAnimRegistry.js';

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
      physics: { maxJoints: 10 },
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
      renderer: { ...scene.config.renderer, ...(overrides.config?.renderer || {}) },
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

test('computeAutoMaxVisibleRenderables matches pool formula', () => {
  const scene = createValidationScene({
    totalEntityCount: 100,
    config: {
      particle: { maxParticles: 50 },
      decoration: { maxDecorations: 20 },
      bullet: { maxBullets: 10 },
      lighting: { enabled: false },
      renderer: { maxVisibleRenderables: null },
    },
  });
  // 100 + 50 + 20 + 10*2 + 0 glow + 0 adobe
  assert.equal(computeAutoMaxVisibleRenderables(scene), 190);
});

test('computeAutoMaxVisibleRenderables adds glow slots when lighting enabled', () => {
  const scene = createValidationScene({
    totalEntityCount: 100,
    config: {
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 0 },
      lighting: { enabled: true },
    },
  });
  // 100 entities + 100 glow
  assert.equal(computeAutoMaxVisibleRenderables(scene), 200);
});

test('computeAutoMaxVisibleRenderables adds Adobe piece bonus', () => {
  AdobeAnimRegistry.clearForSceneUnload();
  AdobeAnimRegistry.register('testAsset', {
    framePieceCount: new Uint16Array([3, 8, 2]),
  });

  const scene = createValidationScene({
    totalEntityCount: 10,
    registeredClasses: [
      {
        class: class AdobeEnt {},
        startIndex: 0,
        count: 10,
        components: [AdobeAnimComponent],
      },
    ],
    config: {
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 0 },
      lighting: { enabled: false },
    },
  });
  // 10 + 10*(8-1) = 80
  assert.equal(computeAutoMaxVisibleRenderables(scene), 80);
  AdobeAnimRegistry.clearForSceneUnload();
});

test('resolveMaxVisibleRenderables keeps explicit override', () => {
  const scene = createValidationScene({
    totalEntityCount: 100,
    config: {
      particle: { maxParticles: 50 },
      decoration: { maxDecorations: 20 },
      bullet: { maxBullets: 10 },
      renderer: { maxVisibleRenderables: 100 },
    },
  });
  assert.equal(resolveMaxVisibleRenderables(scene), 100);
  assert.equal(scene.config.renderer.maxVisibleRenderables, 100);
});

test('resolveMaxVisibleRenderables auto-fills null', () => {
  const scene = createValidationScene({
    totalEntityCount: 100,
    config: {
      particle: { maxParticles: 50 },
      decoration: { maxDecorations: 20 },
      bullet: { maxBullets: 10 },
      lighting: { enabled: false },
      renderer: { maxVisibleRenderables: null },
    },
  });
  assert.equal(resolveMaxVisibleRenderables(scene), 190);
  assert.equal(scene.config.renderer.maxVisibleRenderables, 190);
});
