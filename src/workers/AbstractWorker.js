// AbstractWorker.js - Base class for all game engine workers
// Provides common functionality: frame timing,  FPS tracking, pause state, message handling

import { GameObject, SpriteSheetRegistry } from '../core/gameObject.js';
import Keyboard from '../core/Keyboard.js';
import { Mouse } from '../core/Mouse.js';
import { ParticleEmitter } from '../core/ParticleEmitter.js';
import { DecorationPool } from '../core/DecorationPool.js';
import { BulletPool } from '../core/BulletPool.js';
import { BulletComponent } from '../components/BulletComponent.js';
import { Flash } from '../core/Flash.js';
import {
  seededRandom,
  loadEntityScripts,
  collectAllComponentsFromClasses,
  initializeComponentViews,
  exposeComponentsGlobally,
  exposeEntityClassesGlobally,
  randomColor,
  distanceSq2D,
  getDirectionFromAngle,
  containerRadius,
} from '../core/utils.js';
import { Camera } from '../core/Camera.js';
import { Sun } from '../core/Sun.js';
import { Layer } from '../core/Layer.js';
import { TileMap } from '../core/TileMap.js';
import { Ray } from '../core/Ray.js';
import { DebugDraw } from '../core/debug/DebugDraw.js';
import { Grid } from '../core/Grid.js';
import { NavGrid } from '../core/NavGrid.js';
import { ParticleComponent } from '../components/ParticleComponent.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { Constraint } from '../core/Constraint.js';
import { SoundManager } from '../core/SoundManager.js';
import { createWorkerQueryFunctions } from '../core/QuerySystem.js';

import { Component } from '../core/Component.js';
import { FSM } from '../core/FSM.js';
import { FSMState } from '../core/FSMState.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { CameraInOutListener } from '../components/CameraInOutListener.js';
import { CollisionListener } from '../components/CollisionListener.js';
import { ShapeType } from '../core/ConfigDefaults.js';

/**
 * AbstractWorker - Base class for all game engine workers
 * Handles common worker functionality like frame timing, FPS tracking, and message handling
 */
export class AbstractWorker {
  constructor(selfRef) {
    this.self = selfRef;

    // Message queue to ensure sequential processing of async messages
    this._messageQueue = Promise.resolve();

    this.self.onmessage = (e) => {
      this._messageQueue = this._messageQueue
        .then(async () => {
          const shouldProfileMessages = !!this.stats;
          const startTime = shouldProfileMessages ? performance.now() : 0;

          await this.handleMessage(e);

          if (shouldProfileMessages) {
            this.messageTimeThisFrame += performance.now() - startTime;
          }
        })
        .catch((error) => {
          console.error(`[${this.constructor.name}] Error in handleMessage:`, error);
          this.reportError('Worker message handling failed', error);
        });
    };

    // Frame timing and FPS tracking
    this.frameNumber = 0;
    this.lastFrameTime = performance.now();
    this.accumulatedTime = 0; // Total time elapsed since start (in seconds)
    this.currentFPS = 0;

    // Stats buffer for writing detailed metrics (set during initialization)
    this.stats = null; // Float32Array view into worker's stat buffer

    // State
    this.isPaused = true;
    this.globalEntityCount = 0;
    this.config = {};

    // Scheduling
    this.usesCustomScheduler = false; // Override in subclass if using custom scheduler
    this.noLimitFPS = false; // Set to true to run as fast as possible (no RAF limiting)
    this.timeoutId = null; // Store timeout ID for clearing

    // Script loading (ALL workers now load scripts and initialize components)
    // This flag now indicates if worker needs to CREATE GameObject instances (logic workers only)
    this.needsGameScripts = true; // Override to false in generic workers (spatial, physics)

    // Shared buffers (common to most workers)
    // Following the naming pattern: xBuffer (SharedArrayBuffer) -> xData (TypedArray view)
    this.inputData = null;
    this.cameraData = null;
    this.neighborData = null;
    this.activeEntitiesData = null; // Compact list of active entity indices [count, idx0, idx1, ...]
    this.frameRateData = null; // Real-time FPS tracking for all workers
    this.frameRateIndex = -1; // Index into frameRateData array (different from workerIndex used by logic workers!)

    // Registered entity classes information (set during initialization)
    this.registeredClasses = [];

    // Query system cache for component-based entity filtering
    this.emptyQueryWarnings = new Set(); // Track empty query warnings (log once per query key)

    // Pre-allocated empty array for query fallbacks
    this._emptyUint16Array = new Uint16Array(0);

    // MessagePorts for direct worker-to-worker communication
    this.workerPorts = new Map(); // Map<workerName, MessagePort>

    // Bind methods
    this.gameLoop = this.gameLoop.bind(this);
    this.handleMessage = this.handleMessage.bind(this);

    // PERFORMANCE: Reusable timing object to avoid GC pressure
    // This is returned by updateFrameTiming() every frame on every worker
    this._timing = {
      deltaTime: 0,
      dtRatio: 1,
    };

    // Lightweight worker diagnostics written into the existing stats buffers.
    this.messageTimeThisFrame = 0;

    this.reportLog('finished constructor');
  }

