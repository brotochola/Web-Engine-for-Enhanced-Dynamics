// ============================================================================
// WeedJS - Multithreaded Game Engine 🌿
// Main entry point for the engine
// ============================================================================

import { VERSION } from './version.js';

// ============================================================================
// CORE MODULES
// ============================================================================
export { VERSION } from './version.js';
export { GameEngine } from './core/gameEngine.js';
export { Scene } from './core/scene.js';
export { GameObject, Keyboard, SceneBridge } from './core/gameObject.js';
export { Component } from './core/component.js';
export { FSM } from './core/fsm.js';
export { FSMState } from './core/fsmState.js';
export { DebugFlags, DEBUG_FLAGS, DEBUG_SELECTED_ENTITY_OFFSET } from './core/debug/debugFlags.js';
export { DebugUI } from './core/debug/debugUi.js';
export { DebugDraw } from './core/debug/debugDraw.js';
export { Mouse } from './core/mouse.js';
export { Gamepad } from './core/gamepad.js';
export { Camera } from './core/camera.js';
export { Noise2D } from './core/noise2D.js';
export { Ray } from './core/ray.js';
export { NavGrid } from './core/navGrid.js';
export { Grid } from './core/grid.js';
export { Sun } from './core/sun.js';
export { Layer } from './core/layer.js';
export { TileMap } from './core/tileMap.js';
export { SpriteSheetRegistry } from './core/spriteSheetRegistry.js';
export { AdobeAnimRegistry } from './core/adobeAnimRegistry.js';
export { BigAtlasInspector } from './core/bigAtlasInspector.js';
export { SoundManager } from './core/soundManager.js';
export {
  mixSeed,
  seededRandom,
  collisionPairKey,
  setupWorkerCommunication,
  containerRadius,
  distanceSq2D,
  getDirectionFromAngle,
  getDirectionFromVector,
  getDirection8FromVector,
  mixTint,
  randomColor,
  rng,
} from './util/utils.js';
export {
  SaveStore,
  saveGame,
  loadGame,
  buildSavePayload,
  encodeSave,
  decodeSave,
} from './core/save/saveGame.js';

// ============================================================================
// COMPONENTS
// ============================================================================
export { Transform } from './components/transform.js';
export { RigidBody } from './components/rigidBody.js';
export { Collider } from './components/collider.js';
export { SpriteRenderer } from './components/spriteRenderer.js';
export { MeshRenderer } from './components/meshRenderer.js';
export { AdobeAnimComponent } from './components/adobeAnimComponent.js';
export { ParticleComponent } from './components/particleComponent.js';
export { DecorationComponent } from './components/decorationComponent.js';
export { LightEmitter } from './components/lightEmitter.js';
export { ShadowCaster } from './components/shadowCaster.js';
export {
  LightOccluder,
  LIGHT_OCCLUDER_MASK_COLLIDER,
  LIGHT_OCCLUDER_MASK_SPRITE,
} from './components/lightOccluder.js';
export { FlashComponent } from './components/flashComponent.js';
export { CameraInOutListener } from './components/cameraInOutListener.js';
export { CollisionListener } from './components/collisionListener.js';
export { JointBreakListener } from './components/jointBreakListener.js';
export { Grab } from './components/grab.js';

// ============================================================================
// PARTICLES
// ============================================================================
// Note: Particles are NOT GameObjects - they use ParticleComponent directly
export { ParticleEmitter, DECAL_STAMPS_BLEND_MODE } from './core/particleEmitter.js';
export { LiquidFun, LIQUIDFUN_FLAGS, LIQUIDFUN_GROUP_FLAGS } from './core/liquidFun.js';
export { Box2d } from './core/box2d.js';
export { Decal } from './core/decal.js';

// ============================================================================
// DECORATIONS
// ============================================================================
// Note: Decorations are NOT GameObjects - they use DecorationComponent directly
export {
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
  DECORATION_NO_PARENT,
  SWAY_OFF,
  SWAY_LOOP,
  SWAY_IMPULSE,
} from './core/decorationPool.js';
export { Decoration } from './core/decoration.js';
export { DecorationSpatial } from './core/decorationSpatial.js';

// ============================================================================
// BULLETS
// ============================================================================
// Note: Bullets are NOT GameObjects - they use BulletComponent directly
export { BulletPool } from './core/bulletPool.js';
export { BulletComponent } from './components/bulletComponent.js';

