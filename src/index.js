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
export { Scene } from './core/Scene.js';
export { GameObject, Keyboard, SceneBridge } from './core/gameObject.js';
export { Component } from './core/Component.js';
export { FSM } from './core/FSM.js';
export { FSMState } from './core/FSMState.js';
export { DebugFlags, DEBUG_FLAGS, DEBUG_SELECTED_ENTITY_OFFSET } from './core/debug/DebugFlags.js';
export { DebugUI } from './core/debug/DebugUI.js';
export { DebugDraw } from './core/debug/DebugDraw.js';
export { Mouse } from './core/Mouse.js';
export { Gamepad } from './core/Gamepad.js';
export { Camera } from './core/Camera.js';
export { Noise2D } from './core/Noise2D.js';
export { Ray } from './core/Ray.js';
export { NavGrid } from './core/NavGrid.js';
export { Grid } from './core/Grid.js';
export { Sun } from './core/Sun.js';
export { Layer } from './core/Layer.js';
export { TileMap } from './core/TileMap.js';
export { SpriteSheetRegistry } from './core/SpriteSheetRegistry.js';
export { AdobeAnimRegistry } from './core/AdobeAnimRegistry.js';
export { BigAtlasInspector } from './core/BigAtlasInspector.js';
export { SoundManager } from './core/SoundManager.js';
export * from './core/utils.js';
export {
  SaveStore,
  saveGame,
  loadGame,
  buildSavePayload,
  encodeSave,
  decodeSave,
  collectSerializableEntities,
  isEntityClassSerializable,
  shouldSaveEntity,
  applyEntitySaveRestore,
} from './core/save/SaveGame.js';
export * as SaveGame from './core/save/SaveGame.js';

// ============================================================================
// COMPONENTS
// ============================================================================
export { Transform } from './components/Transform.js';
export { RigidBody } from './components/RigidBody.js';
export { Collider } from './components/Collider.js';
export { SpriteRenderer } from './components/SpriteRenderer.js';
export { AdobeAnimComponent } from './components/AdobeAnimComponent.js';
export { ParticleComponent } from './components/ParticleComponent.js';
export { DecorationComponent } from './components/DecorationComponent.js';
export { LightEmitter } from './components/LightEmitter.js';
export { ShadowCaster } from './components/ShadowCaster.js';
export {
  LightOccluder,
  LIGHT_OCCLUDER_MASK_COLLIDER,
  LIGHT_OCCLUDER_MASK_SPRITE,
} from './components/LightOccluder.js';
export { FlashComponent } from './components/FlashComponent.js';
export { CameraInOutListener } from './components/CameraInOutListener.js';
export { CollisionListener } from './components/CollisionListener.js';
export { JointBreakListener } from './components/JointBreakListener.js';
export { Grab } from './components/Grab.js';

// ============================================================================
// PARTICLES
// ============================================================================
// Note: Particles are NOT GameObjects - they use ParticleComponent directly
export { ParticleEmitter, DECAL_STAMPS_BLEND_MODE } from './core/ParticleEmitter.js';
export { LiquidFun, LIQUIDFUN_FLAGS, LIQUIDFUN_GROUP_FLAGS } from './core/LiquidFun.js';

// ============================================================================
// DECORATIONS
// ============================================================================
// Note: Decorations are NOT GameObjects - they use DecorationComponent directly
export {
  DecorationPool,
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
  DECORATION_NO_PARENT,
  SWAY_OFF,
  SWAY_LOOP,
  SWAY_IMPULSE,
} from './core/DecorationPool.js';
export { Decoration } from './core/Decoration.js';
export { DecorationSpatial } from './core/DecorationSpatial.js';

// ============================================================================
// BULLETS
// ============================================================================
// Note: Bullets are NOT GameObjects - they use BulletComponent directly
export { BulletPool } from './core/BulletPool.js';
export { BulletComponent } from './components/BulletComponent.js';

