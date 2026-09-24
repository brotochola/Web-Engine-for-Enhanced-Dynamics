/**
 * Default configuration values for the game engine
 * Single source of truth for all config settings across the engine
 */

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Max vertices on a convex Collider polygon (Box2D B2_MAX_POLYGON_VERTICES).
 * Changing this affects Collider SAB size even if you use fewer verts.
 */
export const MAX_POLYGON_VERTICES = 8;

/** Collider shapes — Box=0, Circle=1, Polygon=2 (WASM C / Box2D language). */
export {
  ShapeType,
  Box2dBodyType,
  STATE_CHANNELS,
} from '../box2d/box2dConstants.js';

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
 * How a shader layer builds its density RT (pass 1 before the look fragment).
 * Int values — stored in layer metadata / compared on workers.
 * Config still accepts the old strings `'sprites'` / `'liquidFun'` at normalize.
 * @readonly
 * @enum {number}
 */
export const LAYER_DENSITY_SOURCE = Object.freeze({
  /** InstancedSpriteBatch + atlas kernels (default). */
  SPRITES: 0,
  /** Procedural soft disks from LiquidFun HEAP pose (no type-7 sprite queue). */
  LIQUID_FUN: 1,
});

/**
 * What a compute layer packs into GPU storage (not the look vertex shader).
 * Int values. Config still accepts `'box2dBodies'` / `'liquidFun'` at normalize.
 * @readonly
 * @enum {number}
 */
export const LAYER_COMPUTE_SOURCE = Object.freeze({
  /** Colliders whose layerMask includes this layer: pose/vel + box/circle/polygon verts. */
  BOX2D_BODIES: 0,
  /** Layer particles (LiquidFun HEAP + CPU ParticleEmitter) packed into the engine `particles` SSBO. */
  LIQUID_FUN: 1,
});

/**
 * How a layer consumes subscribed particles/colliders.
 * Cached in Layer config SAB (`Uint8` per id).
 * @readonly
 * @enum {number}
 */
export const LAYER_FEEDER_KIND = Object.freeze({
  NONE: 0,
  BUILTIN: 1,
  SPRITES: 2,
  DENSITY: 3,
  COMPUTE: 4,
  MESH: 5,
});

/**
 * Layer content / pipeline kind. Scene config: `kind: LAYER_KIND.TILEMAP` (value is `'tilemap'`).
 * @readonly
 * @enum {string}
 */
export const LAYER_KIND = Object.freeze({
  SPRITES: 'sprites',
  COVER: 'cover',
  STATIC: 'static',
  TILING: 'tiling',
  TILEMAP: 'tilemap',
  DENSITY: 'density',
  COMPUTE: 'compute',
  MESH: 'mesh',
  DECALS: 'decals',
  SHADOWS: 'shadows',
  LIGHTING: 'lighting',
});

const SCENERY_KIND_SET = new Set([
  LAYER_KIND.COVER,
  LAYER_KIND.STATIC,
  LAYER_KIND.TILING,
  LAYER_KIND.TILEMAP,
]);

const SKIP_SUBSCRIBE_KIND_SET = new Set([
  LAYER_KIND.COVER,
  LAYER_KIND.STATIC,
  LAYER_KIND.TILING,
  LAYER_KIND.TILEMAP,
  LAYER_KIND.DECALS,
  LAYER_KIND.SHADOWS,
  LAYER_KIND.LIGHTING,
]);

/** @param {string|null|undefined} kind */
export function isSceneryKind(kind) {
  return SCENERY_KIND_SET.has(kind);
}

/** @param {string|null|undefined} kind */
export function isSkipSubscribeKind(kind) {
  return SKIP_SUBSCRIBE_KIND_SET.has(kind);
}

/**
 * `Layer.resolveSubscriptions` kind.
 * @readonly
 * @enum {number}
 */
export const LAYER_SUBSCRIBE_KIND = Object.freeze({
  PARTICLE: 0,
  GAME_OBJECT: 1,
});

