// Main entry point for the multithreaded game engine library
// Export all public APIs

// Core classes
export { GameObject } from './core/gameObject.js';
export { RenderableGameObject } from './core/RenderableGameObject.js';
export { GameEngine } from './core/gameEngine.js';

// Utilities
export { getParentClasses } from './core/utils.js';

// Type exports
export type {
  // Configuration types
  GameConfig,
  EntityConfig,
  RenderableConfig,
  SpriteConfig,
  AnimationConfig,
  PhysicsConfig,
  SpatialConfig,
  InputState,
  CameraState,
  
  // Schema types
  ArraySchema,
  TypedArrayConstructor,
  
  // Worker message types
  WorkerMessage,
  WorkerMessageType,
  InitMessage,
  SpawnMessage,
  DespawnMessage,
  ConfigUpdateMessage,
  ReadyMessage,
  FPSMessage,
  
  // Collision types
  CollisionEvent,
  
  // Entity metadata
  EntityClassInfo,
  
  // Texture/asset types
  TextureConfig,
  
  // Performance
  PerformanceMetrics,
} from './types/index.js';

// Type guards
export { isTypedArrayConstructor } from './types/index.js';