  /**
   * Calculate delta time and update FPS
   * @returns {Object} - { deltaTime, dtRatio }
   */
  updateFrameTiming() {
    const now = performance.now();
    const deltaTime = Math.min(now - this.lastFrameTime, 100);
    this.lastFrameTime = now;

    // Calculate instantaneous FPS
    const instantaneousFPS = 1000 / deltaTime;
    this.currentFPS = instantaneousFPS;

    // Write instantaneous FPS to shared frameRateData buffer
    // This allows the renderer to know each worker's FPS for smooth interpolation
    // (e.g., renderer interpolates positions when rendering faster than physics)
    if (this.frameRateData && this.frameRateIndex >= 0) {
      this.frameRateData[this.frameRateIndex] = instantaneousFPS;
    }

    // Normalize delta time to 60fps (16.67ms per frame)
    const dtRatio = deltaTime / 16.67;

    // Accumulate total time in seconds
    this.accumulatedTime += deltaTime;

    // Reuse timing object to avoid GC pressure
    this._timing.deltaTime = deltaTime;
    this._timing.dtRatio = dtRatio;

    return this._timing;
  }

  /**
   * Report FPS to main thread (DEPRECATED - now using stat buffers)
   * Subclasses can override this to write additional stats to their stat buffer
   */
  reportFPS() {
    // Base implementation does nothing - stats are written directly to SharedArrayBuffer
    // Subclasses override this to write their specific stats
  }

  reportLog(message) {
    self.postMessage({ msg: 'log', message, when: Date.now() });
  }

  reportError(title, error) {
    console.error(`❌ [${this.constructor.name}] ${title}:`, error);
    self.postMessage({
      msg: 'error',
      title,
      message: error?.message || String(error),
      stack: error?.stack,
      when: Date.now(),
    });
  }

  /**
   * Main game loop - calls update() method each frame
   * @param {boolean} resuming - Whether we're resuming from pause
   */
  gameLoop(resuming = false) {
    if (this.isPaused) return;

    this.frameNumber++;
    const timing = this.updateFrameTiming();

    // Call the worker-specific update logic
    this.update(timing.deltaTime, timing.dtRatio, resuming);

    // Report FPS
    this.reportFPS();

    // Reset per-frame diagnostics after subclasses publish them.
    this.messageTimeThisFrame = 0;

    // Schedule next frame (only if not using custom scheduler)
    if (!this.usesCustomScheduler) {
      this.scheduleNextFrame();
    }
  }

  /**
   * Schedule the next frame (can be overridden for custom scheduling)
   * Uses setTimeout(0ms) if noLimitFPS is true to yield to event loop but run ASAP
   * Otherwise uses requestAnimationFrame for standard 60fps
   */
  scheduleNextFrame() {
    if (this.noLimitFPS) {
      // Run as fast as possible while still yielding to event loop
      // setTimeout(0) runs after current event loop but doesn't wait for next frame
      this.timeoutId = setTimeout(this.gameLoop, 2);
    } else {
      // Standard 60fps using requestAnimationFrame
      requestAnimationFrame(this.gameLoop);
    }
  }

  /**
   * Start the game loop (call this from initialize())
   */
  startGameLoop() {
    this.reportLog('starting game loop');
    this.isPaused = false;
    this.lastFrameTime = performance.now(); // Reset timing

    if (this.usesCustomScheduler) {
      // Custom scheduler will call gameLoop manually
      this.onCustomSchedulerStart();
    } else {
      // Use requestAnimationFrame
      this.gameLoop();
    }
  }

  /**
   * Override this if using custom scheduler (like PIXI ticker)
   */
  onCustomSchedulerStart() {
    // Override in subclass
  }