/** Default GPU/CPU body cap for BOX2D_BODIES compute layers. */
export const COMPUTE_LAYER_DEFAULT_MAX_BODIES = 512;
/** Default GPU particle cap when `shader.source` is LIQUID_FUN and `maxParticles` is omitted. */
export const COMPUTE_LAYER_DEFAULT_MAX_PARTICLES = 4096;
/** Engine-owned Body.flags bit: RigidBody.static. Bit 0 and others are shader-defined. */
export const COMPUTE_FLAG_STATIC = 2;
/** Engine-owned Body.flags bit: motion-sweep ghost (shader occupancy). */
export const COMPUTE_FLAG_SWEEP = 4;

/**
 * Soft-disk falloff for `LAYER_DENSITY_SOURCE.LIQUID_FUN` splat kernels.
 * Int values. Config still accepts `'quadratic'` / `'smoothstep'` / `'gaussian'`.
 * @readonly
 * @enum {number}
 */
export const LAYER_SPLAT_FALLOFF = Object.freeze({
  /** alpha = max(0, 1 - d*d) where d is normalized radius in [0,1]. Default / v1 active. */
  QUADRATIC: 0,
  /** alpha = 1 - smoothstep(0, 1, d). Reserved — falls back to quadratic until wired. */
  SMOOTHSTEP: 1,
  /** alpha = exp(-4 * d*d). Reserved — falls back to quadratic until wired. */
  GAUSSIAN: 2,
});

/**
 * Pixi v8 TextureSource.scaleMode for low-res layer RT upsample (displaySprite stretch).
 * Not MSAA / FXAA — only bilinear vs nearest when sampling the RT.
 * Int values. Pixi string is `Layer._SCALE_MODE_STRINGS[id]` at RT create.
 * @readonly
 * @enum {number}
 */
export const LAYER_SCALE_MODE = Object.freeze({
  /** Soft bilinear upsample (default; good for soft fluid looks at resolution < 1). */
  LINEAR: 0,
  /** Crisp / blocky upsample. */
  NEAREST: 1,
});

/**
 * Sprite atlas tiling. `repeatX/Y` is always the world-px period (0 = stretch).
 * WORLD locks the wallpaper to the scene; LOCAL freezes a crop on the quad (rotates with it).
 * GPU packs mode in the sign of `aInstTileInv` (positive WORLD, negative LOCAL, 0 stretch).
 * @readonly
 * @enum {number}
 */
export const SPRITE_TILE_MODE = Object.freeze({
  STRETCH: 0,
  WORLD: 1,
  LOCAL: 2,
});

/**
 * Built-in pipeline layers. Same shape as scene config.layers entries.
 * ySorting is false for all built-in layers; entities gets overridden
 * at runtime by the scene's renderer.ySortingInCPU config.
 * Scenery (cover / tiling / tilemap) is scene-owned — not listed here.
 * @readonly
 */
export const DEFAULT_LAYERS = Object.freeze({
  decals: {
    zIndex: 1,
    blendMode: BLEND_MODES.NORMAL,
    ySorting: false,
    kind: LAYER_KIND.DECALS,
  },
  castedShadows: {
    zIndex: 2,
    blendMode: BLEND_MODES.MULTIPLY,
    ySorting: false,
    kind: LAYER_KIND.SHADOWS,
  },
  entities: {
    zIndex: 3,
    blendMode: BLEND_MODES.NORMAL,
    ySorting: false,
    kind: LAYER_KIND.SPRITES,
  },
  lighting: {
    zIndex: 4,
    blendMode: BLEND_MODES.MULTIPLY,
    ySorting: false,
    kind: LAYER_KIND.LIGHTING,
  },
  // ADD bloom mesh. Not a sprite queue. z starts above lighting so multiply does not crush it.
  lightGlows: {
    zIndex: 5,
    blendMode: BLEND_MODES.ADD,
    ySorting: false,
    kind: LAYER_KIND.LIGHTING,
  },
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
  /** Bin-pack heuristic: best-short-side | best-long-side | best-area */
  heuristic: 'best-short-side',
});

// ============================================================================
// TOP-LEVEL DEFAULTS
// ============================================================================

