// AbstractWorker.js - Base class for all game engine workers
// Provides common functionality: frame timing,  FPS tracking, pause state, message handling

import { GameObject, SpriteSheetRegistry } from '../core/gameObject.js';
import { AdobeAnimRegistry } from '../core/adobeAnimRegistry.js';
import Keyboard from '../core/keyboard.js';
import { Mouse } from '../core/mouse.js';
import { Gamepad } from '../core/gamepad.js';
import { ParticleEmitter } from '../core/particleEmitter.js';
import { DecorationPool } from '../core/decorationPool.js';
import { DecorationSpatial } from '../core/decorationSpatial.js';
import { Decoration } from '../core/decoration.js';
import { BulletPool } from '../core/bulletPool.js';
import { BulletComponent } from '../components/bulletComponent.js';
import { Flash } from '../core/flash.js';
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
  getDirectionFromVector,
  getDirection8FromVector,
  containerRadius,
} from '../util/utils.js';
import { Camera } from '../core/camera.js';
import { Sun } from '../core/sun.js';
import { Layer } from '../core/layer.js';
import { TileMap } from '../core/tileMap.js';
import { Ray } from '../core/ray.js';
import { LiquidFun } from '../core/liquidFun.js';
import { setAssertRotCSUnit } from '../box2d/box2dCommandRing.js';
import { SceneBridge } from '../core/sceneBridge.js';
import { SharedResource } from '../core/sharedResource.js';
import { DebugDraw } from '../core/debug/debugDraw.js';
import { Grid } from '../core/grid.js';
import { NavGrid } from '../core/navGrid.js';
import { ParticleComponent } from '../components/particleComponent.js';
import { DecorationComponent } from '../components/decorationComponent.js';
import { Joint } from '../core/joint.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { SoundManager } from '../core/soundManager.js';
import { createWorkerQueryFunctions } from '../core/querySystem.js';
import { Query } from '../core/query.js';
import { Box2d } from '../core/box2d.js';
import { Decal } from '../core/decal.js';
import { bindSpawnCommandRing } from '../util/spawnCommandRing.js';
import { bindEntityIdWidth, resolveEntityIdWidth, EntityIdArray } from '../util/entityIdWidth.js';
import { setVerboseWorkers, installQuietConsoleLog } from '../util/debugLog.js';
import { bindBox2dHotFields, bindWeedPoseFields } from '../box2d/box2dHotFields.js';
import { bindCommandRing } from '../box2d/box2dCommandRing.js';
import { bindQueryAabbSab } from '../box2d/box2dQueryAabb.js';
import { bindOverlapCircleSab } from '../box2d/box2dOverlapCircle.js';
import { bindRayCastSab } from '../box2d/box2dRayCast.js';
import { bindCastRayAllSab } from '../box2d/box2dCastRayAll.js';
import { bindLiquidFunQuerySab } from '../box2d/liquidFunQuery.js';
import { bindLiquidFunExtractSab } from '../box2d/liquidFunExtract.js';
import { bindLiquidFunUserDataListSab } from '../box2d/liquidFunUserDataList.js';
import { bindMovedBodies } from '../box2d/box2dMovedBodies.js';
import { bindBodySyncBuffers } from '../box2d/box2dBodySync.js';

import { Component } from '../core/component.js';
import { FSM } from '../core/fsm.js';
import { FSMState } from '../core/fsmState.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { Collider } from '../components/collider.js';
import { SpriteRenderer } from '../components/spriteRenderer.js';
import { MeshRenderer } from '../components/meshRenderer.js';
import { AdobeAnimComponent } from '../components/adobeAnimComponent.js';
import { LightEmitter } from '../components/lightEmitter.js';
import { ShadowCaster } from '../components/shadowCaster.js';
import { FlashComponent } from '../components/flashComponent.js';
import { LightOccluder } from '../components/lightOccluder.js';
import { CameraInOutListener } from '../components/cameraInOutListener.js';
import { CollisionListener } from '../components/collisionListener.js';
import { JointBreakListener } from '../components/jointBreakListener.js';
import { Grab } from '../components/grab.js';
import { ShapeType } from '../util/configDefaults.js';

/**
 * AbstractWorker - Base class for all game engine workers
 * Handles common worker functionality like frame timing, FPS tracking, and message handling
 */