// ============================================================================
// JOINTS
// ============================================================================
// Box2D joints (distance / revolute / weld) synced to WASM via command ring
export { Joint } from './core/joint.js';
export { ColliderFixture } from './core/colliderFixture.js';
export { SharedAtomicPool } from './core/sharedAtomicPool.js';

// ============================================================================
// FLASHES
// ============================================================================
export { Flash } from './core/flash.js';
export { Query } from './core/query.js';

// ============================================================================
// ENUMS
// ============================================================================
export {
  ShapeType,
  MAX_POLYGON_VERTICES,
  Box2dBodyType,
  STATE_CHANNELS,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_COMPUTE_SOURCE,
  LAYER_FEEDER_KIND,
  LAYER_KIND,
  LAYER_SUBSCRIBE_KIND,
  COMPUTE_FLAG_STATIC,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
  SPRITE_TILE_MODE,
  DEFAULT_LAYERS,
  CAMERA_TYPES,
  PARTICLE_EASE,
} from './util/configDefaults.js';

// ============================================================================
// WEED NAMESPACE - PIXI-style usage 🌿
// ============================================================================
import { GameEngine } from './core/gameEngine.js';
import { Scene } from './core/scene.js';
import { GameObject, Keyboard, SceneBridge } from './core/gameObject.js';
import { Component } from './core/component.js';
import { FSM } from './core/fsm.js';
import { FSMState } from './core/fsmState.js';
import { DebugFlags, DEBUG_FLAGS, DEBUG_SELECTED_ENTITY_OFFSET } from './core/debug/debugFlags.js';
import { DebugUI } from './core/debug/debugUi.js';
import { DebugDraw } from './core/debug/debugDraw.js';
import { Mouse } from './core/mouse.js';
import { Gamepad } from './core/gamepad.js';
import { Camera } from './core/camera.js';
import { Noise2D } from './core/noise2D.js';
import { Ray } from './core/ray.js';
import { NavGrid } from './core/navGrid.js';
import { Grid } from './core/grid.js';
import { Sun } from './core/sun.js';
import { Layer } from './core/layer.js';
import { TileMap } from './core/tileMap.js';
import { SpriteSheetRegistry } from './core/spriteSheetRegistry.js';
import { AdobeAnimRegistry } from './core/adobeAnimRegistry.js';
import { BigAtlasInspector } from './core/bigAtlasInspector.js';
import { SoundManager } from './core/soundManager.js';
import {
  SaveStore,
  saveGame,
  loadGame,
  buildSavePayload,
  encodeSave,
  decodeSave,
} from './core/save/saveGame.js';
import {
  mixSeed,
  seededRandom,
  collisionPairKey,
  setupWorkerCommunication,
  containerRadius,
  distanceSq2D,
  getDirectionFromAngle,
  getDirectionFromVector,
  getDirection8FromVector,
  mixTint,
  randomColor,
  rng,
} from './util/utils.js';

import { Transform } from './components/transform.js';
import { RigidBody } from './components/rigidBody.js';
import { Collider } from './components/collider.js';
import { SpriteRenderer } from './components/spriteRenderer.js';
import { MeshRenderer } from './components/meshRenderer.js';
import { AdobeAnimComponent } from './components/adobeAnimComponent.js';
import { ParticleComponent } from './components/particleComponent.js';