  /**
   * Initialize common buffers
   * @param {Object} data - Initialization data from main thread
   */
  async initializeCommonBuffers(data) {
    // console.log(
    //   `${this.constructor.name}: initializeCommonBuffers called, needsGameScripts=${this.needsGameScripts}`
    // );
    this.reportLog('initializing common buffers');
    this.globalEntityCount = data.globalEntityCount;

    // Store config for worker access
    this.config = data.config || {};

    // Check if this worker should run with unlimited FPS (no RAF limiting)
    // Each worker type can have its own noLimitFPS setting in its nested config
    const workerType = this.constructor.name.replace('Worker', '').toLowerCase();

    // Check nested config first, then fall back to root level
    const workerConfig = this.config[workerType] || {};
    if (workerConfig.noLimitFPS === true) {
      this.noLimitFPS = true;
      // console.log(
      //   `${this.constructor.name}: Running in unlimited FPS mode (noLimitFPS)`
      // );
    }

    // Register core engine classes globally BEFORE loading scripts
    // This ensures GameObject, Component, etc. are available when entity scripts are evaluated
    this.registerCoreClasses();

    // Initialize worker-side SoundManager (shared slot SAB + sound ID map)
    SoundManager.importSoundIdMap(data.audio?.soundIdMap || null);
    SoundManager.initializeSlotSAB(data.audio?.slotSAB || null);

    // Load game-specific scripts dynamically (entity classes + custom components)
    // ALL workers now receive entity classes for consistent component access
    // Uses the unified loadEntityScripts function from utils.js (auto-detects worker context)
    if (data.scriptsToLoad && data.scriptsToLoad.length > 0) {
      await loadEntityScripts(data.scriptsToLoad);
    }

    // Initialize GameObject arrays if buffer provided
    if (data.buffers?.gameObjectData) {
      GameObject.initializeArrays(
        data.buffers.gameObjectData,
        this.globalEntityCount,
        data.buffers.neighborData, // Automatically initialize neighbor data
        data.buffers.nextTickData // Tick decimation buffer (if staggeredUpdates enabled)
      );
    }

    // Initialize ParticleComponent arrays (separate particle pool system)
    // Particles are NOT entities - they have their own pool with maxParticles size
    if (data.maxParticles && data.maxParticles > 0) {
      if (data.buffers?.componentData?.ParticleComponent) {
        ParticleComponent.initializeArrays(
          data.buffers.componentData.ParticleComponent,
          data.maxParticles
        );
        ParticleComponent.particleCount = data.maxParticles;
        this.reportLog(`initialized ParticleComponent for ${data.maxParticles} particles`);
      }

      // Initialize ParticleEmitter with shared free list (enables any worker to emit particles)
      ParticleEmitter.initialize(data.maxParticles);
      if (data.particleFreeList && data.particleFreeListTop) {
        ParticleEmitter.initializeFreeList(data.particleFreeList, data.particleFreeListTop);
        this.reportLog(`initialized ParticleEmitter free list`);
      }
    }

    // Initialize DecorationComponent arrays (separate decoration pool system)
    // Decorations are NOT entities - they have their own pool with maxDecorations size
    if (data.maxDecorations && data.maxDecorations > 0) {
      if (data.buffers?.componentData?.DecorationComponent) {
        DecorationComponent.initializeArrays(
          data.buffers.componentData.DecorationComponent,
          data.maxDecorations
        );
        DecorationComponent.decorationCount = data.maxDecorations;
        this.maxDecorations = data.maxDecorations;
        this.reportLog(`initialized DecorationComponent for ${data.maxDecorations} decorations`);
      }

      // Initialize DecorationPool with shared free list (enables any worker to spawn decorations)
      DecorationPool.initialize(data.maxDecorations);
      if (data.decorationFreeList && data.decorationFreeListTop) {
        DecorationPool.initializeFreeList(data.decorationFreeList, data.decorationFreeListTop);
        this.reportLog(`initialized DecorationPool free list`);
      }

      // Initialize activeDecorationsData compact list (for optimized iteration)
      if (data.activeDecorationsData) {
        DecorationPool.initializeActiveList(data.activeDecorationsData);
        this.activeDecorationsData = new Uint16Array(data.activeDecorationsData);
        this.reportLog(`initialized DecorationPool activeDecorationsData`);
      }

      // Initialize visibleDecorationsData compact list (written by particle_worker, read by pre_render_worker)
      if (data.visibleDecorationsData) {
        this.visibleDecorationsData = new Uint16Array(data.visibleDecorationsData);
        this.reportLog(`initialized visibleDecorationsData`);
      }
    }

    // Initialize BulletComponent arrays (separate bullet pool system)
    if (data.maxBullets && data.maxBullets > 0) {
      if (data.buffers?.componentData?.BulletComponent) {
        BulletComponent.initializeArrays(
          data.buffers.componentData.BulletComponent,
          data.maxBullets
        );
        BulletComponent.bulletCount = data.maxBullets;
        this.maxBullets = data.maxBullets;
        this.reportLog(`initialized BulletComponent for ${data.maxBullets} bullets`);
      }
      BulletPool.initialize(data.maxBullets);
      if (data.bulletFreeList && data.bulletFreeListTop) {
        BulletPool.initializeFreeList(data.bulletFreeList, data.bulletFreeListTop);
      }
      if (data.activeBulletsData) {
        this.activeBulletsData = new Uint16Array(data.activeBulletsData);
      }
      if (data.visibleBulletsData) {
        this.visibleBulletsData = new Uint16Array(data.visibleBulletsData);
      }
      if (data.impactBuffer) {
        this.impactBuffer = data.impactBuffer;
      }
      this.totalLogicWorkers = data.totalLogicWorkers ?? 1;
    }

    // Initialize Constraint system (distance constraints for position-based dynamics)
    // All workers can add/remove constraints atomically via the shared free list
    if (data.constraints && data.constraints.enabled) {
      Constraint.initializeArrays(data.constraints.data, data.constraints.maxConstraints);
      Constraint.initialize(data.constraints.maxConstraints);
      Constraint.initializeFreeList(data.constraints.freeList, data.constraints.freeListTop);
      this.reportLog(`initialized Constraint system for ${data.constraints.maxConstraints} constraints`);
    }

    // Initialize particle compact lists (for optimized iteration)
    if (data.maxParticles && data.maxParticles > 0) {
      // activeParticlesData: rebuilt each frame by particle_worker
      if (data.activeParticlesData) {
        this.activeParticlesData = new Uint16Array(data.activeParticlesData);
        this.reportLog(`initialized activeParticlesData`);
      }
      // visibleParticlesData: subset of active particles that are on-screen
      if (data.visibleParticlesData) {
        this.visibleParticlesData = new Uint16Array(data.visibleParticlesData);
        this.reportLog(`initialized visibleParticlesData`);
      }
    }

    // Initialize common shared buffers using Buffer->Data naming pattern
    if (data.buffers?.inputData) {
      this.inputData = new Int32Array(data.buffers.inputData);
    }

    if (data.buffers?.cameraData) {
      this.cameraData = new Float32Array(data.buffers.cameraData);
      // Initialize Camera static class for entity code
      Camera.initialize(
        this.cameraData,
        this.config.canvasWidth || 800,
        this.config.canvasHeight || 600
      );
      // Set world bounds for camera clamping
      if (this.config.worldWidth && this.config.worldHeight) {
        Camera.setWorldBounds(this.config.worldWidth, this.config.worldHeight);
      }
    }

    // Initialize Mouse static class (input state shared across workers)
    if (data.buffers?.mouseData) {
      Mouse.initialize(data.buffers.mouseData);
    }

    // Initialize Sun static class (directional light shared across workers)
    if (data.sunData) {
      Sun.initialize(data.sunData);
    }

    // Initialize Layer static class (rendering layers shared across workers)
    if (data.layerData) {
      Layer.initializeFromBuffers(data.layerData);
    }

    // Initialize TileMap static class (SAB-backed tile data shared across workers)
    if (data.tilemapData) {
      TileMap.initializeFromBuffers(data.tilemapData);
    }

    // Initialize neighbor data reference (single buffer - row ownership eliminates races)
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    if (data.buffers?.neighborData) {
      this.neighborData = new Uint16Array(data.buffers.neighborData);
    }

    // Initialize active entities list (for load-balanced processing)
    // Layout: [count, entityIdx0, entityIdx1, ...]
    // Maintained incrementally by spawn/despawn, consumed by all workers
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    if (data.buffers?.activeEntitiesData) {
      this.activeEntitiesData = new Uint16Array(data.buffers.activeEntitiesData);
      // Also set on GameObject for static access via GameObject.getAllActive()
      GameObject.activeEntitiesData = this.activeEntitiesData;
    }

    // Per-type active entity lists (SABs for O(1) type-specific queries)
    // These are attached to EntityClass in createGameObjectInstances()
    if (data.buffers?.perTypeActiveLists) {
      this.perTypeActiveLists = data.buffers.perTypeActiveLists;
    }

    // Entity free lists (SABs for atomic spawn/despawn from any worker)
    // These are attached to EntityClass later after scripts load
    if (data.buffers?.entityFreeLists) {
      this.entityFreeLists = data.buffers.entityFreeLists;
      this.entityFreeListTops = data.buffers.entityFreeListTops;
    }

    // Initialize frame rate tracking buffer
    if (data.buffers?.frameRateData) {
      this.frameRateData = new Float32Array(data.buffers.frameRateData);
    }

    // Store frame rate buffer index for writing to frameRateData
    // Note: This is different from workerIndex used by logic workers for job partitioning!
    if (data.frameRateIndex !== undefined) {
      this.frameRateIndex = data.frameRateIndex;
    }

    // Store registered classes (used by logic worker and potentially others)
    this.registeredClasses = data.registeredClasses || [];

    // Initialize query system for component-based entity filtering (SAB-based only)
    if (data.queries && data.buffers?.queryEntityMetadata) {
      const queryFunctions = createWorkerQueryFunctions(
        data.queries,
        {
          entityMetadataSAB: data.buffers.queryEntityMetadata,
          queryCacheSAB: data.buffers.queryCache,
          queryResultsSAB: data.buffers.queryResults,
        },
        this.activeEntitiesData
      );

      this._queryFn = queryFunctions.query;
      this._queryActiveEntitiesFn = queryFunctions.queryActiveEntities;
      this._queryResultViews = queryFunctions._queryResultViews;
      this._precomputedQueries = queryFunctions._precomputedQueries;
      this._queryEntityMetadata = queryFunctions._entityMetadata;

      this.reportLog(
        `initialized query system with ${this._precomputedQueries?.length || 0} pre-computed queries`
      );
    } else if (data.queries) {
      throw new Error('Query system requires SAB buffers (queryEntityMetadata/queryCache/queryResults)');
    }

    this.reportLog('finished initializing common buffers');

    // Keep a reference to neighbor data for easy access (already set above, but also from GameObject)
    // NOTE: With double buffering, these will point to the initial read buffer (A)
    // Workers should prefer Grid.neighborData getter for dynamic access to current read buffer
    if (GameObject.neighborData) {
      this.neighborData = GameObject.neighborData;
    }

    // Make camera data available to GameObject for direct access
    if (this.cameraData) {
      GameObject.cameraData = this.cameraData;
    }

    // Note: registerCoreClasses() already called earlier (before loadEntityScripts)

    // Initialize ALL components (core + custom) for ALL workers
    // Connects components to SharedArrayBuffers and makes them globally available
    // Always called: core components (Transform, RigidBody, etc.) need SAB views
    // even when no entity classes are registered (e.g. particle-only scenes)
    this.initializeAllComponents(data);

    // Attach per-type active list views to EntityClasses
    // Now that scripts are loaded and components initialized, EntityClasses are on self
    // This gives ALL workers access to EntityClass._activeList for O(1) getAllActive()
    if (this.perTypeActiveLists && this.registeredClasses) {
      for (const registration of this.registeredClasses) {
        const EntityClass = self[registration.name];
        const sab = this.perTypeActiveLists[registration.name];
        if (EntityClass && sab) {
          EntityClass._activeList = new Uint16Array(sab);
        }
      }
    }

    // Attach entity free lists (SAB-backed) to EntityClasses
    // This enables atomic spawn/despawn from ANY worker without routing to worker-0
    if (this.entityFreeLists && this.entityFreeListTops && this.registeredClasses) {
      for (const registration of this.registeredClasses) {
        const EntityClass = self[registration.name];
        const freeListSAB = this.entityFreeLists[registration.name];
        const freeListTopSAB = this.entityFreeListTops[registration.name];
        if (EntityClass && freeListSAB && freeListTopSAB) {
          EntityClass.freeList = new Uint16Array(freeListSAB);
          EntityClass.freeListTop = new Int32Array(freeListTopSAB);
        }
      }
    }

    // Initialize Grid system with shared buffers and metadata
    // ARCHITECTURE: Row-based partitioned spatial grid
    // - gridBuffer: SINGLE buffer, each spatial worker owns specific rows
    // - neighborData: SINGLE buffer, row ownership eliminates races
    // - cellSleepingBuffer: SINGLE buffer, written by particle_worker, read by all
    // Row ownership: worker i owns rows where (cellY % totalWorkers === workerId)
    // No double buffering, no Atomics, no locks - pure deterministic memory.
    if (data.gridMetadata && data.buffers?.gridBuffer) {
      // Use gridMetadata directly - it now includes maxNeighbors and maxEntitiesPerCell from scene config
      Grid.initialize(
        {
          gridBuffer: data.buffers.gridBuffer,
          neighborBuffer: data.buffers.neighborData,
          cellSleepingBuffer: data.buffers.cellSleepingBuffer,
        },
        data.gridMetadata
      );
      // this.reportLog('Grid system initialized (row-based partitioning, single buffers)');
    }

    // Initialize DebugDraw ring buffer (shared across all workers and main thread)
    if (data.buffers?.debugDrawData) {
      DebugDraw.initialize(data.buffers.debugDrawData, data.maxDebugDrawEntries || 256);
    }

    // Initialize NavGrid system (if navigation enabled)
    // Navigation buffer is shared across all workers
    // Logic workers read flowfields/paths, particle worker writes them
    if (data.buffers?.navigationData && data.config?.navigation?.enabled) {
      console.log(`[${this.constructor.name}] Initializing NavGrid with navigation buffer`);
      NavGrid.initialize(data.buffers.navigationData, {
        worldWidth: data.config.worldWidth,
        worldHeight: data.config.worldHeight,
      });
    } else {
      console.log(`[${this.constructor.name}] NavGrid NOT initialized - navigationData: ${!!data.buffers?.navigationData}, enabled: ${data.config?.navigation?.enabled}`);
      // this.reportLog('NavGrid initialized for pathfinding');
    }

    // Register static (pre-baked) flowfields from JSON
    if (data.staticFlowfields) {
      for (const [name, ff] of Object.entries(data.staticFlowfields)) {
        NavGrid.registerStaticFlowfield(name, ff);
      }
    }
  }

