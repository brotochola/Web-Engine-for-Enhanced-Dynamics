// ============================================================================
// WeedJS - Multithreaded Game Engine 🌿
// Main entry point for the engine
// ============================================================================

// ============================================================================
// CORE MODULES
// ============================================================================
export { GameEngine } from "./core/gameEngine.js";
export { GameObject, Keyboard } from "./core/gameObject.js";
export { Component } from "./core/Component.js";
export { Debug } from "./core/Debug.js";
export { Mouse } from "./core/Mouse.js";
export { SpriteSheetRegistry } from "./core/SpriteSheetRegistry.js";
export { BigAtlasInspector } from "./core/BigAtlasInspector.js";
export * from "./core/utils.js";

// ============================================================================
// COMPONENTS
// ============================================================================
export { Transform } from "./components/Transform.js";
export { RigidBody } from "./components/RigidBody.js";
export { Collider } from "./components/Collider.js";
export { SpriteRenderer } from "./components/SpriteRenderer.js";
export { MouseComponent } from "./components/MouseComponent.js";

// ============================================================================
// WORKERS
// ============================================================================
// Note: Workers are typically loaded as separate files via new Worker()
// but we export them here for bundling purposes
export { AbstractWorker } from "./workers/AbstractWorker.js";
export { SpriteUpdateOptimizer } from "./workers/SpriteUpdateOptimizer.js";

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
import { GameEngine } from "./core/gameEngine.js";
import { GameObject, Keyboard } from "./core/gameObject.js";
import { Component } from "./core/Component.js";
import { Debug } from "./core/Debug.js";
import { Mouse } from "./core/Mouse.js";
import { SpriteSheetRegistry } from "./core/SpriteSheetRegistry.js";
import { BigAtlasInspector } from "./core/BigAtlasInspector.js";
import * as utils from "./core/utils.js";

import { Transform } from "./components/Transform.js";
import { RigidBody } from "./components/RigidBody.js";
import { Collider } from "./components/Collider.js";
import { SpriteRenderer } from "./components/SpriteRenderer.js";
import { MouseComponent } from "./components/MouseComponent.js";

import { AbstractWorker } from "./workers/AbstractWorker.js";
import { SpriteUpdateOptimizer } from "./workers/SpriteUpdateOptimizer.js";

// Create the WEED namespace object (like PIXI)
const WEED = {
  // Core
  GameEngine,
  GameObject,
  Component,
  Debug,
  Mouse,
  Keyboard,
  SpriteSheetRegistry,
  BigAtlasInspector,

  // Components
  Transform,
  RigidBody,
  Collider,
  SpriteRenderer,
  MouseComponent,

  // Workers
  AbstractWorker,
  SpriteUpdateOptimizer,

  // Utils (spread all utility functions)
  ...utils,

  // Version
  VERSION: "1.0.0",
};

// Make WEED available globally if in browser
if (typeof window !== "undefined") {
  window.WEED = WEED;
}

// Export WEED namespace as default
export default WEED;