export const SCENE_DEFAULTS = Object.freeze({
  gravity: Object.freeze({ x: 0, y: 0 }),
  worldWidth: 1000,
  worldHeight: 1000,
  seed: 1,
  /** 16 = Uint16 entity ids (max 65535). 32 = Uint32 lists (max 300000). */
  entityIdWidth: 16,
  /**
   * When true, Scene.init does not start the main rAF loop or worker loops.
   * Drive simulation with scene.stepFrame(dtMs) / stepFrames(n, dtMs).
   */
  manualStep: false,
});

// ============================================================================
// ENGINE DEFAULTS (GameEngine constructor)
// ============================================================================

export const ENGINE_DEFAULTS = Object.freeze({
  autoResize: false,
  preventContextMenu: true,
  preventDefaultKeys: true,
  injectStyles: true,
  transitionCooldown: 100,
  /** Enable DebugUI overlay. Distinct from Scene.config.debug (DEBUG_DEFAULTS object). */
  debug: false,
  resizeDebounceMs: 150,
  /** Keep presenting to the canvas while the document is hidden. Default off: skip swapchain present. */
  presentWhenHidden: false,
});

// ============================================================================
// PHYSICS DEFAULTS
// ============================================================================

export const PHYSICS_DEFAULTS = Object.freeze({
  /**
   * Default true. false = do not create box2dWasm.js; Transform pose binds to a Weed SAB.
   * RigidBody vel, Collider, Joint, LiquidFun, and Box2d query/explode APIs need true.
   */
  enabled: true,
  /** Solver steps per physics tick (maps to Box2D world.step subStep). */
  subStepCount: 4,
  /** Soft contact spring frequency (Hz) → b2WorldDef.contactHertz. */
  contactHertz: 30,
  /** Soft contact damping ratio ζ → b2WorldDef.contactDampingRatio. */
  contactDampingRatio: 0.7,
  maxJoints: 0,
  /**
   * Global ColliderFixture pool size for the whole scene (not per body). 0 = off.
   * `maxFixtures` is a one-release alias copied onto this field in Scene._applyConfigDefaults.
   */
  maxFixturePoolSize: 0,
  /** @deprecated Use maxFixturePoolSize. Accepted as an alias when the new key is 0. */
  maxFixtures: 0,
  /** Gravity (px/s²). */
  gravity: Object.freeze({ x: 0, y: 0 }),
  /** Pixels treated as 1 meter for Box2D scale-dependent thresholds. */
  lengthUnitsPerMeter: 100,
  /** Overlap push speed cap (px/s). */
  contactSpeed: 1000,
  /** Hard linear speed clamp (px/s). */
  maximumLinearSpeed: 50000,
  /** Box2D internal pthread count (not Weed logic/spatial). Clamped to PTHREAD_POOL_SIZE (4). */
  box2dWorkerCount: 4,
  /** SPMC contact/sensor event ring capacity (begin+end). Dense spawns need large. */
  contactRingCapacity: 65536,
  /** MPSC SET_TRANSFORM/VEL/ROT ring. Boot-time only; dense teleports need large. */
  commandRingCapacity: 4096,
  /** Master switch: maps to b2World_EnableSleeping. When false, Box2D never sleeps dynamics. */
  sleeping: true,
  /** Min relative approach speed (px/s) to emit a Collider.enableHitEvents contact-hit. 0 = Box2D default. */
  hitEventThreshold: 0,
  noLimitFPS: false,
  fixedFps: 0,
  liquidFun: Object.freeze({
    enabled: false, // scene sets true to auto-create the system at physics init
    radius: 10, // particle radius, world px
    maxCount: 10000,
    subSteps: 1, // particle solver only; not Box2D subStepCount
    density: 1,
    // liquidfun-c / Google default is false. RemoveSpuriousBodyContacts (qsort,
    // drops floor+wall corner false-positives) only runs when this is true.
    strictContactCheck: false,
    // System def coeffs (lfParticleSystemDef). Solvers read these each step.
    dampingStrength: 1.0,
    pressureStrength: 0.05,
    viscousStrength: 0.25,
    tensileStrength: 0.2,
    powderStrength: 0.5,
    springStrength: 0.25,
    staticPressureStrength: 0.2,
    staticPressureRelaxation: 0.2,
    staticPressureIterations: 8,
    ejectionStrength: 0.5,
    colorMixingStrength: 0.5,
    repulsiveStrength: 1,
  }),
});