export class AbstractWorker {
  constructor(selfRef) {
    this.self = selfRef;

    // Explicit queue preserves ordering without building a promise chain per message.
    this._pendingMessages = [];
    this._pendingMessageReadIndex = 0;
    this._isProcessingMessages = false;

    this.self.onmessage = (e) => {
      this._pendingMessages.push(e);
      if (!this._isProcessingMessages) {
        this._drainMessageQueue();
      }
    };

    // Frame timing and FPS tracking
    this.frameNumber = 0;
    this.lastFrameTime = performance.now();
    this.accumulatedTime = 0; // Total time elapsed since start (in milliseconds)
    this.currentFPS = 0;
    this.stepTimeThisFrame = 0; // Wall ms for update() this frame (STEP_MS)

    // Stats buffer for writing detailed metrics (set during initialization)
    this.stats = null; // Float32Array view into worker's stat buffer

    // State
    this.isPaused = true;
    this.globalEntityCount = 0;
    this.config = {};

    // Scheduling
    this.usesCustomScheduler = false; // Override in subclass if using custom scheduler
    this.noLimitFPS = false; // Set to true to run as fast as possible (no RAF limiting)
    this.fixedFps = 0; // >0 → setInterval at that rate AND constant sim dt; overrides noLimitFPS/RAF
    this.timeoutId = null; // Store timeout ID for clearing
    this.intervalId = null; // Store interval ID for fixedFps

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
    this.frameRateStride = 1; // Float stride between worker FPS slots in frameRateData

    // Published physics pose (double-buffer SAB). Latch via _latchPose().
    this.poseSync = null;
    this.poseBuffers = [null, null];
    this.poseCapacity = 0;
    this._poseX = null;
    this._poseY = null;
    this._poseRotC = null;
    this._poseRotS = null;
    // Other double-buffer slot (previous physics frame) - only valid once
    // readyFrame >= 2. Used for pose interpolation (preRender.interpolation).
    this._prevPoseX = null;
    this._prevPoseY = null;
    this._prevPoseRotC = null;
    this._prevPoseRotS = null;
    this._poseReadyFrame = 0;

    // Registered entity classes information (set during initialization)
    this.registeredClasses = [];

    // Query system cache for component-based entity filtering
    this.emptyQueryWarnings = new Set(); // Track empty query warnings (log once per query key)
    this.queryVersionData = null; // Shared version for active query result invalidation

    // Pre-allocated empty array for query fallbacks
    this._emptyUint16Array = new Uint16Array(0);

    // MessagePorts for direct worker-to-worker communication
    this.workerPorts = new Map(); // Map<workerName, MessagePort>

    // Bind methods
    this.gameLoop = this.gameLoop.bind(this);
    this.handleMessage = this.handleMessage.bind(this);
    this._drainMessageQueue = this._drainMessageQueue.bind(this);

    // PERFORMANCE: Reusable timing object to avoid GC pressure
    // This is returned by updateFrameTiming() every frame on every worker
    this._timing = {
      deltaTime: 0,
      dtRatio: 1,
    };

    // Lightweight worker diagnostics written into the existing stats buffers.
    this.messageTimeThisFrame = 0;

    // Injected dt for `{ msg: 'step' }` (lockstep). 0 = use wall / fixedFps.
    this._injectedDeltaTime = 0;

    this.reportLog('finished constructor');
  }

  async _drainMessageQueue() {
    this._isProcessingMessages = true;

    try {
      while (this._pendingMessageReadIndex < this._pendingMessages.length) {
        const e = this._pendingMessages[this._pendingMessageReadIndex++];

        try {
          const shouldProfileMessages = !!this.collectDetailedStats;
          const startTime = shouldProfileMessages ? performance.now() : 0;

          await this.handleMessage(e);

          if (shouldProfileMessages) {
            this.messageTimeThisFrame += performance.now() - startTime;
          }
        } catch (error) {
          console.error(`[${this.constructor.name}] Error in handleMessage:`, error);
          this.reportError('Worker message handling failed', error);
        }
      }
    } finally {
      this._pendingMessages.length = 0;
      this._pendingMessageReadIndex = 0;
      this._isProcessingMessages = false;
    }
  }