  /**
   * Register core engine classes globally for all workers
   * These are the fundamental engine classes needed across all worker types
   */
  registerCoreClasses() {
    self.GameObject = GameObject;
    self.Component = Component;
    self.FSM = FSM;
    self.FSMState = FSMState;
    self.Mouse = Mouse;
    self.Keyboard = Keyboard;
    self.Ray = Ray;
    self.DebugDraw = DebugDraw;
    self.DebugUI = DebugDraw; // alias so game scripts can use DebugUI.drawLine(...)
    self.Grid = Grid;
    self.NavGrid = NavGrid;
    self.Camera = Camera;
    self.Sun = Sun;
    self.SpriteSheetRegistry = SpriteSheetRegistry;
    self.SoundManager = SoundManager;
    self.Constraint = Constraint;
    self.Layer = Layer;

    // Components (required for blob worker entity script evaluation)
    self.Transform = Transform;
    self.RigidBody = RigidBody;
    self.Collider = Collider;
    self.SpriteRenderer = SpriteRenderer;
    self.ParticleComponent = ParticleComponent;
    self.LightEmitter = LightEmitter;
    self.ShadowCaster = ShadowCaster;
    self.FlashComponent = FlashComponent;
    self.DecorationComponent = DecorationComponent;
    self.BulletComponent = BulletComponent;
    self.CameraInOutListener = CameraInOutListener;
    self.CollisionListener = CollisionListener;

    // Systems
    self.ParticleEmitter = ParticleEmitter;
    self.DecorationPool = DecorationPool;
    self.BulletPool = BulletPool;
    self.Flash = Flash;

    // Enums & utilities
    self.ShapeType = ShapeType;
    self.randomColor = randomColor;
    self.distanceSq2D = distanceSq2D;
    self.getDirectionFromAngle = getDirectionFromAngle;
    self.containerRadius = containerRadius;
  }