// ============================================================================
// SPATIAL DEFAULTS (Spatial Hashing Grid)
// ============================================================================

export const SPATIAL_DEFAULTS = Object.freeze({
  cellSize: 128,
  // Cap neighbor list length (and SAB size: N * (1+maxNeighbors) * 2 bytes).
  // Dense flocks may need 512–1024; most scenes are fine at 128–256.
  maxNeighbors: 128,
  maxEntitiesPerCell: 64,
  numberOfSpatialWorkers: 1,
  rowsPerBlock: 2,
  noLimitFPS: false,
  fixedFps: 0,
  /**
   * Fraction of visualRange used as Verlet skin for neighbor reuse.
   * 0 = off (rebuild every frame; search radius = visualRange).
   * >0 = search at visualRange + 2*skin, reuse while |ΔA| ≤ skin, re-filter published set each frame.
   */
  neighborReuseSkin: 0.04,
  /** Max frames a Verlet candidate list may be reused before forced rebuild. */
  neighborReuseMaxFrames: 15,
  /**
   * Full candidate rebuild every N frames, staggered by entity index.
   * 1 = every frame (off). >1 amortizes cell-walk like logic tickInterval.
   */
  neighborTickInterval: 1,
});

// ============================================================================
// PARTICLE DEFAULTS
// ============================================================================

/**
 * Particle over-life ease ids (u8). No sine — keep hot path cheap.
 * @readonly
 * @enum {number}
 */
export const PARTICLE_EASE = Object.freeze({
  LERP: 0,
  QUAD_IN: 1,
  QUAD_OUT: 2,
  QUAD_INOUT: 3,
  CUBIC_IN: 4,
  CUBIC_OUT: 5,
  CUBIC_INOUT: 6,
  EXPO_IN: 7,
  EXPO_OUT: 8,
  EXPO_INOUT: 9,
  BACK_IN: 10,
  BACK_OUT: 11,
  BACK_INOUT: 12,
  BOUNCE_OUT: 13,
});

export const PARTICLE_DEFAULTS = Object.freeze({
  maxParticles: 0,
  noLimitFPS: false,
  fixedFps: 0,
  decals: false,
  decalsTileSize: 256,
  decalsResolution: 0.5,
  /** Expo ease LUT samples (built once at module load in particleTween). 256 ≈ 1e-4 error. */
  expoLutSize: 256,
  /** Zenithal projection curve (scene-level). Used when viewMode === ZENITHAL. */
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
  /** Recalc decoration sway every N frames (1 = every frame). */
  swayDecimation: 1,
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
  fixedFps: 0,
});

// ============================================================================
// RENDERER DEFAULTS
// ============================================================================

export const RENDERER_DEFAULTS = Object.freeze({
  /** Pixi init preference. Compute layers require 'webgpu'. */
  backend: 'webgpu',
  noLimitFPS: false,
  fixedFps: 0,
  /** CPU painter on the entities layer. Ignored when useZBuffer is on. */
  ySortingInCPU: false,
  /**
   * Entity batch writes the queue sort key as clip Z and depth-tests.
   * Default off. When on, ySortingInCPU does not run.
   * Empty texels below `alphaCut` do not write Z. A softer edge still does.
   */
  useZBuffer: false,
  /** Low discard for the entity batch while useZBuffer is on. High cut stays 0. */
  alphaCut: 1 / 255,
  cullingRatio: 0.1,
  startFadingDecorationsAtZoom: 0.5,
  hideDecorationsAtZoom: 0.25,
  /** null = auto-size main render queue at SAB alloc from pools + Adobe piece bounds */
  maxVisibleRenderables: null,
  maxDecalTileUploadsPerFrame: 32,
  /** Pixi ImageSource mip chain for atlases/textures/tilesets. Off by default (VRAM + atlas bleed risk; STEP flat in benches). */
  autoGenerateMipmaps: false,
  /** Sampler for the big atlas and loose textures. 'nearest' keeps binary PNG alpha. */
  atlasScaleMode: 'linear',
  /**
   * Blend the last two pre-render queue publishes in the entity sprite shader.
   * Use when preRender.fixedFps is below the display rate. Not physics-pose
   * smoothing (that is preRender.interpolation). Both true adds a frame of lag.
   */
  interpolation: false,
  /**
   * 'add' — type 3 glows go to the lightGlows ADD mesh.
   * 'sprite' — same quads join the entity list (sort bias already above the body).
   * Source-over, so the soft edge can gray, and lighting multiply sits on top.
   */
  lightGlow: 'add',
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
  /** Cap for self-lit occluder fills per frame (collider/sprite into lighting RT). */
  maxOccluderSelfLit: 512,
  /** Bevel power for baked sprite/mesh normals (normalmap23 `p`). Bake-time only. */
  normalBevel: 64,
  /** Point-light height in world px for bump N·L (larger = flatter). */
  normalLightZ: 200,
  /** Scales baked normal XY before normalize. */
  normalStrength: 1,
  sun: SUN_DEFAULTS,
});

