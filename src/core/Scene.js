// Scene.js - Scene management with workers and entity pools
// Handles workers, SharedArrayBuffers, entity registration, and scene lifecycle
// This was previously GameEngine.js - renamed to better reflect its role

import { GameObject } from './gameObject.js';
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
  getPortTransferables,
  postWorkerInitMessage,
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
  getSharedBufferSize as getSharedBufferSizeFromBuffers,
} from './sceneBufferMemory.js';
import { createSceneSharedBuffers, teardownSceneSharedState } from './sceneSharedBuffers.js';
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
    // Compute maxShadowSprites based on light count and shadows per light
    this.config.lighting.maxShadowSprites =
      this.config.lighting.maxShadowCastingLights * this.config.lighting.maxShadowsPerLight;
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

  createSharedBuffers() {
    createSceneSharedBuffers(this);
  }

  preInitializeEntityTypeArrays() {
    for (let i = 0; i < this.totalEntityCount; i++) {
      for (const registration of this.registeredClasses) {
        const { class: EntityClass, startIndex, count } = registration;
        if (i >= startIndex && i < startIndex + count) {
          Transform.entityType[i] = EntityClass.entityType;
          break;
        }
      }
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
    const { canvasWidth, canvasHeight, worldWidth, worldHeight } = this.config;

    const cacheBust = `?v=${Date.now()}`;

    // Check if we're in bundle mode (WEED.WorkerSources exists)
    const useInlineWorkers = typeof window !== 'undefined' && window.WEED?.BUNDLE_MODE && window.WEED?.WorkerSources;

    // Helper to create worker from inline source or file
    const makeWorker = (workerName) => {
      if (useInlineWorkers) {
        return window.WEED.createWorker(workerName);
      }
      return new Worker(`/src/workers/${workerName}.js${cacheBust}`, { type: 'module' });
    };

    if (useInlineWorkers) {
      console.log('[Scene] Using inline workers (single-file bundle mode)');
    }

    // Create multiple spatial workers for parallel neighbor detection
    const numberOfSpatialWorkers = this.config.spatial.numberOfSpatialWorkers;
    for (let i = 0; i < numberOfSpatialWorkers; i++) {
      const spatialWorker = makeWorker('spatial_worker');
      spatialWorker.name = `spatial${i}`;
      this.workers.spatialWorkers.push(spatialWorker);
    }

    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      const logicWorker = makeWorker('logic_worker');
      logicWorker.name = `logic${i}`;
      this.workers.logicWorkers.push(logicWorker);
    }

    this.workers.physics = makeWorker('physics_worker');
    this.workers.renderer = makeWorker('pixi_worker');

    // Particle worker always runs - handles particles, decals, navigation, derived properties
    this.workers.particle = makeWorker('particle_worker');

    // Pre-render worker always runs - handles visibility, animation, render queues
    this.workers.preRender = makeWorker('pre_render_worker');

    this.workers.physics.name = 'physics';
    this.workers.renderer.name = 'renderer';
    this.workers.particle.name = 'particle';
    this.workers.preRender.name = 'preRender';

    // Set up early error handlers IMMEDIATELY after worker creation
    // This catches module loading errors (import failures, syntax errors) that would
    // otherwise be missed if we wait until after postMessage to set up handlers
    const earlyErrorHandler = (workerName) => (e) => {
      console.error(
        `❌ EARLY ERROR in ${workerName} worker (module load failed):\n`,
        `Message: ${e.message}\n`,
        `File: ${e.filename}:${e.lineno}:${e.colno}`,
        e
      );
    };
    this.workers.physics.onerror = earlyErrorHandler('physics');
    this.workers.renderer.onerror = earlyErrorHandler('renderer');
    this.workers.particle.onerror = earlyErrorHandler('particle');
    this.workers.preRender.onerror = earlyErrorHandler('preRender');
    for (let i = 0; i < this.numberOfSpatialWorkers; i++) {
      this.workers.spatialWorkers[i].onerror = earlyErrorHandler(`spatial${i}`);
    }
    for (let i = 0; i < this.workers.logicWorkers.length; i++) {
      this.workers.logicWorkers[i].onerror = earlyErrorHandler(`logic${i}`);
    }

    // Preload assets
    const spritesheetConfigs = this.imageUrls.spritesheets || {};
    await this.preloadAssets(this.imageUrls, spritesheetConfigs);
    this.loadedAudioNames = await this.preloadAudios(this.audioUrls);

    // ========================================
    // BUILD TEXTURE METADATA FOR RENDER QUEUE
    // ========================================
    // Build lookup tables so particle_worker can compute globalTextureId
    // and pixi_worker can do O(1) texture lookup
    this.textureMetadata = this.buildTextureMetadata();

    // Inject loaded shader source text into Layer metadata for worker serialization
    if (this._loadedShaderSources && this.config.layers) {
      for (const [layerName, layerConfig] of Object.entries(this.config.layers)) {
        const fragRef = layerConfig.shader?.fragment;
        if (!fragRef) continue;
        const source = this._loadedShaderSources[fragRef];
        if (!source) continue;
        const layer = Layer.get(layerName);
        const layerMeta = layer ? Layer._metadata?.layers?.[layer.id] : null;
        if (layerMeta) {
          layerMeta.shaderFragment = source;
          layerMeta.shaderName = fragRef;
        }
      }
    }

    // Collect script paths - convert to absolute URLs for Workers running from Blobs
    // Workers created from Blobs can't resolve relative paths like '/demos/...'
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const scriptsToLoad = [
      ...new Set(
        this.registeredClasses
          .map((r) => r.scriptPath)
          .filter((path) => path !== null && path !== undefined)
          .map((path) => {
            // Blob URLs (inline entity sources) — pass through as-is
            if (path.startsWith('blob:')) {
              return path;
            }
            // Already absolute URL
            if (path.startsWith('http://') || path.startsWith('https://')) {
              return path;
            }
            // Convert to absolute URL for Workers
            if (path.startsWith('/')) {
              return `${origin}${path}`;
            }
            // Relative paths - resolve against origin
            return new URL(path, origin).href;
          })
      ),
    ];

    const workerPorts = this.setupWorkerCommunication();

    const sharedBuffers = {
      gameObjectData: this.buffers.gameObjectData,
      // Neighbor data: SINGLE BUFFER (row ownership eliminates races)
      // "Torn reads" mix current + recent data (never garbage)
      // Distance checks filter any out-of-range neighbors
      neighborData: this.buffers.neighborData,
      collisionData: this.buffers.collisionData,
      activeEntitiesData: this.buffers.activeEntitiesData,
      visibleLightsData: this.buffers.visibleLightsData || null,
      inputData: this.buffers.inputData,
      cameraData: this.buffers.cameraData,
      debugData: this.buffers.debugData,
      debugDrawData: this.buffers.debugDrawData,
      frameRateData: this.buffers.frameRateData,
      componentData: this.buffers.componentData,
      // Spatial grid: SINGLE BUFFER with row-based partitioning
      gridBuffer: this.buffers.gridBuffer,
      // Cell sleeping state buffer: written by particle_worker, read by all workers
      cellSleepingBuffer: this.buffers.cellSleepingBuffer,
      // Interleaved entity position data: [x, y, halfExtent, pad] per entity (16 bytes each)
      entityPosData: this.buffers.entityPosData,
      // Worker stat buffers
      rendererStats: this.buffers.rendererStats,
      particleStats: this.buffers.particleStats,
      physicsStats: this.buffers.physicsStats,
      spatialStats: this.buffers.spatialStats,
      logicStats: this.buffers.logicStats,
      // Navigation buffers (if pathfinding enabled)
      navigationData: this.buffers.navigationData || null,
      navigationStats: this.buffers.navigationStats || null,
      // Tick decimation buffer (if staggeredUpdates enabled)
      nextTickData: this.buffers.nextTickData || null,
      // Mouse input buffer (x, y, buttons, presence, wheel, press/release counters)
      mouseData: this.buffers.mouseData,
      // Query system SABs (for component-based entity queries)
      queryEntityMetadata: this.buffers.queryEntityMetadata,
      queryCache: this.buffers.queryCache,
      queryResults: this.buffers.queryResults,
      queryVersion: this.buffers.queryVersion,
      // Per-type active entity lists (for O(1) type-specific queries)
      perTypeActiveLists: this.buffers.perTypeActiveLists,
      // Entity free lists (for atomic spawn/despawn from any worker)
      entityFreeLists: this.buffers.entityFreeLists,
      entityFreeListTops: this.buffers.entityFreeListTops,
    };

    const registeredClassesInfo = this.registeredClasses.map((r) => ({
      name: r.class.name,
      poolSize: r.count,
      startIndex: r.startIndex,
      endIndex: r.startIndex + r.count,
      entityType: r.entityType,
      components: r.components.map((c) => c.name),
    }));

    const componentPoolsInfo = Object.fromEntries(
      Object.entries(this.componentPools).map(([name, pool]) => [
        name,
        {
          count: this.totalEntityCount,
          componentId: pool.ComponentClass.componentId,
        },
      ])
    );

    // Create initialization data
    const frameRateStride = 16;
    const initData = {
      msg: 'init',
      buffers: sharedBuffers,
      frameRateStride,
      globalEntityCount: this.totalEntityCount,
      config: this.config,
      gridMetadata: this.gridMetadata,
      maxDebugDrawEntries: this.maxDebugDrawEntries,
      scriptsToLoad: scriptsToLoad,
      registeredClasses: registeredClassesInfo,
      componentPools: componentPoolsInfo,
      keyIndexMap: this.createKeyIndexMap(),
      spritesheetMetadata: SpriteSheetRegistry.serialize(),
      adobeAnimateMetadata: AdobeAnimRegistry.serialize(),
      maxParticles: this.config.particle.maxParticles,
      particleFreeList: this.buffers.particleFreeList || null,
      particleFreeListTop: this.buffers.particleFreeListTop || null,
      // Particle compact lists (for optimized iteration)
      activeParticlesData: this.buffers.activeParticlesData || null,
      visibleParticlesData: this.buffers.visibleParticlesData || null,
      maxDecorations: this.config.decoration.maxDecorations,
      maxAttachedDecorationsPerEntity: this.config.decoration.maxAttachedDecorationsPerEntity,
      decorationFreeList: this.buffers.decorationFreeList || null,
      decorationFreeListTop: this.buffers.decorationFreeListTop || null,
      // Decoration compact lists (for optimized iteration)
      activeDecorationsData: this.buffers.activeDecorationsData || null,
      visibleDecorationsData: this.buffers.visibleDecorationsData || null,
      attachedDecorationCount: this.buffers.attachedDecorationCount || null,
      attachedDecorationIndices: this.buffers.attachedDecorationIndices || null,
      // Bullet system
      maxBullets: this.config.bullet.maxBullets,
      bulletFreeList: this.buffers.bulletFreeList || null,
      bulletFreeListTop: this.buffers.bulletFreeListTop || null,
      activeBulletsData: this.buffers.activeBulletsData || null,
      visibleBulletsData: this.buffers.visibleBulletsData || null,
      impactBuffer: this.buffers.impactBuffer || null,
      totalLogicWorkers: this.numberOfLogicWorkers,
      // Render queue (pre_render_worker → pixi_worker) - DOUBLE BUFFERED
      // pre_render_worker writes to alternating buffers, pixi_worker reads latest
      // pixi_worker never waits; pre_render_worker waits if >1 frame ahead
      renderQueue: {
        dataA: this.buffers.renderQueueDataA,
        dataB: this.buffers.renderQueueDataB,
        cameraA: this.buffers.renderQueueCameraA,
        cameraB: this.buffers.renderQueueCameraB,
        sync: this.buffers.renderQueueSync,
        entityTextureData: this.buffers.entityTextureData,
        maxItems: this.maxVisibleRenderables,
        itemSize: 48, // bytes per item
      },
      // Texture metadata for globalTextureId computation
      textureMetadata: this.textureMetadata,
      decals: this.config.particle.decals
        ? {
          enabled: true,
          tileSize: this.config.particle.decalsTileSize,
          tilePixelSize: this.config.particle.decalsTilePixelSize,
          resolution: this.config.particle.decalsResolution,
          tilesX: this.decalsTilesX,
          tilesY: this.decalsTilesY,
          totalTiles: this.decalsTotalTiles,
          tilesRGBA: this.buffers.bloodTilesRGBA,
          tilesDirty: this.buffers.bloodTilesDirty,
          textures: this.decalTextureData,
        }
        : null,
      shadows: this.config.lighting.shadowsEnabled
        ? {
          enabled: true,
          maxShadowCastingLights: this.config.lighting.maxShadowCastingLights,
          maxShadowsPerLight: this.config.lighting.maxShadowsPerLight,
          maxShadowsPerEntity: this.config.lighting.maxShadowsPerEntity,
          maxShadowSprites: this.config.lighting.maxShadowSprites,
          maxLights: this.config.lighting.maxLights || 128,
          // Shadow render queue - DOUBLE BUFFERED (same sync as main queue)
          renderQueueDataA: this.buffers.shadowRenderQueueDataA,
          renderQueueDataB: this.buffers.shadowRenderQueueDataB,
          maxRenderItems: this.maxShadowRenderItems,
        }
        : null,
      // Raycasted light occlusion (visibility polygons) - DOUBLE BUFFERED
      visibilityPolygons: this.config.lighting.raycasted
        ? {
          enabled: true,
          maxPolygonVertices: this.config.lighting.maxPolygonVertices || 128,
          maxLights: this.config.lighting.maxLights || 128,
          dataA: this.buffers.visibilityPolygonDataA,
          dataB: this.buffers.visibilityPolygonDataB,
        }
        : null,
      // Sun/directional light system
      sunData: this.buffers.sunData || null,
      flashes:
        this.config.lighting.maxFlashes > 0
          ? {
            enabled: true,
            maxFlashes: this.config.lighting.maxFlashes,
            startIndex: Flash.startIndex,
          }
          : null,
      queries: this.querySystem.serialize(), // Pre-calculated entity queries
      // Static flowfields loaded from JSON (pre-baked direction grids for roads, sidewalks, etc.)
      staticFlowfields: NavGrid.serializeStaticFlowfields(),
      // Constraint system (distance constraints for position-based dynamics)
      constraints: this.config.physics.maxConstraints > 0
        ? {
          enabled: true,
          maxConstraints: this.config.physics.maxConstraints,
          data: this.buffers.constraintData,
          freeList: this.buffers.constraintFreeList,
          freeListTop: this.buffers.constraintFreeListTop,
        }
        : null,
      audio: {
        soundIdMap: SoundManager.exportSoundIdMap(),
        slotSAB: SoundManager.getSlotSABConfig(),
      },
      // Layer system data (static layer config + uniform SABs + per-layer render queues)
      layerData: Layer.getSerializableData(),
      // TileMap system data (SAB-backed tile data + metadata)
      tilemapData: TileMap.getSerializableData(),
      customLayerRenderQueues: this.customLayerRenderQueues,
    };

    // Initialize workers
    // Initialize multiple spatial workers (each builds full grid, processes subset of entities)
    // const numberOfSpatialWorkers = this.config.spatial.numberOfSpatialWorkers;

    // Calculate dynamic worker indices based on numberOfSpatialWorkers
    const PHYSICS_INDEX = numberOfSpatialWorkers;
    const RENDERER_INDEX = numberOfSpatialWorkers + 1;
    const PARTICLE_INDEX = numberOfSpatialWorkers + 2;
    const LOGIC_START_INDEX = numberOfSpatialWorkers + 3;

    console.log(`[Scene] 📤 Sending init messages to workers...`);
    for (let i = 0; i < numberOfSpatialWorkers; i++) {
      console.log(`[Scene]   → Initializing spatial worker ${i}...`);
      postWorkerInitMessage(this.workers.spatialWorkers[i], initData, {
        frameRateIndex: Scene.WORKER_INDICES.SPATIAL_START + i,
        workerIndex: i,
        totalSpatialWorkers: numberOfSpatialWorkers,
      });
    }

    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      console.log(`[Scene]   → Initializing logic worker ${i}...`);
      const logicPorts = workerPorts[`logic${i}`];
      postWorkerInitMessage(
        this.workers.logicWorkers[i],
        initData,
        {
          workerPorts: logicPorts,
          workerIndex: i, // For logic worker job partitioning (0, 1, 2, ...)
          frameRateIndex: LOGIC_START_INDEX + i, // For FPS tracking
          bigAtlasProxySheets: this.bigAtlasProxySheets || {},
        },
        getPortTransferables(logicPorts)
      );
    }

    console.log(`[Scene]   → Initializing physics worker...`);
    postWorkerInitMessage(
      this.workers.physics,
      initData,
      {
        workerPorts: workerPorts.physics,
        frameRateIndex: PHYSICS_INDEX,
      },
      getPortTransferables(workerPorts.physics)
    );

    // Particle worker - handles particles, decals, navigation, derived properties
    console.log(`[Scene]   → Initializing particle worker...`);
    // Create a MessageChannel for main thread ↔ particle worker communication (for nav requests)
    const mainToParticleChannel = new MessageChannel();
    const mainThreadNavPort = mainToParticleChannel.port1;
    const particleWorkerNavPort = mainToParticleChannel.port2;

    // Add the main thread port to particle worker's ports
    const particlePorts = workerPorts.particle || {};
    particlePorts.mainThread = particleWorkerNavPort;

    postWorkerInitMessage(
      this.workers.particle,
      initData,
      {
        workerPorts: particlePorts,
        frameRateIndex: PARTICLE_INDEX,
      },
      getPortTransferables(particlePorts)
    );

    // Set up the main thread's NavGrid port for sending requests (only if navigation enabled)
    if (this.config.navigation.enabled) {
      NavGrid.setNavWorkerPort(mainThreadNavPort);
      mainThreadNavPort.start();
    }

    // Pre-render worker - handles visibility, animation, render queues
    console.log(`[Scene]   → Initializing pre-render worker...`);
    const PRE_RENDER_INDEX = LOGIC_START_INDEX + this.numberOfLogicWorkers;

    postWorkerInitMessage(this.workers.preRender, initData, {
      buffers: {
        ...sharedBuffers,
        preRenderStats: this.buffers.preRenderStats,
      },
      frameRateIndex: PRE_RENDER_INDEX,
    });

    // Initialize renderer
    console.log(`[Scene]   → Initializing renderer worker...`);
    const offscreenCanvas = this.canvas.transferControlToOffscreen();

    // Build tilesetBitmaps map (only ImageBitmaps for PIXI Texture creation)
    // Tile data is already shared via TileMap SABs in initData.tilemapData
    const tilesetBitmaps = {};
    for (const [id, loaded] of Object.entries(this.loadedTilemaps || {})) {
      tilesetBitmaps[id] = loaded.tilesetBitmap;
    }

    const transferables = [
      offscreenCanvas,
      ...Object.values(this.loadedTextures),
      ...Object.values(this.loadedSpritesheets).map((sheet) => sheet.imageBitmap),
      ...Object.values(tilesetBitmaps),
      ...(workerPorts.renderer ? Object.values(workerPorts.renderer) : []),
    ];

    postWorkerInitMessage(
      this.workers.renderer,
      initData,
      {
        view: offscreenCanvas,
        textures: this.loadedTextures,
        spritesheets: this.loadedSpritesheets,
        tilesetBitmaps,
        bigAtlasProxySheets: this.bigAtlasProxySheets || {},
        frameRateIndex: RENDERER_INDEX,
        workerPorts: workerPorts.renderer,
      },
      transferables
    );
    console.log(`[Scene] ✅ All init messages sent to workers`);

    // Setup message handlers
    const allWorkers = this.getAllWorkers();

    console.log(`[Scene] 📨 Setting up message handlers for ${allWorkers.length} workers...`);
    for (let worker of allWorkers) {
      console.log(`[Scene]   → Setting up handlers for ${worker.name}`);
      worker.onmessage = (e) => {
        this.handleMessageFromWorker(e);
      };

      worker.onerror = (e) => {
        console.error(
          `❌ ERROR in ${worker.name} worker:\n`,
          `Message: ${e.message}\n`,
          `File: ${e.filename}:${e.lineno}:${e.colno}`,
          e
        );
      };
    }
    console.log(`[Scene] ✅ Message handlers set up`);
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
      // Atomic decrement to pop from free list (thread-safe)
      const oldTop = Atomics.sub(EntityClass.freeListTop, 0, 1);

      if (oldTop > 0) {
        // Got a valid index
        entityIndex = EntityClass.freeList[oldTop - 1];

        // NOTE: Do NOT set Transform.active here!
        // Worker 0 will set Transform.active = 1 after full setup.
        // Setting it here would cause spatial_worker to add entity to Grid
        // before it's in the active list (so it would never tick/despawn).
        //
        // We only set position so constraints can use the index immediately.
        Transform.x[entityIndex] = spawnConfig.x ?? 0;
        Transform.y[entityIndex] = spawnConfig.y ?? 0;
      } else {
        // Pool exhausted - restore counter
        Atomics.add(EntityClass.freeListTop, 0, 1);
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
    if (!EntityClass.startIndex || !EntityClass.poolSize) {
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
   * Get the total size of all SharedArrayBuffers used by the scene
   * @param {boolean} includeBreakdown - If true, returns an object with total and breakdown by category
   * @returns {number|object} Total size in bytes, or object with {total, breakdown} if includeBreakdown is true
   */
  getSharedBufferSize(includeBreakdown = false) {
    return getSharedBufferSizeFromBuffers(this.buffers, includeBreakdown);
  }
}

export { Scene };