import { ParticleEmitter, DECAL_STAMPS_BLEND_MODE } from './core/particleEmitter.js';
import { LiquidFun, LIQUIDFUN_FLAGS, LIQUIDFUN_GROUP_FLAGS } from './core/liquidFun.js';
import { Box2d } from './core/box2d.js';
import { Decal } from './core/decal.js';
import { Query } from './core/query.js';
import {
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
  DECORATION_NO_PARENT,
  SWAY_OFF,
  SWAY_LOOP,
  SWAY_IMPULSE,
} from './core/decorationPool.js';
import { Decoration } from './core/decoration.js';
import { DecorationSpatial } from './core/decorationSpatial.js';
import { BulletPool } from './core/bulletPool.js';
import { SharedAtomicPool } from './core/sharedAtomicPool.js';
import { DecorationComponent } from './components/decorationComponent.js';
import { BulletComponent } from './components/bulletComponent.js';
import { LightEmitter } from './components/lightEmitter.js';
import { ShadowCaster } from './components/shadowCaster.js';
import {
  LightOccluder,
  LIGHT_OCCLUDER_MASK_COLLIDER,
  LIGHT_OCCLUDER_MASK_SPRITE,
} from './components/lightOccluder.js';
import { FlashComponent } from './components/flashComponent.js';
import { Flash } from './core/flash.js';
import { CameraInOutListener } from './components/cameraInOutListener.js';
import { CollisionListener } from './components/collisionListener.js';
import { JointBreakListener } from './components/jointBreakListener.js';
import { Grab } from './components/grab.js';
import { Joint } from './core/joint.js';
import { ColliderFixture } from './core/colliderFixture.js';
import {
  ShapeType,
  MAX_POLYGON_VERTICES,
  Box2dBodyType,
  STATE_CHANNELS,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_COMPUTE_SOURCE,
  LAYER_FEEDER_KIND,
  LAYER_KIND,
  LAYER_SUBSCRIBE_KIND,
  COMPUTE_FLAG_STATIC,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
  SPRITE_TILE_MODE,
  DEFAULT_LAYERS,
  CAMERA_TYPES,
  PARTICLE_EASE,
} from './util/configDefaults.js';

const enums = Object.freeze({
  ShapeType,
  MAX_POLYGON_VERTICES,
  Box2dBodyType,
  STATE_CHANNELS,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_COMPUTE_SOURCE,
  LAYER_FEEDER_KIND,
  LAYER_KIND,
  LAYER_SUBSCRIBE_KIND,
  COMPUTE_FLAG_STATIC,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
  SPRITE_TILE_MODE,
  DEFAULT_LAYERS,
  CAMERA_TYPES,
  PARTICLE_EASE,
  DECAL_STAMPS_BLEND_MODE,
  DEBUG_FLAGS,
  DEBUG_SELECTED_ENTITY_OFFSET,
});

const SaveGame = Object.freeze({
  SaveStore,
  saveGame,
  loadGame,
  buildSavePayload,
  encodeSave,
  decodeSave,
});

export { SaveGame };

const WEED = Object.freeze({
  ...enums,

  DEBUG_FLAGS,
  DEBUG_SELECTED_ENTITY_OFFSET,
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
  DECORATION_NO_PARENT,

  // Core
  GameEngine,
  Scene,
  GameObject,
  Component,
  FSM,
  FSMState,
  DebugFlags,
  DebugUI,
  DebugDraw,
  Mouse,
  Gamepad,
  Camera,
  Noise2D,
  Ray,
  NavGrid,
  Grid,
  Sun,
  Layer,
  TileMap,
  Keyboard,
  SceneBridge,
  SpriteSheetRegistry,
  AdobeAnimRegistry,
  BigAtlasInspector,
  SoundManager,
  SaveGame,
  SaveStore,
  saveGame,
  loadGame,
  buildSavePayload,
  encodeSave,
  decodeSave,

  // Components
  Transform,
  RigidBody,
  Collider,
  SpriteRenderer,
  MeshRenderer,
  AdobeAnimComponent,
  ParticleComponent,
  LightEmitter,
  ShadowCaster,
  LightOccluder,
  LIGHT_OCCLUDER_MASK_COLLIDER,
  LIGHT_OCCLUDER_MASK_SPRITE,
  FlashComponent,
  CameraInOutListener,
  CollisionListener,
  JointBreakListener,
  Grab,

  // Particles
  ParticleEmitter,
  LiquidFun,
  LIQUIDFUN_FLAGS,
  LIQUIDFUN_GROUP_FLAGS,
  Box2d,
  Decal,
  Query,

  // Decorations
  Decoration,
  DecorationComponent,
  DecorationSpatial,
  SWAY_OFF,
  SWAY_LOOP,
  SWAY_IMPULSE,

  // Bullets
  BulletPool,
  BulletComponent,

  // Joints (Box2D-mapped)
  Joint,
  ColliderFixture,

  // Pool base class
  SharedAtomicPool,

  // Flashes
  Flash,

  // Public utility helpers
  mixSeed,
  seededRandom,
  collisionPairKey,
  setupWorkerCommunication,
  containerRadius,
  distanceSq2D,
  getDirectionFromAngle,
  getDirectionFromVector,
  getDirection8FromVector,
  mixTint,
  randomColor,
  rng,

  SPRITE_TILE_MODE,
  enums,

  VERSION,
});

if (typeof window !== 'undefined') {
  window.WEED = WEED;
}

export default WEED;