  /**
   * Initialize ALL components by collecting them from entity classes
   * This runs in ALL workers, making all components available everywhere with SharedArrayBuffer connections
   * Handles both core (Transform, RigidBody) and custom (FlockingBehavior, PredatorBehavior) components
   * @param {Object} data - Initialization data containing componentPools and buffers
   */
  initializeAllComponents(data) {
    const componentData = data.buffers?.componentData;
    const componentPools = data.componentPools;
    const totalEntityCount = data.globalEntityCount || 0;

    if (this.registeredClasses && this.registeredClasses.length > 0) {
      // Collect ALL components from all registered entity classes
      const componentClasses = collectAllComponentsFromClasses(this.registeredClasses, self);

      // Initialize component views from SharedArrayBuffers
      const initializedCount = initializeComponentViews(
        componentClasses,
        componentData,
        componentPools,
        totalEntityCount
      );

      // Make all components globally available for dynamic lookups
      exposeComponentsGlobally(componentClasses, self);

      if (componentClasses.size > 0) {
        this.reportLog(
          `initialized ${initializedCount}/${componentClasses.size} component classes with SharedArrayBuffers`
        );
      }
    }

    // Always initialize core entity components if buffers exist, even when no entity uses them.
    // Workers receive componentPools as { name: { count, componentId } } (no ComponentClass ref).
    // Without this, scenes whose entities don't use RigidBody/Collider crash in spatial/physics/logic
    // because those workers access .active, .collisionCount etc. which are undefined typed arrays.
    const coreComponents = [Transform, RigidBody, Collider, SpriteRenderer];
    for (const ComponentClass of coreComponents) {
      const name = ComponentClass.name;
      const buffer = componentData?.[name];
      const pool = componentPools?.[name];
      if (buffer) {
        const alreadyInit = ComponentClass.active && ComponentClass.active.length === totalEntityCount;
        if (!alreadyInit) {
          ComponentClass.initializeArrays(buffer, totalEntityCount);
          if (pool?.componentId !== undefined) ComponentClass.componentId = pool.componentId;
        }
      }
    }
  }

