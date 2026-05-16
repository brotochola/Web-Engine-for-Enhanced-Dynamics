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
});

/**
 * Blend mode enum — all PixiJS-supported blend modes.
 * Numeric values stored directly in the Layer config SAB (Uint8).
 * Indices match Layer._BLEND_MODE_STRINGS for id-to-string translation.
 * @readonly
 * @enum {number}
 */
export const BLEND_MODES = Object.freeze({
  NORMAL: 0,
  INHERIT: 1,
  ADD: 2,
  MULTIPLY: 3,
  SCREEN: 4,
  DARKEN: 5,
  LIGHTEN: 6,
  ERASE: 7,
  COLOR_DODGE: 8,
  COLOR_BURN: 9,
  LINEAR_BURN: 10,
  LINEAR_DODGE: 11,
  LINEAR_LIGHT: 12,
  HARD_LIGHT: 13,
  SOFT_LIGHT: 14,
  PIN_LIGHT: 15,
  DIFFERENCE: 16,
  EXCLUSION: 17,
  OVERLAY: 18,
  SATURATION: 19,
  COLOR: 20,
  LUMINOSITY: 21,
  NORMAL_NPM: 22,
  ADD_NPM: 23,
  SCREEN_NPM: 24,
  NONE: 25,
  SUBTRACT: 26,
  DIVIDE: 27,
  VIVID_LIGHT: 28,
  HARD_MIX: 29,
  NEGATION: 30,
  MIN: 31,
  MAX: 32,
});

/**
 * Built-in layer definitions. Same shape as scene config.layers entries.
 * ySorting is false for all built-in layers; ENTITIES gets overridden
 * at runtime by the scene's renderer.ySorting config.
 * @readonly
 */
export const DEFAULT_LAYERS = Object.freeze({
  BACKGROUND: {
    zIndex: 0,
    blendMode: BLEND_MODES.NORMAL,
    ySorting: false,
    layerType: 'background',
  },
  DECALS: {
    zIndex: 1,
    blendMode: BLEND_MODES.NORMAL,
    ySorting: false,
    layerType: 'decals',
  },
  CASTED_SHADOWS: {
    zIndex: 2,
    blendMode: BLEND_MODES.MULTIPLY,
    ySorting: false,
    layerType: 'shadows',
  },
  ENTITIES: {
    zIndex: 3,
    blendMode: BLEND_MODES.NORMAL,
    ySorting: false,
    layerType: 'world',
  },
  LIGHTING: {
    zIndex: 4,
    blendMode: BLEND_MODES.MULTIPLY,
    ySorting: false,
    layerType: 'lighting',
  },
});

/**
 * WebRTC data channel identifiers for Network.send / broadcast / sendToHost / onMessage.
 * RELIABLE: ordered, guaranteed delivery — use for game events, commands, spawns.
 * FAST:     unordered, no retransmits   — use for per-frame positional snapshots.
 * @readonly
 * @enum {number}
 */
export const NETWORK_CHANNEL = Object.freeze({
  RELIABLE: 0,
  FAST: 1,
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
  /** Outer loop: collision resolve passes per frame (variable FPS) or fixed micro-steps (noLimitFPS). */
  subStepCount: 4,
  /** PBD sweeps over distance constraints after each collision pass (>= 1). */
  distanceConstraintIterations: 1,
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
  /** Max decorations attached per GameObject (Uint8 count, hard max 255) */
  maxAttachedDecorationsPerEntity: 32,
});

/** Composite Y-sort: `worldY * DECORATION_Y_SORT_SCALE + innerZ` (entities, decorations, bullets, particles on ENTITIES layer). */
export const DECORATION_Y_SORT_SCALE = 128;
/** Signed decoration sub-layer; reserve the top-most slot for light glow. */
export const DECORATION_INNER_Z_MAX = DECORATION_Y_SORT_SCALE - 2;
export const DECORATION_INNER_Z_MIN = -(DECORATION_Y_SORT_SCALE - 1);
/** Light glow (type 3) sort offset vs entity body at same foot Y; separate from DecorationPool and above child decorations. */
export const ENTITY_GLOW_SORT_BIAS = DECORATION_Y_SORT_SCALE - 1;

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
  maxDecalTileUploadsPerFrame: 32,
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
  resolution: 1.0,
  alpha: 1.0,             // mutable at runtime via layer.alpha = v (SAB + Atomics)
  shader: null,
  blendMode: BLEND_MODES.NORMAL,
  // ySorting intentionally omitted: custom layers inherit the scene-level
  // renderer.ySorting setting (Layer._defaultYSorting) when not specified.
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
  maxProcessingMsPerFrame: 2,
  noLimitFPS: true,
});

// ============================================================================
// DEBUG DEFAULTS
// ============================================================================

export const DEBUG_DEFAULTS = Object.freeze({
  maxDebugDrawEntries: 256,
});
