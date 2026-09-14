// Scene.js - Scene management with workers and entity pools
// Handles workers, SharedArrayBuffers, entity registration, and scene lifecycle
// This was previously GameEngine.js - renamed to better reflect its role

import { GameObject } from './gameObject.js';
import { popFreeIndex } from '../util/atomicFreeList.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { Collider } from '../components/collider.js';
import { bindBox2dHotFields } from '../box2d/box2dHotFields.js';
import { LiquidFun } from './liquidFun.js';
import { bindCommandRing, enqueueExplode } from '../box2d/box2dCommandRing.js';
import {
  bindQueryAabbSab,
  box2dQueryAABBAsync,
} from '../box2d/box2dQueryAabb.js';
import {
  bindRayCastSab,
  box2dCastRayClosestAsync,
} from '../box2d/box2dRayCast.js';
import { bindLiquidFunQuerySab } from '../box2d/liquidFunQuery.js';
import { bindLiquidFunExtractSab } from '../box2d/liquidFunExtract.js';
import { bindMovedBodies, getMovedBodiesViews } from '../box2d/box2dMovedBodies.js';
import { SpriteRenderer } from '../components/spriteRenderer.js';
import { AdobeAnimComponent } from '../components/adobeAnimComponent.js';
import { ParticleComponent } from '../components/particleComponent.js';
import { DecorationComponent } from '../components/decorationComponent.js';
import { BulletComponent } from '../components/bulletComponent.js';
import { DecorationPool } from './decorationPool.js';
import { BulletPool } from './bulletPool.js';
import { ShadowCaster } from '../components/shadowCaster.js';
import { FlashComponent } from '../components/flashComponent.js';
import { LightEmitter } from '../components/lightEmitter.js';
import { LightOccluder } from '../components/lightOccluder.js';
import { CameraInOutListener } from '../components/cameraInOutListener.js';
import { CollisionListener } from '../components/collisionListener.js';
import { JointBreakListener } from '../components/jointBreakListener.js';
import { Grab } from '../components/grab.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { AdobeAnimRegistry } from './adobeAnimRegistry.js';
import { AdobeAnimCompiler } from '../util/adobeAnimCompiler.js';
import {
  setupWorkerCommunication,
  seededRandom,
  loadEntityScripts,
  collectAllComponentsFromClasses,
  initializeComponentViews,
  exposeComponentsGlobally,
  exposeEntityClassesGlobally,
  urlToPath,
} from '../util/utils.js';
import { DebugFlags } from './debug/debugFlags.js';
import { Mouse } from './mouse.js';
import { Gamepad } from './gamepad.js';
import Keyboard from './keyboard.js';
import { Flash } from './flash.js';
import { BigAtlasInspector } from './bigAtlasInspector.js';
import { Camera } from './camera.js';
import {
  buildMemoryUsageSummary,
  buildSceneMemoryUsageReport,
  getSharedBufferSize as getSharedBufferSizeFromBuffers,
} from '../util/sceneBufferMemory.js';
import { createSceneSharedBuffers, teardownSceneSharedState } from '../util/sceneSharedBuffers.js';
import { createSceneWorkers } from '../util/sceneWorkerBootstrap.js';
import { QuerySystem } from './querySystem.js';
import { GrabSystem } from './grabSystem.js';
import {
  SCENE_DEFAULTS,
  PHYSICS_DEFAULTS,
  SPATIAL_DEFAULTS,
  PARTICLE_DEFAULTS,
  DECORATION_DEFAULTS,
  BULLET_DEFAULTS,
  LOGIC_DEFAULTS,
  RENDERER_DEFAULTS,
  PRE_RENDER_DEFAULTS,
  AUDIO_DEFAULTS,
  LIGHTING_DEFAULTS,
  NAVIGATION_DEFAULTS,
  DEBUG_DEFAULTS,
  SUN_DEFAULTS,
  ASSETS_DEFAULTS,
  DEFAULT_LAYERS,
} from '../util/configDefaults.js';
import { Sun } from './sun.js';
import { Layer } from './layer.js';
import { TileMap } from './tileMap.js';
import { computeBufferSize as computeRenderQueueBufferSize } from '../render/renderQueueLayout.js';
import { NavGrid } from './navGrid.js';
import { Grid } from './grid.js';
import { Ray } from './ray.js';
import { DebugDraw } from './debug/debugDraw.js';
import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
} from '../util/workersUtils.js';
import { ParticleEmitter } from './particleEmitter.js';
import { Joint } from './joint.js';
import { SoundManager } from './soundManager.js';
import { Decoration } from './decoration.js';
import {
  assertSceneRendererConfig,
  assertLoadedShadersCompatible,
  collectComputeAssetNames,
  errorShaderFetchFailed,
} from '../render/rendererBackend.js';

class Scene {
  // Worker index constants for FrameRate SharedArrayBuffer
  // NOTE: Spatial workers now occupy indices 0 to N-1 (where N = numberOfSpatialWorkers)
  // Other worker indices are calculated dynamically based on numberOfSpatialWorkers
  static WORKER_INDICES = {
    SPATIAL_START: 0, // First spatial worker index
    // Dynamic indices (calculated at runtime):
    // PHYSICS: numberOfSpatialWorkers
    // RENDERER: numberOfSpatialWorkers + 1
    // PARTICLE: numberOfSpatialWorkers + 2
    // LOGIC_START: numberOfSpatialWorkers + 3
    // PRE_RENDER: numberOfSpatialWorkers + 3 + numberOfLogicWorkers
  };

  // Static declarations - override these in subclasses
  static config = {};
  static assets = {};
  static audios = [];
  static entities = []; // [[EntityClass, poolSize], ...]
  static queries = []; // [[ComponentClass, ...], ...] custom active queries to precompute

  constructor(game) {
    this.game = game; // Reference to GameEngine orchestrator
    this.loadedTextures = null;

    // Merge static config with any runtime config
    this.config = { ...this.constructor.config };
    this.imageUrls = { ...this.constructor.assets };
    this.audioUrls = this.constructor.audios || [];
    this.loadedAudioNames = [];

    this.state = {
      pause: false,
    };

    // Apply all default config values
    this._applyConfigDefaults();

    this.seed = this.config.seed;
    this.rng = seededRandom(this.seed, 'main');
    // Make seeded random available globally for entity code
    globalThis.rng = this.rng;

    // State
    this.keyboard = {};
    // Mouse is accessed via Mouse static class (writes directly to SharedArrayBuffer)
    this.camera = {
      zoom: 1,
      x: 0,
      y: 0,
    };

    /** @type {object|null} Last box2dReady payload (HEAP sab + channelOffsets) */
    this.box2dHotFields = null;

    // Workers
    this.workers = {
      spatialWorkers: [], // Multiple spatial workers for parallel neighbor detection
      logicWorkers: [],
      physics: null,
      renderer: null,
      particle: null,
      preRender: null, // Pre-render worker for visibility, animation, render queues
    };

    // Query system for component-based entity filtering
    this.querySystem = new QuerySystem();

    this.pendingPhysicsUpdates = [];

    const scene = this;
    this.physics = new Proxy(this.config.physics, {
      get(target, prop) {
        return target[prop];
      },
      set(target, prop, value) {
        target[prop] = value;
        scene.updatePhysicsConfig({ [prop]: value });
        return true;
      },
    });

    this._stepSeq = 0;
    this._stepWaiters = new Map();

    // Worker synchronization
    this.workerReadyStates = {
      physics: false,
      renderer: false,
    };
    // Store worker counts for use throughout constructor
    this.numberOfSpatialWorkers = this.config.spatial.numberOfSpatialWorkers;
    for (let i = 0; i < this.numberOfSpatialWorkers; i++) {
      this.workerReadyStates[`spatial${i}`] = false;
    }
    const numberOfLogicWorkers = this.config.logic.numberOfLogicWorkers;
    for (let i = 0; i < numberOfLogicWorkers; i++) {
      this.workerReadyStates[`logic${i}`] = false;
    }
    // Particle worker always runs - it handles particles, decals, navigation, derived properties
    this.workerReadyStates.particle = false;

    // Pre-render worker always runs - handles visibility, animation, render queues
    this.workerReadyStates.preRender = false;

    this.totalWorkers =
      4 +
      this.numberOfSpatialWorkers +
      numberOfLogicWorkers;

    // Shared buffers
    this.buffers = {
      neighborData: null,
      activeEntitiesData: null, // Active entity list for spatial worker load balancing
      inputData: null,
      cameraData: null,
      debugData: null,
      debugDrawData: null, // Debug draw ring buffer (DebugDraw API)
      frameRateData: null, // Real-time FPS tracking per worker
      componentData: {
        Transform: null,
        RigidBody: null,
        Collider: null,
        SpriteRenderer: null,
      },
      // Spatial grid buffers (for raycasting)
      gridEntities: null,
      gridCounts: null,
      // Worker stat buffers (strided SharedArrayBuffers for detailed metrics)
      rendererStats: null,
      particleStats: null,
      physicsStats: null,
      spatialStats: null,
      logicStats: null,
      // Query system SABs (for component-based entity queries)
      queryEntityMetadata: null,
      queryCache: null,
      queryResults: null,
      queryVersion: null,
      bodyDirtyFlags: null,
      bodyDirtyWords: null,
      bodyGeneration: null,
    };

    // Component type ID tracking (similar to entityType)
    this.nextComponentId = 0;

    // Always-dense cores + zero-size markers (listeners + Grab).
    // Optional SoA (Adobe/Light/Shadow/Flash/Occluder) enter componentPools
    // only via entity registration or ensureOptionalComponentPools().
    this.componentPools = {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
      CameraInOutListener: { ComponentClass: CameraInOutListener },
      CollisionListener: { ComponentClass: CollisionListener },
      JointBreakListener: { ComponentClass: JointBreakListener },
      Grab: { ComponentClass: Grab },
    };

    // Assign componentId IDs to always-seeded components
    Transform.componentId = this.nextComponentId++;
    RigidBody.componentId = this.nextComponentId++;
    Collider.componentId = this.nextComponentId++;
    SpriteRenderer.componentId = this.nextComponentId++;
    CameraInOutListener.componentId = this.nextComponentId++;
    CollisionListener.componentId = this.nextComponentId++;
    JointBreakListener.componentId = this.nextComponentId++;
    Grab.componentId = this.nextComponentId++;
    // Clear stale IDs/views from a previous scene (realloc only if pooled again)
    AdobeAnimComponent.componentId = null;
    AdobeAnimComponent.clearArrays();
    LightEmitter.componentId = null;
    LightEmitter.clearArrays();
    ShadowCaster.componentId = null;
    ShadowCaster.clearArrays();
    FlashComponent.componentId = null;
    FlashComponent.clearArrays();
    LightOccluder.componentId = null;
    LightOccluder.clearArrays();

    // Typed array views
    this.views = {
      input: null,
      camera: null,
      frameRate: null,
    };

    // Main thread FPS tracking
    this.mainFPS = 0;
    this.mainStepMs = 0; // Wall ms for updateInternal this frame (same role as worker STEP_MS)
    this.mainFPSFrameCount = 60;
    this.mainFrameTimes = new Array(this.mainFPSFrameCount).fill(16.67);
    this.mainFrameTimeIndex = 0;
    this.mainFrameTimesSum = 16.67 * this.mainFPSFrameCount;
    this.mainFPSReportInterval = 30;
    this.mainFrameNumber = 0;
    this.audioMetrics = {
      activeSlots: 0,
      maxSlots: 0,
      loadedSounds: 0,
      dropped: 0,
      mixGain: 0,
      masterVolume: 0,
      muted: false,
      state: 'closed',
      sampleRate: 0,
      baseLatency: 0,
      outputLatency: 0,
      processMs: 0,
    };

    // Worker stats (populated by worker messages, read by DebugUI)
    this.workerStats = {
      spatial: [], // Array for multiple spatial workers
      logic: [], // Array for multiple logic workers
      physics: { fps: 0, active: 0 },
      renderer: {
        fps: 0,
        drawCalls: 0,
        visibleEntities: 0,
        visibleParticles: 0,
      },
      particle: { fps: 0, active: 0, total: 0 },
    };
    // Initialize spatial worker stats
    for (let i = 0; i < this.numberOfSpatialWorkers; i++) {
      this.workerStats.spatial.push({ fps: 0, active: 0 });
    }
    // Initialize logic worker stats
    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      this.workerStats.logic.push({ fps: 0, active: 0 });
    }