  initSeendedRandom(seed) {
    if (seed == null || seed == undefined) {
      seed = Date.now();
    }
    self.rng = seededRandom(seed);
    // Also make it available globally without 'self.' prefix for entity code
    globalThis.rng = self.rng;
  }

  /**
   * Handle incoming messages from main thread
   * @param {MessageEvent} e - Message event
   */
  async handleMessage(e) {
    const { msg } = e.data;

    switch (msg) {
      case 'init':
        console.log(`[${this.constructor.name}] Received 'init' message, starting initialization...`);
        this.initSeendedRandom(e.data.config.seed);
        this.isPaused = true; // Keep paused until "start" message
        console.log(`[${this.constructor.name}] Initializing common buffers...`);
        await this.initializeCommonBuffers(e.data);
        console.log(`[${this.constructor.name}] Common buffers initialized, setting up worker ports...`);
        this.initializeWorkerPorts(e.data.workerPorts); // Initialize direct worker communication
        console.log(`[${this.constructor.name}] Worker ports initialized, calling worker-specific initialize()...`);
        await this.initialize(e.data);
        console.log(`[${this.constructor.name}] Worker-specific initialize() completed, calling reportReady()...`);
        // After initialization, signal ready to main thread
        this.reportReady();
        console.log(`[${this.constructor.name}] reportReady() called, waiting for 'start' message...`);
        break;

      case 'start':
        // All workers are ready, start the game loop
        this.reportLog('received start signal, beginning game loop');
        this.startGameLoop();
        break;

      case 'pause':
        this.pause();
        break;

      case 'resume':
        this.resume();
        break;

      case 'resize': {
        const { width, height } = e.data;
        this.canvasWidth = width;
        this.canvasHeight = height;
        this.config.canvasWidth = width;
        this.config.canvasHeight = height;
        Camera.canvasWidth = width;
        Camera.canvasHeight = height;
        this.onResize(width, height);
        break;
      }

      default:
        this.handleCustomMessage(e.data);
        break;
    }
  }