  /**
   * Calculate delta time and update FPS
   * @returns {Object} - { deltaTime, dtRatio }
   */
  updateFrameTiming() {
    const now = performance.now();
    const rawDelta = now - this.lastFrameTime;
    const wallDelta = Math.min(Math.max(rawDelta, 0), 100);
    this.lastFrameTime = now;

    // FPS from wall-clock delta; tiny or zero deltas happen (timer resolution, same-tick work).
    // Use a small floor only for FPS so we never divide by zero and stats stay interpretable.
    const FPS_MIN_DELTA_MS = 0.2;
    const instantaneousFPS = 1000 / Math.max(wallDelta, FPS_MIN_DELTA_MS);
    this.currentFPS = instantaneousFPS;

    // Sim dt: injected lockstep step, else freeze when fixedFps > 0.
    // Wall delta stays for FPS / STEP_MS only.
    const deltaTime = this._injectedDeltaTime > 0
      ? this._injectedDeltaTime
      : this.fixedFps > 0
        ? 1000 / this.fixedFps
        : wallDelta;

    // Write instantaneous FPS + frame index (slot 1, unused by FPS readers).
    if (this.frameRateData && this.frameRateIndex >= 0) {
      const base = this.frameRateIndex * this.frameRateStride;
      this.frameRateData[base] = instantaneousFPS;
      if (this.frameRateStride > 1) {
        this.frameRateData[base + 1] = this.frameNumber;
      }
    }

    // Normalize delta time to 60fps (16.67ms per frame)
    const dtRatio = deltaTime / 16.67;

    // Accumulate total time in milliseconds
    this.accumulatedTime += deltaTime;

    // Reuse timing object to avoid GC pressure
    this._timing.deltaTime = deltaTime;
    this._timing.dtRatio = dtRatio;

    return this._timing;
  }

  /**
   * Write worker FPS / metrics into this worker's SharedArrayBuffer stats view.
   * Base no-op; subclasses override to fill their schema.
   */
  reportFPS() {
    // Subclasses write to SharedArrayBuffer stats
  }

  reportLog(message) {
    self.postMessage({ msg: 'log', message, when: Date.now() });
  }

  postMessageToScene(data) {
    self.postMessage(data);
    return true;
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

    this._runFrame(resuming);

    // Schedule next frame (only if not using custom scheduler)
    if (!this.usesCustomScheduler) {
      this.scheduleNextFrame();
    }
  }

  /**
   * One simulation/render tick without scheduling the next frame.
   * Used by gameLoop and by `{ msg: 'step' }` lockstep.
   */
  _runFrame(resuming = false) {
    this.frameNumber++;
    const timing = this.updateFrameTiming();

    if (this.needsGameScripts) {
      Keyboard.updateEdgeFlags();
      Gamepad.updateEdgeFlags();
    }

    // Call the worker-specific update logic; STEP_MS = wall time of that work only
    const t0 = performance.now();
    this.update(timing.deltaTime, timing.dtRatio, resuming);
    this.stepTimeThisFrame = performance.now() - t0;

    // Report FPS
    this.reportFPS();

    // Reset per-frame diagnostics after subclasses publish them.
    this.messageTimeThisFrame = 0;
  }

  /**
   * Hook after a lockstep `{ msg: 'step' }` (pixi presents the canvas).
   */
  afterManualStep() {}

  /**
   * Schedule the next frame (can be overridden for custom scheduling)
   * fixedFps > 0 → setInterval; noLimitFPS → setTimeout(2); else requestAnimationFrame
   */
  scheduleNextFrame() {
    if (this.fixedFps > 0) {
      if (this.intervalId !== null) return;
      const ms = 1000 / this.fixedFps;
      this.intervalId = setInterval(this.gameLoop, ms);
      return;
    }
    if (this.noLimitFPS) {
      // Run as fast as possible while still yielding to event loop
      this.timeoutId = setTimeout(this.gameLoop, 2);
    } else {
      requestAnimationFrame(this.gameLoop);
    }
  }