// ============================================================================
// CONSTRAINTS
// ============================================================================
// Distance constraints for position-based dynamics (ropes, springs, rigid connections)
export { Joint } from './core/Joint.js';
export { SharedAtomicPool } from './core/SharedAtomicPool.js';
export {
  getMovedBodiesViews,
  bindMovedBodies,
  isMovedBodiesBound,
} from './box2d/box2dMovedBodies.js';
export {
  box2dQueryAABB,
  box2dQueryAABBAsync,
  bindQueryAabbSab,
  isQueryAabbBound,
} from './box2d/box2dQueryAabb.js';
export {
  box2dCastRayClosest,
  box2dCastRayClosestAsync,
  bindRayCastSab,
  isRayCastBound,
} from './box2d/box2dRayCast.js';
export {
  liquidFunQueryAABB,
  liquidFunQueryAABBAsync,
  liquidFunRayCast,
  liquidFunRayCastAsync,
  bindLiquidFunQuerySab,
} from './box2d/liquidFunQuery.js';

// ============================================================================
// FLASHES
// ============================================================================
// Note: Flashes ARE GameObjects (auto-registered) with LightEmitter + FlashComponent
export { Flash } from './core/Flash.js';

// ============================================================================
// QUERY SYSTEM (Worker Context Only)
// ============================================================================
// Note: The query helpers are available globally in all workers for
// component-based entity filtering:
//   const allPredators = query([RigidBody, PredatorBehavior]);              // all matching slots
//   const visibleEntities = queryActiveEntities([SpriteRenderer]);          // active precomputed only
//   const customActive = queryActiveEntitiesSlow([RigidBody, EnemyTag]);    // explicit slow path
// These are NOT available in main thread context, only in workers.

// ============================================================================
// WORKERS
// ============================================================================
// Note: Workers are typically loaded as separate files via new Worker()
// but we export them here for bundling purposes
export { AbstractWorker } from './workers/AbstractWorker.js';
export {
  ShapeType,
  MAX_POLYGON_VERTICES,
  Box2dBodyType,
  STATE_CHANNELS,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_COMPUTE_SOURCE,
  FEED_LAYER_NONE,
  COMPUTE_FLAG_STATIC,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
  SPRITE_TILE_MODE,
  DEFAULT_LAYERS,
  CAMERA_TYPES,
  PARTICLE_EASE,
} from './core/ConfigDefaults.js';

// Worker files (logic_worker, pixi_worker, spatial_worker, …)
// Physics = classic src/box2d/box2d_wasm.js + physics_host.impl.js (not ESM).
// are designed to be loaded as Web Workers and don't have default exports,
// but you can import them as modules if needed for bundling:
// import './workers/logic_worker.js';
// import './workers/pixi_worker.js';
// import './workers/spatial_worker.js';

// ============================================================================
// WEED NAMESPACE - PIXI-style usage 🌿
// ============================================================================
// Import everything we need for the namespace
import { GameEngine } from './core/gameEngine.js';
import { Scene } from './core/Scene.js';
import { GameObject, Keyboard, SceneBridge } from './core/gameObject.js';
import { Component } from './core/Component.js';
import { FSM } from './core/FSM.js';
import { FSMState } from './core/FSMState.js';
import { DebugFlags, DEBUG_FLAGS, DEBUG_SELECTED_ENTITY_OFFSET } from './core/debug/DebugFlags.js';
import { DebugUI } from './core/debug/DebugUI.js';
import { DebugDraw } from './core/debug/DebugDraw.js';
import { Mouse } from './core/Mouse.js';
import { Gamepad } from './core/Gamepad.js';
import { Camera } from './core/Camera.js';
import { Noise2D } from './core/Noise2D.js';
import { Ray } from './core/Ray.js';
import { NavGrid } from './core/NavGrid.js';
import { Grid } from './core/Grid.js';
import { Sun } from './core/Sun.js';
import { Layer } from './core/Layer.js';
import { TileMap } from './core/TileMap.js';
import { SpriteSheetRegistry } from './core/SpriteSheetRegistry.js';
import { AdobeAnimRegistry } from './core/AdobeAnimRegistry.js';
import { BigAtlasInspector } from './core/BigAtlasInspector.js';
import { SoundManager } from './core/SoundManager.js';
import * as SaveGameNS from './core/save/SaveGame.js';
import { SaveStore } from './core/save/SaveStore.js';
import {
  containerRadius,
  distanceSq2D,
  getDirectionFromAngle,
  getDirectionFromVector,
  getDirection8FromVector,
  mixTint,
  randomColor,
  rng,
} from './core/utils.js';

import { Transform } from './components/Transform.js';
import { RigidBody } from './components/RigidBody.js';
import { Collider } from './components/Collider.js';
import { SpriteRenderer } from './components/SpriteRenderer.js';
import { AdobeAnimComponent } from './components/AdobeAnimComponent.js';
import { ParticleComponent } from './components/ParticleComponent.js';

