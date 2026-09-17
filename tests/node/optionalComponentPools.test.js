import test from 'node:test';
import assert from 'node:assert/strict';

import { Component } from '../../src/core/component.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { CameraInOutListener } from '../../src/components/cameraInOutListener.js';
import { CollisionListener } from '../../src/components/collisionListener.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { FlashComponent } from '../../src/components/flashComponent.js';
import { LightOccluder } from '../../src/components/lightOccluder.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { Scene } from '../../src/core/scene.js';
import { Query } from '../../src/core/query.js';
import { GameObject } from '../../src/core/gameObject.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';

function resetOptionalComponentIds() {
  LightEmitter.componentId = null;
  FlashComponent.componentId = null;
  ShadowCaster.componentId = null;
  LightOccluder.componentId = null;
  AdobeAnimComponent.componentId = null;
  LightEmitter.clearArrays();
  FlashComponent.clearArrays();
  ShadowCaster.clearArrays();
  LightOccluder.clearArrays();
  AdobeAnimComponent.clearArrays();
}

test('Component.clearArrays nulls schema fields and sharedBuffer', () => {
  class TempComp extends Component {
    static ARRAY_SCHEMA = { active: Uint8Array, value: Float32Array };
  }
  const sab = new SharedArrayBuffer(TempComp.getBufferSize(4));
  TempComp.initializeArrays(sab, 4);
  assert.ok(TempComp.active);
  assert.ok(TempComp.sharedBuffer);

  TempComp.clearArrays();
  assert.equal(TempComp.active, null);
  assert.equal(TempComp.value, null);
  assert.equal(TempComp.sharedBuffer, null);
  assert.equal(TempComp.globalEntityCount, 0);
});

test('ensureOptionalComponentPools only seeds from lighting/flash flags', () => {
  const scene = Object.create(Scene.prototype);
  scene.nextComponentId = 10;
  scene.componentPools = {};
  scene.config = {
    lighting: {
      enabled: false,
      maxFlashes: 0,
      shadowsEnabled: false,
      raycasted: false,
    },
  };

  scene.ensureOptionalComponentPools();
  assert.deepEqual(Object.keys(scene.componentPools), []);

  scene.config.lighting.enabled = true;
  scene.ensureOptionalComponentPools();
  assert.ok(scene.componentPools.LightEmitter);
  assert.equal(typeof LightEmitter.componentId, 'number');
  assert.equal(scene.componentPools.FlashComponent, undefined);
  assert.equal(scene.componentPools.ShadowCaster, undefined);

  scene.config.lighting.shadowsEnabled = true;
  scene.config.lighting.maxFlashes = 8;
  scene.config.lighting.raycasted = true;
  scene.ensureOptionalComponentPools();
  assert.ok(scene.componentPools.FlashComponent);
  assert.ok(scene.componentPools.ShadowCaster);
  assert.ok(scene.componentPools.LightOccluder);
  assert.equal(typeof FlashComponent.componentId, 'number');
  assert.equal(typeof ShadowCaster.componentId, 'number');
  assert.equal(typeof LightOccluder.componentId, 'number');

  resetOptionalComponentIds();
});