    // Canvas - now provided by GameEngine
    this.canvas = game.canvas;

    // Entity registration
    this.registeredClasses = [];
    this.totalEntityCount = 0;
    this.grabByType = [];
    this._anyGrabType = false;
    this._anyCollisionListener = false;
    this._anyDeriveSpeed = false;
    /** @type {Map<number, GameObject>} */
    this._entityViewCache = new Map();

    // Key mapping for input buffer
    this.keyMap = {};
    let keyIndex = 0;

    // Letters a-z
    for (let i = 0; i < 26; i++) {
      this.keyMap[String.fromCharCode(97 + i)] = keyIndex++;
    }

    // Numbers 0-9
    for (let i = 0; i < 10; i++) {
      this.keyMap[String.fromCharCode(48 + i)] = keyIndex++;
    }

    // Special keys
    this.keyMap[' '] = keyIndex++;
    this.keyMap['enter'] = keyIndex++;
    this.keyMap['escape'] = keyIndex++;
    this.keyMap['tab'] = keyIndex++;
    this.keyMap['backspace'] = keyIndex++;
    this.keyMap['delete'] = keyIndex++;
    this.keyMap['shift'] = keyIndex++;
    this.keyMap['control'] = keyIndex++;
    this.keyMap['alt'] = keyIndex++;
    this.keyMap['meta'] = keyIndex++;

    // Arrow keys
    this.keyMap['arrowup'] = keyIndex++;
    this.keyMap['arrowdown'] = keyIndex++;
    this.keyMap['arrowleft'] = keyIndex++;
    this.keyMap['arrowright'] = keyIndex++;

    // Function keys F1-F12
    for (let i = 1; i <= 12; i++) {
      this.keyMap[`f${i}`] = keyIndex++;
    }

    // Punctuation
    const punctuation = ['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`'];
    punctuation.forEach((char) => {
      this.keyMap[char] = keyIndex++;
    });

    this.inputBufferSize = keyIndex;

    // Frame timing
    this.lastFrameTime = performance.now();
    this.updateRate = 1000 / 60;
    this.animationFrameId = null; // Store RAF ID so we can cancel it

    // Initialization promise
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    // Auto-register Flash if lighting is enabled
    const maxFlashes = this.config.lighting.maxFlashes;
    if (maxFlashes > 0) {
      this.registerEntityClass(Flash, maxFlashes);
      Flash.initialize(maxFlashes);
    }

    // Register entities from static declaration
    for (const [EntityClass, poolSize] of this.constructor.entities) {
      this.registerEntityClass(EntityClass, poolSize);
    }

