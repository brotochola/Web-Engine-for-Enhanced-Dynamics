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
  /** Entities layer - standard alpha blending (PixiJS 8.16+ uses 'normal' for correct alpha) */
  ENTITIES: 'normal',
  /** Lighting overlay - multiply to darken unlit areas */
  LIGHTING: 'multiply',
});

/**
 * Camera / view styles for particle (and future entity) rendering.
 * @readonly
 * @enum {number}
 */
export const CAMERA_TYPES = Object.freeze({
  /** Top-down / isometric: Z offsets screen Y */
  TOPDOWN: 0,
  /** Zenithal (bird's-eye): Z affects scale (and optionally alpha) */
  ZENITHAL: 1,
  /** Side / platformer: Z offsets screen Y (same as topdown for particles) */
  SIDE: 2,
});

// ============================================================================
// ASSETS DEFAULTS (BigAtlas generation)
// ============================================================================

export const ASSETS_DEFAULTS = Object.freeze({
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
});

// ============================================================================
// TOP-LEVEL DEFAULTS
// ============================================================================

export const SCENE_DEFAULTS = Object.freeze({
  gravity: Object.freeze({ x: 0, y: 0 }),
  worldWidth: 1000,
  worldHeight: 1000,
});

// ============================================================================
// PHYSICS DEFAULTS
// ============================================================================

export const PHYSICS_DEFAULTS = Object.freeze({
  subStepCount: 4,
  boundaryElasticity: 0.8,
  collisionResponseStrength: 0.8,
  verletDamping: 0.995,
  minSpeedForRotation: 0.1,
  maxCollisionPairs: 10000,
  maxConstraints: 0,
  gravity: Object.freeze({ x: 0, y: 0 }),
  sleepThreshold: 0.1,
  wakeUpThreshold: 0.05,
  sleepDuration: 30,
});

// ============================================================================
// SPATIAL DEFAULTS (Spatial Hashing Grid)
// ============================================================================

export const SPATIAL_DEFAULTS = Object.freeze({
  cellSize: 128,
  maxNeighbors: 500,
  maxEntitiesPerCell: 64,
  numberOfSpatialWorkers: 1,
  rowsPerBlock: 2,
  noLimitFPS: false,
  collisionCandidateSearchMargin: 0.25,
});

// ============================================================================
// PARTICLE DEFAULTS
// ============================================================================

export const PARTICLE_DEFAULTS = Object.freeze({
  maxParticles: 0,
  noLimitFPS: false,
  decals: false,
  decalsTileSize: 256,
  decalsResolution: 0.5,
  cameraView: CAMERA_TYPES.TOPDOWN,
  zenithalMaxHeight: 50,
  zenithalScaleFactor: 0.5,
  zenithalAlphaFade: 0,
});

// ============================================================================
// DECORATION DEFAULTS
// ============================================================================

export const DECORATION_DEFAULTS = Object.freeze({
  maxDecorations: 0,
});

// ============================================================================
// BULLET DEFAULTS
// ============================================================================

export const BULLET_DEFAULTS = Object.freeze({
  maxBullets: 0,
  maxImpactsPerFrame: 64,
});

// ============================================================================
// AUDIO DEFAULTS
// ============================================================================

export const AUDIO_DEFAULTS = Object.freeze({
  maxSlots: 128,
  mixGain: 0.5,
  masterVolume: 1.0,
});

// ============================================================================
// LOGIC DEFAULTS
// ============================================================================

export const LOGIC_DEFAULTS = Object.freeze({
  numberOfLogicWorkers: 1,
  staggeredUpdates: false,
  noLimitFPS: false,
});

// ============================================================================
// RENDERER DEFAULTS
// ============================================================================

export const RENDERER_DEFAULTS = Object.freeze({
  noLimitFPS: false,
  ySorting: false,
  interpolation: true,
  cullingRatio: 0.1,
  startFadingDecorationsAtZoom: 0.5,
  hideDecorationsAtZoom: 0.25,
  maxVisibleRenderables: 40000,
});

// ============================================================================
// LIGHTING DEFAULTS
// ============================================================================

/**
 * Sun/directional light defaults
 * The sun provides ambient light during daytime and casts parallel shadows
 * When sun intensity is high, point light shadows are suppressed (realistic behavior)
 */
export const SUN_DEFAULTS = Object.freeze({
  enabled: false,
  angle: 180,
  elevation: 45,
  intensity: 0.7,
  color: 0xffffff,
  shadowAlpha: 0.4,
  startHour: 12,
  shadowAngleOffset: Math.PI,
  shadowMinLengthRatio: 0.2,
  shadowMaxLengthRatio: 2.0,
  shadowStretchAlphaFactor: 0.5,
  dayCycle: Object.freeze({
    enabled: false,
    speed: 1,
    dayDurationMinutes: 5,
  }),
});

export const LIGHTING_DEFAULTS = Object.freeze({
  enabled: false,
  baseAmbient: 0.05,
  maxLights: 10,
  shadowsEnabled: false,
  maxShadowCastingLights: 20,
  maxShadowsPerLight: 15,
  maxShadowsPerEntity: 0,
  maxShadowSprites: 1000,
  maxFlashes: 0,
  resolution: 0.25,
  shadowResolution: 0.5,
  raycasted: false,
  maxPolygonVertices: 128,
  sun: SUN_DEFAULTS,
});

// ============================================================================
// LAYER DEFAULTS
// ============================================================================

export const LAYER_DEFAULTS = Object.freeze({
  maxItemsPerLayer: 5000,
});

// ============================================================================
// PRE-RENDER DEFAULTS
// ============================================================================

export const PRE_RENDER_DEFAULTS = Object.freeze({
  noLimitFPS: true,
});

// ============================================================================
// NAVIGATION DEFAULTS
// ============================================================================

export const NAVIGATION_DEFAULTS = Object.freeze({
  enabled: false,
  cellSize: 32,
  maxFlowfields: 16,
  maxPaths: 64,
  maxPathLength: 128,
  noLimitFPS: true,
});

// ============================================================================
// DEBUG DEFAULTS
// ============================================================================

export const DEBUG_DEFAULTS = Object.freeze({
  maxDebugDrawEntries: 256,
});