test('Balls-like scene allocates dense cores only (no optional lighting/Adobe SABs)', { concurrency: false }, () => {
  resetOptionalComponentIds();
  Transform.componentId = 0;
  RigidBody.componentId = 1;
  Collider.componentId = 2;
  SpriteRenderer.componentId = 3;
  CameraInOutListener.componentId = 4;
  CollisionListener.componentId = 5;

  class BallLike extends GameObject {}
  BallLike.components = [RigidBody, Collider, SpriteRenderer];
  class FloorLike extends GameObject {}
  FloorLike.components = [RigidBody, Collider, SpriteRenderer];

  const previousLog = console.log;
  console.log = () => {};
  try {
    Query.reset();
    const scene = {
      totalEntityCount: 11000,
      nextComponentId: 6,
      registeredClasses: [
        { class: BallLike, count: 10000, startIndex: 0, entityType: 0, components: BallLike.components },
        { class: FloorLike, count: 1000, startIndex: 10000, entityType: 1, components: FloorLike.components },
      ],
      componentPools: {
        Transform: { ComponentClass: Transform },
        RigidBody: { ComponentClass: RigidBody },
        Collider: { ComponentClass: Collider },
        SpriteRenderer: { ComponentClass: SpriteRenderer },
        CameraInOutListener: { ComponentClass: CameraInOutListener },
        CollisionListener: { ComponentClass: CollisionListener },
      },
      config: {
        worldWidth: 4000,
        worldHeight: 5000,
        canvasWidth: 800,
        canvasHeight: 600,
        particle: { maxParticles: 0 },
        decoration: { maxDecorations: 0 },
        bullet: { maxBullets: 0 },
        physics: { maxJoints: 0 },
        spatial: {
          cellSize: 100,
          maxNeighbors: 32,
          maxEntitiesPerCell: 64,
          rowsPerBlock: 2,
          numberOfSpatialWorkers: 1,
        },
        lighting: {
          enabled: false,
          maxLights: 10,
          shadowsEnabled: false,
          maxFlashes: 0,
          raycasted: false,
        },
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
      preInitializeEntityTypeArrays() {},
      constructor: { queries: [] },
    };

    createSceneSharedBuffers(scene);

    const keys = Object.keys(scene.buffers.componentData);
    assert.deepEqual(keys.sort(), ['Collider', 'RigidBody', 'SpriteRenderer', 'Transform']);
    for (const optional of [
      'AdobeAnimComponent',
      'LightEmitter',
      'ShadowCaster',
      'FlashComponent',
      'LightOccluder',
    ]) {
      assert.equal(scene.buffers.componentData[optional], undefined);
    }
  } finally {
    console.log = previousLog;
    resetOptionalComponentIds();
  }
});

test('entity-listed ShadowCaster/LightEmitter allocate when lighting flags off', { concurrency: false }, () => {
  resetOptionalComponentIds();
  Transform.componentId = 0;
  RigidBody.componentId = 1;
  Collider.componentId = 2;
  SpriteRenderer.componentId = 3;
  CameraInOutListener.componentId = 4;
  CollisionListener.componentId = 5;
  ShadowCaster.componentId = 6;
  LightEmitter.componentId = 7;

  class LitProp extends GameObject {}
  LitProp.components = [RigidBody, Collider, SpriteRenderer, ShadowCaster, LightEmitter];

  const previousLog = console.log;
  console.log = () => {};
  try {
    Query.reset();
    const scene = {
      totalEntityCount: 20,
      nextComponentId: 8,
      registeredClasses: [
        { class: LitProp, count: 20, startIndex: 0, entityType: 0, components: LitProp.components },
      ],
      componentPools: {
        Transform: { ComponentClass: Transform },
        RigidBody: { ComponentClass: RigidBody },
        Collider: { ComponentClass: Collider },
        SpriteRenderer: { ComponentClass: SpriteRenderer },
        CameraInOutListener: { ComponentClass: CameraInOutListener },
        CollisionListener: { ComponentClass: CollisionListener },
        ShadowCaster: { ComponentClass: ShadowCaster },
        LightEmitter: { ComponentClass: LightEmitter },
      },
      config: {
        worldWidth: 1024,
        worldHeight: 1024,
        canvasWidth: 800,
        canvasHeight: 600,
        particle: { maxParticles: 0 },
        decoration: { maxDecorations: 0 },
        bullet: { maxBullets: 0 },
        physics: { maxJoints: 0 },
        spatial: {
          cellSize: 128,
          maxNeighbors: 32,
          maxEntitiesPerCell: 64,
          rowsPerBlock: 2,
          numberOfSpatialWorkers: 1,
        },
        lighting: {
          enabled: false,
          maxLights: 10,
          shadowsEnabled: false,
          maxFlashes: 0,
          raycasted: false,
        },
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
      preInitializeEntityTypeArrays() {},
      constructor: { queries: [] },
    };

    createSceneSharedBuffers(scene);
    assert.ok(scene.buffers.componentData.ShadowCaster);
    assert.ok(scene.buffers.componentData.LightEmitter);
    assert.equal(scene.buffers.componentData.AdobeAnimComponent, undefined);
    assert.equal(scene.buffers.componentData.FlashComponent, undefined);
  } finally {
    console.log = previousLog;
    resetOptionalComponentIds();
  }
});