  /**
   * Report to main thread that this worker is ready
   * Called automatically after initialization completes
   */
  reportReady() {
    this.reportLog('initialization complete, signaling ready');
    console.log(`${this.constructor.name}: Sending workerReady message`);
    self.postMessage({ msg: 'workerReady', worker: this.constructor.name });
  }

  /**
   * Initialize MessagePorts for direct worker-to-worker communication
   * Called during init with ports object from main thread
   * @param {Object} ports - Object mapping worker names to MessagePorts
   */
  initializeWorkerPorts(ports) {
    this.reportLog('initializing worker ports');
    if (!ports) return;

    Object.entries(ports).forEach(([workerName, port]) => {
      this.workerPorts.set(workerName, port);

      // Setup message handler for this port
      port.onmessage = (e) => {
        this.handleWorkerMessage(workerName, e.data);
      };
    });

    // If this worker has a port to the particle worker, configure NavGrid to use it
    // Logic workers use this to send pathfinding requests to the particle worker
    if (this.workerPorts.has('particle')) {
      console.log(`[${this.constructor.name}] Setting NavGrid port to particle worker`);
      NavGrid.setNavWorkerPort(this.workerPorts.get('particle'));
    } else {
      console.log(`[${this.constructor.name}] No particle port found. Available ports:`, Array.from(this.workerPorts.keys()));
    }

    // console.log(
    //   `${this.constructor.name}: Connected to workers:`,
    //   Array.from(this.workerPorts.keys())
    // );
  }