// ============================================================================
// LAYER DEFAULTS
// ============================================================================

export const LAYER_DEFAULTS = Object.freeze({
  maxItemsPerLayer: 5000,
  resolution: 1.0,
  alpha: 1.0,             // mutable at runtime via layer.alpha = v (SAB + Atomics)
  blendMode: BLEND_MODES.NORMAL,
  /** Pixi scaleMode for custom shader RT upsample. */
  scaleMode: LAYER_SCALE_MODE.LINEAR,
  // ySorting intentionally omitted: custom layers inherit the scene-level
  // renderer.ySortingInCPU setting (Layer._defaultYSorting) when not specified.
});

// ============================================================================
// PRE-RENDER DEFAULTS
// ============================================================================

export const PRE_RENDER_DEFAULTS = Object.freeze({
  numberOfPreRenderWorkers: 1,
  /** Entity ids in a block share one worker. 256 keeps animation state and SoA runs together. */
  entityBlockSize: 256,
  noLimitFPS: false,
  fixedFps: 0,
  /** When true, skip packing if >1 frame ahead of pixi (Atomics sync). */
  backpressure: true,
  /**
   * Skip entity viewport AABB and screenX/Y. Every active renderVisible
   * sprite (and adobe) is queued; CameraInOutListener / isOnScreen treat
   * them as on camera. Off-screen worlds grow RENDER_QUEUE_SIZE and pixi.
   * Particles, decorations, bullets, lights, and shadow gather still cull.
   * Default false — opt-in when the world is the viewport (bunny mark).
   */
  skipCull: false,
  /**
   * Blend the last two published physics poses while packing the render queue.
   * true lags display by up to one physics frame. Does not guess ahead
   * (no extrapolation). Bunny-style scenes leave this false and use
   * renderer.interpolation instead.
   */
  interpolation: false,
});

/** @param {boolean|null|undefined} value */
export function resolvePreRenderInterpolation(value) {
  if (value === true) return true;
  if (value && typeof value === 'object') return value.mode === 'interpolate';
  return false;
}

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
  noLimitFPS: false,
  fixedFps: 0,
});

// ============================================================================
// DEBUG DEFAULTS
// ============================================================================

export const DEBUG_DEFAULTS = Object.freeze({
  maxDebugDrawEntries: 256,
  /**
   * Worker subtimers + SAB detail fields (Collect/Sort/Vis/Ray/Lights/…).
   * Independent of GameEngine({ debug }) — overlay ≠ profiler.
   * false (default) → only FPS + STEP_MS written; DebugUI shows Step / Load% / Fps.
   * Opt in per scene: debug: { collectDetailedStats: true }.
   */
  collectDetailedStats: false,
  /**
   * Init / worker console.log spam (Scene bootstrap, pool init, atlas bake).
   * Independent of collectDetailedStats. Default off.
   */
  verboseWorkers: false,
  /** Warn when cmd-ring / Ray get non-unit (rotC,rotS) or dir. Off in prod. */
  assertRotCSUnit: false,
  /** DebugUI poll ms. GameEngine constructor override: debugUpdateInterval. */
  updateInterval: 100,
  /** DebugUI accordion section id, or null. Override: debugDefaultOpen. */
  defaultOpen: null,
});
