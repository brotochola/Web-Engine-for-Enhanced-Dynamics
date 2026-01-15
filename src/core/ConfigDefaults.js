/**
 * Default configuration values for the game engine
 * Single source of truth for all config settings across the engine
 */

// ============================================================================
// TOP-LEVEL DEFAULTS
// ============================================================================

export const SCENE_DEFAULTS = {
  gravity: { x: 0, y: 0 },
  worldWidth: 1000,
  worldHeight: 1000,
  canvasWidth: 800,
  canvasHeight: 600,
};

// ============================================================================
// PHYSICS DEFAULTS
// ============================================================================

export const PHYSICS_DEFAULTS = {
  subStepCount: 4,
  boundaryElasticity: 0.8,
  collisionResponseStrength: 0.8,
  verletDamping: 0.995,
  minSpeedForRotation: 0.1,
  maxCollisionPairs: 10000,
  gravity: { x: 0, y: 0 },
};

// ============================================================================
// SPATIAL DEFAULTS
// ============================================================================

export const SPATIAL_DEFAULTS = {
  cellSize: 128,
  maxNeighbors: 100,
  numberOfSpatialWorkers: 1, // Number of parallel spatial workers for neighbor detection
  noLimitFPS: false,
};

// ============================================================================
// PARTICLE DEFAULTS
// ============================================================================

export const PARTICLE_DEFAULTS = {
  maxParticles: 0,
  noLimitFPS: false,
  decals: false,
  decalsTileSize: 256,
  decalsResolution: 0.5,
};

// ============================================================================
// DECORATION DEFAULTS
// ============================================================================

export const DECORATION_DEFAULTS = {
  maxDecorations: 0, // Number of static decorations (grass, rocks, etc.)
};

// ============================================================================
// LOGIC DEFAULTS
// ============================================================================

export const LOGIC_DEFAULTS = {
  numberOfLogicWorkers: 1,
  numberOfEntitiesPerJob: 250,

  noLimitFPS: false,
};

// ============================================================================
// RENDERER DEFAULTS
// ============================================================================

export const RENDERER_DEFAULTS = {
  noLimitFPS: false,
  ySorting: false,
  interpolation: true, // Smooth rendering when renderer FPS > physics FPS
  cullingRatio: 0.1,
};

// ============================================================================
// LIGHTING DEFAULTS
// ============================================================================

export const LIGHTING_DEFAULTS = {
  enabled: false,
  lightingAmbient: 0.3,
  maxLights: 10,
  shadowsEnabled: false,
  maxShadowCastingLights: 20,
  maxShadowsPerLight: 15,
  maxShadowsPerEntity: 0,
  maxFlashes: 0,
  resolution: 0.25,
};

// ============================================================================
// COMBINED CONFIG (for convenience)
// ============================================================================

export const CONFIG_DEFAULTS = {
  ...SCENE_DEFAULTS,
  physics: PHYSICS_DEFAULTS,
  spatial: SPATIAL_DEFAULTS,
  particle: PARTICLE_DEFAULTS,
  decoration: DECORATION_DEFAULTS,
  logic: LOGIC_DEFAULTS,
  renderer: RENDERER_DEFAULTS,
  lighting: LIGHTING_DEFAULTS,
};