  /**
   * Send data directly to another worker via MessagePort
   * This bypasses the main thread for faster communication
   * @param {string} workerName - Target worker name ('renderer', 'logic', 'physics', etc.)
   * @param {Object} data - Data to send
   */
  sendDataToWorker(workerName, data) {
    const port = this.workerPorts.get(workerName);
    if (!port) {
      console.warn(
        `${this.constructor.name}: No port to worker "${workerName}". Available:`,
        Array.from(this.workerPorts.keys())
      );
      return;
    }
    port.postMessage(data);
  }

  /**
   * Handle messages from other workers (via MessagePort)
   * Override in subclass for custom handling, or handle in handleCustomMessage
   * @param {string} fromWorker - Name of sender worker
   * @param {Object} data - Message data
   */
  handleWorkerMessage(fromWorker, data) {
    // Default implementation - subclasses can override
    // Or just pass to handleCustomMessage for unified handling
    if (data && typeof data === 'object') {
      data._fromWorker = fromWorker;
      this.handleCustomMessage(data);
      return;
    }

    this.handleCustomMessage({
      data,
      _fromWorker: fromWorker,
    });
  }

  /**
   * Pause the worker
   */
  pause() {
    this.isPaused = true;
    // Clear timeout if we're using noLimitFPS mode
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Resume the worker
   */
  resume() {
    this.isPaused = false;
    this.lastFrameTime = performance.now(); // Reset timing to avoid large delta

    if (!this.usesCustomScheduler) {
      this.gameLoop(true);
    }
    // If using custom scheduler, it will continue calling gameLoop automatically
  }

  /**
   * Get the count of active entities (built by particle_worker each frame)
   * @returns {number} - Number of active entities
   */
  getActiveEntityCount() {
    return this.activeEntitiesData ? this.activeEntitiesData[0] : 0;
  }

  /**
   * Get an active entity index by its position in the active list
   * @param {number} activeIndex - Index in the active list (0 to count-1)
   * @returns {number} - Actual entity index, or -1 if invalid
   */
  getActiveEntityIndex(activeIndex) {
    if (!this.activeEntitiesData) return -1;
    const count = this.activeEntitiesData[0];
    if (activeIndex < 0 || activeIndex >= count) return -1;
    return this.activeEntitiesData[1 + activeIndex];
  }

  /**
   * Query entities by component combination
   * Returns indices of ALL entities that have ALL specified components (regardless of active state)
   *
   * @param {Array<Component>} componentClasses - Array of component classes to query
   * @returns {Uint16Array} - Indices of matching entities (may be shared, do not modify)
   *
   * @example
   * const rigidBodies = this.query([RigidBody]);
   * const physicsObjects = this.query([RigidBody, Collider]);
   */
  query(componentClasses) {
    if (!this._queryFn) {
      console.warn(`[${this.constructor.name}] Query system not initialized!`);
      return this._emptyUint16Array;
    }
    return this._queryFn(componentClasses);
  }

  /**
   * Query for ACTIVE entities with specified components
   * Returns view into pre-populated SAB (updated each frame by particle_worker)
   *
   * @param {Array<Component>} componentClasses - Array of component classes to query
   * @returns {Uint16Array} - Active entity indices (view into SAB, do not modify)
   *
   * @example
   * const activeLights = this.queryActiveEntities([LightEmitter]);
   * const activePhysics = this.queryActiveEntities([RigidBody, Collider]);
   */
  queryActiveEntities(componentClasses) {
    if (!this._queryActiveEntitiesFn) {
      console.warn(`[${this.constructor.name}] Active query system not initialized!`);
      return this._emptyUint16Array;
    }
    return this._queryActiveEntitiesFn(componentClasses);
  }

  // ==========================================
  // ABSTRACT METHODS - Must be implemented by subclasses
  // ==========================================

  /**
   * Initialize the worker with data from main thread
   * @abstract
   * @param {Object} data - Initialization data
   */
  async initialize(data) {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Update logic called each frame
   * @abstract
   * @param {number} deltaTime - Time since last frame in milliseconds
   * @param {number} dtRatio - Delta time ratio normalized to 60fps
   * @param {boolean} resuming - Whether we're resuming from pause
   */
  update(deltaTime, dtRatio, resuming) {
    throw new Error('update() must be implemented by subclass');
  }

  /**
   * Called after canvas dimensions are updated on resize.
   * Override in subclasses that need extra resize logic (e.g. pixi_worker resizes the renderer).
   * @param {number} width - New canvas width
   * @param {number} height - New canvas height
   */
  onResize(width, height) {
    // Override in subclass if needed
  }

  /**
   * Handle custom messages not covered by standard messages
   * @param {Object} data - Message data
   */
  handleCustomMessage(data) {
    // Override in subclass if needed
  }
}
