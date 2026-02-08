// Scene.js - Scene management with workers and entity pools
// Handles workers, SharedArrayBuffers, entity registration, and scene lifecycle
// This was previously GameEngine.js - renamed to better reflect its role

import { GameObject } from './gameObject.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { ParticleComponent } from '../components/ParticleComponent.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { DecorationPool } from './DecorationPool.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
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
import { DebugFlags } from './DebugFlags.js';
import { Mouse } from './Mouse.js';
import { Flash } from './Flash.js';
import { BigAtlasInspector } from './BigAtlasInspector.js';
import { Camera } from './Camera.js';
import { QuerySystem } from './QuerySystem.js';
import {
  SCENE_DEFAULTS,
  PHYSICS_DEFAULTS,
  SPATIAL_DEFAULTS,
  PARTICLE_DEFAULTS,
  DECORATION_DEFAULTS,
  LOGIC_DEFAULTS,
  RENDERER_DEFAULTS,
  LIGHTING_DEFAULTS,
  NAVIGATION_DEFAULTS,
} from './ConfigDefaults.js';
import { NavGrid } from './NavGrid.js';
import { Grid } from './Grid.js';
import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  NAVIGATION_STATS,
} from '../workers/workers-utils.js';
import { ParticleEmitter } from './ParticleEmitter.js';

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
  };

  // Static declarations - override these in subclasses
  static config = {};
  static assets = {};
  static entities = []; // [[EntityClass, poolSize], ...]

  static now = Date.now();

  constructor(game) {
    this.game = game; // Reference to GameEngine orchestrator
    this.log = [];
    this.loadedTextures = null;

    // Merge static config with any runtime config
    this.config = { ...this.constructor.config };
    this.imageUrls = { ...this.constructor.assets };

    this.seed = this.config.seed || Math.random();
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
      navigation: null, // Dedicated pathfinding worker (if navigation.enabled)
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
    // Particle worker always runs - it handles lighting, shadows, visibility, etc.
    this.workerReadyStates.particle = false;

    // Navigation worker (if pathfinding enabled)
    if (this.config.navigation.enabled) {
      this.workerReadyStates.navigation = false;
    }

    this.totalWorkers =
      3 +
      this.numberOfSpatialWorkers +
      numberOfLogicWorkers +
      (this.config.navigation.enabled ? 1 : 0);

    // Shared buffers
    this.buffers = {
      gameObjectData: null,
      neighborData: null,
      distanceData: null,
      collisionData: null,
      activeEntitiesData: null, // Active entity list for spatial worker load balancing
      inputData: null,
      cameraData: null,
      syncData: null,
      jobQueueData: null,
      debugData: null,
      raycastDebugData: null, // Raycast visualization data
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
    };

    // Component type ID tracking (similar to entityType)
    this.nextComponentId = 0;

    // Component pool tracking - assign componentId IDs to core and engine components
    this.componentPools = {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
      LightEmitter: { ComponentClass: LightEmitter },
      ShadowCaster: { ComponentClass: ShadowCaster },
      FlashComponent: { ComponentClass: FlashComponent },
    };

    // Assign componentId IDs to core and engine components
    Transform.componentId = this.nextComponentId++;
    RigidBody.componentId = this.nextComponentId++;
    Collider.componentId = this.nextComponentId++;
    SpriteRenderer.componentId = this.nextComponentId++;
    LightEmitter.componentId = this.nextComponentId++;
    ShadowCaster.componentId = this.nextComponentId++;
    FlashComponent.componentId = this.nextComponentId++;

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
    console.log(`[Scene] ✅ SharedArrayBuffer support confirmed`);

    // Load entity scripts dynamically in main thread (like workers do)
    console.log(`[Scene] 📜 Loading entity scripts in main thread...`);
    await this.loadEntityScriptsInMainThread();
    console.log(`[Scene] ✅ Entity scripts loaded`);

    // Create shared buffers
    console.log(`[Scene] 🗄️ Creating shared buffers...`);
    this.createSharedBuffers();
    console.log(`[Scene] ✅ Shared buffers created`);

    // Create workers
    console.log(`[Scene] 👷 Creating workers...`);
    await this.createWorkers();
    console.log(`[Scene] ✅ Workers created, waiting for ready signals...`);

    // Setup event listeners
    console.log(`[Scene] 🎧 Setting up event listeners...`);
    this.setupEventListeners();
    console.log(`[Scene] ✅ Event listeners set up`);

    // Start main loop
    console.log(`[Scene] 🔄 Starting main loop...`);
    this.startMainLoop();
    console.log(`[Scene] ✅ Main loop started`);

    // Update entity count display
    const numberBoidsElement = document.getElementById('numberBoids');
    if (numberBoidsElement) {
      numberBoidsElement.textContent = `Number of entities: ${this.totalEntityCount}`;
    }

    // Log current worker ready states
    console.log(`[Scene] ⏳ Waiting for workers to be ready...`);
    console.log(`[Scene] Current worker ready states:`, { ...this.workerReadyStates });
    console.log(`[Scene] Total workers expected: ${this.totalWorkers}`);

    // Wait for all workers to be ready
    await this.readyPromise;
    console.log(`[Scene] ✅ All workers are ready!`);

    // Expose scene and component references globally for console access
    console.log(`[Scene] 🌍 Exposing global references...`);
    this.exposeGlobalReferences();

    console.log(`✅ Scene ${this.constructor.name}: Initialized!`);
    console.log(
      `💡 Debug tip: Use 'scene', 'game', component classes, and entity classes from console`
    );

    // Call user's create() hook
    console.log(`[Scene] 🎨 Calling user's create() hook...`);
    this.create();
    console.log(`[Scene] ✅ User's create() hook completed`);
  }

  /**
   * Load entity scripts dynamically in main thread
   * Uses the unified loadEntityScripts function (auto-detects window context)
   */
  async loadEntityScriptsInMainThread() {
    const scriptsToLoad = [];

    // Collect script paths from registered entity classes
    for (const classInfo of this.registeredClasses) {
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
    window.SpriteSheetRegistry = SpriteSheetRegistry;
    window.Mouse = Mouse;
    window.Flash = Flash;
    window.NavGrid = NavGrid;
    window.Grid = Grid;
    window.DecorationPool = DecorationPool;

    console.log(
      `🌍 Exposed ${exposedEntities.length} entity classes and ${componentMap.size} components globally (${initializedCount} with SAB views)`
    );
    if (exposedEntities.length > 0) {
      console.log(`💡 Try: ${exposedEntities[0]}.forEach(i => console.log(i)) or RigidBody.vx[0]`);
    }
  }

  // User lifecycle hooks - override these in subclasses
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

  // ... (rest of the methods from GameEngine.js - kept exactly the same)
  // I'll include the essential ones inline and reference the rest

  createSharedBuffers() {
    // Mouse buffer: [x, y, button0, button1, button2, isPresent, wheel] - 7 Float32 values
    this.buffers.mouseData = new SharedArrayBuffer(Mouse.BUFFER_SIZE);
    Mouse.initialize(this.buffers.mouseData);

    // GameObject entity metadata buffer
    const gameObjectBufferSize = GameObject.getBufferSize(this.totalEntityCount);
    this.buffers.gameObjectData = new SharedArrayBuffer(gameObjectBufferSize);

    // ==========================================================================
    // NEIGHBOR DATA - Single Buffer (No Double Buffering)
    // ==========================================================================
    // Row ownership eliminates races: each spatial worker only writes neighbors
    // for entities in its owned rows. "Torn reads" just mix current + recent data
    // (never garbage), and distance checks filter any out-of-range neighbors.
    //
    // Layout per entity: [totalCount:Int32, collisionCount:Int32, neighbors[MAX_NEIGHBORS]:Int32]
    // Neighbors are partitioned: collision candidates first, then visual-only neighbors
    // Physics only iterates collisionCount, logic iterates totalCount
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    const maxNeighbors = this.config.spatial.maxNeighbors;
    const NEIGHBOR_BUFFER_SIZE = this.totalEntityCount * (2 + maxNeighbors) * 2; // Uint16 = 2 bytes
    this.buffers.neighborData = new SharedArrayBuffer(NEIGHBOR_BUFFER_SIZE);

    // Layout per entity: [dist2[MAX_NEIGHBORS]:Float32]
    const DISTANCE_BUFFER_SIZE = this.totalEntityCount * (2 + maxNeighbors) * 4;
    this.buffers.distanceData = new SharedArrayBuffer(DISTANCE_BUFFER_SIZE);

    // Number of spatial workers (used for stats buffer sizing)
    const numberOfSpatialWorkers = this.config.spatial.numberOfSpatialWorkers || 1;

    // Create tick decimation buffer if staggeredUpdates is enabled
    // Layout: 1 byte per entity (Uint8Array) - countdown until next tick
    if (this.config.logic.staggeredUpdates) {
      this.buffers.nextTickData = new SharedArrayBuffer(this.totalEntityCount);
    }

    GameObject.initializeArrays(
      this.buffers.gameObjectData,
      this.totalEntityCount,
      this.buffers.neighborData,
      this.buffers.distanceData,
      this.buffers.nextTickData || null
    );

    // Create Component buffers
    for (const [componentName, pool] of Object.entries(this.componentPools)) {
      if (pool.ComponentClass) {
        const ComponentClass = pool.ComponentClass;
        const bufferSize = ComponentClass.getBufferSize(this.totalEntityCount);
        this.buffers.componentData[componentName] = new SharedArrayBuffer(bufferSize);
        ComponentClass.initializeArrays(
          this.buffers.componentData[componentName],
          this.totalEntityCount
        );
      }
    }

    // ParticleComponent buffer
    const maxParticles = this.config.particle.maxParticles;
    if (maxParticles > 0) {
      const particleBufferSize = ParticleComponent.getBufferSize(maxParticles);
      this.buffers.componentData.ParticleComponent = new SharedArrayBuffer(particleBufferSize);
      ParticleComponent.initializeArrays(
        this.buffers.componentData.ParticleComponent,
        maxParticles
      );
      ParticleComponent.particleCount = maxParticles;

      // Create shared free list for O(1) particle allocation
      // freeList: Uint16Array of size maxParticles (stack of free indices)
      // freeListTop: Int32Array[1] (atomic counter for stack top)
      this.buffers.particleFreeList = new SharedArrayBuffer(maxParticles * 2); // Uint16 = 2 bytes
      this.buffers.particleFreeListTop = new SharedArrayBuffer(4); // Int32 = 4 bytes

      // Initialize free list with all indices (0, 1, 2, ..., maxParticles-1)
      const freeList = new Uint16Array(this.buffers.particleFreeList);
      for (let i = 0; i < maxParticles; i++) {
        freeList[i] = i;
      }
      // Stack top starts at maxParticles (all indices are free)
      new Int32Array(this.buffers.particleFreeListTop)[0] = maxParticles;
    }

    // DecorationComponent buffer
    const maxDecorations = this.config.decoration.maxDecorations;
    if (maxDecorations > 0) {
      const decorationBufferSize = DecorationComponent.getBufferSize(maxDecorations);
      this.buffers.componentData.DecorationComponent = new SharedArrayBuffer(decorationBufferSize);
      DecorationComponent.initializeArrays(
        this.buffers.componentData.DecorationComponent,
        maxDecorations
      );
      DecorationComponent.decorationCount = maxDecorations;

      // Create shared buffer for active decoration count (4 bytes for Uint32)
      this.buffers.decorationActiveCount = new SharedArrayBuffer(4);
      // Initialize to 0
      new Uint32Array(this.buffers.decorationActiveCount)[0] = 0;

      // Create shared buffers for active decoration indices (O(1) iteration in workers)
      // activeIndices: Uint16Array of active decoration indices
      // indexToActiveSlot: Uint16Array mapping decoration index → slot in activeIndices
      this.buffers.decorationActiveIndices = new SharedArrayBuffer(maxDecorations * 2); // Uint16 = 2 bytes
      this.buffers.decorationIndexToSlot = new SharedArrayBuffer(maxDecorations * 2);

      // Initialize DecorationPool on main thread for scene-level spawning
      DecorationPool.initialize(maxDecorations);
      DecorationPool.initializeActiveCount(this.buffers.decorationActiveCount);
      DecorationPool.initializeActiveIndices(
        this.buffers.decorationActiveIndices,
        this.buffers.decorationIndexToSlot
      );
    }

    // Shadow sprite system
    const maxShadowSprites = this.config.lighting.maxShadowSprites;
    if (this.config.lighting.shadowsEnabled && maxShadowSprites > 0) {
      const shadowSpriteBufferSize = ShadowCaster.getBufferSize(maxShadowSprites);
      this.buffers.shadowSpriteData = new SharedArrayBuffer(shadowSpriteBufferSize);
    }

    // Blood decals tilemap
    if (this.config.particle.decals) {
      const tileSize = this.config.particle.decalsTileSize;
      const tilePixelSize = this.config.particle.decalsTilePixelSize;
      const worldWidth = this.config.worldWidth;
      const worldHeight = this.config.worldHeight;

      const tilesX = Math.ceil(worldWidth / tileSize);
      const tilesY = Math.ceil(worldHeight / tileSize);
      const totalTiles = tilesX * tilesY;

      const bytesPerTile = tilePixelSize * tilePixelSize * 4;
      const totalTileBytes = totalTiles * bytesPerTile;

      this.buffers.bloodTilesRGBA = new SharedArrayBuffer(totalTileBytes);
      this.buffers.bloodTilesDirty = new SharedArrayBuffer(totalTiles);

      this.decalsTilesX = tilesX;
      this.decalsTilesY = tilesY;
      this.decalsTotalTiles = totalTiles;
    }

    // Navigation buffer (for pathfinding)
    if (this.config.navigation.enabled) {
      const navConfig = this.config.navigation;
      const { worldWidth, worldHeight } = this.config;

      // Calculate grid dimensions
      const gridWidth = Math.ceil(worldWidth / navConfig.cellSize);
      const gridHeight = Math.ceil(worldHeight / navConfig.cellSize);

      // Calculate SAB size and create buffer
      const navBufferSize = NavGrid.calculateSABSize(navConfig, gridWidth, gridHeight);
      this.buffers.navigationData = new SharedArrayBuffer(navBufferSize);

      // Write header
      NavGrid.writeHeader(this.buffers.navigationData, navConfig, gridWidth, gridHeight);

      // Initialize walkability to all walkable (nav worker will rebuild from static entities)
      const walkabilityOffset = 32; // After header
      const walkabilityArray = new Uint8Array(
        this.buffers.navigationData,
        walkabilityOffset,
        gridWidth * gridHeight
      );
      walkabilityArray.fill(1);

      // Store grid metadata for workers
      this.navigationMetadata = {
        gridWidth,
        gridHeight,
        cellSize: navConfig.cellSize,
        maxFlowfields: navConfig.maxFlowfields,
        maxPaths: navConfig.maxPaths,
        maxPathLength: navConfig.maxPathLength,
      };

      // Initialize NavGrid on main thread for DebugUI visualization
      NavGrid.initialize(this.buffers.navigationData, {
        worldWidth,
        worldHeight,
      });

      console.log(
        `[Scene] Navigation grid: ${gridWidth}x${gridHeight} cells (${navBufferSize} bytes)`
      );
    }

    // Pre-initialize entityType values
    this.preInitializeEntityTypeArrays();

    // Build query system for fast component-based entity filtering
    console.log('[Scene] Building query system...');
    this.querySystem.buildQueries(this.registeredClasses);

    // Define pre-computed queries for engine components
    this.querySystem.definePrecomputedQueries({
      Transform,
      RigidBody,
      Collider,
      SpriteRenderer,
      LightEmitter,
      ShadowCaster,
      FlashComponent,
    });

    // Create query system SABs
    const querySABs = this.querySystem.createSharedBuffers();
    this.buffers.queryEntityMetadata = querySABs.entityMetadataSAB;
    this.buffers.queryCache = querySABs.queryCacheSAB;
    this.buffers.queryResults = querySABs.queryResultsSAB;

    console.log('[Scene] Query system ready!');

    // Collision data buffer
    const maxCollisionPairs = this.config.physics.maxCollisionPairs;
    const COLLISION_BUFFER_SIZE = (1 + maxCollisionPairs * 2) * 4;
    this.buffers.collisionData = new SharedArrayBuffer(COLLISION_BUFFER_SIZE);
    this.views.collision = new Int32Array(this.buffers.collisionData);
    this.views.collision[0] = 0;

    // Active entities buffer - tracks which entities are active for spatial worker load balancing
    // Layout: [count, entityIdx0, entityIdx1, ...]
    // Now maintained incrementally by spawn/despawn instead of rebuilt each frame
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    const ACTIVE_ENTITIES_BUFFER_SIZE = (1 + this.totalEntityCount) * 2; // count + indices (Uint16)
    this.buffers.activeEntitiesData = new SharedArrayBuffer(ACTIVE_ENTITIES_BUFFER_SIZE);
    // Make active entities list accessible from main thread via GameObject.getAllActive()
    GameObject.activeEntitiesData = new Uint16Array(this.buffers.activeEntitiesData);

    // Per-type active entity lists - one SAB per entity type for O(1) type-specific queries
    // Layout: [count, entityIdx0, entityIdx1, ...] (same as global activeEntitiesData)
    // Maintained incrementally by spawn/despawn
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    this.buffers.perTypeActiveLists = {};
    for (const registration of this.registeredClasses) {
      const typeName = registration.class.name;
      const poolSize = registration.count;
      // Each type needs: 1 count + poolSize indices, as Uint16
      const bufferSize = (1 + poolSize) * 2;
      this.buffers.perTypeActiveLists[typeName] = new SharedArrayBuffer(bufferSize);

      // Also attach view to EntityClass on main thread for getAllActive() access
      const EntityClass = registration.class;
      EntityClass._activeList = new Uint16Array(this.buffers.perTypeActiveLists[typeName]);
      EntityClass._activeList[0] = 0; // Initialize count to 0
    }

    const INPUT_BUFFER_SIZE = this.inputBufferSize * 4;
    this.buffers.inputData = new SharedArrayBuffer(INPUT_BUFFER_SIZE);
    this.views.input = new Int32Array(this.buffers.inputData);

    // Camera buffer: [zoom, x, y, followTargetX, followTargetY, targetZoom]
    const CAMERA_BUFFER_SIZE = 6 * 4;
    this.buffers.cameraData = new SharedArrayBuffer(CAMERA_BUFFER_SIZE);
    this.views.camera = new Float32Array(this.buffers.cameraData);
    this.views.camera[0] = this.camera.zoom;
    // Initialize follow target to NaN (indicates no target)
    this.views.camera[3] = NaN;
    this.views.camera[4] = NaN;
    // Initialize target zoom to current zoom
    this.views.camera[5] = this.camera.zoom;

    // Initialize Camera static class with shared buffer
    Camera.initialize(this.views.camera, this.config.canvasWidth, this.config.canvasHeight);

    // Set world bounds for camera clamping
    if (this.config.worldWidth && this.config.worldHeight) {
      Camera.setWorldBounds(this.config.worldWidth, this.config.worldHeight);
    }

    // Debug buffer
    // Layout: [flags 0-15 as Uint8] [selectedEntityIndex at 16-19 as Int32]
    const DEBUG_BUFFER_SIZE = 32;
    this.buffers.debugData = new SharedArrayBuffer(DEBUG_BUFFER_SIZE);
    this.debugFlags = new DebugFlags(this.buffers.debugData);
    // Initialize selected entity to -1 (no selection)
    this.debugFlags.setSelectedEntity(-1);

    // Raycast debug buffer - stores recent raycasts for visualization
    // Layout: [count, ray0_startX, ray0_startY, ray0_endX, ray0_endY, ray0_hitX, ray0_hitY, ray0_hit, ray1_...]
    // 1 + maxRaycasts * 7 floats (startX, startY, endX, endY, hitX, hitY, hit)
    const maxDebugRaycasts = 100;
    const RAYCAST_DEBUG_SIZE = (1 + maxDebugRaycasts * 7) * 4; // Float32Array
    this.buffers.raycastDebugData = new SharedArrayBuffer(RAYCAST_DEBUG_SIZE);
    this.maxDebugRaycasts = maxDebugRaycasts;

    // FrameRate buffer: stores real-time FPS for each worker
    // Layout: [spatial0_fps, spatial1_fps, ..., physics_fps, renderer_fps, particle_fps, logic0_fps, logic1_fps, ...]
    const numSpatialWorkers = this.config.spatial.numberOfSpatialWorkers;
    const maxWorkers = numSpatialWorkers + 3 + this.numberOfLogicWorkers; // spatial workers + physics + renderer + particle + logic workers
    const FRAMERATE_BUFFER_SIZE = maxWorkers * 4; // 1 float per worker
    this.buffers.frameRateData = new SharedArrayBuffer(FRAMERATE_BUFFER_SIZE);
    this.views.frameRate = new Float32Array(this.buffers.frameRateData);

    // ==========================================================================
    // SPATIAL GRID - Row-Based Partitioned Single Buffer
    // ==========================================================================
    // ARCHITECTURE: Each spatial worker owns specific rows (cellY % workerCount === workerId)
    // - No double buffering for grid (row ownership eliminates races)
    // - No Atomics needed for grid writes
    // - Each worker rebuilds its own rows and computes neighbors for entities in those rows
    //
    // MEMORY LAYOUT PER CELL:
    // [count: Uint8, pad: 3 bytes, entities[MAX_ENTITIES_PER_CELL]: Uint32]
    // Total: 4 + 16*4 = 68 bytes per cell

    const cellSize = this.config.spatial?.cellSize || this.config.cellSize;
    const gridCols = Math.ceil(this.config.worldWidth / cellSize);
    const gridRows = Math.ceil(this.config.worldHeight / cellSize);
    const totalCells = gridCols * gridRows;
    const maxEntitiesPerCell = this.config.spatial.maxEntitiesPerCell; // Read from scene config

    // Cell byte size: 4 bytes (count + pad) + maxEntitiesPerCell * 4 bytes
    const CELL_BYTE_SIZE = 4 + maxEntitiesPerCell * 4;

    // SINGLE BUFFER: Row ownership eliminates need for double buffering
    const GRID_BUFFER_SIZE = totalCells * CELL_BYTE_SIZE;
    this.buffers.gridBuffer = new SharedArrayBuffer(GRID_BUFFER_SIZE);

    // CELL SLEEPING STATE BUFFER: Tracks sleeping state per cell (0=awake, 1=sleeping)
    // Written by particle_worker after physics updates, read by other workers for optimization
    // Layout: One Uint8 per cell (0 = awake, 1 = sleeping)
    // A cell is sleeping if ALL entities in it are either sleeping or static
    const CELL_SLEEPING_BUFFER_SIZE = totalCells * 1; // 1 byte per cell
    this.buffers.cellSleepingBuffer = new SharedArrayBuffer(CELL_SLEEPING_BUFFER_SIZE);

    // Pre-computed entity data: written by spatial workers during grid rebuild
    // Shared across all spatial workers for neighbor distance calculations
    // CACHE OPTIMIZED: Interleaved [x, y, halfExtent, pad] layout (16 bytes per entity)
    // This ensures all three values per entity are in a single cache line fetch
    // Access pattern: entityPosData[i * 4 + 0] = x, [i * 4 + 1] = y, [i * 4 + 2] = halfExtent
    const ENTITY_POS_DATA_SIZE = this.totalEntityCount * 4 * 4; // 4 floats × 4 bytes
    this.buffers.entityPosData = new SharedArrayBuffer(ENTITY_POS_DATA_SIZE);

    // Store grid metadata for workers
    this.gridMetadata = {
      cellSize,
      invCellSize: 1 / cellSize,
      gridCols,
      gridRows,
      totalCells,
      maxEntitiesPerCell,
      maxNeighbors, // Include maxNeighbors from scene config
      rowsPerBlock: this.config.spatial.rowsPerBlock, // Add this
    };

    // Initialize Grid on main thread for DebugUI visualization
    Grid.initialize(
      {
        gridBuffer: this.buffers.gridBuffer,
        neighborBuffer: this.buffers.neighborData,
        distanceBuffer: this.buffers.distanceData,
        cellSleepingBuffer: this.buffers.cellSleepingBuffer,
      },
      {
        cellSize,
        invCellSize: 1 / cellSize,
        gridWidth: gridCols,
        gridHeight: gridRows,
        totalCells,
        maxEntitiesPerCell,
        maxNeighbors,
        rowsPerBlock: this.config.spatial.rowsPerBlock,
      }
    );

    console.log(
      `[Scene] Spatial grid: ${gridCols}x${gridRows} cells (${totalCells} total), ` +
      `${cellSize}px cell size, ${GRID_BUFFER_SIZE} bytes (row-based partitioning)`
    );

    // Worker stat buffers: detailed metrics for each worker type
    // Each buffer uses strided layout for cache-line isolation (64 bytes per worker)
    this.buffers.rendererStats = new SharedArrayBuffer(RENDERER_STATS.BUFFER_SIZE);
    this.buffers.particleStats = new SharedArrayBuffer(PARTICLE_STATS.BUFFER_SIZE);
    this.buffers.physicsStats = new SharedArrayBuffer(PHYSICS_STATS.BUFFER_SIZE);
    this.buffers.spatialStats = new SharedArrayBuffer(
      SPATIAL_STATS.BUFFER_SIZE_PER_WORKER * numberOfSpatialWorkers
    );
    this.buffers.logicStats = new SharedArrayBuffer(
      LOGIC_STATS.BUFFER_SIZE_PER_WORKER * this.numberOfLogicWorkers
    );

    // Navigation stats buffer (if navigation enabled)
    if (this.config.navigation.enabled) {
      this.buffers.navigationStats = new SharedArrayBuffer(NAVIGATION_STATS.BUFFER_SIZE);
    }

    // Synchronization buffer
    const SYNC_BUFFER_SIZE = 5 * 4;
    this.buffers.syncData = new SharedArrayBuffer(SYNC_BUFFER_SIZE);
    const syncView = new Int32Array(this.buffers.syncData);
    syncView[0] = 0;
    syncView[1] = 0;

    const totalWorkers = this.config.logic.numberOfLogicWorkers;
    syncView[2] = totalWorkers;
    syncView[3] = 0;
    syncView[4] = 1;

    // Job queue buffer
    const entitiesPerJob = this.config.logic.numberOfEntitiesPerJob;
    const totalJobs = Math.ceil(this.totalEntityCount / entitiesPerJob);
    const JOB_QUEUE_SIZE = (2 + totalJobs * 2) * 4;
    this.buffers.jobQueueData = new SharedArrayBuffer(JOB_QUEUE_SIZE);
    const jobQueueView = new Int32Array(this.buffers.jobQueueData);
    jobQueueView[0] = 0;
    jobQueueView[1] = totalJobs;

    for (let i = 0; i < totalJobs; i++) {
      const startIndex = i * entitiesPerJob;
      const endIndex = Math.min((i + 1) * entitiesPerJob, this.totalEntityCount);
      jobQueueView[2 + i * 2] = startIndex;
      jobQueueView[2 + i * 2 + 1] = endIndex;
    }

    // Center camera on world
    const worldCenterX = this.config.worldWidth / 2 - this.config.canvasWidth / 2;
    const worldCenterY = this.config.worldHeight / 2 - this.config.canvasHeight / 2;
    this.camera.x = worldCenterX;
    this.camera.y = worldCenterY;

    this.views.camera[1] = this.camera.x;
    this.views.camera[2] = this.camera.y;
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

  async preloadAssets(imageUrls, spritesheetConfigs = {}) {
    this.loadedTextures = {};
    this.loadedSpritesheets = {};
    this.loadedTilemaps = {}; // Store loaded tilemap data

    console.log('🎨 Generating BigAtlas from all assets...');

    // Transform new format to old format expected by createBigAtlas
    // New format: { textures: {...}, spritesheets: {...} }
    // Old format: { texture1: "url", texture2: "url", spritesheets: {...} }
    const flattenedAssets = {};

    if (imageUrls.textures) {
      // Flatten textures to root level
      Object.assign(flattenedAssets, imageUrls.textures);
    }

    if (imageUrls.spritesheets) {
      // Keep spritesheets nested
      flattenedAssets.spritesheets = imageUrls.spritesheets;
    }

    // If imageUrls is already in old format (no textures/spritesheets keys), use as-is
    const assetsToLoad = imageUrls.textures || imageUrls.spritesheets ? flattenedAssets : imageUrls;

    try {
      const bigAtlas = await SpriteSheetRegistry.createBigAtlas(assetsToLoad, {
        maxWidth: 4096,
        maxHeight: 4096,
        padding: 2,
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
      console.log(`🗺️ Loading ${Object.keys(imageUrls.tilemaps).length} tilemaps...`);

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

          console.log(`  ✅ Loaded tilemap: ${tilemapId}`);
        } catch (error) {
          console.error(`❌ Failed to load tilemap "${tilemapId}":`, error);
        }
      }
    }
  }

  extractDecalTextures(atlasCanvas, atlasJson) {
    const ctx = atlasCanvas.getContext('2d');
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

    console.log(
      `📍 Extracted ${animationNames.length} animation textures + ${frameNames.length} frame textures for decals`
    );

    return textures;
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

    // Connect all logic workers to navigation worker (if enabled)
    // Logic workers send pathfinding requests, nav worker computes and writes to SAB
    if (this.config.navigation.enabled) {
      for (let i = 0; i < this.numberOfLogicWorkers; i++) {
        connections.push({ from: `logic${i}`, to: 'navigation' });
      }
    }

    return setupWorkerCommunication(connections);
  }

  async createWorkers() {
    const { canvasWidth, canvasHeight, worldWidth, worldHeight } = this.config;

    const cacheBust = `?v=${Date.now()}`;

    // Create multiple spatial workers for parallel neighbor detection
    const numberOfSpatialWorkers = this.config.spatial.numberOfSpatialWorkers;
    for (let i = 0; i < numberOfSpatialWorkers; i++) {
      const spatialWorker = new Worker(`/src/workers/spatial_worker.js${cacheBust}`, {
        type: 'module',
      });
      spatialWorker.name = `spatial${i}`;
      this.workers.spatialWorkers.push(spatialWorker);
    }

    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      const logicWorker = new Worker(`/src/workers/logic_worker.js${cacheBust}`, {
        type: 'module',
      });
      logicWorker.name = `logic${i}`;
      this.workers.logicWorkers.push(logicWorker);
    }

    this.workers.physics = new Worker(`/src/workers/physics_worker.js${cacheBust}`, {
      type: 'module',
    });
    this.workers.renderer = new Worker(`/src/workers/pixi_worker.js${cacheBust}`, {
      type: 'module',
    });

    // Particle worker always runs - handles particles, lighting, shadows, visibility, etc.
    this.workers.particle = new Worker(`/src/workers/particle_worker.js${cacheBust}`, {
      type: 'module',
    });

    this.workers.physics.name = 'physics';
    this.workers.renderer.name = 'renderer';
    this.workers.particle.name = 'particle';

    // Navigation worker (if pathfinding enabled)
    if (this.config.navigation.enabled) {
      this.workers.navigation = new Worker(`/src/workers/nav_worker.js${cacheBust}`, {
        type: 'module',
      });
      this.workers.navigation.name = 'navigation';
    }

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
    for (let i = 0; i < this.numberOfSpatialWorkers; i++) {
      this.workers.spatialWorkers[i].onerror = earlyErrorHandler(`spatial${i}`);
    }
    for (let i = 0; i < this.workers.logicWorkers.length; i++) {
      this.workers.logicWorkers[i].onerror = earlyErrorHandler(`logic${i}`);
    }
    if (this.workers.navigation) {
      this.workers.navigation.onerror = earlyErrorHandler('navigation');
    }

    // Preload assets
    const spritesheetConfigs = this.imageUrls.spritesheets || {};
    await this.preloadAssets(this.imageUrls, spritesheetConfigs);

    // Collect script paths
    const scriptsToLoad = [
      ...new Set(
        this.registeredClasses
          .map((r) => r.scriptPath)
          .filter((path) => path !== null && path !== undefined)
          .map((path) => {
            if (path.startsWith('/') || path.startsWith('http')) {
              return path;
            }
            if (path.startsWith('../')) {
              return path;
            }
            return `../${path}`;
          })
      ),
    ];

    const workerPorts = this.setupWorkerCommunication();

    // Create initialization data
    const initData = {
      msg: 'init',
      buffers: {
        gameObjectData: this.buffers.gameObjectData,
        // Neighbor data: SINGLE BUFFER (row ownership eliminates races)
        // "Torn reads" mix current + recent data (never garbage)
        // Distance checks filter any out-of-range neighbors
        neighborData: this.buffers.neighborData,
        distanceData: this.buffers.distanceData,
        collisionData: this.buffers.collisionData,
        activeEntitiesData: this.buffers.activeEntitiesData,
        inputData: this.buffers.inputData,
        cameraData: this.buffers.cameraData,
        syncData: this.buffers.syncData,
        jobQueueData: this.buffers.jobQueueData,
        debugData: this.buffers.debugData,
        raycastDebugData: this.buffers.raycastDebugData,
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
        // Mouse input buffer (x, y, buttons, presence, wheel)
        mouseData: this.buffers.mouseData,
        // Query system SABs (for component-based entity queries)
        queryEntityMetadata: this.buffers.queryEntityMetadata,
        queryCache: this.buffers.queryCache,
        queryResults: this.buffers.queryResults,
        // Per-type active entity lists (for O(1) type-specific queries)
        perTypeActiveLists: this.buffers.perTypeActiveLists,
      },
      globalEntityCount: this.totalEntityCount,
      config: this.config,
      gridMetadata: this.gridMetadata,
      maxDebugRaycasts: this.maxDebugRaycasts,
      scriptsToLoad: scriptsToLoad,
      registeredClasses: this.registeredClasses.map((r) => ({
        name: r.class.name,
        poolSize: r.count,
        startIndex: r.startIndex,
        endIndex: r.startIndex + r.count,
        entityType: r.entityType,
        components: r.components.map((c) => c.name),
      })),
      componentPools: Object.fromEntries(
        Object.entries(this.componentPools).map(([name, pool]) => [
          name,
          {
            count: this.totalEntityCount,
            componentId: pool.ComponentClass.componentId,
          },
        ])
      ),
      keyIndexMap: this.createKeyIndexMap(),
      spritesheetMetadata: SpriteSheetRegistry.serialize(),
      maxParticles: this.config.particle.maxParticles,
      particleFreeList: this.buffers.particleFreeList || null,
      particleFreeListTop: this.buffers.particleFreeListTop || null,
      maxDecorations: this.config.decoration.maxDecorations,
      decorationActiveCount: this.buffers.decorationActiveCount || null,
      decorationActiveIndices: this.buffers.decorationActiveIndices || null,
      decorationIndexToSlot: this.buffers.decorationIndexToSlot || null,
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
          spriteData: this.buffers.shadowSpriteData,
        }
        : null,
      flashes:
        this.config.lighting.maxFlashes > 0
          ? {
            enabled: true,
            maxFlashes: this.config.lighting.maxFlashes,
            startIndex: Flash.startIndex,
          }
          : null,
      queries: this.querySystem.serialize(), // Pre-calculated entity queries
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
      this.workers.spatialWorkers[i].postMessage({
        ...initData,
        frameRateIndex: Scene.WORKER_INDICES.SPATIAL_START + i,
        workerIndex: i,
        totalSpatialWorkers: numberOfSpatialWorkers,
      });
    }

    for (let i = 0; i < this.numberOfLogicWorkers; i++) {
      console.log(`[Scene]   → Initializing logic worker ${i}...`);
      this.workers.logicWorkers[i].postMessage(
        {
          ...initData,
          workerPorts: workerPorts[`logic${i}`],
          workerIndex: i, // For logic worker job partitioning (0, 1, 2, ...)
          frameRateIndex: LOGIC_START_INDEX + i, // For FPS tracking
          bigAtlasProxySheets: this.bigAtlasProxySheets || {},
        },
        workerPorts[`logic${i}`] ? Object.values(workerPorts[`logic${i}`]) : []
      );
    }

    console.log(`[Scene]   → Initializing physics worker...`);
    this.workers.physics.postMessage(
      {
        ...initData,
        workerPorts: workerPorts.physics,
        frameRateIndex: PHYSICS_INDEX,
      },
      workerPorts.physics ? Object.values(workerPorts.physics) : []
    );

    // Particle worker always receives init data
    console.log(`[Scene]   → Initializing particle worker...`);
    this.workers.particle.postMessage({
      ...initData,
      frameRateIndex: PARTICLE_INDEX,
    });

    // Navigation worker (if pathfinding enabled)
    if (this.config.navigation.enabled && this.workers.navigation) {
      console.log(`[Scene]   → Initializing navigation worker...`);
      const NAV_INDEX = LOGIC_START_INDEX + this.numberOfLogicWorkers;

      // Create a MessageChannel for main thread ↔ nav worker communication
      const mainToNavChannel = new MessageChannel();

      // Keep port1 for main thread, send port2 to nav worker
      const mainThreadNavPort = mainToNavChannel.port1;
      const navWorkerPort = mainToNavChannel.port2;

      // Add the main thread port to nav worker's ports
      const navPorts = workerPorts.navigation || {};
      navPorts.mainThread = navWorkerPort;

      this.workers.navigation.postMessage(
        {
          ...initData,
          workerPorts: navPorts,
          frameRateIndex: NAV_INDEX,
        },
        Object.values(navPorts)
      );

      // Set up the main thread's NavGrid port for sending requests
      NavGrid.setNavWorkerPort(mainThreadNavPort);
      mainThreadNavPort.start(); // Required to start receiving messages
    }

    // Initialize renderer
    console.log(`[Scene]   → Initializing renderer worker...`);
    const offscreenCanvas = this.canvas.transferControlToOffscreen();

    const transferables = [
      offscreenCanvas,
      ...Object.values(this.loadedTextures),
      ...Object.values(this.loadedSpritesheets).map((sheet) => sheet.imageBitmap),
      ...Object.values(this.loadedTilemaps || {}).map((tilemap) => tilemap.tilesetBitmap),
      ...(workerPorts.renderer ? Object.values(workerPorts.renderer) : []),
    ];

    this.workers.renderer.postMessage(
      {
        ...initData,
        view: offscreenCanvas,
        textures: this.loadedTextures,
        spritesheets: this.loadedSpritesheets,
        tilemaps: this.loadedTilemaps || {}, // Pass loaded tilemap data
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
    if (e.data.msg === 'fps') {
      // Store worker stats (DebugUI will read these)
      this._storeWorkerStats(e.currentTarget.name, e.data.fps, e.data.activeEntities, e.data);
    } else if (e.data.msg === 'log') {
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
      console.log(`[Scene] 🎉 All workers are ready! Starting all workers...`);
      this.startAllWorkers();
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

  /**
   * Store worker stats (called from worker messages, read by DebugUI)
   */
  _storeWorkerStats(id, fps, activeEntities, data = {}) {
    // Handle spatial workers (spatial0, spatial1, etc.)
    if (id.startsWith('spatial')) {
      const index = parseInt(id.replace('spatial', ''), 10);
      if (this.workerStats.spatial[index]) {
        this.workerStats.spatial[index] = {
          fps,
          active: activeEntities || 0,
        };
      }
      return;
    }

    // Handle logic workers (logic0, logic1, etc.)
    if (id.startsWith('logic')) {
      const index = parseInt(id.replace('logic', ''), 10);
      if (this.workerStats.logic[index]) {
        this.workerStats.logic[index] = {
          fps,
          active: activeEntities || 0,
        };
      }
      return;
    }

    // Handle other workers
    switch (id) {
      case 'physics':
        this.workerStats.physics = { fps, active: activeEntities || 0 };
        break;
      case 'renderer':
        this.workerStats.renderer = {
          fps,
          drawCalls: data.drawCalls || 0,
          visibleEntities: data.visibleEntities || 0,
          visibleParticles: data.visibleParticles || 0,
        };
        break;
      case 'particle':
        this.workerStats.particle = {
          fps,
          active: data.activeParticles || 0,
          total: data.totalParticles || 0,
        };
        break;
    }
  }

  setupEventListeners() {
    // Store bound handlers so we can remove them later
    this._keydownHandler = (e) => {
      const key = e.key.toLowerCase();
      this.keyboard[key] = true;
      this.updateKeyboardBuffer();
    };

    this._keyupHandler = (e) => {
      const key = e.key.toLowerCase();
      this.keyboard[key] = false;
      this.updateKeyboardBuffer();
    };

    this._mousedownHandler = (e) => {
      // Skip button state updates when debug tool is active (DebugUI painter/eraser)
      if (Mouse.isDebugToolActive) return;
      if (e.button == 0) Mouse.isButton0Down = true;
      if (e.button == 1) Mouse.isButton1Down = true;
      if (e.button == 2) Mouse.isButton2Down = true;
    };

    this._mouseupHandler = (e) => {
      // Always process mouseup to prevent stuck button state
      if (e.button == 0) Mouse.isButton0Down = false;
      if (e.button == 1) Mouse.isButton1Down = false;
      if (e.button == 2) Mouse.isButton2Down = false;
    };

    this._mousemoveHandler = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      Mouse.isPresent = true;
      Mouse.setCanvasPosition(e.clientX - rect.left, e.clientY - rect.top, this.camera);
    };

    this._mouseleaveHandler = () => {
      Mouse.isPresent = false;
    };

    this._wheelHandler = (e) => {
      e.preventDefault();

      // Accumulate wheel delta for this frame (devs read Mouse.wheel in tick)
      Mouse.wheel += e.deltaY;
    };

    window.addEventListener('keydown', this._keydownHandler);
    window.addEventListener('keyup', this._keyupHandler);
    this.canvas.addEventListener('mousedown', this._mousedownHandler);
    this.canvas.addEventListener('mouseup', this._mouseupHandler);
    this.canvas.addEventListener('mousemove', this._mousemoveHandler);
    this.canvas.addEventListener('mouseleave', this._mouseleaveHandler);
    window.addEventListener('wheel', this._wheelHandler, { passive: false });
  }

  updateKeyboardBuffer() {
    const input = this.views.input;
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

    // Note: Camera following is now handled in Player.tick() which writes directly to cameraData SharedArrayBuffer
    // Main thread reads from cameraData and syncs to this.camera in updateCameraBuffer()
    this.updateCameraBuffer();

    // Visible/active units are now read directly by DebugUI from Transform/SpriteRenderer arrays

    // Call user's update hook
    this.update(dtRatio, deltaTime, performance.now(), this.mainFrameNumber);

    // Reset per-frame input state (after update so devs can read it)
    Mouse.wheel = 0;
  }

  createKeyIndexMap() {
    return this.keyMap;
  }

  async destroy() {
    console.log(`🔴 Scene ${this.constructor.name}: Destroying...`);

    // Stop the main loop immediately
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Terminate all workers
    const allWorkers = this.getAllWorkers();

    allWorkers.forEach((worker) => {
      if (worker) worker.terminate();
    });

    // Remove event listeners
    if (this._keydownHandler) {
      window.removeEventListener('keydown', this._keydownHandler);
    }
    if (this._keyupHandler) {
      window.removeEventListener('keyup', this._keyupHandler);
    }
    if (this._mousedownHandler) {
      this.canvas.removeEventListener('mousedown', this._mousedownHandler);
    }
    if (this._mouseupHandler) {
      this.canvas.removeEventListener('mouseup', this._mouseupHandler);
    }
    if (this._mousemoveHandler) {
      this.canvas.removeEventListener('mousemove', this._mousemoveHandler);
    }
    if (this._mouseleaveHandler) {
      this.canvas.removeEventListener('mouseleave', this._mouseleaveHandler);
    }
    if (this._wheelHandler) {
      window.removeEventListener('wheel', this._wheelHandler);
    }

    // Clear keyboard state
    this.keyboard = {};

    // Clear all entity instances
    for (const registration of this.registeredClasses) {
      const EntityClass = registration.class;
      if (EntityClass.instances) {
        EntityClass.instances = [];
      }
      if (EntityClass.poolSize !== undefined) {
        EntityClass.poolSize = 0;
      }
    }

    // Clear gameObjects array
    this.gameObjects = [];

    // Reset component arrays to initial state (all inactive)
    if (Transform.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        Transform.active[i] = 0;
      }
    }
    if (RigidBody.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        RigidBody.active[i] = 0;
      }
    }
    if (Collider.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        Collider.active[i] = 0;
      }
    }
    if (SpriteRenderer.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        SpriteRenderer.active[i] = 0;
      }
    }

    // Reset GameObject active array
    if (GameObject.active) {
      for (let i = 0; i < this.totalEntityCount; i++) {
        GameObject.active[i] = 0;
      }
    }

    // Clear activeEntitiesData buffer (incremental active entity management)
    if (GameObject.activeEntitiesData) {
      GameObject.activeEntitiesData[0] = 0; // Set count to 0
    }

    // Clear all query result buffers (incremental active entity management)
    if (this.querySystem && this.querySystem.queryResultViews) {
      for (const view of this.querySystem.queryResultViews) {
        view[0] = 0; // Set count to 0 for each query buffer
      }
    }

    // Clear per-type active lists (incremental active entity management)
    if (this.buffers.perTypeActiveLists) {
      for (const typeName in this.buffers.perTypeActiveLists) {
        const sab = this.buffers.perTypeActiveLists[typeName];
        const view = new Uint16Array(sab);
        view[0] = 0; // Set count to 0 for each type
      }
    }

    // Clear ParticleComponent if it exists
    if (ParticleComponent.active) {
      for (let i = 0; i < this.config.particle.maxParticles; i++) {
        ParticleComponent.active[i] = 0;
      }
    }

    // Clear DecorationComponent if it exists
    if (DecorationComponent.active) {
      for (let i = 0; i < this.config.decoration.maxDecorations; i++) {
        DecorationComponent.active[i] = 0;
      }
    }

    // Reset Mouse state
    Mouse.isPresent = false;
    Mouse.isButton0Down = false;
    Mouse.isButton1Down = false;
    Mouse.isButton2Down = false;

    // Clear Flash if it was initialized
    if (this.config.lighting.maxFlashes > 0 && Flash.instances) {
      Flash.instances = [];
    }

    // Clear global rng reference
    if (globalThis.rng === this.rng) {
      globalThis.rng = null;
    }

    // Clear registered classes for next scene
    this.registeredClasses = [];
    this.totalEntityCount = 0;

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

  spawnEntity(EntityClassOrName, spawnConfig = {}) {
    // Accept either a class or a string name
    const className =
      typeof EntityClassOrName === 'function' ? EntityClassOrName.name : EntityClassOrName;

    if (this.workers.logicWorkers && this.workers.logicWorkers.length > 0) {
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({
          msg: 'spawn',
          className: className,
          spawnConfig: spawnConfig,
        });
      });
    }
  }

  despawnEntity(entityIndex) {
    if (this.workers.logicWorkers && this.workers.logicWorkers.length > 0) {
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({
          msg: 'despawn',
          entityIndex: entityIndex,
        });
      });
    }
  }

  despawnAllEntities(className) {
    if (this.workers.logicWorkers && this.workers.logicWorkers.length > 0) {
      this.workers.logicWorkers.forEach((worker) => {
        worker.postMessage({
          msg: 'despawnAll',
          className: className,
        });
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

  // ========================================
  // BACKGROUND CONTROL METHODS
  // ========================================

  /**
   * Set a static background (simple Sprite, does not tile)
   * @param {string} textureId - ID of texture in assets.textures
   */
  setStaticBackground(textureId) {
    if (!this.workers.renderer) {
      console.warn('Renderer worker not initialized');
      return;
    }

    this.workers.renderer.postMessage({
      msg: 'setBackground',
      type: 'static',
      textureId: textureId,
    });
  }

  /**
   * Set a tiling background (TilingSprite - repeats pattern)
   * @param {string} textureId - ID of texture in assets.textures
   * @param {number} tileScale - Scale of tiles (default: 1)
   */
  setTilingBackground(textureId, tileScale = 1) {
    if (!this.workers.renderer) {
      console.warn('Renderer worker not initialized');
      return;
    }

    this.workers.renderer.postMessage({
      msg: 'setBackground',
      type: 'tiling',
      textureId: textureId,
      tileScale: tileScale,
    });
  }

  /**
   * Set a tilemap background (@pixi/tilemap - varied tiles from Tiled editor)
   * @param {string} tilemapId - ID of tilemap in assets.tilemaps
   * @param {object} options - Options: { layers: [...], scale: 1 }
   */
  setTilemapBackground(tilemapId, options = {}) {
    if (!this.workers.renderer) {
      console.warn('Renderer worker not initialized');
      return;
    }

    // Check if the tilemap asset exists
    if (!this.loadedTilemaps || !this.loadedTilemaps[tilemapId]) {
      const availableTilemaps = this.loadedTilemaps ? Object.keys(this.loadedTilemaps) : [];
      console.error(
        `Tilemap "${tilemapId}" not found. ` +
        `Available tilemaps: [${availableTilemaps.join(', ') || 'none'}]`
      );
      return;
    }

    this.workers.renderer.postMessage({
      msg: 'setBackground',
      type: 'tilemap',
      tilemapId: tilemapId,
      options: options,
    });
  }

  /**
   * Remove the current background
   */
  clearBackground() {
    if (!this.workers.renderer) {
      console.warn('Renderer worker not initialized');
      return;
    }

    this.workers.renderer.postMessage({
      msg: 'setBackground',
      type: 'none',
    });
  }

  /**
   * Get the total size of all SharedArrayBuffers used by the scene
   * @param {boolean} includeBreakdown - If true, returns an object with total and breakdown by category
   * @returns {number|object} Total size in bytes, or object with {total, breakdown} if includeBreakdown is true
   */
  getSharedBufferSize(includeBreakdown = false) {
    if (!this.buffers) {
      return includeBreakdown ? { total: 0, breakdown: {} } : 0;
    }

    let total = 0;
    const breakdown = {};

    // Helper to safely get buffer size
    const getBufferSize = (buffer) => {
      if (!buffer || !(buffer instanceof SharedArrayBuffer)) return 0;
      return buffer.byteLength;
    };

    // Core entity buffers
    breakdown.gameObjectData = getBufferSize(this.buffers.gameObjectData);
    breakdown.neighborData = getBufferSize(this.buffers.neighborData);
    breakdown.distanceData = getBufferSize(this.buffers.distanceData);
    breakdown.collisionData = getBufferSize(this.buffers.collisionData);
    breakdown.activeEntitiesData = getBufferSize(this.buffers.activeEntitiesData);

    // Input and camera buffers
    breakdown.inputData = getBufferSize(this.buffers.inputData);
    breakdown.cameraData = getBufferSize(this.buffers.cameraData);
    breakdown.mouseData = getBufferSize(this.buffers.mouseData);

    // Synchronization and job queue buffers
    breakdown.syncData = getBufferSize(this.buffers.syncData);
    breakdown.jobQueueData = getBufferSize(this.buffers.jobQueueData);

    // Debug buffers
    breakdown.debugData = getBufferSize(this.buffers.debugData);
    breakdown.raycastDebugData = getBufferSize(this.buffers.raycastDebugData);
    breakdown.frameRateData = getBufferSize(this.buffers.frameRateData);

    // Component buffers (nested object)
    breakdown.componentData = {};
    let componentDataTotal = 0;
    if (this.buffers.componentData) {
      for (const [componentName, componentBuffer] of Object.entries(this.buffers.componentData)) {
        const size = getBufferSize(componentBuffer);
        breakdown.componentData[componentName] = size;
        componentDataTotal += size;
      }
    }
    breakdown.componentDataTotal = componentDataTotal;

    // Spatial grid buffers
    breakdown.gridBuffer = getBufferSize(this.buffers.gridBuffer);
    breakdown.entityPosData = getBufferSize(this.buffers.entityPosData);

    // Worker stat buffers
    breakdown.rendererStats = getBufferSize(this.buffers.rendererStats);
    breakdown.particleStats = getBufferSize(this.buffers.particleStats);
    breakdown.physicsStats = getBufferSize(this.buffers.physicsStats);
    breakdown.spatialStats = getBufferSize(this.buffers.spatialStats);
    breakdown.logicStats = getBufferSize(this.buffers.logicStats);

    // Optional buffers
    breakdown.nextTickData = getBufferSize(this.buffers.nextTickData);
    breakdown.shadowSpriteData = getBufferSize(this.buffers.shadowSpriteData);
    breakdown.bloodTilesRGBA = getBufferSize(this.buffers.bloodTilesRGBA);
    breakdown.bloodTilesDirty = getBufferSize(this.buffers.bloodTilesDirty);
    breakdown.navigationData = getBufferSize(this.buffers.navigationData);
    breakdown.navigationStats = getBufferSize(this.buffers.navigationStats);
    breakdown.decorationActiveCount = getBufferSize(this.buffers.decorationActiveCount);

    // Calculate total
    for (const value of Object.values(breakdown)) {
      if (typeof value === 'number') {
        total += value;
      }
    }

    if (includeBreakdown) {
      return {
        total,
        breakdown,
        // Human-readable format
        totalFormatted: this._formatBytes(total),
      };
    }

    return total;
  }

  /**
   * Format bytes to human-readable string
   * @private
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  }
}

export { Scene };
