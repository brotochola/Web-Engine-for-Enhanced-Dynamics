/**
 * Default configuration values for the game engine
 * Single source of truth for all config settings across the engine
 */

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Shape types for Collider component
 * @readonly
 * @enum {number}
 */
export const ShapeType = Object.freeze({
  /** Circle collider - uses radius property */
  Circle: 0,
  /** Box/rectangle collider - uses width and height properties */
  Box: 1,
  /** Polygon collider - uses custom vertices (future) */
  Polygon: 2,
});

/**
 * Z-index values for rendering layers
 * Used by PixiRenderer and DebugUI for layer ordering
 * @readonly
 * @enum {number}
 */
export const Z_INDICES = Object.freeze({
  /** Background layer (tilemap or texture) */
  BACKGROUND: 0,
  /** Decals layer (blood, footprints, etc.) */
  DECALS: 1,
  /** Casted shadows from entities */
  CASTED_SHADOWS: 2,
  /** Main entities layer (sprites, particles) */
  ENTITIES: 3,
  /** Lighting overlay layer */
  LIGHTING: 4,
  /** Light glow effects layer */
  LIGHT_GLOW: 5,
});

/**
 * Default blend modes for each rendering layer
 * Used by PixiRenderer during initialization and DebugUI for displaying current values
 * @readonly
 * @enum {string}
 */
export const LAYER_DEFAULT_BLEND_MODES = Object.freeze({
  /** Background layer - normal blend */
  BACKGROUND: 'normal',
  /** Decals layer - normal blend */
  DECALS: 'normal',
  /** Casted shadows - multiply to darken scene */
  CASTED_SHADOWS: 'multiply',
  /** Entities layer - normal-npm (non-premultiplied alpha for ParticleContainer) */
  ENTITIES: 'normal-npm',
  /** Lighting overlay - multiply to darken unlit areas */
  LIGHTING: 'multiply',
  /** Light glow effects - additive for glow effect */
  LIGHT_GLOW: 'add',
});

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
  // Sleeping optimization
  sleepThreshold: 0.1, // Speed threshold below which entity is considered still (units/frame)
  wakeUpThreshold: 0.05, // Speed threshold above which entity is considered moving (units/frame)
  sleepDuration: 30, // Frames of stillness required before sleeping (0.5 seconds at 60fps)
};

// ============================================================================
// SPATIAL DEFAULTS (Spatial Hashing Grid)
// ============================================================================

export const SPATIAL_DEFAULTS = {
  cellSize: 128, // Grid cell size in world units
  maxNeighbors: 500, // Max neighbors per entity (passed to Grid via gridMetadata)
  maxEntitiesPerCell: 64, // Max entities per grid cell (passed to Grid via gridMetadata)
  numberOfSpatialWorkers: 1, // Number of parallel spatial workers for neighbor detection
  rowsPerBlock: 2,
  noLimitFPS: false,
  collisionCandidateSearchMargin: 0.25,// Extra distance added to collision range to account for entity movement between spatial worker and physics worker
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
  staggeredUpdates: false, // Enable tick decimation (entities tick every N frames based on tickInterval)
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
  startFadingDecorationsAtZoom: 0.5, // Zoom level where decorations start fading out
  hideDecorationsAtZoom: 0.25, // Zoom level where decorations are completely hidden
  maxVisibleRenderables: 40000, // Max items in render queue per frame (entities + particles + decorations)
};

// ============================================================================
// LIGHTING DEFAULTS
// ============================================================================

export const LIGHTING_DEFAULTS = {
  enabled: false,
  lightingAmbient: 0.05,
  maxLights: 10,
  shadowsEnabled: false,
  maxShadowCastingLights: 20,
  maxShadowsPerLight: 15,
  maxShadowsPerEntity: 0,
  maxShadowSprites: 1000,
  maxFlashes: 0,
  resolution: 0.25,
};

// ============================================================================
// NAVIGATION DEFAULTS
// ============================================================================

export const NAVIGATION_DEFAULTS = {
  enabled: false, // Must be explicitly enabled
  cellSize: 32, // Pixels per navigation cell
  maxFlowfields: 16, // How many distinct flowfield targets to cache
  maxPaths: 64, // How many A* paths to cache
  maxPathLength: 128, // Maximum cells per path
  noLimitFPS: true, // Nav worker runs as fast as possible by default
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
  navigation: NAVIGATION_DEFAULTS,
};