import { ParticleEmitter, DECAL_STAMPS_BLEND_MODE } from './core/ParticleEmitter.js';
import { LiquidFun, LIQUIDFUN_FLAGS, LIQUIDFUN_GROUP_FLAGS } from './core/LiquidFun.js';
import { DecorationPool, SWAY_OFF, SWAY_LOOP, SWAY_IMPULSE } from './core/DecorationPool.js';
import { Decoration } from './core/Decoration.js';
import { DecorationSpatial } from './core/DecorationSpatial.js';
import { BulletPool } from './core/BulletPool.js';
import { SharedAtomicPool } from './core/SharedAtomicPool.js';
import { DecorationComponent } from './components/DecorationComponent.js';
import { BulletComponent } from './components/BulletComponent.js';
import { LightEmitter } from './components/LightEmitter.js';
import { ShadowCaster } from './components/ShadowCaster.js';
import {
  LightOccluder,
  LIGHT_OCCLUDER_MASK_COLLIDER,
  LIGHT_OCCLUDER_MASK_SPRITE,
} from './components/LightOccluder.js';
import { FlashComponent } from './components/FlashComponent.js';
import { Flash } from './core/Flash.js';
import { CameraInOutListener } from './components/CameraInOutListener.js';
import { CollisionListener } from './components/CollisionListener.js';
import { JointBreakListener } from './components/JointBreakListener.js';
import { Grab } from './components/Grab.js';
import { Joint } from './core/Joint.js';
import { AbstractWorker } from './workers/AbstractWorker.js';
import {
  getMovedBodiesViews,
  bindMovedBodies,
  isMovedBodiesBound,
} from './box2d/box2dMovedBodies.js';
import {
  box2dQueryAABB,
  box2dQueryAABBAsync,
  bindQueryAabbSab,
  isQueryAabbBound,
} from './box2d/box2dQueryAabb.js';
import {
  box2dCastRayClosest,
  box2dCastRayClosestAsync,
  bindRayCastSab,
  isRayCastBound,
} from './box2d/box2dRayCast.js';
import {
  liquidFunQueryAABB,
  liquidFunQueryAABBAsync,
  liquidFunRayCast,
  liquidFunRayCastAsync,
  bindLiquidFunQuerySab,
} from './box2d/liquidFunQuery.js';
import {
  ShapeType,
  MAX_POLYGON_VERTICES,
  Box2dBodyType,
  STATE_CHANNELS,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_COMPUTE_SOURCE,
  FEED_LAYER_NONE,
  COMPUTE_FLAG_STATIC,
  LAYER_SPLAT_FALLOFF,
  LAYER_SCALE_MODE,
  SPRITE_TILE_MODE,
  DEFAULT_LAYERS,
  CAMERA_TYPES,
  PARTICLE_EASE,
} from './core/ConfigDefaults.js';

const enums = Object.freeze({
  ShapeType,
  MAX_POLYGON_VERTICES,
  Box2dBodyType,
  STATE_CHANNELS,
  BLEND_MODES,
  LAYER_DENSITY_SOURCE,
  LAYER_COMPUTE_SOURCE,
  FEED_LAYER_NONE,
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

const WEED = Object.freeze({

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
  SaveGame: SaveGameNS,
  SaveStore,

  // Components
  Transform,
  RigidBody,
  Collider,
  SpriteRenderer,
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

  // Decorations
  DecorationPool,
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

  // Pool base class
  SharedAtomicPool,

  // Box2D movers SAB (last physics step)
  getMovedBodiesViews,
  bindMovedBodies,
  isMovedBodiesBound,

  // Box2D QueryAABB (logic sync / Scene async)
  box2dQueryAABB,
  box2dQueryAABBAsync,
  bindQueryAabbSab,
  isQueryAabbBound,

  // Box2D castRayClosest (logic sync / Scene async)
  box2dCastRayClosest,
  box2dCastRayClosestAsync,
  bindRayCastSab,
  isRayCastBound,

  // LiquidFun QueryAABB / RayCast (logic sync / Scene async)
  liquidFunQueryAABB,
  liquidFunQueryAABBAsync,
  liquidFunRayCast,
  liquidFunRayCastAsync,
  bindLiquidFunQuerySab,

  // Flashes
  Flash,

  // Workers
  AbstractWorker,

  // Public utility helpers
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