  _clearFrameSchedulers() {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
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
   * @param {Object} data - Initialization data from Scene
   */
  async initializeCommonBuffers(data) {
    // console.log(
    //   `${this.constructor.name}: initializeCommonBuffers called, needsGameScripts=${this.needsGameScripts}`
    // );
    this.reportLog('initializing common buffers');
    this.globalEntityCount = data.globalEntityCount;
    this.bodySyncViews = bindBodySyncBuffers(data.buffers);
    Decal.bindStampRing(data.buffers?.decalStampRing || null);
    bindSpawnCommandRing(data.buffers?.spawnCommandRing || null);
    {
      const p = data.config?.particle;
      if (data.buffers?.decalsTilesRGBA && p?.decals) {
        const tileSize = p.decalsTileSize;
        Decal.bindAtlas({
          tilesSab: data.buffers.decalsTilesRGBA,
          tileSize,
          tilePixelSize: p.decalsTilePixelSize,
          tilesX: Math.ceil(data.config.worldWidth / tileSize),
          tilesY: Math.ceil(data.config.worldHeight / tileSize),
        });
      } else {
        Decal.bindAtlas(null);
      }
    }

    // Store config for worker access
    this.config = data.config || {};
    bindEntityIdWidth(resolveEntityIdWidth(this.config));

    // Fine worker subtimers + SAB detail fields (config.debug.collectDetailedStats)
    this.collectDetailedStats = !!(this.config.debug?.collectDetailedStats);
    setVerboseWorkers(!!this.config.debug?.verboseWorkers);
    installQuietConsoleLog();
    Ray.collectDetailedStats = this.collectDetailedStats;
    Box2d.collectDetailedStats = this.collectDetailedStats;
    Ray.assertRotCSUnit = !!(this.config.debug?.assertRotCSUnit);
    setAssertRotCSUnit(!!this.config.debug?.assertRotCSUnit);

    this._bindPosePublish(data.posePublish);

    // Boot: query/explode throw if no WASM worker. Not a per-tick gate.
    Box2d.physicsWorkerAbsent = data.config?.physics?.enabled === false;

    // Check nested config for fixedFps / noLimitFPS (class name → config key)
    const workerType = this.constructor.name.replace('Worker', '').toLowerCase();
    const configKeyAliases = {
      prerender: 'preRender',
      pixi: 'renderer',
    };
    const configKey = configKeyAliases[workerType] || workerType;
    const workerConfig = this.config[configKey] || this.config[workerType] || {};
    const fixedFps = Number(workerConfig.fixedFps);
    if (fixedFps > 0) {
      this.fixedFps = fixedFps;
    } else if (workerConfig.noLimitFPS === true) {
      this.noLimitFPS = true;
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

    if (data.sharedResources && data.sharedResources.length > 0) {
      SharedResource.bindFromInit(data.sharedResources, self);
    }

    GameObject.initializeArrays(
      this.globalEntityCount,
      data.buffers?.neighborData,
      data.buffers?.nextTickData,
      data.buffers?.forceProcessOnLogicWorkerData,
      data.buffers?.entityTypeHasForcedLogicWorker,
      data.buffers?.entityTypeForcedLogicWorkerCount
    );

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
        DecorationPool.initializeActiveList(data.activeDecorationsData, data.activeDecorationsLock || null);
        this.activeDecorationsData = new Uint16Array(data.activeDecorationsData);
        this.reportLog(`initialized DecorationPool activeDecorationsData`);
      }

      // Initialize visibleDecorationsData compact list (written by particle_worker, read by pre_render_worker)
      if (data.visibleDecorationsData) {
        this.visibleDecorationsData = new Uint16Array(data.visibleDecorationsData);
        this.reportLog(`initialized visibleDecorationsData`);
      }

      const maxAttached = data.maxAttachedDecorationsPerEntity | 0;
      if (
        data.attachedDecorationCount &&
        data.attachedDecorationIndices &&
        data.globalEntityCount > 0 &&
        maxAttached > 0
      ) {
        DecorationPool.initializeAttachmentSlots(
          data.attachedDecorationCount,
          data.attachedDecorationIndices,
          data.globalEntityCount,
          maxAttached
        );
        this.reportLog(
          `initialized DecorationPool attachment slots (${data.globalEntityCount} entities × ${maxAttached})`
        );
      }

      if (
        data.decorationSpatialHead &&
        data.decorationSpatialNext &&
        data.decorationSpatialPrev &&
        data.decorationSpatialCellOf &&
        data.decorationSpatialMeta
      ) {
        DecorationSpatial.initialize(
          {
            head: data.decorationSpatialHead,
            next: data.decorationSpatialNext,
            prev: data.decorationSpatialPrev,
            cellOf: data.decorationSpatialCellOf,
            lock: data.decorationSpatialLock || null,
          },
          data.decorationSpatialMeta,
          false
        );
        this.reportLog(
          `initialized DecorationSpatial (${data.decorationSpatialMeta.gridWidth}x${data.decorationSpatialMeta.gridHeight})`
        );
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

    // Initialize Joint system (Box2D-mapped distance/revolute/weld)
    if (data.joints && data.joints.enabled) {
      Joint.initializeArrays(
        data.joints.data,
        data.joints.maxJoints,
        data.joints.entityCount || 0
      );
      Joint.initialize(data.joints.maxJoints);
      Joint.initializeFreeList(data.joints.freeList, data.joints.freeListTop);
      this.reportLog(`initialized Joint system for ${data.joints.maxJoints} joints`);
    }

    if (data.fixtures && data.fixtures.enabled) {
      const maxFixturePoolSize =
        data.fixtures.maxFixturePoolSize | data.fixtures.maxFixtures | 0;
      ColliderFixture.initializeArrays(
        data.fixtures.data,
        maxFixturePoolSize,
        data.fixtures.entityCount || 0
      );
      ColliderFixture.initialize(maxFixturePoolSize);
      ColliderFixture.initializeFreeList(data.fixtures.freeList, data.fixtures.freeListTop);
      this.reportLog(`initialized ColliderFixture pool for ${maxFixturePoolSize} fixtures`);
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
      if (data.keyIndexMap) {
        Keyboard.initialize(this.inputData, data.keyIndexMap);
      }
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

    // LiquidFun groups + thin emit SAB (HEAP pose bound later on box2dReady).
    if (data.buffers?.liquidFunGroups || data.buffers?.liquidFunRender) {
      LiquidFun.bindSabs({
        groups: data.buffers.liquidFunGroups || null,
        render: data.buffers.liquidFunRender || null,
        maxCount: data.liquidFunMaxCount | 0,
      });
    }

    // Initialize Mouse static class (input state shared across workers)
    if (data.buffers?.mouseData) {
      Mouse.initialize(data.buffers.mouseData);
    }

    // Initialize Gamepad static class (multipad state shared across workers)
    if (data.buffers?.gamepadData) {
      Gamepad.initialize(data.buffers.gamepadData);
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
      this.neighborData = new (EntityIdArray())(data.buffers.neighborData);
    }

    // Initialize active entities list (for load-balanced processing)
    // Layout: [count, entityIdx0, entityIdx1, ...]
    // Maintained incrementally by spawn/despawn, consumed by all workers
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    if (data.buffers?.activeEntitiesData) {
      this.activeEntitiesData = new (EntityIdArray())(data.buffers.activeEntitiesData);
      // Also set on GameObject for static access via GameObject.getAllActive()
      GameObject.activeEntitiesData = this.activeEntitiesData;
    }

    if (data.buffers?.queryVersion) {
      this.queryVersionData = new Int32Array(data.buffers.queryVersion);
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
    if (data.frameRateStride !== undefined) {
      this.frameRateStride = data.frameRateStride;
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
        this.activeEntitiesData,
        this.queryVersionData
      );

      this._publishPrecomputedActiveQueries = queryFunctions.publishPrecomputedActiveQueries;
      this._precomputedQueries = queryFunctions._precomputedQueries;
      this._queryEntityMetadata = queryFunctions._entityMetadata;

      Query.bindWorker(queryFunctions);

      this.reportLog(
        `initialized query system with ${this._precomputedQueries?.length || 0} pre-computed queries`
      );
    } else if (data.queries) {
      throw new Error('Query system requires SAB buffers (queryEntityMetadata/queryCache/queryResults)');
    }

    if (data.adobeAnimateMetadata) {
      AdobeAnimRegistry.deserialize(data.adobeAnimateMetadata);
    }

    this.reportLog('finished initializing common buffers');

    // Keep a reference to neighbor data for easy access (already set above, but also from GameObject)
    // neighborData is a single SAB (row ownership). Prefer Grid.neighborData.
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

    // Boot bind: same Transform.x views as HEAP. Logic uses _weedPoseBound only for reportReady.
    if (data.weedPose?.sab) {
      bindWeedPoseFields(data.weedPose);
      this._weedPoseBound = true;
    } else {
      this._weedPoseBound = false;
    }

    // Attach per-type active list views to EntityClasses
    // Now that scripts are loaded and components initialized, EntityClasses are on self
    // This gives ALL workers access to EntityClass._activeList for O(1) getAllActive()
    if (this.perTypeActiveLists && this.registeredClasses) {
      for (const registration of this.registeredClasses) {
        const EntityClass = self[registration.name];
        const sab = this.perTypeActiveLists[registration.name];
        if (EntityClass && sab) {
          EntityClass._activeList = new (EntityIdArray())(sab);
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
          EntityClass.freeList = new (EntityIdArray())(freeListSAB);
          EntityClass.freeListTop = new Int32Array(freeListTopSAB);
        }
      }
    }

    // Initialize Grid system with shared buffers and metadata
    // ARCHITECTURE: Row-based partitioned spatial grid
    // - gridBuffer: SINGLE buffer, each spatial worker owns specific rows
    // - neighborData: SINGLE buffer, row ownership eliminates races
    // - cellSleepingBuffer: SINGLE buffer, written by particle_worker, read by all
    // Row ownership: worker i owns row blocks where floor(row / rowsPerBlock) % totalWorkers === workerId
    // No double buffering, no Atomics, no locks - pure deterministic memory.
    if (data.gridMetadata && data.buffers?.gridBuffer) {
      // Use gridMetadata directly - it now includes maxNeighbors and maxEntitiesPerCell from scene config
      Grid.initialize(
        {
          gridBuffer: data.buffers.gridBuffer,
          neighborBuffer: data.buffers.neighborData,
          cellSleepingBuffer: data.buffers.cellSleepingBuffer,
          cellVersionBuffer: data.buffers.cellVersionBuffer,
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
    self.SharedResource = SharedResource;
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
    self.AdobeAnimRegistry = AdobeAnimRegistry;
    self.SoundManager = SoundManager;
    self.Joint = Joint;
    self.Layer = Layer;
    self.SceneBridge = SceneBridge;
    self.Gamepad = Gamepad;
    self.Box2d = Box2d;
    self.Decal = Decal;
    self.Query = Query;
    self.LiquidFun = LiquidFun;

    // Components (required for blob worker entity script evaluation)
    self.Transform = Transform;
    self.RigidBody = RigidBody;
    self.Collider = Collider;
    self.SpriteRenderer = SpriteRenderer;
    self.MeshRenderer = MeshRenderer;
    self.AdobeAnimComponent = AdobeAnimComponent;
    self.ParticleComponent = ParticleComponent;
    self.LightEmitter = LightEmitter;
    self.ShadowCaster = ShadowCaster;
    self.FlashComponent = FlashComponent;
    self.DecorationComponent = DecorationComponent;
    self.BulletComponent = BulletComponent;
    self.CameraInOutListener = CameraInOutListener;
    self.CollisionListener = CollisionListener;
    self.JointBreakListener = JointBreakListener;
    self.Grab = Grab;

    // Systems
    self.ParticleEmitter = ParticleEmitter;
    self.DecorationPool = DecorationPool;
    self.Decoration = Decoration;
    self.BulletPool = BulletPool;
    self.Flash = Flash;

    // Enums & utilities
    self.ShapeType = ShapeType;
    self.randomColor = randomColor;
    self.distanceSq2D = distanceSq2D;
    self.getDirectionFromAngle = getDirectionFromAngle;
    self.getDirectionFromVector = getDirectionFromVector;
    self.getDirection8FromVector = getDirection8FromVector;
    self.containerRadius = containerRadius;
  }

  /**
   * Initialize ALL components by collecting them from entity classes
   * This runs in ALL workers, making all components available everywhere with SharedArrayBuffer connections
   * Handles core components (Transform, RigidBody) and custom scene components
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

    // Always initialize dense cores if buffers exist, even when no entity uses them.
    // Workers receive componentPools as { name: { count, componentId } } (no ComponentClass ref).
    // Without this, scenes whose entities don't use RigidBody/Collider crash in spatial/physics/logic
    // because those workers access .active, pose/vel fields etc. which are undefined typed arrays.
    const coreComponents = [Transform, RigidBody, Collider, SpriteRenderer, MeshRenderer, AdobeAnimComponent];
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

    // Optional SoA: connect when allocated, else drop stale views from a prior scene
    const optionalComponents = [
      AdobeAnimComponent,
      LightEmitter,
      ShadowCaster,
      FlashComponent,
      LightOccluder,
    ];
    for (const ComponentClass of optionalComponents) {
      const name = ComponentClass.name;
      const buffer = componentData?.[name];
      const pool = componentPools?.[name];
      if (buffer) {
        const alreadyInit = ComponentClass.active && ComponentClass.active.length === totalEntityCount;
        if (!alreadyInit) {
          ComponentClass.initializeArrays(buffer, totalEntityCount);
          if (pool?.componentId !== undefined) ComponentClass.componentId = pool.componentId;
        }
      } else {
        ComponentClass.clearArrays();
        ComponentClass.componentId = null;
      }
    }
  }

  /**
   * Bind published physics pose double-buffer (all workers; same SAB).
   * @param {{ sync: SharedArrayBuffer, dataA: SharedArrayBuffer, dataB: SharedArrayBuffer, capacity: number }|null|undefined} pose
   */
  _bindPosePublish(pose) {
    this.poseSync = null;
    this.poseBuffers = [null, null];
    this.poseCapacity = 0;
    if (!pose?.sync || !pose.dataA || !pose.dataB) return;
    const n = pose.capacity | 0;
    if (!(n > 0)) return;
    this.poseCapacity = n;
    this.poseSync = new Int32Array(pose.sync);
    const sabs = [pose.dataA, pose.dataB];
    // 4 channels: x,y,rotC,rotS - must mirror weedjsPost.js bindPosePublish
    // (physics-worker-side writer of this same SAB layout).
    for (let i = 0; i < 2; i++) {
      const sab = sabs[i];
      this.poseBuffers[i] = {
        x: new Float32Array(sab, 0, n),
        y: new Float32Array(sab, n * 4, n),
        rotC: new Float32Array(sab, n * 8, n),
        rotS: new Float32Array(sab, n * 12, n),
      };
    }
  }

  /**
   * Pin published pose views on this._poseX/Y/rotC/rotS.
   * @param {boolean} [consume=false] - If true, store sync[1] (pre_render only).
   * @param {number} [readyOverride] - If a number (including 0), pin that generation
   *   and skip Atomics.load(poseSync). Pixi passes the render-queue stamp.
   */
  _latchPose(consume = false, readyOverride) {
    this._poseX = null;
    this._poseY = null;
    this._poseRotC = null;
    this._poseRotS = null;
    this._poseReadyFrame = 0;
    if (!this.poseBuffers[0]) return;
    const ready = readyOverride !== undefined && readyOverride !== null
      ? readyOverride | 0
      : (this.poseSync ? Atomics.load(this.poseSync, 0) : 0);
    if (!(ready > 0)) return;
    const curIdx = (ready - 1) & 1;
    const buf = this.poseBuffers[curIdx];
    this._poseX = buf.x;
    this._poseY = buf.y;
    this._poseRotC = buf.rotC;
    this._poseRotS = buf.rotS;
    this._poseReadyFrame = ready;
    if (ready >= 2) {
      const prevBuf = this.poseBuffers[1 - curIdx];
      this._prevPoseX = prevBuf.x;
      this._prevPoseY = prevBuf.y;
      this._prevPoseRotC = prevBuf.rotC;
      this._prevPoseRotS = prevBuf.rotS;
    } else {
      this._prevPoseX = null;
      this._prevPoseY = null;
      this._prevPoseRotC = null;
      this._prevPoseRotS = null;
    }
    if (consume && this.poseSync) Atomics.store(this.poseSync, 1, ready);
  }

  initSeededRandom(seed, workerId) {
    if (seed == null || seed == undefined) {
      seed = Date.now();
    }
    self.rng = seededRandom(seed, workerId ?? 'worker');
    // Also make it available globally without 'self.' prefix for entity code
    globalThis.rng = self.rng;
  }

  /**
   * Handle incoming messages from Scene
   * @param {MessageEvent} e - Message event
   */
  async handleMessage(e) {
    const { msg } = e.data;

    switch (msg) {
      case 'init':
        console.log(`[${this.constructor.name}] Received 'init' message, starting initialization...`);
        if (e.data.pageOrigin) {
          self.__weedPageOrigin = e.data.pageOrigin;
        }
        this.initSeededRandom(
          e.data.config.seed,
          e.data.workerName ?? e.data.frameRateIndex ?? e.data.workerIndex ?? 'worker'
        );
        this.isPaused = true; // Keep paused until "start" message
        console.log(`[${this.constructor.name}] Initializing common buffers...`);
        await this.initializeCommonBuffers(e.data);
        console.log(`[${this.constructor.name}] Common buffers initialized, setting up worker ports...`);
        this.initializeWorkerPorts(e.data.workerPorts); // Initialize direct worker communication
        console.log(`[${this.constructor.name}] Worker ports initialized, calling worker-specific initialize()...`);
        await this.initialize(e.data);
        console.log(`[${this.constructor.name}] Worker-specific initialize() completed`);
        // Logic defers reportReady until box2dReady (hot fields bound before setup()).
        if (this.shouldReportReadyAfterInit()) {
          console.log(`[${this.constructor.name}] calling reportReady()...`);
          this.reportReady();
          console.log(`[${this.constructor.name}] reportReady() called, waiting for 'start' message...`);
        } else {
          console.log(`[${this.constructor.name}] deferring reportReady until box2dReady`);
        }
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

      case 'step': {
        const dt = Number(e.data.deltaTime);
        this._injectedDeltaTime = dt > 0 ? dt : 16.67;
        this.isPaused = false;
        this._runFrame(false);
        this._injectedDeltaTime = 0;
        if (this.config?.manualStep) {
          this.isPaused = true;
        }
        this.afterManualStep();
        self.postMessage({ msg: 'stepDone', id: e.data.id | 0 });
        break;
      }

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
   * Whether to post workerReady at end of init.
   * LogicWorker returns false — it reports ready after box2dReady + GameObject construction.
   */
  shouldReportReadyAfterInit() {
    return true;
  }

  /**
   * Report to Scene that this worker is ready
   * Called automatically after initialization completes (unless deferred)
   */
  reportReady() {
    this.reportLog('initialization complete, signaling ready');
    console.log(`${this.constructor.name}: Sending workerReady message`);
    self.postMessage({ msg: 'workerReady', worker: this.constructor.name });
  }

  /**
   * Initialize MessagePorts for direct worker-to-worker communication
   * Called during init with ports object from Scene
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
   * @param {string} workerName - Target worker name ('renderer', 'logic0', 'particle', 'physics', …)
   * @param {Object} data - Data to send
   * @returns {boolean} True when the message was posted, false when no port exists
   */
  sendDataToWorker(workerName, data) {
    const port = this.workerPorts.get(workerName);
    if (!port) {
      console.warn(
        `${this.constructor.name}: No port to worker "${workerName}". Available:`,
        Array.from(this.workerPorts.keys())
      );
      return false;
    }
    port.postMessage(data);
    return true;
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
    this._clearFrameSchedulers();
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
   * Get the count of active entities from the shared activeEntitiesData list.
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

  // ==========================================
  // ABSTRACT METHODS - Must be implemented by subclasses
  // ==========================================

  /**
   * Initialize the worker with data from Scene
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
    if (data?.msg === 'box2dReady' && data.channelOffsets) {
      bindBox2dHotFields(data);
      if (data.commandSab) {
        bindCommandRing(data.commandSab);
      }
      if (data.queryAabbSab) {
        bindQueryAabbSab(data.queryAabbSab);
      }
      if (data.overlapCircleSab) {
        bindOverlapCircleSab(data.overlapCircleSab);
      }
      if (data.rayCastSab) {
        bindRayCastSab(data.rayCastSab);
      }
      if (data.castRayAllSab) {
        bindCastRayAllSab(data.castRayAllSab);
      }
      if (data.liquidFunQuerySab) {
        bindLiquidFunQuerySab(data.liquidFunQuerySab);
      }
      if (data.liquidFunExtractSab) {
        bindLiquidFunExtractSab(data.liquidFunExtractSab);
      }
      if (data.liquidFunUserDataListSab) {
        bindLiquidFunUserDataListSab(data.liquidFunUserDataListSab);
      }
      if (data.movedSab) {
        bindMovedBodies(data.movedSab);
      }
      if (data.liquidFunHeap) {
        LiquidFun.bindHeapPose(data.liquidFunHeap);
      }
    } else if (data?.msg === 'liquidFunHeap' && data.liquidFunHeap) {
      LiquidFun.bindHeapPose(data.liquidFunHeap);
    }
  }
}
