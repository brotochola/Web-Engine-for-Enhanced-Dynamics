// Scene.js - Scene management with workers and entity pools
// Handles workers, SharedArrayBuffers, entity registration, and scene lifecycle
// This was previously GameEngine.js - renamed to better reflect its role

import { GameObject } from './gameObject.js';
import { popFreeIndex } from './atomicFreeList.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { AdobeAnimComponent } from '../components/AdobeAnimComponent.js';
import { ParticleComponent } from '../components/ParticleComponent.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { BulletComponent } from '../components/BulletComponent.js';
import { DecorationPool } from './DecorationPool.js';
import { BulletPool } from './BulletPool.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { LightOccluder } from '../components/LightOccluder.js';
import { CameraInOutListener } from '../components/CameraInOutListener.js';
import { CollisionListener } from '../components/CollisionListener.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { AdobeAnimRegistry } from './AdobeAnimRegistry.js';
import { AdobeAnimCompiler } from './AdobeAnimCompiler.js';
import {
  setupWorkerCommunication,
  seededRandom,
  loadEntityScripts,
  collectAllComponentsFromClasses,
  initializeComponentViews,
  exposeComponentsGlobally,
  exposeEntityClassesGlobally,
  urlToPath,
} from './utils.js';
import { DebugFlags } from './debug/DebugFlags.js';
import { Mouse } from './Mouse.js';
import Keyboard from './Keyboard.js';
import { Flash } from './Flash.js';
import { BigAtlasInspector } from './BigAtlasInspector.js';
import { Camera } from './Camera.js';
import {
  buildMemoryUsageSummary,
  buildSceneMemoryUsageReport,
  getSharedBufferSize as getSharedBufferSizeFromBuffers,
} from './sceneBufferMemory.js';
import { createSceneSharedBuffers, teardownSceneSharedState } from './sceneSharedBuffers.js';
import { createSceneWorkers } from './sceneWorkerBootstrap.js';
import { QuerySystem } from './QuerySystem.js';
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
  LAYER_DEFAULTS,
  DEFAULT_LAYERS,
} from './ConfigDefaults.js';
import { Sun } from './Sun.js';
import { Layer } from './Layer.js';
import { TileMap } from './TileMap.js';
import { computeBufferSize as computeRenderQueueBufferSize } from './RenderQueueLayout.js';
import { NavGrid } from './NavGrid.js';
import { Grid } from './Grid.js';
import { Ray } from './Ray.js';
import { DebugDraw } from './debug/DebugDraw.js';
import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  NAVIGATION_STATS,
  PRE_RENDER_STATS,
} from '../workers/workers-utils.js';
import { ParticleEmitter } from './ParticleEmitter.js';
import { Constraint } from './Constraint.js';
import { SoundManager } from './SoundManager.js';
import { Decoration } from './Decoration.js';

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

  static now = Date.now();

  constructor(game) {
    this.game = game; // Reference to GameEngine orchestrator
    this.log = [];
    this.loadedTextures = null;

    // Merge static config with any runtime config
    this.config = { ...this.constructor.config };
    this.imageUrls = { ...this.constructor.assets };
    this.audioUrls = this.constructor.audios || [];
    this.loadedAudioNames = [];

    this.seed = this.config.seed || 1
    this.rng = seededRandom(this.seed);
    // Make seeded random available globally for entity code
    globalThis.rng = this.rng;
    this.state = {
      pause: false,
    };

    // Apply all default config values
    this._applyConfigDefaults();

    // State
    this.keyboard = {};
    // Mouse is accessed via Mouse static class (writes directly to SharedArrayBuffer)
    this.camera = {
      zoom: 1,
      x: 0,
      y: 0,
    };

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
      gameObjectData: null,
      neighborData: null,
      collisionData: null,
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
    };

    // Component type ID tracking (similar to entityType)
    this.nextComponentId = 0;

    // Component pool tracking - assign componentId IDs to core and engine components
    this.componentPools = {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
      AdobeAnimComponent: { ComponentClass: AdobeAnimComponent },
      LightEmitter: { ComponentClass: LightEmitter },
      ShadowCaster: { ComponentClass: ShadowCaster },
      FlashComponent: { ComponentClass: FlashComponent },
      LightOccluder: { ComponentClass: LightOccluder },
      CameraInOutListener: { ComponentClass: CameraInOutListener },
      CollisionListener: { ComponentClass: CollisionListener },
    };

    // Assign componentId IDs to core and engine components
    Transform.componentId = this.nextComponentId++;
    RigidBody.componentId = this.nextComponentId++;
    Collider.componentId = this.nextComponentId++;
    SpriteRenderer.componentId = this.nextComponentId++;
    AdobeAnimComponent.componentId = this.nextComponentId++;
    LightEmitter.componentId = this.nextComponentId++;
    ShadowCaster.componentId = this.nextComponentId++;
    FlashComponent.componentId = this.nextComponentId++;
    LightOccluder.componentId = this.nextComponentId++;
    CameraInOutListener.componentId = this.nextComponentId++;
    CollisionListener.componentId = this.nextComponentId++;

    // Typed array views
    this.views = {
      input: null,
      camera: null,
      collision: null,
      frameRate: null,
    };

    // Main thread FPS tracking
    this.mainFPS = 0;
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
    this.gameObjects = [];
    this.totalEntityCount = 0;
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

    // Register custom components and assign componentId IDs
    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;
      if (!this.componentPools[componentName]) {
        this.componentPools[componentName] = {
          ComponentClass: ComponentClass,
        };
        // Assign unique componentId ID (similar to entityType)
        // Check for null, undefined, or non-number
        if (ComponentClass.componentId == null || typeof ComponentClass.componentId !== 'number') {
          ComponentClass.componentId = this.nextComponentId++;
        }
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

    // Pre-render defaults from centralized config
    this.config.preRender = {
      ...PRE_RENDER_DEFAULTS,
      ...(this.config.preRender || {}),
    };

    // Lighting defaults from centralized config
    this.config.lighting = {
      ...LIGHTING_DEFAULTS,
      ...(this.config.lighting || {}),
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

    // Debug defaults from centralized config
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
          const componentName = ComponentClass.name;
          if (!this.componentPools[componentName]) {
            this.componentPools[componentName] = {
              ComponentClass: ComponentClass,
            };
            // Assign unique componentId ID (similar to entityType)
            // Check for null, undefined, or non-number
            if (ComponentClass.componentId == null || typeof ComponentClass.componentId !== 'number') {
              ComponentClass.componentId = this.nextComponentId++;
            }
          }
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

    // Update entity count display
    const numberBoidsElement = document.getElementById('numberBoids');
    if (numberBoidsElement) {
      numberBoidsElement.textContent = `Number of entities: ${this.totalEntityCount}`;
    }

    // Log current worker ready states

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
    // Spawn entities and set up the game world.
    await this.create();

    // LIFECYCLE PHASE 3: Start everything.
    // Main thread loop first (for input handling), then worker game loops.
    // Workers see a fully populated scene with infrastructure ready on frame 1.
    this.startMainLoop();
    this.startAllWorkers();
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
    const initializedCount = initializeComponentViews(
      componentMap,
      this.buffers.componentData,
      this.componentPools,
      this.totalEntityCount
    );

    // Expose all components globally (both core and custom)
    exposeComponentsGlobally(componentMap, window);

    // Expose all registered entity classes
    const exposedEntities = exposeEntityClassesGlobally(this.registeredClasses, window);

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
   * Called after preload(), right before workers start their game loops.
   * Use this for spawning entities and game-world setup.
   */
  create() {
    // Override this to spawn initial entities
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

    for (const [assetName, config] of Object.entries(adobeConfigs)) {
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
    }

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

  async preloadAssets(imageUrls, spritesheetConfigs = {}) {
    this.loadedTextures = {};
    this.loadedSpritesheets = {};
    this.loadedTilemaps = {}; // Store loaded tilemap data
    this.loadedAdobeAnimateAssets = {};

    const textures = imageUrls?.textures || {};
    const sceneSpritesheets = imageUrls?.spritesheets || {};
    const adobeAnimateAnimations = imageUrls?.AdobeAnimateAnimations || {};
    const preparedAdobeAssets = await this.prepareAdobeAnimateAssets(adobeAnimateAnimations);
    const spritesheets = {
      ...sceneSpritesheets,
      ...preparedAdobeAssets.spritesheetConfigs,
    };
    const assetsToLoad = {
      ...textures,
      spritesheets,
    };

    try {
      // Use config.assets for atlas options (with defaults from ASSETS_DEFAULTS)
      const assetsConfig = this.config.assets || {};
      const bigAtlas = await SpriteSheetRegistry.createBigAtlas(assetsToLoad, {
        maxAtlasWidth: assetsConfig.maxAtlasWidth ?? 4096,
        maxAtlasHeight: assetsConfig.maxAtlasHeight ?? 4096,
        atlasPadding: assetsConfig.atlasPadding ?? 2,
        trimImages: assetsConfig.trimImages ?? true,
        trimAlphaThreshold: assetsConfig.trimAlphaThreshold ?? 0,
        heuristic: 'best-short-side',
      });

      const imageBitmap = await createImageBitmap(bigAtlas.canvas);

      this.loadedSpritesheets['bigAtlas'] = {
        json: bigAtlas.json,
        imageBitmap: imageBitmap,
      };

      SpriteSheetRegistry.register('bigAtlas', bigAtlas.json);

      for (const [sheetName, proxyData] of Object.entries(bigAtlas.proxySheets)) {
        SpriteSheetRegistry.registerProxy(sheetName, proxyData);
      }

      this.finalizeAdobeAnimateAssets(preparedAdobeAssets.compiledAssets);

      this.bigAtlasProxySheets = bigAtlas.proxySheets;
      this.bigAtlasCanvas = bigAtlas.canvas;
      this.bigAtlasJson = bigAtlas.json;

      // Extract decal textures
      if (this.config.particle.decals) {
        this.decalTextureData = this.extractDecalTextures(bigAtlas.canvas, bigAtlas.json);
      }

      // Make helper functions available globally
      window.downloadBigAtlas = () => {
        const link = document.createElement('a');
        link.download = `bigAtlas_${bigAtlas.json.meta.size.w}x${bigAtlas.json.meta.size.h}.png`;
        link.href = this.bigAtlasCanvas.toDataURL();
        link.click();
      };

      window.inspectBigAtlas = () => {
        BigAtlasInspector.show(this.bigAtlasCanvas, this.bigAtlasJson);
      };
    } catch (error) {
      console.error('❌ Failed to generate BigAtlas:', error);
      throw error;
    }

    // Load tilemaps (Tiled JSON + tileset images)
    if (imageUrls.tilemaps) {

      for (const [tilemapId, tilemapConfig] of Object.entries(imageUrls.tilemaps)) {
        try {
          // Load Tiled JSON file
          const jsonResponse = await fetch(tilemapConfig.json);
          if (!jsonResponse.ok) {
            throw new Error(`Failed to load tilemap JSON: ${tilemapConfig.json}`);
          }
          const tilemapData = await jsonResponse.json();

          // Load tileset image
          const tilesetResponse = await fetch(tilemapConfig.png);
          if (!tilesetResponse.ok) {
            throw new Error(`Failed to load tileset image: ${tilemapConfig.png}`);
          }
          const tilesetBlob = await tilesetResponse.blob();
          const tilesetBitmap = await createImageBitmap(tilesetBlob);

          // Store loaded tilemap data
          this.loadedTilemaps[tilemapId] = {
            data: tilemapData,
            tilesetBitmap: tilesetBitmap,
          };

        } catch (error) {
          console.error(`❌ Failed to load tilemap "${tilemapId}":`, error);
        }
      }

      // Initialize TileMap static class from loaded tilemap data (creates SABs)
      TileMap.initializeFromLoaded(this.loadedTilemaps);
    }

    // Load static flowfields (pre-baked direction grids from JSON)
    if (imageUrls.flowfields) {
      await NavGrid.loadStaticFlowfieldsFromJSON(imageUrls.flowfields, this.config.worldWidth, this.config.worldHeight);
    }

    // Load shader assets declared in static assets.shaders (name → path)
    this._loadedShaderSources = {};
    const shaderAssets = imageUrls?.shaders || {};
    const shaderAssetPromises = [];
    for (const [shaderName, shaderPath] of Object.entries(shaderAssets)) {
      shaderAssetPromises.push(
        fetch(shaderPath)
          .then(res => {
            if (!res.ok) throw new Error(`Failed to load shader asset "${shaderName}": ${shaderPath}`);
            return res.text();
          })
          .then(source => {
            this._loadedShaderSources[shaderName] = source;
          })
      );
    }
    if (shaderAssetPromises.length > 0) {
      await Promise.all(shaderAssetPromises);
      console.log(`[Scene] Loaded ${shaderAssetPromises.length} shader asset(s)`);
    }

    // Resolve layer shader references: name lookup into loaded assets, or direct URL fetch
    if (this.config.layers) {
      const inlinePromises = [];
      for (const [layerName, layerConfig] of Object.entries(this.config.layers)) {
        const fragRef = layerConfig.shader?.fragment;
        if (!fragRef) continue;
        if (this._loadedShaderSources[fragRef]) continue; // already loaded as named asset
        if (fragRef.includes('/') || fragRef.includes('.')) {
          inlinePromises.push(
            fetch(fragRef)
              .then(res => {
                if (!res.ok) throw new Error(`Failed to load shader: ${fragRef}`);
                return res.text();
              })
              .then(source => {
                this._loadedShaderSources[fragRef] = source;
              })
          );
        }
      }
      if (inlinePromises.length > 0) {
        await Promise.all(inlinePromises);
      }
    }
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
      this.log.push({
        worker: e.currentTarget.name,
        message: e.data.message,
        when: e.data.when - Scene.now,
      });
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
    } else if (e.data.msg === 'backgroundReady') {
      Layer.resolveBackgroundReady(e.data.layerId, e.data.requestId);
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
      const deltaTime = currentTime - this.lastFrameTime;
      this.lastFrameTime = currentTime;

      this.updateInternal(deltaTime);

      this.mainFrameNumber++;
      this.mainFrameTimesSum -= this.mainFrameTimes[this.mainFrameTimeIndex];
      this.mainFrameTimes[this.mainFrameTimeIndex] = deltaTime;
      this.mainFrameTimesSum += deltaTime;
      this.mainFrameTimeIndex = (this.mainFrameTimeIndex + 1) % this.mainFPSFrameCount;

      const averageFrameTime = this.mainFrameTimesSum / this.mainFPSFrameCount;
      this.mainFPS = 1000 / averageFrameTime;

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

    // Note: Camera following is now handled in Player.tick() which writes directly to cameraData SharedArrayBuffer
    // Main thread reads from cameraData and syncs to this.camera in updateCameraBuffer()
    this.updateCameraBuffer();

    // Update sun day cycle (if enabled)
    // Sun writes to SharedArrayBuffer, workers read it
    this.updateSunDayCycle(deltaTime);

    // Visible/active units are now read directly by DebugUI from Transform/SpriteRenderer arrays

    // Update input edge flags on the main thread so Scene.update() can use them
    // the same way entity tick() does in workers.
    Keyboard.updateEdgeFlags();
    Mouse.updateEdgeFlags();

    // Call user's update hook
    this.update(dtRatio, deltaTime, performance.now(), this.mainFrameNumber);

    // Reset per-frame input state (after update so devs can read it)
    Mouse.wheel = 0;
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

    console.log(`✅ Scene ${this.constructor.name}: Destroyed!`);
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
