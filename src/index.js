// ============================================================================
// WeedJS - Multithreaded Game Engine 🌿
// Main entry point for the engine
// ============================================================================

// ============================================================================
// CORE MODULES
// ============================================================================
export { GameEngine } from './core/gameEngine.js';
export { Scene } from './core/Scene.js';
export { GameObject, Keyboard } from './core/gameObject.js';
export { Component } from './core/Component.js';
export { FSM } from './core/FSM.js';
export { FSMState } from './core/FSMState.js';
export { DebugFlags } from './core/debug/DebugFlags.js';
export { DebugUI } from './core/debug/DebugUI.js';
export { DebugDraw } from './core/debug/DebugDraw.js';
export { Mouse } from './core/Mouse.js';
export { Camera } from './core/Camera.js';
export { Ray } from './core/Ray.js';
export { NavGrid } from './core/NavGrid.js';
export { Grid } from './core/Grid.js';
export { Sun } from './core/Sun.js';
export { Layer } from './core/Layer.js';
export { TileMap } from './core/TileMap.js';
export { SpriteSheetRegistry } from './core/SpriteSheetRegistry.js';
export { BigAtlasInspector } from './core/BigAtlasInspector.js';
export { SoundManager } from './core/SoundManager.js';
export * from './core/utils.js';

// ============================================================================
// COMPONENTS
// ============================================================================
export { Transform } from './components/Transform.js';
export { RigidBody } from './components/RigidBody.js';
export { Collider } from './components/Collider.js';
export { SpriteRenderer } from './components/SpriteRenderer.js';
export { ParticleComponent } from './components/ParticleComponent.js';
export { DecorationComponent } from './components/DecorationComponent.js';
export { LightEmitter } from './components/LightEmitter.js';
export { ShadowCaster } from './components/ShadowCaster.js';
export { LightOccluder } from './components/LightOccluder.js';
export { FlashComponent } from './components/FlashComponent.js';

// ============================================================================
// PARTICLES
// ============================================================================
// Note: Particles are NOT GameObjects - they use ParticleComponent directly
export { ParticleEmitter, DECAL_STAMPS_BLEND_MODE } from './core/ParticleEmitter.js';

// ============================================================================
// DECORATIONS
// ============================================================================
// Note: Decorations are NOT GameObjects - they use DecorationComponent directly
export { DecorationPool } from './core/DecorationPool.js';

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
export { Constraint } from './core/Constraint.js';

// ============================================================================
// FLASHES
// ============================================================================
// Note: Flashes ARE GameObjects (auto-registered) with LightEmitter + FlashComponent
export { Flash } from './core/Flash.js';

// ============================================================================
// QUERY SYSTEM (Worker Context Only)
// ============================================================================
// Note: The query() function is available globally in all workers for
// component-based entity filtering. Use it in entity code like:
//   const allPredators = query([RigidBody, PredatorBehavior]);
//   const visibleEntities = query([SpriteRenderer, Transform]);
// This is NOT available in main thread context, only in workers.

// ============================================================================
// WORKERS
// ============================================================================
// Note: Workers are typically loaded as separate files via new Worker()
// but we export them here for bundling purposes
export { AbstractWorker } from './workers/AbstractWorker.js';

// Worker files (logic_worker, physics_worker, pixi_worker, spatial_worker, pixi4webworkers)
// are designed to be loaded as Web Workers and don't have default exports,
// but you can import them as modules if needed for bundling:
// import './workers/logic_worker.js';
// import './workers/physics_worker.js';
// import './workers/pixi_worker.js';
// import './workers/spatial_worker.js';
// import './workers/pixi4webworkers.js';

// ============================================================================
// WEED NAMESPACE - PIXI-style usage 🌿
// ============================================================================
// Import everything we need for the namespace
import { GameEngine } from './core/gameEngine.js';
import { Scene } from './core/Scene.js';
import { GameObject, Keyboard } from './core/gameObject.js';
import { Component } from './core/Component.js';
import { FSM } from './core/FSM.js';
import { FSMState } from './core/FSMState.js';
import { DebugFlags } from './core/debug/DebugFlags.js';
import { DebugUI } from './core/debug/DebugUI.js';
import { DebugDraw } from './core/debug/DebugDraw.js';
import { Mouse } from './core/Mouse.js';
import { Camera } from './core/Camera.js';
import { Ray } from './core/Ray.js';
import { NavGrid } from './core/NavGrid.js';
import { Grid } from './core/Grid.js';
import { Sun } from './core/Sun.js';
import { Layer } from './core/Layer.js';
import { TileMap } from './core/TileMap.js';
import { SpriteSheetRegistry } from './core/SpriteSheetRegistry.js';
import { BigAtlasInspector } from './core/BigAtlasInspector.js';
import { SoundManager } from './core/SoundManager.js';
import * as utils from './core/utils.js';

import { Transform } from './components/Transform.js';
import { RigidBody } from './components/RigidBody.js';
import { Collider } from './components/Collider.js';
import { SpriteRenderer } from './components/SpriteRenderer.js';
import { ParticleComponent } from './components/ParticleComponent.js';

import { ParticleEmitter, DECAL_STAMPS_BLEND_MODE } from './core/ParticleEmitter.js';
import { DecorationPool } from './core/DecorationPool.js';
import { SharedAtomicPool } from './core/SharedAtomicPool.js';
import { DecorationComponent } from './components/DecorationComponent.js';
import { LightEmitter } from './components/LightEmitter.js';
import { ShadowCaster } from './components/ShadowCaster.js';
import { LightOccluder } from './components/LightOccluder.js';
import { FlashComponent } from './components/FlashComponent.js';
import { Flash } from './core/Flash.js';
import { Constraint } from './core/Constraint.js';
import { AbstractWorker } from './workers/AbstractWorker.js';
import { DEBUG_FLAGS } from './core/debug/DebugFlags.js';
import {
  ShapeType,
  BLEND_MODES,
  DEFAULT_LAYERS,
  CAMERA_TYPES,
} from './core/ConfigDefaults.js';

const enums = Object.freeze({
  ShapeType,
  BLEND_MODES,
  DEFAULT_LAYERS,
  CAMERA_TYPES,
  DECAL_STAMPS_BLEND_MODE,
  DEBUG_FLAGS,
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
  Camera,
  Ray,
  NavGrid,
  Grid,
  Sun,
  Layer,
  TileMap,
  Keyboard,
  SpriteSheetRegistry,
  BigAtlasInspector,
  SoundManager,

  // Components
  Transform,
  RigidBody,
  Collider,
  SpriteRenderer,
  ParticleComponent,
  LightEmitter,
  ShadowCaster,
  LightOccluder,
  FlashComponent,

  // Particles
  ParticleEmitter,

  // Decorations
  DecorationPool,
  DecorationComponent,

  // Constraints
  Constraint,

  // Pool base class
  SharedAtomicPool,

  // Flashes
  Flash,

  // Workers
  AbstractWorker,

  // Utils
  ...utils,

  enums,

  VERSION: '1.0.0',
});

if (typeof window !== 'undefined') {
  window.WEED = WEED;
}

export default WEED;
