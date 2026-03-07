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
  /** Entities layer - normal-npm (non-premultiplied alpha for correct particle/alpha blending) */
  ENTITIES: 'normal-npm',
  /** Lighting overlay - multiply to darken unlit areas */
  LIGHTING: 'multiply',
});

// ============================================================================
// ASSETS DEFAULTS (BigAtlas generation)
// ============================================================================

export const ASSETS_DEFAULTS = {
  /** Maximum atlas width in pixels (GPU texture limit) */
  maxAtlasWidth: 4096,
  /** Maximum atlas height in pixels (GPU texture limit) */
  maxAtlasHeight: 4096,
  /** Trim transparent pixels from individual images to save atlas space */
  trimImages: true,
  /** Alpha threshold for trimming (pixels with alpha <= this are trimmed) */
  trimAlphaThreshold: 0,
  /** Padding between packed sprites (prevents texture bleeding) */
  atlasPadding: 2,
};

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
  maxConstraints: 0, // Max distance constraints (0 = disabled)
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
// BULLET DEFAULTS
// ============================================================================

export const BULLET_DEFAULTS = {
  maxBullets: 0,
  maxImpactsPerFrame: 64,
};

// ============================================================================
// AUDIO DEFAULTS
// ============================================================================

export const AUDIO_DEFAULTS = {
  maxSlots: 128, // Max simultaneous sounds (AudioWorklet SAB slot count)
  mixGain: 0.5, // Mix gain (0-1)
  masterVolume: 1.0, // Master volume (0-1)

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

/**
 * Sun/directional light defaults
 * The sun provides ambient light during daytime and casts parallel shadows
 * When sun intensity is high, point light shadows are suppressed (realistic behavior)
 */
export const SUN_DEFAULTS = {
  enabled: false, // Must be explicitly enabled
  angle: 180, // Degrees (0=East, 90=South, 180=West, 270=North) - default facing south
  elevation: 45, // Degrees above horizon (0=horizon, 90=overhead)
  intensity: 0.7, // Light intensity (0-1), affects ambient brightness
  color: 0xffffff, // Sun color (warm white default)
  shadowAlpha: 0.4, // Base darkness of sun-cast shadows (0-1)
  startHour: 12, // Starting hour for day cycle (0-24)
  // Shadow configuration
  shadowAngleOffset: Math.PI, // Hemisphere offset: π for southern (shadows point south), 0 for northern
  shadowMinLengthRatio: 0.2, // Shadow length multiplier at zenith (noon) - shortest shadows
  shadowMaxLengthRatio: 2.0, // Shadow length multiplier at horizon (sunrise/sunset) - longest shadows
  shadowStretchAlphaFactor: 0.5, // Alpha fade when shadows stretch (0=none, 1=full compensation)
  dayCycle: {
    enabled: false, // Auto-advance time of day
    speed: 1, // Multiplier (1 = real time, 60 = 1 minute = 1 hour)
    dayDurationMinutes: 5, // Real minutes for full day (1440 = 24 real hours)
  },
};

export const LIGHTING_DEFAULTS = {
  enabled: false,
  baseAmbient: 0.05, // Minimum ambient light (night/indoor) - renamed from lightingAmbient
  maxLights: 10,
  shadowsEnabled: false,
  maxShadowCastingLights: 20,
  maxShadowsPerLight: 15,
  maxShadowsPerEntity: 0,
  maxShadowSprites: 1000,
  maxFlashes: 0,
  resolution: 0.25,
  shadowResolution: 0.5,
  sun: SUN_DEFAULTS,
};

// ============================================================================
// PRE-RENDER DEFAULTS
// ============================================================================

export const PRE_RENDER_DEFAULTS = {
  noLimitFPS: true, // Set true to run visibility/render queue as fast as possible
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
  noLimitFPS: true, // Navigation (in particle_worker) runs as fast as possible by default
};