    // Lighting / flash flags may need optional SoA even with no entity listing them yet
    this.ensureOptionalComponentPools();
  }

  /**
   * Add a component class to componentPools (allocates SAB later) and assign componentId if needed.
   * @param {Function} ComponentClass
   */
  _ensureComponentPool(ComponentClass) {
    if (!ComponentClass) return;
    const componentName = ComponentClass.name;
    if (!this.componentPools[componentName]) {
      this.componentPools[componentName] = { ComponentClass };
    }
    if (ComponentClass.componentId == null || typeof ComponentClass.componentId !== 'number') {
      ComponentClass.componentId = this.nextComponentId++;
    }
  }

  /**
   * Ensure optional SoA components are pooled when lighting/flash config requires them.
   * Entity registration already adds comps listed on entity classes.
   */
  ensureOptionalComponentPools() {
    const lighting = this.config?.lighting || {};
    const maxFlashes = lighting.maxFlashes | 0;

    if (lighting.enabled || maxFlashes > 0) {
      this._ensureComponentPool(LightEmitter);
    }
    if (maxFlashes > 0) {
      this._ensureComponentPool(FlashComponent);
    }
    if (lighting.shadowsEnabled) {
      this._ensureComponentPool(ShadowCaster);
    }
    if (lighting.raycasted) {
      this._ensureComponentPool(LightOccluder);
      // Raycasted lighting needs LightEmitter for light sources
      this._ensureComponentPool(LightEmitter);
    }
  }

  /**
   * Register an entity class
   */
  registerEntityClass(EntityClass, count, scriptPath = null) {
    // Auto-detect script path
    if (!scriptPath && EntityClass.scriptUrl) {
      scriptPath = urlToPath(EntityClass.scriptUrl);
    }

    // Auto-detect and register parent classes
    this._autoRegisterParentClasses(EntityClass);

    // Collect components
    const components = GameObject._collectComponents(EntityClass);

    // Check if already registered
    const existing = this.registeredClasses.find(
      (r) => r.class === EntityClass || r.class.name === EntityClass.name
    );
    if (existing) {
      console.warn(`⚠️ ${EntityClass.name} is already registered. Skipping duplicate.`);
      return;
    }

    const startIndex = this.totalEntityCount;
    const entityTypeId = this.registeredClasses.length;
    EntityClass.entityType = entityTypeId;
    if (EntityClass.deriveSpeed === true) this._anyDeriveSpeed = true;

    // Register custom components and assign componentId IDs
    for (const ComponentClass of components) {
      this._ensureComponentPool(ComponentClass);
      if (ComponentClass === Grab) {
        this.grabByType[entityTypeId] = 1;
        this._anyGrabType = true;
      }
      if (ComponentClass === CollisionListener) {
        this._anyCollisionListener = true;
      }
    }

    this.registeredClasses.push({
      class: EntityClass,
      count: count,
      startIndex: startIndex,
      entityType: entityTypeId,
      scriptPath: scriptPath,
      components: components,
    });

    this.totalEntityCount += count;

    // Auto-initialize static properties
    if (!EntityClass.hasOwnProperty('instances')) {
      EntityClass.instances = [];
    }

    EntityClass.startIndex = startIndex;
    EntityClass.poolSize = count;
    EntityClass.endIndex = startIndex + count;

    // Pre-computed typed array of all entity indices for this class
    // Enables zero-allocation iteration: Prey.entityIndices.forEach(...)
    EntityClass.entityIndices = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      EntityClass.entityIndices[i] = startIndex + i;
    }

    GameObject._assignComponentClassMap(EntityClass);
  }

  /**
   * Main-thread wrapper over an existing entity slot (SharedArrayBuffers).
   * Does not spawn/despawn. Logic (`tick`, collisions, …) still runs on workers only.
   *
   * @param {number} index - Global entity index
   * @param {Object} [options] - If cache is true, reuse the same instance until releaseEntityView(index)
   * @param {boolean} [options.cache]
   * @returns {GameObject}
   */
  getEntityView(index, options = {}) {
    const cache = options.cache === true;
    if (index < 0 || index >= this.totalEntityCount) {
      throw new RangeError(
        `getEntityView: index ${index} out of range (0..${this.totalEntityCount - 1})`
      );
    }
    if (!Transform.entityType || Transform.entityType.length <= index) {
      throw new Error('getEntityView: Transform not initialized (call after Scene buffers are ready)');
    }
    if (cache && this._entityViewCache.has(index)) {
      return this._entityViewCache.get(index);
    }
    const typeId = Transform.entityType[index];
    const reg = this.registeredClasses[typeId];
    if (!reg || !reg.class) {
      throw new Error(`getEntityView: unknown entityType ${typeId} at index ${index}`);
    }
    const EntityClass = reg.class;
    const instance = new EntityClass(index, this.config, null, { view: true });
    if (cache) {
      this._entityViewCache.set(index, instance);
    }
    return instance;
  }

  /**
   * Drop a cached main-thread view only (does not despawn the entity).
   * @param {number} index
   */
  releaseEntityView(index) {
    this._entityViewCache.delete(index);
  }

  /**
   * Apply default values to all config sections.
   * After this method, all config values are guaranteed to exist with sensible defaults.
   * Access config via this.config.section.property (e.g., this.config.lighting.maxFlashes)
   */
  _applyConfigDefaults() {
    const userLightingConfig = this.config.lighting || {};

    // Top-level defaults from centralized config
    this.config = {
      ...SCENE_DEFAULTS,
      ...this.config,
    };

    // Physics defaults from centralized config
    this.config.physics = {
      ...PHYSICS_DEFAULTS,
      gravity: this.config.gravity, // Use top-level gravity as default
      ...(this.config.physics || {}),
    };
    // Ensure gravity is synced
    this.config.physics.gravity = this.config.physics.gravity || this.config.gravity;
    this.config.gravity = this.config.physics.gravity;

    // Spatial defaults from centralized config
    this.config.spatial = {
      ...SPATIAL_DEFAULTS,
      ...(this.config.spatial || {}),
    };

    // Particle defaults from centralized config
    this.config.particle = {
      ...PARTICLE_DEFAULTS,
      ...(this.config.particle || {}),
    };
    // Compute decalsTilePixelSize
    this.config.particle.decalsTilePixelSize = Math.floor(
      this.config.particle.decalsTileSize * this.config.particle.decalsResolution
    );

    // Decoration defaults from centralized config
    this.config.decoration = {
      ...DECORATION_DEFAULTS,
      ...(this.config.decoration || {}),
    };
    const ma = this.config.decoration.maxAttachedDecorationsPerEntity | 0;
    this.config.decoration.maxAttachedDecorationsPerEntity = ma < 1 ? 1 : ma > 255 ? 255 : ma;

    // Bullet defaults from centralized config
    this.config.bullet = {
      ...BULLET_DEFAULTS,
      ...(this.config.bullet || {}),
    };

    // Audio defaults from centralized config
    this.config.audio = {
      ...AUDIO_DEFAULTS,
      ...(this.config.audio || {}),
    };

    // Assets defaults (BigAtlas packing)
    this.config.assets = {
      ...ASSETS_DEFAULTS,
      ...(this.config.assets || {}),
    };

    // Logic defaults from centralized config
    this.config.logic = {
      ...LOGIC_DEFAULTS,
      ...(this.config.logic || {}),
    };

    // Renderer defaults from centralized config
    this.config.renderer = {
      ...RENDERER_DEFAULTS,
      ...(this.config.renderer || {}),
    };
    this.config.renderer.backend = assertSceneRendererConfig(this.config);

    // Pre-render defaults from centralized config
    this.config.preRender = {
      ...PRE_RENDER_DEFAULTS,
      ...(this.config.preRender || {}),
    };

    // Lighting defaults from centralized config (sun / dayCycle nested, not shallow-replaced)
    const userSun = userLightingConfig.sun || {};
    this.config.lighting = {
      ...LIGHTING_DEFAULTS,
      ...(this.config.lighting || {}),
    };
    this.config.lighting.sun = {
      ...SUN_DEFAULTS,
      ...userSun,
      dayCycle: {
        ...SUN_DEFAULTS.dayCycle,
        ...(userSun.dayCycle || {}),
      },
    };
    // Compute maxShadowSprites unless the scene explicitly provides a global cap.
    if (userLightingConfig.maxShadowSprites == null) {
      this.config.lighting.maxShadowSprites =
        this.config.lighting.maxShadowCastingLights * this.config.lighting.maxShadowsPerLight;
    }
    // Compute shadowsEnabled (requires both enabled and shadowsEnabled)
    this.config.lighting.shadowsEnabled =
      this.config.lighting.enabled && this.config.lighting.shadowsEnabled !== false;

    // Navigation defaults from centralized config
    this.config.navigation = {
      ...NAVIGATION_DEFAULTS,
      ...(this.config.navigation || {}),
    };

    // Debug defaults from centralized config.
    // collectDetailedStats is opt-in on the scene; GameEngine({ debug }) does not force it.
    this.config.debug = {
      ...DEBUG_DEFAULTS,
      ...(this.config.debug || {}),
    };

    // Layers defaults (custom layers are user-defined, empty by default)
    if (!this.config.layers) {
      this.config.layers = {};
    }
  }

  // ========================================
  // CONFIG CONVENIENCE GETTERS
  // These provide quick access to commonly used config values
  // ========================================

  /** @returns {number} Number of logic workers */
  get numberOfLogicWorkers() {
    return this.config.logic.numberOfLogicWorkers;
  }

  /**
   * Entity indices that moved in the last physics step (live SAB subarray).
   * @returns {Uint32Array}
   */
  get bodiesThatMoved() {
    const v = getMovedBodiesViews();
    if (!v || !v.movedList) return new Uint32Array(0);
    const count = v.count | 0;
    return count > 0 ? v.movedList.subarray(0, count) : new Uint32Array(0);
  }

  /**
   * Full moved-body views for the last physics step.
   * @returns {{ list: Uint32Array, count: number, bits: Uint8Array|null, generation: number, fellAsleep: Uint8Array|null }}
   */
  getBodiesThatMoved() {
    const v = getMovedBodiesViews();
    if (!v || !v.movedList) {
      return {
        list: new Uint32Array(0),
        count: 0,
        bits: null,
        generation: 0,
        fellAsleep: null,
      };
    }
    const count = v.count | 0;
    return {
      list: count > 0 ? v.movedList.subarray(0, count) : new Uint32Array(0),
      count,
      bits: v.movedBits,
      generation: v.generation | 0,
      fellAsleep: v.fellAsleep,
    };
  }

  /** @returns {boolean} Whether particles are enabled */
  get hasParticles() {
    return this.config.particle.maxParticles > 0;
  }

  /** @returns {number} Maximum number of particles */
  get maxParticles() {
    return this.config.particle.maxParticles;
  }

  /** @returns {boolean} Whether decorations are enabled */
  get hasDecorations() {
    return this.config.decoration.maxDecorations > 0;
  }

  /** @returns {number} Maximum number of decorations */
  get maxDecorations() {
    return this.config.decoration.maxDecorations;
  }

  /** @returns {boolean} Whether bullets are enabled */
  get hasBullets() {
    return this.config.bullet.maxBullets > 0;
  }

  /** @returns {number} Maximum number of bullets */
  get maxBullets() {
    return this.config.bullet.maxBullets;
  }

  /**
   * @returns {boolean} Whether the particle worker is needed
   * Particle worker handles more than particles: lighting, shadows, flashes, entity visibility
   */
  get needsParticleWorker() {
    return true; // Always run particle worker - it handles lighting, shadows, visibility, etc.
  }

  /** @returns {boolean} Whether shadows are enabled */
  get shadowsEnabled() {
    return this.config.lighting.shadowsEnabled;
  }

  /** @returns {number} Maximum shadow-casting lights */
  get maxShadowCastingLights() {
    return this.config.lighting.maxShadowCastingLights;
  }

  /** @returns {number} Maximum shadows per light */
  get maxShadowsPerLight() {
    return this.config.lighting.maxShadowsPerLight;
  }

  /** @returns {number} Maximum shadows per entity */
  get maxShadowsPerEntity() {
    return this.config.lighting.maxShadowsPerEntity;
  }

  /** @returns {number} Total maximum shadow sprites */
  get maxShadowSprites() {
    return this.config.lighting.maxShadowSprites;
  }

  /** @returns {boolean} Whether decals are enabled */
  get decalsEnabled() {
    return this.config.particle.decals;
  }

  /** @returns {number} Decal tile size in world units */
  get decalsTileSize() {
    return this.config.particle.decalsTileSize;
  }

  /** @returns {number} Decal resolution multiplier */
  get decalsResolution() {
    return this.config.particle.decalsResolution;
  }

  /** @returns {number} Decal tile pixel size */
  get decalsTilePixelSize() {
    return this.config.particle.decalsTilePixelSize;
  }

  /** @returns {number} Maximum flash effects */
  get maxFlashes() {
    return this.config.lighting.maxFlashes;
  }

  /** @returns {boolean} Whether navigation/pathfinding is enabled */
  get navigationEnabled() {
    return this.config.navigation.enabled;
  }

  _autoRegisterParentClasses(EntityClass) {
    const parentChain = [];
    let current = EntityClass;

    while (current && current !== GameObject) {
      parentChain.unshift(current);
      current = Object.getPrototypeOf(current);
    }

    for (const ParentClass of parentChain) {
      const alreadyRegistered = this.registeredClasses.some(
        (r) => r.class === ParentClass || r.class.name === ParentClass.name
      );

      if (!alreadyRegistered && ParentClass !== EntityClass) {
        const startIndex = this.totalEntityCount;
        const parentComponents = GameObject._collectComponents(ParentClass);

        for (const ComponentClass of parentComponents) {
          this._ensureComponentPool(ComponentClass);
        }

        const entityTypeId = this.registeredClasses.length;
        ParentClass.entityType = entityTypeId;

        // Auto-detect script path from parent class (for worker script loading)
        const parentScriptPath = ParentClass.scriptUrl ? urlToPath(ParentClass.scriptUrl) : null;

        this.registeredClasses.push({
          class: ParentClass,
          count: 0,
          startIndex: startIndex,
          entityType: entityTypeId,
          scriptPath: parentScriptPath,
          components: parentComponents,
        });

        if (!ParentClass.hasOwnProperty('sharedBuffer')) {
          ParentClass.sharedBuffer = null;
        }
        if (!ParentClass.hasOwnProperty('poolSize')) {
          ParentClass.poolSize = 0;
        }
        if (!ParentClass.hasOwnProperty('instances')) {
          ParentClass.instances = [];
        }

        GameObject._assignComponentClassMap(ParentClass);
      }
    }
  }

  // Initialize everything
  async init() {
    console.log(`🎬 Scene ${this.constructor.name}: Initializing...`);

    // Check SharedArrayBuffer support
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('SharedArrayBuffer not available! Check CORS headers.');
    }

    // Initialize AudioWorklet mixer and autoplay gate
    const audioConfig = this.config.audio || {};
    await SoundManager.initializeAudioWorklet(
      audioConfig.maxSlots,
      audioConfig.mixGain,
      audioConfig.masterVolume
    );
    SoundManager.initializeAutoplayGate();

    // Load entity scripts dynamically in main thread (like workers do)

    await this.loadEntityScriptsInMainThread();

    // Create shared buffers

    this.createSharedBuffers();

    // Create workers

    await this.createWorkers();

    // Wait for all workers to be ready (workers stay paused until we send 'start')
    await this.readyPromise;

    // Expose scene and component references globally for console access
    this.exposeGlobalReferences();

    // LIFECYCLE PHASE 1: preload()
    // Scene infrastructure setup (tilemap background, camera, nav grid).
    // Messages sent here are processed by workers while they are still paused,
    // so the renderer can build the tilemap and warm up the GPU before the first frame.
    await this.preload();

    // LIFECYCLE PHASE 2: create()
    // Static / always-on world setup (runs for new game AND save load).
    await this.create();

    // LIFECYCLE PHASE 2b: new game vs save restore
    // Restore awaits logic0 restoreSaveComplete so entities are in the scene
    // before play starts (workers stay paused until start below).
    if (this._restorePayload) {
      const payload = this._restorePayload;
      const { applySavePayloadToScene } = await import('./save/saveGame.js');
      await applySavePayloadToScene(this, payload);
      await this.onLoadGame(payload);
    } else {
      await this.createNewGame();
    }

    // LIFECYCLE PHASE 3: Start everything.
    // Main thread loop first (for input handling), then worker game loops.
    // Workers see a fully populated scene with infrastructure ready on frame 1.
    // manualStep: tests drive time via stepFrame(); loops stay paused.
    if (!this.config.manualStep) {
      this.startMainLoop();
      this.startAllWorkers();
    }
  }

  /**
   * Load entity scripts dynamically in main thread
   * Uses the unified loadEntityScripts function (auto-detects window context)
   *
   * In bundle mode, classes are typically already imported by the scene file,
   * so we expose them directly without re-loading the scripts.
   */
  async loadEntityScriptsInMainThread() {
    const scriptsToLoad = [];

    // Collect script paths from registered entity classes
    // Classes that are already in registeredClasses don't need to be loaded again
    for (const classInfo of this.registeredClasses) {
      const className = classInfo.class.name;

      // If we already have the class reference, expose it globally without loading
      if (classInfo.class && typeof window !== 'undefined') {
        window[className] = classInfo.class;
        continue;
      }

      // Only load scripts for classes we don't have yet
      if (classInfo.scriptPath) {
        scriptsToLoad.push(classInfo.scriptPath);
      }
    }

    if (scriptsToLoad.length > 0) {
      await loadEntityScripts(scriptsToLoad);
    }
  }

  /**
   * Expose all components and entity classes globally for console access
   * Makes it possible to access SharedArrayBuffer views and iterate entities
   */
  exposeGlobalReferences() {
    // Expose scene and game
    window.scene = this;
    window.game = this.game;

    // Collect all components from all registered entity classes
    const componentMap = collectAllComponentsFromClasses(this.registeredClasses, window);

    // Initialize component views from SharedArrayBuffers (ensures all custom components are connected)
    initializeComponentViews(
      componentMap,
      this.buffers.componentData,
      this.componentPools,
      this.totalEntityCount
    );

    // Pose/vel live on Box2D HEAP only — bind after SoA init (box2dReady precedes readyPromise).
    if (this.box2dHotFields?.sab) {
      bindBox2dHotFields(this.box2dHotFields);
    }

    // Expose all components globally (both core and custom)
    exposeComponentsGlobally(componentMap, window);

    // Expose all registered entity classes
    exposeEntityClassesGlobally(this.registeredClasses, window);

    // Expose core classes that might not be in componentMap (system classes)
    window.GameObject = GameObject;
    window.Camera = Camera;
    window.Sun = Sun;
    window.TileMap = TileMap;
    window.SpriteSheetRegistry = SpriteSheetRegistry;
    window.AdobeAnimRegistry = AdobeAnimRegistry;
    window.Mouse = Mouse;
    window.Flash = Flash;
    window.NavGrid = NavGrid;
    window.Grid = Grid;
    window.DecorationPool = DecorationPool;
    window.BulletPool = BulletPool;
    window.BulletComponent = BulletComponent;
    window.SoundManager = SoundManager;
    window.Layer = Layer;
    window.Decoration = Decoration;
    window.Joint = Joint;
    window.LiquidFun = LiquidFun;
    GameObject.scene = this;
  }

  // User lifecycle hooks - override these in subclasses

  /**
   * Called after all workers are initialized but BEFORE the game loop starts.
   * Use this for scene infrastructure that workers need on their first frame:
   * - setTilemapBackground()
   * - Camera.centerOn()
   * - NavGrid setup
   *
   * Messages sent here are processed by workers while they are still paused,
   * guaranteeing everything is ready before the first frame renders.
   */
  preload() {
    // Override this for scene infrastructure setup
  }

  /**
   * Viewport-cover background (fills the canvas, extra size at zoom=1, optional pan/zoom parallax).
   * @param {string|{texture?:string,textureId?:string,parallax?:number|{x?:number,y?:number},margin?:number,zoomParallax?:number}} textureOrOpts
   */
  setBackground(textureOrOpts) {
    Layer.BACKGROUND.setCoverBackground(textureOrOpts);
  }

  /**
   * Called after preload(), right before workers start their game loops.
   * Runs for **both** new games and save loads.
   * Use for static world setup that is not restored from a save
   * (tile props, lights, decorations, non-serializable entities).
   */
  create() {
    // Override this to spawn static / always-present world content
  }

  /**
   * Called after create() only when starting a **new game** (no restore payload).
   * Spawn serializable / dynamic entities here (soldiers, civilians, player, …).
   * Skipped entirely when loading a save — those entities come from the save instead.
   */
  createNewGame() {
    // Override for new-game-only spawns
  }

  /**
   * Called after create() and after the engine has applied a save payload
   * (serializable entities restored + active lists flushed, camera/sun applied).
   * Runs only after logic0 restoreSaveComplete — before play starts.
   * Override for load-only hooks (UI, quests, follow-up spawns).
   * @param {object} payload - Decoded save payload
   */
  onLoadGame(payload) {
    // Override for post-load scene logic
  }

  /**
   * Called once per frame on the main thread.
   *
   * Override this method in subclasses to implement per-frame scene logic.
   * Runs after all core engine updates and before rendering.
   *
   * @param {number} dtRatio - The delta time ratio normalized to 60fps (1.0 = 16.67ms frame).
   * @param {number} deltaTime - The time elapsed since the last frame (ms).
   * @param {number} accumulatedTime - The total time elapsed since the game started (ms).
   * @param {number} frameNumber - The current frame number
   */
  update(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    // Override this for per-frame scene logic
  }

  onMessageFromGameObject(data, entityIndex, className, workerName, workerIndex) {
    // Override this in scenes that want to react to worker-side entity messages.
  }

  createSharedBuffers() {
    createSceneSharedBuffers(this);
  }

  preInitializeEntityTypeArrays() {
    for (const registration of this.registeredClasses) {
      const { class: EntityClass, startIndex, count } = registration;
      if (count <= 0) continue;
      // Entity pools are registered as contiguous ranges, so one native fill
      // replaces the old entity-by-registration scan.
      Transform.entityType.fill(EntityClass.entityType, startIndex, startIndex + count);
    }
  }

  async prepareAdobeAnimateAssets(adobeConfigs = {}) {
    const compiledAssets = {};
    const spritesheetConfigs = {};

    await Promise.all(
      Object.entries(adobeConfigs).map(async ([assetName, config]) => {
        try {
          const [atlasResponse, animationResponse, image] = await Promise.all([
            fetch(config.atlas),
            fetch(config.animation),
            SpriteSheetRegistry._loadImage(config.png),
          ]);

          if (!atlasResponse.ok) {
            throw new Error(`Failed to load Adobe atlas JSON: ${config.atlas}`);
          }
          if (!animationResponse.ok) {
            throw new Error(`Failed to load Adobe animation JSON: ${config.animation}`);
          }

          const [atlasData, animationData] = await Promise.all([
            atlasResponse.json(),
            animationResponse.json(),
          ]);

          spritesheetConfigs[assetName] = {
            jsonData: AdobeAnimCompiler.buildAtlasSpritesheetJson(atlasData),
            img: image,
          };
          compiledAssets[assetName] = AdobeAnimCompiler.compile(
            assetName,
            animationData,
            atlasData
          );
        } catch (error) {
          console.error(`❌ Failed to prepare Adobe Animate asset "${assetName}":`, error);
        }
      })
    );

    return { compiledAssets, spritesheetConfigs };
  }

  finalizeAdobeAnimateAssets(compiledAssets = {}) {
    AdobeAnimRegistry.clearForSceneUnload();
    this.loadedAdobeAnimateAssets = {};

    for (const [assetName, compiledAsset] of Object.entries(compiledAssets)) {
      const finalized = AdobeAnimCompiler.finalizeTextureIds(
        compiledAsset,
        assetName,
        SpriteSheetRegistry
      );
      const assetId = AdobeAnimRegistry.register(assetName, finalized);
      this.loadedAdobeAnimateAssets[assetName] = {
        id: assetId,
        clipNames: finalized.clipNames,
      };
    }
  }

  /**
   * Install a packed or prebaked bigAtlas onto the scene + registry.
   * @param {{ json: object, imageBitmap: ImageBitmap, canvas: HTMLCanvasElement }} atlas
   * @param {object} [compiledAdobeAssets]
   */
  _installBigAtlas(atlas, compiledAdobeAssets = {}) {
    const { json, imageBitmap, canvas } = atlas;
    const proxySheets = json?.meta?.proxySheets || {};
    const individualTextures = json?.meta?.individualTextures || [];

    this.loadedSpritesheets['bigAtlas'] = {
      json,
      imageBitmap,
    };

    SpriteSheetRegistry.register('bigAtlas', json);

    for (const [sheetName, proxyData] of Object.entries(proxySheets)) {
      SpriteSheetRegistry.registerProxy(sheetName, proxyData);
    }

    for (const textureName of individualTextures) {
      SpriteSheetRegistry.registerSpritesheetId(textureName);
    }

    this.finalizeAdobeAnimateAssets(compiledAdobeAssets);

    this.bigAtlasProxySheets = proxySheets;
    this.bigAtlasCanvas = canvas;
    this.bigAtlasJson = json;

    if (this.config.particle.decals && canvas) {
      this.decalTextureData = this.extractDecalTextures(canvas, json);
    }

    if (typeof window !== 'undefined') {
      window.downloadBigAtlas = () => {
        const link = document.createElement('a');
        const size = json.meta?.size || {};
        link.download = `bigAtlas_${size.w || 0}x${size.h || 0}.png`;
        link.href = this.bigAtlasCanvas.toDataURL();
        link.click();
      };

      window.inspectBigAtlas = () => {
        BigAtlasInspector.show(this.bigAtlasCanvas, this.bigAtlasJson);
      };
    }
  }

  /** @returns {HTMLCanvasElement} */
  _canvasFromImageBitmap(imageBitmap) {
    const canvas = document.createElement('canvas');
    canvas.width = imageBitmap.width;
    canvas.height = imageBitmap.height;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(imageBitmap, 0, 0);
    return canvas;
  }

  async _loadBakedBigAtlas(bigAtlasAsset) {
    const [jsonResponse, pngResponse] = await Promise.all([
      fetch(bigAtlasAsset.json),
      fetch(bigAtlasAsset.png),
    ]);
    if (!jsonResponse.ok) {
      throw new Error(`Failed to load baked bigAtlas JSON: ${bigAtlasAsset.json}`);
    }
    if (!pngResponse.ok) {
      throw new Error(`Failed to load baked bigAtlas PNG: ${bigAtlasAsset.png}`);
    }
    const json = await jsonResponse.json();
    const imageBitmap = await createImageBitmap(await pngResponse.blob());
    const canvas = this._canvasFromImageBitmap(imageBitmap);
    return { json, imageBitmap, canvas };
  }

  async _packBigAtlasOnMainThread(assetsToLoad, options) {
    const packed = await SpriteSheetRegistry.createBigAtlas(assetsToLoad, options);
    const imageBitmap = await createImageBitmap(packed.canvas);
    return { json: packed.json, imageBitmap, canvas: packed.canvas };
  }

  async _loadTilemapsParallel(tilemaps) {
    if (!tilemaps) return;
    const entries = Object.entries(tilemaps);
    await Promise.all(
      entries.map(async ([tilemapId, tilemapConfig]) => {
        try {
          const jsonResponse = await fetch(tilemapConfig.json);
          if (!jsonResponse.ok) {
            throw new Error(`Failed to load tilemap JSON: ${tilemapConfig.json}`);
          }
          const tilemapData = await jsonResponse.json();

          const tilesetResponse = await fetch(tilemapConfig.png);
          if (!tilesetResponse.ok) {
            throw new Error(`Failed to load tileset image: ${tilemapConfig.png}`);
          }
          const tilesetBitmap = await createImageBitmap(await tilesetResponse.blob());

          this.loadedTilemaps[tilemapId] = {
            data: tilemapData,
            tilesetBitmap,
          };
        } catch (error) {
          console.error(`❌ Failed to load tilemap "${tilemapId}":`, error);
        }
      })
    );

    if (Object.keys(this.loadedTilemaps).length > 0) {
      TileMap.initializeFromLoaded(this.loadedTilemaps);
    }
  }

  async _loadShaderSources(imageUrls) {
    this._loadedShaderSources = {};
    // Tag-at-load: names used as a compute source anywhere in config.layers are
    // compute-only WGSL (no mainFrag) — LayersPanel excludes them from the look
    // shader dropdown so picking one there can't throw a compile error.
    this._computeShaderNames = new Set();
    for (const layerConfig of Object.values(this.config.layers || {})) {
      for (const name of collectComputeAssetNames(layerConfig.shader)) {
        this._computeShaderNames.add(name);
      }
    }
    const shaderAssets = imageUrls?.shaders || {};
    const shaderAssetPromises = [];
    for (const [shaderName, shaderPath] of Object.entries(shaderAssets)) {
      shaderAssetPromises.push(
        fetch(shaderPath)
          .then((res) => {
            if (!res.ok) throw errorShaderFetchFailed(shaderName, shaderPath, res.status);
            return res.text();
          })
          .then((source) => {
            this._loadedShaderSources[shaderName] = source;
          })
      );
    }
    if (shaderAssetPromises.length > 0) {
      await Promise.all(shaderAssetPromises);
      console.log(`[Scene] Loaded ${shaderAssetPromises.length} shader asset(s)`);
    }

    if (this.config.layers) {
      const inlinePromises = [];
      for (const layerConfig of Object.values(this.config.layers)) {
        const fragRef = layerConfig.shader?.fragment;
        if (!fragRef) continue;
        if (this._loadedShaderSources[fragRef]) continue;
        if (fragRef.includes('/') || fragRef.includes('.')) {
          inlinePromises.push(
            fetch(fragRef)
              .then((res) => {
                if (!res.ok) throw errorShaderFetchFailed(fragRef, fragRef, res.status);
                return res.text();
              })
              .then((source) => {
                this._loadedShaderSources[fragRef] = source;
              })
          );
        }
      }
      if (inlinePromises.length > 0) {
        await Promise.all(inlinePromises);
      }
    }

    assertLoadedShadersCompatible({
      backend: this.config.renderer.backend,
      layers: this.config.layers,
      shaderAssets,
      loadedSources: this._loadedShaderSources,
    });
  }

  async preloadAssets(imageUrls, spritesheetConfigs = {}, audioManifest = null) {
    this.loadedTextures = {};
    this.loadedSpritesheets = {};
    this.loadedTilemaps = {};
    this.loadedAdobeAnimateAssets = {};

    const textures = imageUrls?.textures || {};
    const sceneSpritesheets = imageUrls?.spritesheets || {};
    const adobeAnimateAnimations = imageUrls?.AdobeAnimateAnimations || {};
    const preparedAdobeAssets = await this.prepareAdobeAnimateAssets(adobeAnimateAnimations);
    const bakedBigAtlas = imageUrls?.bigAtlas;
    const atlasOptions = this.config.assets;

    const atlasPromise = (async () => {
      try {
        if (bakedBigAtlas?.json && bakedBigAtlas?.png) {
          console.log('[Scene] Loading prebaked bigAtlas...');
          return await this._loadBakedBigAtlas(bakedBigAtlas);
        }
        const spritesheets = {
          ...sceneSpritesheets,
          ...preparedAdobeAssets.spritesheetConfigs,
        };
        const assetsToLoad = {
          ...textures,
          spritesheets,
        };
        return await this._packBigAtlasOnMainThread(assetsToLoad, atlasOptions);
      } catch (error) {
        console.error('❌ Failed to generate BigAtlas:', error);
        throw error;
      }
    })();

    const flowfieldsPromise = imageUrls?.flowfields
      ? NavGrid.loadStaticFlowfieldsFromJSON(
        imageUrls.flowfields,
        this.config.worldWidth,
        this.config.worldHeight
      )
      : Promise.resolve();

    const audioPromise = this.preloadAudios(
      audioManifest !== null && audioManifest !== undefined ? audioManifest : this.audioUrls
    );

    const [atlasResult, , , , loadedAudioNames] = await Promise.all([
      atlasPromise,
      this._loadTilemapsParallel(imageUrls?.tilemaps),
      flowfieldsPromise,
      this._loadShaderSources(imageUrls),
      audioPromise,
    ]);

    this._installBigAtlas(atlasResult, preparedAdobeAssets.compiledAssets);
    this.loadedAudioNames = loadedAudioNames;
  }

  async preloadAudios(audioManifest) {
    if (!audioManifest || (Array.isArray(audioManifest) && audioManifest.length === 0)) {
      return [];
    }

    await SoundManager.loadManifest(audioManifest);

    const names = [];
    if (Array.isArray(audioManifest)) {
      for (let i = 0; i < audioManifest.length; i++) {
        const entry = audioManifest[i];
        if (!entry) continue;
        if (typeof entry === 'string') names.push(entry);
        else if (entry.name) names.push(entry.name);
        else if (entry.id) names.push(entry.id);
      }
      return names;
    }

    if (typeof audioManifest === 'object') {
      return Object.keys(audioManifest);
    }

    return names;
  }

  extractDecalTextures(atlasCanvas, atlasJson) {
    const ctx = atlasCanvas.getContext('2d', { willReadFrequently: true });

    const textures = {};
    const animationNames = Object.keys(atlasJson.animations);

    // First pass: Extract first frame of each animation (for animation-based stamping)
    // textureId 0 to animationNames.length-1 = animation first frames
    for (let textureId = 0; textureId < animationNames.length; textureId++) {
      const animName = animationNames[textureId];
      const frameList = atlasJson.animations[animName];

      if (!frameList || frameList.length === 0) continue;

      const firstFrameName = frameList[0];
      const frameData = atlasJson.frames[firstFrameName];

      if (!frameData) continue;

      const frame = frameData.frame;
      const imageData = ctx.getImageData(frame.x, frame.y, frame.w, frame.h);

      textures[textureId] = {
        width: frame.w,
        height: frame.h,
        rgba: imageData.data.buffer,
      };
    }

    // Second pass: Extract ALL individual frames (for frame-specific stamping)
    // This allows stamping any specific frame like "civil1_hurt_5" (last frame of hurt)
    // textureIds start after animation count, using negative offsets from frame index
    const frameNames = Object.keys(atlasJson.frames);
    const frameNameToId = {};

    // Build frame name → textureId mapping
    // We store frames with textureIds starting at animationNames.length
    let frameTextureId = animationNames.length;

    for (const frameName of frameNames) {
      const frameData = atlasJson.frames[frameName];
      if (!frameData) continue;

      const frame = frameData.frame;
      const imageData = ctx.getImageData(frame.x, frame.y, frame.w, frame.h);

      textures[frameTextureId] = {
        width: frame.w,
        height: frame.h,
        rgba: imageData.data.buffer,
      };

      frameNameToId[frameName] = frameTextureId;
      frameTextureId++;
    }

    // Store the frame mapping for lookup by ParticleEmitter
    this.decalFrameNameToId = frameNameToId;
    SpriteSheetRegistry.setDecalFrameMapping(frameNameToId);

    return textures;
  }

  /**
   * Build texture metadata for render queue system
   * Creates lookup tables so particle_worker can compute globalTextureId
   * and pixi_worker can do O(1) texture lookup
   */
  buildTextureMetadata() {
    const bigAtlas = SpriteSheetRegistry.spritesheets.get('bigAtlas');
    if (!bigAtlas) {
      console.warn('[Scene] bigAtlas not found, texture metadata not built');
      return null;
    }

    // Build animation frame offsets
    // animationFrameStart[animIdx] = starting index in flat texture array
    // animationFrameCount[animIdx] = number of frames
    const animationFrameStart = [];
    const animationFrameCount = [];
    let currentOffset = 0;

    const animCount = bigAtlas.totalAnimations;
    for (let animIdx = 0; animIdx < animCount; animIdx++) {
      const animName = bigAtlas.indexToName[animIdx];
      const animData = bigAtlas.animations[animName];
      const frameCount = animData ? animData.frameCount : 1;

      animationFrameStart[animIdx] = currentOffset;
      animationFrameCount[animIdx] = frameCount;
      currentOffset += frameCount;
    }

    // Get frame dimension arrays from SpriteSheetRegistry
    const frameDimensions = SpriteSheetRegistry.buildFrameDimensionArrays();

    // Build proxy sheet mapping: proxyToGlobalAnim[sheetId][localAnimIdx] = globalAnimIdx
    // This maps (spritesheetId, animationState) → bigAtlas animation index
    const proxyToGlobalAnim = {};
    const spritesheetNames = SpriteSheetRegistry.spritesheetNames;

    for (let sheetId = 0; sheetId < spritesheetNames.length; sheetId++) {
      const sheetName = spritesheetNames[sheetId];
      if (!sheetName) continue;

      const sheet = SpriteSheetRegistry.spritesheets.get(sheetName);
      if (!sheet) continue;

      if (sheet.isProxy) {
        // Proxy sheet - map local animation indices to bigAtlas indices
        proxyToGlobalAnim[sheetId] = {};
        for (const [animName, animInfo] of Object.entries(sheet.animations)) {
          const localIdx = animInfo.index;
          const prefixedName = animInfo.prefixedName;
          // Look up the global index in bigAtlas
          const globalAnimData = bigAtlas.animations[prefixedName];
          if (globalAnimData) {
            proxyToGlobalAnim[sheetId][localIdx] = globalAnimData.index;
          }
        }
      } else if (sheetName === 'bigAtlas') {
        // bigAtlas itself - direct 1:1 mapping
        proxyToGlobalAnim[sheetId] = {};
        for (let i = 0; i < animCount; i++) {
          proxyToGlobalAnim[sheetId][i] = i;
        }
      }
    }

    // Build animation name → index lookup (for direct texture lookups like _lightGradient)
    const animationNameToIndex = {};
    for (let animIdx = 0; animIdx < animCount; animIdx++) {
      const animName = bigAtlas.indexToName[animIdx];
      animationNameToIndex[animName] = animIdx;
    }

    return {
      animationFrameStart,
      animationFrameCount,
      proxyToGlobalAnim,
      animationNameToIndex,
      totalFrames: currentOffset,
      frameWidth: frameDimensions?.frameWidth,   // Uint16Array[textureId] → pixel width
      frameHeight: frameDimensions?.frameHeight, // Uint16Array[textureId] → pixel height
    };
  }

  setupWorkerCommunication() {
    const connections = [{ from: 'physics', to: 'renderer' }];

    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      connections.push({ from: `logic${i}`, to: 'renderer' });
    }

    // Connect all logic workers to logic0 for spawn/despawn routing
    // This ensures freeList synchronization across workers
    for (let i = 1; i < this.numberOfLogicWorkers; i++) {
      connections.push({ from: `logic${i}`, to: 'logic0' });
    }

    // Connect all logic workers to particle worker
    // Logic workers send pathfinding requests, particle worker computes and writes to SAB
    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      connections.push({ from: `logic${i}`, to: 'particle' });
    }

    // Connect particle worker to all logic workers for bullet impact events (each processes targetId % workers)
    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      connections.push({ from: 'particle', to: `logic${i}` });
    }

    return setupWorkerCommunication(connections);
  }

  async createWorkers() {
    await createSceneWorkers(this);
  }

  handleMessageFromWorker(e) {
    if (e.data.msg === 'log') {
      return;
    } else if (e.data.msg === 'stepDone') {
      const waiter = this._stepWaiters.get(e.data.id | 0);
      if (!waiter) return;
      waiter.pending.delete(e.currentTarget.name);
      if (waiter.pending.size === 0) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    } else if (e.data.msg === 'workerReady') {
      console.log(`[Scene] 📬 Received 'workerReady' message from ${e.currentTarget.name}`);
      this.handleWorkerReady(e.currentTarget.name);
    } else if (e.data.msg === 'error') {
      const { title, message, stack } = e.data;
      const workerName = e.currentTarget.name;

      // Log to console with full details
      console.error(
        `❌ FATAL ERROR in [${workerName}] worker:\n${title}\n${message}\n${stack || ''}`
      );

      // Show a visible error message on the page
      this._showFatalErrorMessage(workerName, title, message);
    } else if (e.data.msg === 'box2dReady') {
      const payload = {
        msg: 'box2dReady',
        sab: e.data.sab,
        bodyCapacity: e.data.bodyCapacity,
        channelOffsets: e.data.channelOffsets,
        sleepingByteOffset: e.data.sleepingByteOffset,
        commandSab: e.data.commandSab,
        queryAabbSab: e.data.queryAabbSab || null,
        rayCastSab: e.data.rayCastSab || null,
        liquidFunQuerySab: e.data.liquidFunQuerySab || null,
        liquidFunExtractSab: e.data.liquidFunExtractSab || null,
        contactSab: e.data.contactSab,
        movedSab: e.data.movedSab || null,
        hitSab: e.data.hitSab || null,
        jointBreakSab: e.data.jointBreakSab || null,
        eventHeaderBaseIndex: e.data.eventHeaderBaseIndex,
        contactBeginBaseIndex: e.data.contactBeginBaseIndex,
        contactEndBaseIndex: e.data.contactEndBaseIndex,
        sensorBeginBaseIndex: e.data.sensorBeginBaseIndex,
        sensorEndBaseIndex: e.data.sensorEndBaseIndex,
        contactEventCapacity: e.data.contactEventCapacity,
        sensorEventCapacity: e.data.sensorEventCapacity,
        contactPairIntStride: e.data.contactPairIntStride || 2,
        eventHeaderIntCount: e.data.eventHeaderIntCount || 11,
        liquidFunHeap: e.data.liquidFunHeap || null,
      };
      bindBox2dHotFields(payload);
      this.box2dHotFields = payload;
      if (payload.liquidFunHeap) {
        LiquidFun.bindHeapPose(payload.liquidFunHeap);
      }
      if (payload.commandSab) {
        bindCommandRing(payload.commandSab);
      }
      if (payload.queryAabbSab) {
        bindQueryAabbSab(payload.queryAabbSab);
      }
      if (payload.rayCastSab) {
        bindRayCastSab(payload.rayCastSab);
      }
      if (payload.liquidFunQuerySab) {
        bindLiquidFunQuerySab(payload.liquidFunQuerySab);
      }
      if (payload.liquidFunExtractSab) {
        bindLiquidFunExtractSab(payload.liquidFunExtractSab);
      }
      if (payload.movedSab) {
        bindMovedBodies(payload.movedSab);
      }
      for (const worker of this.getAllWorkers()) {
        if (worker && worker !== e.currentTarget) {
          worker.postMessage(payload);
        }
      }
    } else if (e.data.msg === 'liquidFunHeap') {
      const heap = e.data.liquidFunHeap || null;
      if (heap) LiquidFun.bindHeapPose(heap);
      const payload = { msg: 'liquidFunHeap', liquidFunHeap: heap };
      for (const worker of this.getAllWorkers()) {
        if (worker && worker !== e.currentTarget) {
          worker.postMessage(payload);
        }
      }
    } else if (e.data.msg === 'liquidFunCleared') {
      const payload = { msg: 'liquidFunCleared' };
      for (const worker of this.getAllWorkers()) {
        if (worker && worker !== e.currentTarget) {
          worker.postMessage(payload);
        }
      }
    } else if (e.data.msg === 'backgroundReady') {
      Layer.resolveBackgroundReady(e.data.layerId, e.data.requestId);
    } else if (e.data.msg === 'restoreSaveComplete') {
      const pending = this._pendingRestoreComplete;
      this._pendingRestoreComplete = null;
      if (pending) {
        pending.resolve({
          restored: e.data.restored || 0,
          failed: e.data.failed || 0,
        });
      }
    } else if (e.data.msg === 'messageFromGameObject') {
      this.onMessageFromGameObject(
        e.data.data,
        e.data.entityIndex,
        e.data.className,
        e.currentTarget.name,
        e.data.workerIndex
      );
    } else {
      // Log unexpected messages for debugging
      console.log(`[Scene] 📨 Received message from ${e.currentTarget.name}:`, e.data.msg, e.data);
    }
  }

  _showFatalErrorMessage(workerName, title, message) {
    // Check if error overlay already exists
    let overlay = document.getElementById('fatal-error-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'fatal-error-overlay';
      overlay.style.cssText = `
        position: fixed;
        top: 20px;
        left: 20px;
        right: 20px;
        background: rgba(255, 0, 0, 0.9);
        color: white;
        padding: 20px;
        border-radius: 8px;
        z-index: 10000;
        font-family: monospace;
        box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        border: 2px solid white;
      `;
      document.body.appendChild(overlay);
    }

    const errorHtml = `
      <h2 style="margin-top: 0; border-bottom: 1px solid white; padding-bottom: 10px;">
        ⚠️ Engine Error: ${title}
      </h2>
      <p><strong>Worker:</strong> ${workerName}</p>
      <p><strong>Message:</strong> ${message}</p>
      <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.3); margin: 15px 0;">
      <p style="font-size: 0.9em; opacity: 0.8;">
        The game engine has encountered a fatal error and may have stopped rendering.
        Check the browser console for more details.
      </p>
      <button onclick="location.reload()" style="
        background: white;
        color: red;
        border: none;
        padding: 10px 20px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: bold;
        margin-top: 10px;
      ">Reload Page</button>
    `;

    overlay.innerHTML = errorHtml;
  }

  handleWorkerReady(workerName) {
    console.log(`[Scene] ✅ Worker "${workerName}" is ready!`);
    this.workerReadyStates[workerName] = true;

    if (workerName === 'physics' && this.pendingPhysicsUpdates.length) {
      console.log(`[Scene] 📤 Sending ${this.pendingPhysicsUpdates.length} pending physics updates...`);
      this.pendingPhysicsUpdates.forEach((update) => {
        this.workers.physics.postMessage({
          msg: 'updatePhysicsConfig',
          config: update,
        });
      });
      this.pendingPhysicsUpdates = [];
    }

    // Log current ready states
    const readyCount = Object.values(this.workerReadyStates).filter((ready) => ready).length;
    const totalWorkers = Object.keys(this.workerReadyStates).length;
    console.log(`[Scene] 📊 Workers ready: ${readyCount}/${totalWorkers}`);

    // Log which workers are still waiting
    const waitingWorkers = Object.entries(this.workerReadyStates)
      .filter(([name, ready]) => !ready)
      .map(([name]) => name);
    if (waitingWorkers.length > 0) {
      console.log(`[Scene] ⏳ Still waiting for: ${waitingWorkers.join(', ')}`);
    }

    const allReady = Object.values(this.workerReadyStates).every((ready) => ready);

    if (allReady) {
      console.log(`[Scene] 🎉 All workers are ready!`);
      if (this.resolveReady) {
        console.log(`[Scene] ✅ Resolving ready promise`);
        this.resolveReady();
      }
    }
  }

  getAllWorkers() {
    return Object.values(this.workers).flat().filter(w => w);
  }

  startAllWorkers() {
    const allWorkers = this.getAllWorkers();

    console.log(`[Scene] 🚀 Starting ${allWorkers.filter(w => w).length} workers...`);
    for (const worker of allWorkers) {
      if (worker) {
        console.log(`[Scene]   → Sending 'start' message to ${worker.name}`);
        worker.postMessage({ msg: 'start' });
      }
    }
    console.log(`[Scene] ✅ All start messages sent`);
  }

  /**
   * One lockstep frame: main-thread update, then workers in pipeline order.
   * Requires config.manualStep. Does not schedule further frames.
   * @param {number} [deltaTimeMs=16.67]
   */
  async stepFrame(deltaTimeMs = 16.67) {
    if (!this.config.manualStep) {
      throw new Error('stepFrame requires config.manualStep: true');
    }
    const dt = Number(deltaTimeMs);
    if (!(dt > 0)) {
      throw new Error('stepFrame needs deltaTime > 0');
    }

    this.updateInternal(dt);

    await this._stepWorkerGroup(this.workers.logicWorkers, dt);
    await this._stepWorkerGroup(this.workers.physics ? [this.workers.physics] : [], dt);
    await this._stepWorkerGroup(this.workers.spatialWorkers, dt);
    await this._stepWorkerGroup(this.workers.particle ? [this.workers.particle] : [], dt);
    await this._stepWorkerGroup(this.workers.preRender ? [this.workers.preRender] : [], dt);
    await this._stepWorkerGroup(this.workers.renderer ? [this.workers.renderer] : [], dt);
  }

  /**
   * @param {number} count
   * @param {number} [deltaTimeMs=16.67]
   */
  async stepFrames(count, deltaTimeMs = 16.67) {
    const n = count | 0;
    for (let i = 0; i < n; i++) {
      await this.stepFrame(deltaTimeMs);
    }
  }

  _stepWorkerGroup(workers, deltaTime) {
    const list = (workers || []).filter(Boolean);
    if (list.length === 0) return Promise.resolve();
    const id = ++this._stepSeq;
    return new Promise((resolve, reject) => {
      const pending = new Set(list.map((w) => w.name));
      const timer = setTimeout(() => {
        const waiter = this._stepWaiters.get(id);
        if (!waiter) return;
        this._stepWaiters.delete(id);
        reject(new Error(`step ${id} timeout waiting for ${[...waiter.pending].join(',')}`));
      }, 20000);
      this._stepWaiters.set(id, { pending, resolve, reject, timer });
      for (const w of list) {
        w.postMessage({ msg: 'step', deltaTime, id });
      }
    }).finally(() => {
      const waiter = this._stepWaiters.get(id);
      if (waiter?.timer) clearTimeout(waiter.timer);
      this._stepWaiters.delete(id);
    });
  }

  /**
   * FNV-1a of active Transform x/y/rotation bits (main-thread HEAP views).
   * @returns {{ hash: string, count: number }}
   */
  hashActiveTransforms() {
    const active = Transform.active;
    const xs = Transform.x;
    const ys = Transform.y;
    const rot = Transform.rotation;
    if (!active || !xs || !ys) {
      return { hash: 'missing', count: 0 };
    }
    const bits = new Uint32Array(1);
    const f32 = new Float32Array(bits.buffer);
    let h = 2166136261 >>> 0;
    let count = 0;
    const n = active.length;
    for (let i = 0; i < n; i++) {
      if (active[i] === 0) continue;
      count++;
      h ^= i;
      h = Math.imul(h, 16777619) >>> 0;
      f32[0] = xs[i];
      h ^= bits[0];
      h = Math.imul(h, 16777619) >>> 0;
      f32[0] = ys[i];
      h ^= bits[0];
      h = Math.imul(h, 16777619) >>> 0;
      if (rot) {
        f32[0] = rot[i];
        h ^= bits[0];
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    return { hash: (h >>> 0).toString(16).padStart(8, '0'), count };
  }

  /**
   * FNV-1a of live LiquidFun particle x/y bits. count 0 / hash 'none' if LF unbound.
   * @returns {{ hash: string, count: number }}
   */
  hashLiquidFun() {
    const views = LiquidFun.getViews();
    if (!views?.x || !views.y || !views.count) {
      return { hash: 'none', count: 0 };
    }
    const n = views.count[0] | 0;
    const xs = views.x;
    const ys = views.y;
    const bits = new Uint32Array(1);
    const f32 = new Float32Array(bits.buffer);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < n; i++) {
      h ^= i;
      h = Math.imul(h, 16777619) >>> 0;
      f32[0] = xs[i];
      h ^= bits[0];
      h = Math.imul(h, 16777619) >>> 0;
      f32[0] = ys[i];
      h ^= bits[0];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return { hash: (h >>> 0).toString(16).padStart(8, '0'), count: n };
  }

  countActiveTransforms() {
    const active = Transform.active;
    if (!active) return 0;
    let n = 0;
    for (let i = 0; i < active.length; i++) {
      if (active[i]) n++;
    }
    return n;
  }

  readWorkerStepMs() {
    const one = (sab, slot) => {
      if (!sab) return 0;
      return new Float32Array(sab)[slot] || 0;
    };
    const multi = (sab, schema, count) => {
      if (!sab || count < 1) return 0;
      const view = new Float32Array(sab);
      let sum = 0;
      for (let i = 0; i < count; i++) {
        sum += view[i * schema.STRIDE_FLOATS + schema.STEP_MS] || 0;
      }
      return sum;
    };
    const logicCount = this.config.logic?.numberOfLogicWorkers || 1;
    return {
      physics: one(this.buffers.physicsStats, PHYSICS_STATS.STEP_MS),
      particle: one(this.buffers.particleStats, PARTICLE_STATS.STEP_MS),
      renderer: one(this.buffers.rendererStats, RENDERER_STATS.STEP_MS),
      preRender: one(this.buffers.preRenderStats, PRE_RENDER_STATS.STEP_MS),
      spatial: multi(this.buffers.spatialStats, SPATIAL_STATS, this.numberOfSpatialWorkers),
      logic: multi(this.buffers.logicStats, LOGIC_STATS, logicCount),
      main: this.mainStepMs || 0,
    };
  }

  /**
   * Box2D radial explosion — applies falling-off impulse to bodies within radius
   * (falloff = 0.5 * radius, handled by the physics worker).
   * @param {{x:number, y:number, radius:number, impulsePerLength:number, maskBits?:number}} opts
   */
  explode({ x, y, radius, impulsePerLength, maskBits = 0xffffffff }) {
    enqueueExplode(maskBits >>> 0, x, y, radius, impulsePerLength);
  }

  /**
   * Box2D QueryAABB from main thread (async — Atomics.waitAsync).
   * Logic / GameObject should use sync `box2dQueryAABB` instead.
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   * @param {Int32Array} out
   * @param {{categoryBits?:number, maskBits?:number}} [filter]
   * @returns {Promise<number>} full hit count (may exceed out.length)
   */
  box2dQueryAABB(x0, y0, x1, y1, out, filter) {
    return box2dQueryAABBAsync(x0, y0, x1, y1, out, filter);
  }

  /**
   * Box2D castRayClosest from main thread (async — Atomics.waitAsync).
   * Logic / GameObject should use sync `box2dCastRayClosest` instead.
   */
  box2dCastRayClosest(ox, oy, dx, dy, out, filter) {
    return box2dCastRayClosestAsync(ox, oy, dx, dy, out, filter);
  }

  updatePhysicsConfig(partialConfig = {}) {
    if (!partialConfig || typeof partialConfig !== 'object') return;

    Object.assign(this.config.physics, partialConfig);
    const updatePayload = { ...partialConfig };

    if (this.workers.physics && this.workerReadyStates && this.workerReadyStates.physics) {
      this.workers.physics.postMessage({
        msg: 'updatePhysicsConfig',
        config: updatePayload,
      });
    } else {
      this.pendingPhysicsUpdates.push(updatePayload);
    }
  }

  // ---------------------------------------------------------------------------
  // Input callbacks — called by GameEngine's event listeners
  // ---------------------------------------------------------------------------

  onKeyDown(key) {
    const wasDown = this.keyboard[key] === true;
    this.keyboard[key] = true;
    if (!wasDown && this.views.input) {
      const index = this.keyMap[key];
      if (index !== undefined) {
        this.views.input[this.inputBufferSize + index]++;
      }
    }
    this.updateKeyboardBuffer();
  }

  onKeyUp(key) {
    this.keyboard[key] = false;
    this.updateKeyboardBuffer();
  }

  onMouseDown(button) {
    if (button == 0) { Mouse.isButton0Down = true; Mouse.incrementPress0(); }
    if (button == 1) { Mouse.isButton1Down = true; Mouse.incrementPress1(); }
    if (button == 2) { Mouse.isButton2Down = true; Mouse.incrementPress2(); }
  }

  onMouseUp(button) {
    if (button == 0) { Mouse.isButton0Down = false; Mouse.incrementRelease0(); }
    if (button == 1) { Mouse.isButton1Down = false; Mouse.incrementRelease1(); }
    if (button == 2) { Mouse.isButton2Down = false; Mouse.incrementRelease2(); }
  }

  onMouseMove(canvasX, canvasY) {
    Mouse.isPresent = true;
    Mouse.setCanvasPosition(canvasX, canvasY, this.camera);
  }

  onMouseLeave() {
    Mouse.isPresent = false;
  }

  onWheel(deltaY) {
    Mouse.wheel += deltaY;
  }

  updateKeyboardBuffer() {
    const input = this.views.input;
    if (!input) return;
    for (const [key, index] of Object.entries(this.keyMap)) {
      input[index] = this.keyboard[key] ? 1 : 0;
    }
  }

  updateCameraBuffer() {
    // Sync all camera state from Camera static class (controlled by worker/entity via follow())
    this.camera.zoom = Camera.zoom;
    this.camera.x = Camera.x;
    this.camera.y = Camera.y;

    // Update mouse world position based on camera
    Mouse.updateWorldPosition(this.camera);
  }

  startMainLoop() {
    const loop = (currentTime) => {
      if (!this.state.pause) {
        const deltaTime = currentTime - this.lastFrameTime;
        this.lastFrameTime = currentTime;

        const t0 = performance.now();
        this.updateInternal(deltaTime);
        this.mainStepMs = performance.now() - t0;

        this.mainFrameNumber++;
        this.mainFrameTimesSum -= this.mainFrameTimes[this.mainFrameTimeIndex];
        this.mainFrameTimes[this.mainFrameTimeIndex] = deltaTime;
        this.mainFrameTimesSum += deltaTime;
        this.mainFrameTimeIndex = (this.mainFrameTimeIndex + 1) % this.mainFPSFrameCount;

        const averageFrameTime = this.mainFrameTimesSum / this.mainFPSFrameCount;
        this.mainFPS = 1000 / averageFrameTime;
      }

      // mainFPS is now read directly by DebugUI

      // Store the RAF ID so we can cancel it later
      this.animationFrameId = requestAnimationFrame(loop);
    };

    this.animationFrameId = requestAnimationFrame(loop);
  }

  updateInternal(deltaTime) {
    const dtRatio = deltaTime / 16.67;

    // Update audio metrics from AudioWorklet (worklet handles playback directly via SAB)
    const am = SoundManager.getMetrics();
    const audioMetrics = this.audioMetrics;
    audioMetrics.activeSlots = am.activeSlots;
    audioMetrics.maxSlots = am.maxSlots;
    audioMetrics.loadedSounds = am.loadedSounds;
    audioMetrics.dropped = am.dropped;
    audioMetrics.mixGain = am.mixGain;
    audioMetrics.masterVolume = am.masterVolume;
    audioMetrics.muted = am.muted;
    audioMetrics.state = am.state;
    audioMetrics.sampleRate = am.sampleRate;
    audioMetrics.baseLatency = am.baseLatency;
    audioMetrics.outputLatency = am.outputLatency;
    audioMetrics.processMs = am.processMs || 0;

    // Note: Camera following is now handled in Player.tick() which writes directly to cameraData SharedArrayBuffer
    // Main thread reads from cameraData and syncs to this.camera in updateCameraBuffer()
    this.updateCameraBuffer();

    // Update sun day cycle (if enabled)
    // Sun writes to SharedArrayBuffer, workers read it
    this.updateSunDayCycle(deltaTime);

    // Visible/active units are now read directly by DebugUI from Transform/SpriteRenderer arrays

    // Update input edge flags on the main thread so Scene.update() can use them
    // the same way entity tick() does in workers.
    Gamepad.poll();
    Keyboard.updateEdgeFlags();
    Mouse.updateEdgeFlags();
    Gamepad.updateEdgeFlags();

    // Call user's update hook
    this.update(dtRatio, deltaTime, performance.now(), this.mainFrameNumber);

    GrabSystem.update(this);

    // Free-cam after scene.update so scenes can setFreeTarget / pauseFreeZoom first
    Camera.updateFree(dtRatio);

    // Reset per-frame input state (after update so devs can read it)
    Mouse.wheel = 0;
    Mouse.snapshotPreviousFrame();
  }

  /**
   * Update sun day cycle if enabled
   * Advances time and updates sun position/intensity/color
   * @param {number} deltaTime - Time since last frame in milliseconds
   */
  updateSunDayCycle(deltaTime) {
    if (!Sun.isInitialized) return;

    const dayCycleConfig = this.config.lighting?.sun?.dayCycle;
    if (!dayCycleConfig?.enabled) return;

    const speed = dayCycleConfig.speed || 1;
    const dayDurationMinutes = dayCycleConfig.dayDurationMinutes || 1440;

    Sun.advanceTime(deltaTime, speed, dayDurationMinutes);
  }

  createKeyIndexMap() {
    return this.keyMap;
  }

  async destroy() {
    console.log(`🔴 Scene ${this.constructor.name}: Destroying...`);

    Camera.setFree(false);
    GrabSystem.reset();

    // =========================================================================
    // CRITICAL: Clear global references FIRST to allow GC of the scene
    // window.scene holds a reference - without clearing, the entire scene stays in memory
    // =========================================================================
    if (typeof window !== 'undefined') {
      window.scene = null;
      delete window.downloadBigAtlas;
      delete window.inspectBigAtlas;
    }
    GameObject.scene = null;

    // Stop the main loop immediately
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Break worker handler closures BEFORE terminate (prevents scene ref retention)
    const allWorkers = this.getAllWorkers();
    allWorkers.forEach((worker) => {
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
      }
    });

    // Terminate all workers
    allWorkers.forEach((worker) => {
      if (worker) worker.terminate();
    });

    teardownSceneSharedState(this);

    this._releaseBootAssets();

    console.log(`✅ Scene ${this.constructor.name}: Destroyed!`);
  }

  /**
   * Deterministically release boot-time asset memory (atlas canvas, ImageBitmaps,
   * decal RGBA extracts). After a successful init most ImageBitmaps were
   * transferred to the renderer worker (so close() is a no-op on the detached
   * husks), but on a failed/partial init they are still alive on this thread --
   * closing them here frees the pixel memory immediately instead of waiting
   * for GC of the scene graph.
   */
  _releaseBootAssets() {
    for (const sheet of Object.values(this.loadedSpritesheets || {})) {
      sheet?.imageBitmap?.close?.();
    }
    for (const texture of Object.values(this.loadedTextures || {})) {
      texture?.close?.();
    }
    for (const tilemap of Object.values(this.loadedTilemaps || {})) {
      tilemap?.tilesetBitmap?.close?.();
    }

    this.loadedSpritesheets = {};
    this.loadedTextures = {};
    this.loadedTilemaps = {};
    this.loadedAdobeAnimateAssets = {};
    this.decalTextureData = null;
    this.bigAtlasCanvas = null;
    this.bigAtlasJson = null;
    this.bigAtlasProxySheets = null;
    this._loadedShaderSources = null;
    this._computeShaderNames = null;
  }

  pause() {
    this.state.pause = true;
    const allWorkers = this.getAllWorkers();

    allWorkers.forEach((worker) => {
      if (worker) worker.postMessage({ msg: 'pause' });
    });
  }

  resume() {
    this.state.pause = false;
    this.lastFrameTime = performance.now();
    const allWorkers = this.getAllWorkers();

    allWorkers.forEach((worker) => {
      if (worker) worker.postMessage({ msg: 'resume' });
    });
  }

  /**
   * Resize the canvas and propagate new dimensions to Camera and all workers
   * Called by GameEngine.resize() when the window is resized (autoResize) or manually
   * @param {number} width - New canvas width in pixels
   * @param {number} height - New canvas height in pixels
   */
  resize(width, height) {
    this.config.canvasWidth = width;
    this.config.canvasHeight = height;

    Camera.canvasWidth = width;
    Camera.canvasHeight = height;

    const allWorkers = this.getAllWorkers();
    allWorkers.forEach((worker) => {
      if (worker) worker.postMessage({ msg: 'resize', width, height });
    });
  }

  /**
   * Sparse save of active serializable entities to IndexedDB.
   * @param {string} [slotId]
   */
  async saveGame(slotId) {
    const { saveGame } = await import('./save/saveGame.js');
    return saveGame(this, slotId);
  }

  /**
   * Load a save slot by remounting this scene class with restore payload.
   * @param {string} slotId
   */
  async loadGame(slotId) {
    const { loadGame } = await import('./save/saveGame.js');
    return loadGame(this.game, this.constructor, slotId);
  }

  spawnEntity(EntityClassOrName, spawnConfig = {}) {
    // Accept either a class or a string name
    let EntityClass;
    let className;

    if (typeof EntityClassOrName === 'function') {
      EntityClass = EntityClassOrName;
      className = EntityClass.name;
    } else {
      className = EntityClassOrName;
      // Look up the class from registered classes
      const registration = this.registeredClasses.find(r => r.class.name === className);
      EntityClass = registration?.class;
    }

    // ========================================
    // ATOMIC SPAWN: Reserve index on main thread
    // ========================================
    // This enables immediate use of entity index (e.g., for constraints)
    // Worker 0 receives the pre-assigned index and:
    // 1. Sets up component data and calls lifecycle hooks
    // 2. Queues list updates (activeEntities, perTypeActive, queries)
    // 3. List updates are processed at start of next frame by logic0
    let entityIndex = -1;

    if (EntityClass && EntityClass.freeList && EntityClass.freeListTop) {
      // Lock-free CAS pop (Treiber stack) - safe against concurrent
      // spawns/despawns on logic workers
      entityIndex = popFreeIndex(
        EntityClass.freeListTop,
        EntityClass.freeList,
        EntityClass.startIndex
      );

      if (entityIndex >= 0) {
        // NOTE: Do NOT set Transform.active here!
        // Worker 0 will set Transform.active = 1 after full setup.
        // Setting it here would cause spatial_worker to add entity to Grid
        // before it's in the active list (so it would never tick/despawn).
        //
        // We only set position so constraints can use the index immediately.
        Transform.x[entityIndex] = spawnConfig.x ?? 0;
        Transform.y[entityIndex] = spawnConfig.y ?? 0;
      } else {
        // Pool exhausted
        console.warn(`spawnEntity: Pool exhausted for ${className}`);
        return null;
      }
    }

    // ========================================
    // NOTIFY WORKER 0
    // ========================================
    // Worker 0 calls GameObject.spawn() with preAssignedIndex which:
    // - Skips freeList pop (already done above)
    // - Sets up all component data
    // - Calls lifecycle hooks (setup, onSpawned)
    // - Queues list updates for processing at start of next frame
    const worker0 = this.workers.logicWorkers?.[0];
    if (worker0) {
      worker0.postMessage({
        msg: 'spawn',
        className: className,
        spawnConfig: spawnConfig,
        entityIndex: entityIndex, // Pre-assigned index
      });
    }

    // Return a simple object with the index for immediate use
    // (e.g., creating constraints between spawned entities)
    if (entityIndex >= 0) {
      return { index: entityIndex };
    }
    return null;
  }

  despawnEntity(entityIndex) {
    // Only worker 0 handles despawn messages
    const worker0 = this.workers.logicWorkers?.[0];
    if (worker0) {
      worker0.postMessage({
        msg: 'despawn',
        entityIndex: entityIndex,
      });
    }
  }

  despawnAllEntities(className) {
    // Only worker 0 handles despawnAll messages
    const worker0 = this.workers.logicWorkers?.[0];
    if (worker0) {
      worker0.postMessage({
        msg: 'despawnAll',
        className: className,
      });
    }
  }

  getPoolStats(EntityClass) {
    if (EntityClass.startIndex == null || EntityClass.poolSize == null) {
      return { total: 0, active: 0, available: 0 };
    }

    const startIndex = EntityClass.startIndex;
    const total = EntityClass.poolSize;
    let activeCount = 0;

    for (let i = startIndex; i < EntityClass.endIndex; i++) {
      if (Transform.active[i]) {
        activeCount++;
      }
    }

    return {
      total: total,
      active: activeCount,
      available: total - activeCount,
    };
  }

  /**
   * Get detailed memory usage for all SharedArrayBuffers owned by this scene.
   * Traverses this.buffers recursively and returns per-category and total usage.
   *
   * @returns {object} Detailed memory summary object
   */
  getMemoryUsageSummary() {
    return buildMemoryUsageSummary(this.buffers);
  }

  /**
   * Get memory usage plus component allocation metadata.
   * Useful for spotting sparse components that are expensive under dense storage.
   *
   * @returns {object} Detailed memory report with componentAllocations
   */
  getMemoryUsageReport() {
    return buildSceneMemoryUsageReport(this);
  }

  /**
   * Get the total size of all SharedArrayBuffers used by the scene
   * @param {boolean} includeBreakdown - If true, returns an object with total and breakdown by category
   * @returns {number|object} Total size in bytes, or object with {total, breakdown} if includeBreakdown is true
   */
  getSharedBufferSize(includeBreakdown = false) {
    return getSharedBufferSizeFromBuffers(this.buffers, includeBreakdown);
  }
}

export { Scene };
