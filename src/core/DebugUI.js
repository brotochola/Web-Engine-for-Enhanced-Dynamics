// DebugUI.js - Minimalist debug overlay with self-updating display
// Creates a header bar with expandable sections for Scene, Performance, Visual Aids, and Entities

import { DEBUG_FLAGS } from "./DebugFlags.js";
import { Transform } from "../components/Transform.js";
import { Mouse } from "./Mouse.js";
import { GameObject } from "./gameObject.js";
import { DecorationComponent } from "../components/DecorationComponent.js";
import { DecorationPool } from "./DecorationPool.js";
import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  WORKER_DISPLAY_CONFIG,
  createStatsReader,
  createMultiWorkerStatsReaderArray,
} from "../workers/workers-utils.js";
import { formatNumber } from "./utils.js";
import { Z_INDICES, LAYER_DEFAULT_BLEND_MODES } from "./ConfigDefaults.js";

/**
 * DebugUI - Self-contained debug overlay that pulls data and updates itself
 * Managed by GameEngine, attaches/detaches when scenes change
 */
export class DebugUI {
  constructor(options = {}) {
    this.scene = null;
    this.debugFlags = null;
    this.gameEngine = null;

    this.updateInterval = 100; // Throttle interval in ms (~10fps for debug UI)
    this._rafId = null; // requestAnimationFrame ID
    this._lastTickTime = 0; // Last tick timestamp for throttling

    // DOM elements
    this.container = null;
    this.sections = {};
    this.elements = {};

    // Section state
    this.openSection = options.defaultOpen || null;

    // Registered scenes for scene switching
    this.registeredScenes = [];

    // Painter/Eraser tool state
    this.activeSpawnerType = null; // Which entity type is being painted
    this.eraserActive = false;
    this.lastSpawnTime = 0;
    this.spawnThrottleMs = 50; // Minimum ms between spawns while painting
    this._toolMouseDown = false; // Track mouse button for tool mode (separate from game input)
    this.bulkSpawnEnabled = false; // Spawn 10 at a time instead of 1

    // Worker stat views (created when scene attaches)
    this.workerStatViews = null;

    // FPS smoothing (60-frame moving average, calculated in DebugUI)
    this.fpsSmoothing = {
      frameCount: 60,
      renderer: { values: new Array(60).fill(60), index: 0, sum: 3600 },
      particle: { values: new Array(60).fill(60), index: 0, sum: 3600 },
      physics: { values: new Array(60).fill(60), index: 0, sum: 3600 },
      spatial: [], // Array of smoothing objects (one per spatial worker)
      logic: [], // Array of smoothing objects (one per logic worker)
    };

    // ========================================
    // PERFORMANCE: Pre-allocated caches to avoid GC
    // ========================================
    // Cache previous values to skip DOM updates when unchanged
    this._prevValues = {
      mainFPS: -1,
      activeGO: -1,
      totalGO: -1,
      visibleGO: -1,
      activeP: -1,
      totalP: -1,
      visibleP: -1,
      activeD: -1,
      totalD: -1,
      visibleD: -1,
      flashUpdated: -1,
      activeEntities: -1,
      totalEntities: -1,
      visibleEntities: -1,
      decorationTotal: -1,
      decorationActive: -1,
      decorationVisible: -1,
      decorationSprites: -1,
    };

    // Pre-allocated Set for internal entities (reused, never recreated)
    this._internalEntitiesSet = new Set(["Mouse", "Flash"]);

    // Pre-allocated string builder for pool stats
    this._poolStatsBuffer = "";
    this._prevPoolStatsBuffer = "";

    // Cache for worker stat previous values: { workerType: { workerIndex: { statKey: prevValue } } }
    this._prevWorkerStats = {};

    // Cache for spawner button keys (populated in _autoGenerateEntityTools)
    this._spawnerButtonKeys = null;

    // Inject styles and create UI (async, but doesn't block initialization)
    this._injectStyles();
    this._createUI();
    this._setupKeyboardShortcuts();
    this._setupToolMouseHandlers();
  }

  /**
   * Register available scenes for the scene switcher
   * @param {Array} scenes - [{ name: "Predators", class: PredatorScene }, ...]
   */
  registerScenes(scenes) {
    this.registeredScenes = scenes;
    this._updateScenePanel();
  }

  /**
   * Attach to a scene (called by GameEngine after scene loads)
   */
  attach(gameEngine, scene) {
    this.gameEngine = gameEngine;
    this.scene = scene;
    this.debugFlags = scene.debugFlags;

    // Reset painter tools on scene change
    this.activeSpawnerType = null;
    this.eraserActive = false;
    this._toolMouseDown = false;
    Mouse.isDebugToolActive = false;

    // Disable all debug flags when switching scenes
    if (this.debugFlags) {
      this.debugFlags.disableAll();
    }

    // Create stat buffer views for reading worker metrics
    this._createStatViews();

    this._updateVisualAidsState();
    this._updateScenePanel();
    this._autoGenerateEntityTools();
    this._updateLayersAvailability();
    this._updateToolIndicator();
    this.start();
  }

  /**
   * Create stat buffer views for reading worker metrics
   */
  _createStatViews() {
    if (!this.scene || !this.scene.buffers) return;

    const buffers = this.scene.buffers;
    const spatialWorkerCount = this.scene.config.spatial.numberOfSpatialWorkers;
    const logicWorkerCount = this.scene.numberOfLogicWorkers;

    this.workerStatViews = {
      renderer: buffers.rendererStats
        ? createStatsReader(buffers.rendererStats, RENDERER_STATS)
        : null,
      particle: buffers.particleStats
        ? createStatsReader(buffers.particleStats, PARTICLE_STATS)
        : null,
      physics: buffers.physicsStats
        ? createStatsReader(buffers.physicsStats, PHYSICS_STATS)
        : null,
      spatial: buffers.spatialStats
        ? createMultiWorkerStatsReaderArray(
          buffers.spatialStats,
          SPATIAL_STATS,
          spatialWorkerCount
        )
        : [],
      logic: buffers.logicStats
        ? createMultiWorkerStatsReaderArray(
          buffers.logicStats,
          LOGIC_STATS,
          logicWorkerCount
        )
        : [],
    };

    // Initialize FPS smoothing arrays for multi-worker types
    this.fpsSmoothing.spatial = [];
    for (let i = 0; i < spatialWorkerCount; i++) {
      this.fpsSmoothing.spatial.push({
        values: new Array(60).fill(60),
        index: 0,
        sum: 3600,
      });
    }

    this.fpsSmoothing.logic = [];
    for (let i = 0; i < logicWorkerCount; i++) {
      this.fpsSmoothing.logic.push({
        values: new Array(60).fill(60),
        index: 0,
        sum: 3600,
      });
    }

    // Create DOM elements for each worker
    this._createWorkerStatElements();
  }

  /**
   * Create DOM elements for each worker's stats
   */
  _createWorkerStatElements() {
    const container = this.elements.workerStatsContainer;
    if (!container) return;

    // Clear existing content
    container.innerHTML = "";

    // Create table structure
    const table = document.createElement("div");
    table.className = "debug-ui-worker-table";

    // Storage for worker stat elements
    this.elements.workerStats = {};

    // Calculate max stat count for column width distribution
    let maxStatCount = 0;
    for (const config of Object.values(WORKER_DISPLAY_CONFIG)) {
      maxStatCount = Math.max(maxStatCount, config.stats.length);
    }
    table.setAttribute("data-stat-count", maxStatCount);

    // Main thread FPS row (add as first row in table)
    const mainRow = document.createElement("div");
    mainRow.className = "debug-ui-worker-row";
    const mainLabel = document.createElement("div");
    mainLabel.className = "debug-ui-worker-cell label debug-ui-stat main";
    mainLabel.textContent = "Main:";
    mainRow.appendChild(mainLabel);
    const mainFpsCell = document.createElement("div");
    mainFpsCell.className = "debug-ui-worker-cell stat";
    mainFpsCell.textContent = "FPS: --";
    mainRow.appendChild(mainFpsCell);
    this.elements.mainFPS = mainFpsCell;
    table.appendChild(mainRow);

    // Single workers (renderer, particle, physics)
    const singleWorkers = ["renderer", "particle", "physics"];
    for (const workerType of singleWorkers) {
      if (this.workerStatViews[workerType]) {
        const row = this._createWorkerStatRow(workerType, 0);
        table.appendChild(row.row);
        if (!this.elements.workerStats[workerType]) {
          this.elements.workerStats[workerType] = [];
        }
        this.elements.workerStats[workerType].push(row.elements);
      }
    }

    // Multi-workers (spatial, logic)
    const multiWorkers = ["spatial", "logic"];
    for (const workerType of multiWorkers) {
      const workerViews = this.workerStatViews[workerType];
      if (workerViews && workerViews.length > 0) {
        this.elements.workerStats[workerType] = [];
        for (let i = 0; i < workerViews.length; i++) {
          const row = this._createWorkerStatRow(workerType, i);
          table.appendChild(row.row);
          this.elements.workerStats[workerType].push(row.elements);
        }
      }
    }

    container.appendChild(table);
  }

  /**
   * Create a single worker stat row with all its stats
   * @param {string} workerType - Type of worker (renderer, particle, etc.)
   * @param {number} workerIndex - Index for multi-workers (0 for single workers)
   * @returns {Object} Object with row element and elements property containing stat cells
   */
  _createWorkerStatRow(workerType, workerIndex) {
    const config = WORKER_DISPLAY_CONFIG[workerType];
    const row = document.createElement("div");
    row.className = "debug-ui-worker-row";

    const elements = {};

    // Worker label (e.g., "Spatial #0:", "Render #0:")
    const labelCell = document.createElement("div");
    labelCell.className = `debug-ui-worker-cell label debug-ui-stat ${config.color}`;
    const workerCount =
      workerType === "spatial" || workerType === "logic"
        ? this.workerStatViews[workerType].length
        : 1;
    const workerLabel =
      workerCount > 1 ? `${config.label} #${workerIndex}` : config.label;
    labelCell.textContent = `${workerLabel}:`;
    row.appendChild(labelCell);

    // Create stat elements based on config
    for (const stat of config.stats) {
      const statCell = document.createElement("div");
      statCell.className = `debug-ui-worker-cell stat debug-ui-stat ${config.color}`;
      statCell.textContent = `${stat.key}: --`;
      row.appendChild(statCell);
      elements[stat.key] = statCell;
    }

    return { row, elements };
  }

  /**
   * Smooth FPS using 60-frame moving average
   * @param {number} rawFPS - Instantaneous FPS from worker
   * @param {Object} smoothing - Smoothing state object
   * @returns {number} Smoothed FPS
   */
  _smoothFPS(rawFPS, smoothing) {
    // Remove oldest value from sum
    smoothing.sum -= smoothing.values[smoothing.index];
    // Add new value
    smoothing.values[smoothing.index] = rawFPS;
    smoothing.sum += rawFPS;
    // Move to next index (circular buffer)
    smoothing.index = (smoothing.index + 1) % smoothing.values.length;
    // Return average
    return smoothing.sum / smoothing.values.length;
  }

  /**
   * Detach from scene (called by GameEngine before scene unloads)
   */
  detach() {
    this.stop();
    this.activeSpawnerType = null;
    this.eraserActive = false;
    this._toolMouseDown = false;
    Mouse.isDebugToolActive = false;
    this.workerStatViews = null;
    this.scene = null;
    this.debugFlags = null;
  }

  /**
   * Start the self-update loop using requestAnimationFrame
   * Throttled to ~10fps (100ms intervals) to minimize overhead
   */
  start() {
    if (this._rafId) return;
    this._lastTickTime = 0;

    const loop = (currentTime) => {
      // Throttle to updateInterval (default 100ms = ~10fps for debug UI)
      if (currentTime - this._lastTickTime >= this.updateInterval) {
        this._lastTickTime = currentTime;
        this._tick();
      }
      this._rafId = requestAnimationFrame(loop);
    };

    this._rafId = requestAnimationFrame(loop);
  }

  /**
   * Stop the update loop
   */
  stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * Main update loop - pulls all data and updates UI
   * OPTIMIZED: Only runs every ~100ms, caches values, minimal DOM updates
   */
  _tick() {
    if (!this.scene) return;

    // DEBUG: Set to true to completely skip all updates (test if DebugUI is the bottleneck)
    // const SKIP_ALL_UPDATES = true;
    // if (SKIP_ALL_UPDATES) return;

    // DEBUG: Uncomment to profile tick time
    // const t0 = performance.now();

    this._updatePerformanceSection();
    this._updateEntitiesSection();
    this._updateDecorationsSection();
    this._updateToolButtonStates();
    this._updatePaintTool();

    // DEBUG: Uncomment to profile tick time
    // const tickTime = performance.now() - t0;
    // if (tickTime > 1) console.log("DebugUI._tick took", tickTime.toFixed(2), "ms");
  }

  /**
   * Poll for paint/erase tool actions
   * Uses _toolMouseDown (tracked by DebugUI) and Mouse position (entity 0)
   */
  _updatePaintTool() {
    if (!this.activeSpawnerType && !this.eraserActive) {
      return;
    }

    // Perform paint action while mouse is held down
    if (this._toolMouseDown && Mouse.isPresent) {
      this._handlePaintAction();
    }
  }

  // ========================================
  // PERFORMANCE SECTION
  // ========================================

  _updatePerformanceSection() {
    const scene = this.scene;
    if (!scene || !this.workerStatViews) return;

    // Update summary counts
    this._updatePerformanceSummary();

    // Main thread FPS - only update if changed (rounded to 2 decimals)
    const mainFPSRounded = (scene.mainFPS * 100) | 0;
    if (this.elements.mainFPS && mainFPSRounded !== this._prevValues.mainFPS) {
      this._prevValues.mainFPS = mainFPSRounded;
      this.elements.mainFPS.textContent =
        "FPS: " + (mainFPSRounded / 100).toFixed(2);
    }

    // Update single workers (renderer, particle, physics)
    this._updateSingleWorkerStats("renderer", RENDERER_STATS);
    this._updateSingleWorkerStats("particle", PARTICLE_STATS);
    this._updateSingleWorkerStats("physics", PHYSICS_STATS);

    // Update multi-workers (spatial, logic)
    this._updateMultiWorkerStats("spatial", SPATIAL_STATS);
    this._updateMultiWorkerStats("logic", LOGIC_STATS);
  }

  /**
   * Update the performance summary section with entity/particle/decoration counts
   * OPTIMIZED: Only update DOM when values change, no allocations in hot path
   */
  _updatePerformanceSummary() {
    const scene = this.scene;
    if (!scene) return;

    const pv = this._prevValues;
    const particleView = this.workerStatViews && this.workerStatViews.particle;
    const rendererView = this.workerStatViews && this.workerStatViews.renderer;

    // GameObjects - only update if any value changed
    if (particleView && this.elements.perfGameObjects) {
      const activeGO = (particleView[PARTICLE_STATS.ACTIVE_ENTITIES] || 0) | 0;
      const totalGO = (particleView[PARTICLE_STATS.TOTAL_ENTITIES] || 0) | 0;
      const visibleGO = rendererView
        ? (rendererView[RENDERER_STATS.VISIBLE_ENTITIES] || 0) | 0
        : 0;

      if (
        activeGO !== pv.activeGO ||
        totalGO !== pv.totalGO ||
        visibleGO !== pv.visibleGO
      ) {
        pv.activeGO = activeGO;
        pv.totalGO = totalGO;
        pv.visibleGO = visibleGO;
        this.elements.perfGameObjects.textContent =
          "GameObjects: " +
          formatNumber(activeGO) +
          " / " +
          formatNumber(totalGO) +
          " (👁 " +
          formatNumber(visibleGO) +
          ")";
      }
    }

    // Particles - only update if any value changed
    if (particleView && this.elements.perfParticles) {
      const activeP = (particleView[PARTICLE_STATS.ACTIVE_PARTICLES] || 0) | 0;
      const totalP = (particleView[PARTICLE_STATS.TOTAL_PARTICLES] || 0) | 0;
      const visibleP = rendererView
        ? (rendererView[RENDERER_STATS.VISIBLE_PARTICLES] || 0) | 0
        : 0;

      if (
        activeP !== pv.activeP ||
        totalP !== pv.totalP ||
        visibleP !== pv.visibleP
      ) {
        pv.activeP = activeP;
        pv.totalP = totalP;
        pv.visibleP = visibleP;
        this.elements.perfParticles.textContent =
          "Particles: " +
          formatNumber(activeP) +
          " / " +
          formatNumber(totalP) +
          " (👁 " +
          formatNumber(visibleP) +
          ")";
      }
    }

    // Decorations - only update if any value changed
    if (rendererView && this.elements.perfDecorations) {
      const activeD =
        (rendererView[RENDERER_STATS.ACTIVE_DECORATIONS] || 0) | 0;
      const visibleD =
        (rendererView[RENDERER_STATS.VISIBLE_DECORATIONS] || 0) | 0;
      const totalD = (DecorationPool.maxDecorations || 0) | 0;

      if (
        activeD !== pv.activeD ||
        totalD !== pv.totalD ||
        visibleD !== pv.visibleD
      ) {
        pv.activeD = activeD;
        pv.totalD = totalD;
        pv.visibleD = visibleD;
        this.elements.perfDecorations.textContent =
          "Decorations: " +
          formatNumber(activeD) +
          " / " +
          formatNumber(totalD) +
          " (👁 " +
          formatNumber(visibleD) +
          ")";
      }
    }

    // Flash entities - only update if value changed
    if (particleView && this.elements.perfFlash) {
      const flashesUpdated =
        (particleView[PARTICLE_STATS.FLASHES_UPDATED] || 0) | 0;

      if (flashesUpdated !== pv.flashUpdated) {
        pv.flashUpdated = flashesUpdated;
        this.elements.perfFlash.textContent =
          "Flash: " + formatNumber(flashesUpdated) + " updated";
      }
    }
  }

  /**
   * Update stats for a single worker
   * OPTIMIZED: Cache previous values, only update DOM when changed
   * @param {string} workerType - Type of worker (renderer, particle, physics)
   * @param {Object} statsSchema - Stats schema object
   */
  _updateSingleWorkerStats(workerType, statsSchema) {
    const view = this.workerStatViews[workerType];
    if (!view) return;

    const workerStats = this.elements.workerStats;
    if (!workerStats || !workerStats[workerType] || !workerStats[workerType][0])
      return;
    const elements = workerStats[workerType][0];

    const config = WORKER_DISPLAY_CONFIG[workerType];

    // Initialize cache if needed
    if (!this._prevWorkerStats[workerType]) {
      this._prevWorkerStats[workerType] = { 0: {} };
    }
    const prevCache = this._prevWorkerStats[workerType][0];

    const stats = config.stats;
    for (let s = 0; s < stats.length; s++) {
      const stat = stats[s];
      const statIndex = statsSchema[stat.key];
      let rawValue = view[statIndex];

      // Smooth FPS values
      if (stat.key === "FPS") {
        rawValue = this._smoothFPS(rawValue, this.fpsSmoothing[workerType]);
      }

      // Round to avoid floating point noise triggering updates
      const roundedValue = (rawValue * 100) | 0;
      if (prevCache[stat.key] === roundedValue) continue;
      prevCache[stat.key] = roundedValue;

      const formattedValue = stat.format(rawValue);
      elements[stat.key].textContent = stat.key + ": " + formattedValue;
    }
  }

  /**
   * Update stats for multi-workers
   * OPTIMIZED: Cache previous values, only update DOM when changed
   * @param {string} workerType - Type of worker (spatial, logic)
   * @param {Object} statsSchema - Stats schema object
   */
  _updateMultiWorkerStats(workerType, statsSchema) {
    const views = this.workerStatViews[workerType];
    if (!views || views.length === 0) return;

    const workerStats = this.elements.workerStats;
    if (!workerStats || !workerStats[workerType]) return;
    const workerElements = workerStats[workerType];

    const config = WORKER_DISPLAY_CONFIG[workerType];

    // Initialize cache if needed
    if (!this._prevWorkerStats[workerType]) {
      this._prevWorkerStats[workerType] = {};
    }

    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      const elements = workerElements[i];
      if (!elements) continue;

      if (!this._prevWorkerStats[workerType][i]) {
        this._prevWorkerStats[workerType][i] = {};
      }
      const prevCache = this._prevWorkerStats[workerType][i];

      const stats = config.stats;
      for (let s = 0; s < stats.length; s++) {
        const stat = stats[s];
        const statIndex = statsSchema[stat.key];
        let rawValue = view[statIndex];

        // Smooth FPS values
        if (stat.key === "FPS") {
          rawValue = this._smoothFPS(
            rawValue,
            this.fpsSmoothing[workerType][i]
          );
        }

        // Round to avoid floating point noise triggering updates
        const roundedValue = (rawValue * 100) | 0;
        if (prevCache[stat.key] === roundedValue) continue;
        prevCache[stat.key] = roundedValue;

        const formattedValue = stat.format(rawValue);
        elements[stat.key].textContent = stat.key + ": " + formattedValue;
      }
    }
  }

  // ========================================
  // ENTITIES SECTION
  // ========================================

  _updateEntitiesSection() {
    const scene = this.scene;
    if (!scene) return;

    const pv = this._prevValues;
    const particleView = this.workerStatViews && this.workerStatViews.particle;
    const rendererView = this.workerStatViews && this.workerStatViews.renderer;

    // Active entities - only update if changed
    if (this.elements.activeCount && particleView) {
      const active = (particleView[PARTICLE_STATS.ACTIVE_ENTITIES] || 0) | 0;
      const total = (particleView[PARTICLE_STATS.TOTAL_ENTITIES] || 0) | 0;

      if (active !== pv.activeEntities || total !== pv.totalEntities) {
        pv.activeEntities = active;
        pv.totalEntities = total;
        this.elements.activeCount.textContent =
          "Active: " +
          formatNumber(active) +
          "/" +
          formatNumber(total);
      }
    }

    // Visible units - only update if changed
    if (this.elements.visibleCount && rendererView) {
      const visible =
        ((rendererView[RENDERER_STATS.VISIBLE_ENTITIES] || 0) +
          (rendererView[RENDERER_STATS.VISIBLE_PARTICLES] || 0)) |
        0;

      if (visible !== pv.visibleEntities) {
        pv.visibleEntities = visible;
        this.elements.visibleCount.textContent =
          "Visible: " + formatNumber(visible);
      }
    }

    // Pool stats - build string only if values changed, reuse Set
    if (this.elements.poolStats && this.gameEngine) {
      this._poolStatsBuffer = "";
      const registeredClasses = scene.registeredClasses;
      if (registeredClasses) {
        for (let i = 0; i < registeredClasses.length; i++) {
          const reg = registeredClasses[i];
          if (this._internalEntitiesSet.has(reg.class.name)) continue;
          const stats = this.gameEngine.getPoolStats(reg.class);
          if (stats && stats.total > 0) {
            if (this._poolStatsBuffer.length > 0) {
              this._poolStatsBuffer += " | ";
            }
            this._poolStatsBuffer +=
              reg.class.name +
              ": " +
              formatNumber(stats.active) +
              "/" +
              formatNumber(stats.total);
          }
        }
      }
      // Only update DOM if string changed
      if (this._poolStatsBuffer !== this._prevPoolStatsBuffer) {
        this._prevPoolStatsBuffer = this._poolStatsBuffer;
        this.elements.poolStats.textContent = this._poolStatsBuffer;
      }
    }
  }

  // ========================================
  // DECORATIONS SECTION
  // ========================================

  _updateDecorationsSection() {
    const scene = this.scene;
    if (!scene) return;

    const pv = this._prevValues;
    const rendererView = this.workerStatViews && this.workerStatViews.renderer;

    // Total decoration pool size - only update if changed
    if (this.elements.decorationTotal) {
      const total = (DecorationPool.maxDecorations || 0) | 0;
      if (total !== pv.decorationTotal) {
        pv.decorationTotal = total;
        this.elements.decorationTotal.textContent =
          "Total: " + formatNumber(total);
      }
    }

    // Active decorations - only update if changed
    if (this.elements.decorationActive && rendererView) {
      const active = (rendererView[RENDERER_STATS.ACTIVE_DECORATIONS] || 0) | 0;
      if (active !== pv.decorationActive) {
        pv.decorationActive = active;
        this.elements.decorationActive.textContent =
          "Active: " + formatNumber(active);
      }
    }

    // Visible decorations - only update if changed
    if (this.elements.decorationVisible && rendererView) {
      const visible =
        (rendererView[RENDERER_STATS.VISIBLE_DECORATIONS] || 0) | 0;
      if (visible !== pv.decorationVisible) {
        pv.decorationVisible = visible;
        this.elements.decorationVisible.textContent =
          "Visible: " + formatNumber(visible);
      }
    }

    // PIXI sprites created - only update if changed
    if (this.elements.decorationSprites && rendererView) {
      const spriteCount =
        (rendererView[RENDERER_STATS.DECORATION_SPRITES] || 0) | 0;
      if (spriteCount !== pv.decorationSprites) {
        pv.decorationSprites = spriteCount;
        this.elements.decorationSprites.textContent =
          "Sprites: " + formatNumber(spriteCount);
      }
    }
  }

  // ========================================
  // VISUAL AIDS SECTION
  // ========================================

  _updateVisualAidsState() {
    if (!this.debugFlags) return;

    // Update toggle button states
    const state = this.debugFlags.getState();
    for (const [key, btn] of Object.entries(
      this.elements.visualToggles || {}
    )) {
      if (btn && state[key] !== undefined) {
        btn.classList.toggle("active", state[key]);
      }
    }
  }

  _toggleVisualAid(key) {
    if (!this.debugFlags) return;

    const methodMap = {
      colliders: "showColliders",
      velocity: "showVelocity",
      acceleration: "showAcceleration",
      neighbors: "showNeighbors",
      spatialGrid: "showSpatialGrid",
      aabb: "showAABB",
      entityIndices: "showEntityIndices",
      raycasts: "showRaycasts",
    };

    const method = methodMap[key];
    if (method && this.debugFlags[method]) {
      const currentState = this.debugFlags.isEnabled(
        DEBUG_FLAGS[
        `SHOW_${key
          .toUpperCase()
          .replace("GRID", "_GRID")
          .replace("INDICES", "_INDICES")}`
        ]
      );
      this.debugFlags[method](!currentState);
      this._updateVisualAidsState();
    }
  }

  // ========================================
  // UI CREATION
  // ========================================

  async _injectStyles() {
    if (document.getElementById("debug-ui-styles")) return;

    try {
      // Fetch CSS file from the same directory as this module
      const cssPath = new URL("./DebugUI.css", import.meta.url).href;
      const response = await fetch(cssPath);
      const cssText = await response.text();

      const style = document.createElement("style");
      style.id = "debug-ui-styles";
      style.textContent = cssText;
      document.head.appendChild(style);
    } catch (error) {
      console.error("Failed to load DebugUI.css:", error);
      // Fallback: continue without styles (or could inject minimal inline styles)
    }
  }

  _createUI() {
    // Main container
    this.container = document.createElement("div");
    this.container.className = "debug-ui";

    // Header bar
    const header = document.createElement("div");
    header.className = "debug-ui-header";

    // Scene tab (NEW)
    const sceneTab = this._createTab("🎬", "Scene", "scene");
    header.appendChild(sceneTab);

    // Performance tab
    const perfTab = this._createTab("⚡", "Performance", "performance");
    header.appendChild(perfTab);

    // Visual Aids tab
    const visualTab = this._createTab("👁", "Visual", "visual");
    header.appendChild(visualTab);

    // Entities tab
    const entitiesTab = this._createTab("📦", "Entities", "entities");
    header.appendChild(entitiesTab);

    // Decorations tab
    const decorationsTab = this._createTab("🌿", "Decorations", "decorations");
    header.appendChild(decorationsTab);

    // Layers tab (NEW)
    const layersTab = this._createTab("📚", "Layers", "layers");
    header.appendChild(layersTab);

    // Spacer
    const spacer = document.createElement("div");
    spacer.className = "debug-ui-spacer";
    header.appendChild(spacer);

    // Toggle visibility hint
    const toggle = document.createElement("div");
    toggle.className = "debug-ui-toggle";
    toggle.textContent = "[H] Toggle";
    toggle.onclick = () => this.toggle();
    header.appendChild(toggle);

    this.container.appendChild(header);

    // Create panels
    this._createScenePanel();
    this._createPerformancePanel();
    this._createVisualPanel();
    this._createEntitiesPanel();
    this._createDecorationsPanel();
    this._createLayersPanel();

    // Create tool indicator (shows active tool at bottom of screen)
    this._createToolIndicator();

    document.body.appendChild(this.container);
  }

  _createTab(icon, label, sectionId) {
    const tab = document.createElement("div");
    tab.className = "debug-ui-tab";
    tab.innerHTML = `<span class="icon">${icon}</span><span>${label}</span><span class="arrow">▼</span>`;
    tab.onclick = () => this._toggleSection(sectionId);
    this.sections[sectionId] = { tab };
    return tab;
  }

  _toggleSection(sectionId) {
    const wasOpen = this.openSection === sectionId;

    // Close all sections
    for (const [id, section] of Object.entries(this.sections)) {
      section.tab.classList.remove("active");
      if (section.panel) section.panel.classList.remove("open");
    }

    // Open clicked section (unless it was already open)
    if (!wasOpen) {
      this.openSection = sectionId;
      this.sections[sectionId].tab.classList.add("active");
      if (this.sections[sectionId].panel) {
        this.sections[sectionId].panel.classList.add("open");
      }
    } else {
      this.openSection = null;
    }
  }

  // ========================================
  // SCENE PANEL (NEW)
  // ========================================

  _createScenePanel() {
    const panel = document.createElement("div");
    panel.className = "debug-ui-panel";

    // Scene buttons container
    this.elements.sceneSwitchContainer = document.createElement("div");
    this.elements.sceneSwitchContainer.className = "debug-ui-row";
    this.elements.sceneSwitchContainer.style.gap = "8px";
    panel.appendChild(this.elements.sceneSwitchContainer);

    // Controls row (pause/resume)
    const controlsRow = document.createElement("div");
    controlsRow.className = "debug-ui-row";
    controlsRow.style.marginTop = "8px";
    controlsRow.style.gap = "8px";

    // Label
    const controlsLabel = document.createElement("span");
    controlsLabel.className = "debug-ui-stat";
    controlsLabel.textContent = "Controls:";
    controlsRow.appendChild(controlsLabel);

    // Pause button
    this.elements.pauseBtn = document.createElement("button");
    this.elements.pauseBtn.className = "debug-ui-btn";
    this.elements.pauseBtn.textContent = "⏸ Pause";
    this.elements.pauseBtn.onclick = () => {
      if (this.gameEngine) {
        this.gameEngine.pause();
        this._updatePlayPauseState();
      }
    };
    controlsRow.appendChild(this.elements.pauseBtn);

    // Resume button
    this.elements.resumeBtn = document.createElement("button");
    this.elements.resumeBtn.className = "debug-ui-btn";
    this.elements.resumeBtn.textContent = "▶ Play";
    this.elements.resumeBtn.onclick = () => {
      if (this.gameEngine) {
        this.gameEngine.resume();
        this._updatePlayPauseState();
      }
    };
    controlsRow.appendChild(this.elements.resumeBtn);

    panel.appendChild(controlsRow);

    this.container.appendChild(panel);
    this.sections.scene.panel = panel;
  }

  _updateScenePanel() {
    const container = this.elements.sceneSwitchContainer;
    if (!container) return;

    container.innerHTML = "";

    // Label
    const label = document.createElement("span");
    label.className = "debug-ui-stat";
    label.textContent = "Scene:";
    container.appendChild(label);

    // Add scene buttons
    for (const sceneConfig of this.registeredScenes) {
      const btn = document.createElement("button");
      btn.className = "debug-ui-btn scene-btn";
      btn.textContent = sceneConfig.name;

      // Mark current scene as active
      if (this.scene && this.scene.constructor === sceneConfig.class) {
        btn.classList.add("active");
      }

      btn.onclick = async () => {
        if (this.gameEngine && this.scene?.constructor !== sceneConfig.class) {
          await this.gameEngine.loadScene(sceneConfig.class);
        }
      };

      container.appendChild(btn);
    }

    this._updatePlayPauseState();
  }

  _updatePlayPauseState() {
    if (!this.scene) return;

    const isPaused = this.scene.state?.pause;
    if (this.elements.pauseBtn) {
      this.elements.pauseBtn.classList.toggle("active", isPaused);
    }
    if (this.elements.resumeBtn) {
      this.elements.resumeBtn.classList.toggle("active", !isPaused);
    }
  }

  _createPerformancePanel() {
    const panel = document.createElement("div");
    panel.className = "debug-ui-panel";

    // Container div for flexible layout
    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "12px";

    // Summary section for entity counts
    const summarySection = document.createElement("div");
    summarySection.className = "debug-ui-performance-summary";
    summarySection.style.display = "flex";
    summarySection.style.flexDirection = "column";
    summarySection.style.gap = "4px";
    summarySection.style.padding = "8px";
    summarySection.style.backgroundColor = "rgba(0, 0, 0, 0.3)";
    summarySection.style.borderRadius = "4px";

    // All pool stats on ONE row with different colors
    const poolStatsRow = document.createElement("div");
    poolStatsRow.className = "debug-ui-row";
    poolStatsRow.style.justifyContent = "flex-start";
    poolStatsRow.style.gap = "16px";

    // Pools Stats title (inline with data)
    const poolStatsTitle = document.createElement("span");
    poolStatsTitle.className = "debug-ui-stat";
    poolStatsTitle.style.fontWeight = "bold";
    poolStatsTitle.style.color = "rgba(255, 255, 255, 0.9)";
    poolStatsTitle.textContent = "Pools Stats:";
    poolStatsRow.appendChild(poolStatsTitle);

    // GameObjects (main green color)
    this.elements.perfGameObjects = document.createElement("span");
    this.elements.perfGameObjects.className = "debug-ui-stat";
    this.elements.perfGameObjects.style.color = "#4ade80";
    this.elements.perfGameObjects.textContent = "GameObjects: -- / -- (👁 --)";
    poolStatsRow.appendChild(this.elements.perfGameObjects);

    // Particles (particle orange color)
    this.elements.perfParticles = document.createElement("span");
    this.elements.perfParticles.className = "debug-ui-stat";
    this.elements.perfParticles.style.color = "#fb923c";
    this.elements.perfParticles.textContent = "Particles: -- / -- (👁 --)";
    poolStatsRow.appendChild(this.elements.perfParticles);

    // Decorations (nature green-cyan color)
    this.elements.perfDecorations = document.createElement("span");
    this.elements.perfDecorations.className = "debug-ui-stat";
    this.elements.perfDecorations.style.color = "#34d399";
    this.elements.perfDecorations.textContent = "Decorations: -- / -- (👁 --)";
    poolStatsRow.appendChild(this.elements.perfDecorations);

    // Flash (bright yellow color)
    this.elements.perfFlash = document.createElement("span");
    this.elements.perfFlash.className = "debug-ui-stat";
    this.elements.perfFlash.style.color = "#fbbf24";
    this.elements.perfFlash.textContent = "Flash: -- / -- (👁 --)";
    poolStatsRow.appendChild(this.elements.perfFlash);

    summarySection.appendChild(poolStatsRow);
    container.appendChild(summarySection);

    // Job stealing stats (shown when enabled)
    const jobRow = document.createElement("div");
    jobRow.className = "debug-ui-row";
    this.elements.jobStealing = this._createStat("Jobs: --", "jobs");
    jobRow.appendChild(this.elements.jobStealing);
    jobRow.style.display = "none";
    this.elements.jobStealingRow = jobRow;
    container.appendChild(jobRow);

    // Worker Stats Title
    const workerStatsTitle = document.createElement("div");
    workerStatsTitle.className = "debug-ui-stat";
    workerStatsTitle.style.fontWeight = "bold";
    workerStatsTitle.style.fontSize = "12px";
    workerStatsTitle.style.marginTop = "8px";
    workerStatsTitle.style.marginBottom = "4px";
    workerStatsTitle.style.color = "rgba(255, 255, 255, 0.9)";
    workerStatsTitle.textContent = "Worker Stats";
    container.appendChild(workerStatsTitle);

    // Container for worker stat rows (will be dynamically populated on scene attach)
    this.elements.workerStatsContainer = document.createElement("div");
    this.elements.workerStatsContainer.style.display = "flex";
    this.elements.workerStatsContainer.style.flexDirection = "column";
    this.elements.workerStatsContainer.style.gap = "4px";
    container.appendChild(this.elements.workerStatsContainer);

    panel.appendChild(container);
    this.container.appendChild(panel);
    this.sections.performance.panel = panel;
  }

  _createVisualPanel() {
    const panel = document.createElement("div");
    panel.className = "debug-ui-panel";

    const row = document.createElement("div");
    row.className = "debug-ui-row";

    this.elements.visualToggles = {};

    const visualAids = [
      { key: "colliders", label: "Colliders", shortcut: "1" },
      { key: "velocity", label: "Velocity", shortcut: "2" },
      { key: "acceleration", label: "Accel", shortcut: "3" },
      { key: "neighbors", label: "Neighbors", shortcut: "4" },
      { key: "spatialGrid", label: "Grid", shortcut: "5" },
      { key: "aabb", label: "AABB", shortcut: "6" },
      { key: "entityIndices", label: "Indices", shortcut: "7" },
      { key: "raycasts", label: "Raycasts", shortcut: "8" },
    ];

    for (const aid of visualAids) {
      const btn = document.createElement("button");
      btn.className = "debug-ui-btn";
      btn.textContent = `[${aid.shortcut}] ${aid.label}`;
      btn.onclick = () => this._toggleVisualAid(aid.key);
      this.elements.visualToggles[aid.key] = btn;
      row.appendChild(btn);
    }

    // Disable all button
    const disableBtn = document.createElement("button");
    disableBtn.className = "debug-ui-btn danger";
    disableBtn.textContent = "[0] Off";
    disableBtn.onclick = () => {
      if (this.debugFlags) {
        this.debugFlags.disableAll();
        this._updateVisualAidsState();
      }
    };
    row.appendChild(disableBtn);

    panel.appendChild(row);
    this.container.appendChild(panel);
    this.sections.visual.panel = panel;
  }

  _createEntitiesPanel() {
    const panel = document.createElement("div");
    panel.className = "debug-ui-panel";

    // Stats row
    const statsRow = document.createElement("div");
    statsRow.className = "debug-ui-row";

    this.elements.activeCount = this._createStat("Active: --", "");
    this.elements.visibleCount = this._createStat("Visible: --", "");
    this.elements.poolStats = this._createStat("Pools: --", "");

    statsRow.appendChild(this.elements.activeCount);
    statsRow.appendChild(this.elements.visibleCount);
    statsRow.appendChild(this._createDivider());
    statsRow.appendChild(this.elements.poolStats);

    panel.appendChild(statsRow);

    // Tools container (populated per-scene)
    this.elements.entityToolsContainer = document.createElement("div");
    this.elements.entityToolsContainer.style.marginTop = "8px";
    panel.appendChild(this.elements.entityToolsContainer);

    this.container.appendChild(panel);
    this.sections.entities.panel = panel;
  }

  _createDecorationsPanel() {
    const panel = document.createElement("div");
    panel.className = "debug-ui-panel";

    // Stats row
    const statsRow = document.createElement("div");
    statsRow.className = "debug-ui-row";

    this.elements.decorationTotal = this._createStat("Total: --", "");
    this.elements.decorationActive = this._createStat("Active: --", "");
    this.elements.decorationVisible = this._createStat("Visible: --", "");
    this.elements.decorationSprites = this._createStat(
      "Sprites: --",
      "renderer"
    );

    statsRow.appendChild(this.elements.decorationTotal);
    statsRow.appendChild(this.elements.decorationActive);
    statsRow.appendChild(this.elements.decorationVisible);
    statsRow.appendChild(this._createDivider());
    statsRow.appendChild(this.elements.decorationSprites);

    panel.appendChild(statsRow);

    this.container.appendChild(panel);
    this.sections.decorations.panel = panel;
  }

  // ========================================
  // LAYERS PANEL
  // ========================================

  _createLayersPanel() {
    const panel = document.createElement("div");
    panel.className = "debug-ui-panel";

    // Layer names from Z_INDICES enum (imported from ConfigDefaults)
    const layerNames = Object.keys(Z_INDICES);

    // Store layer control elements for potential updates
    this.elements.layerControls = {};
    this.elements.layerRows = {};

    // Create a row for each layer
    for (const layerName of layerNames) {
      const row = document.createElement("div");
      row.className = "debug-ui-row";
      row.style.gap = "12px";
      row.style.alignItems = "center";
      row.style.marginBottom = "6px";

      // Layer name label
      const label = document.createElement("span");
      label.className = "debug-ui-stat";
      label.style.minWidth = "120px";
      label.style.fontWeight = "bold";
      label.textContent = layerName;
      row.appendChild(label);

      // Visibility checkbox
      const visibleLabel = document.createElement("label");
      visibleLabel.style.display = "flex";
      visibleLabel.style.alignItems = "center";
      visibleLabel.style.gap = "4px";
      visibleLabel.style.cursor = "pointer";
      visibleLabel.style.fontSize = "10px";
      visibleLabel.style.color = "rgba(255, 255, 255, 0.7)";

      const visibleCheckbox = document.createElement("input");
      visibleCheckbox.type = "checkbox";
      visibleCheckbox.checked = true;
      visibleCheckbox.style.cursor = "pointer";
      visibleCheckbox.onchange = () => this._setLayerProp(layerName, "visible", visibleCheckbox.checked);

      visibleLabel.appendChild(visibleCheckbox);
      visibleLabel.appendChild(document.createTextNode("Visible"));
      row.appendChild(visibleLabel);

      // Alpha slider
      const alphaContainer = document.createElement("div");
      alphaContainer.style.display = "flex";
      alphaContainer.style.alignItems = "center";
      alphaContainer.style.gap = "4px";

      const alphaLabel = document.createElement("span");
      alphaLabel.style.fontSize = "10px";
      alphaLabel.style.color = "rgba(255, 255, 255, 0.7)";
      alphaLabel.textContent = "Alpha:";
      alphaContainer.appendChild(alphaLabel);

      const alphaSlider = document.createElement("input");
      alphaSlider.type = "range";
      alphaSlider.min = "0";
      alphaSlider.max = "100";
      alphaSlider.value = "100";
      alphaSlider.style.width = "80px";
      alphaSlider.style.cursor = "pointer";
      alphaSlider.oninput = () => {
        alphaValue.textContent = alphaSlider.value + "%";
        this._setLayerProp(layerName, "alpha", parseInt(alphaSlider.value) / 100);
      };
      alphaContainer.appendChild(alphaSlider);

      const alphaValue = document.createElement("span");
      alphaValue.style.fontSize = "10px";
      alphaValue.style.color = "rgba(255, 255, 255, 0.7)";
      alphaValue.style.minWidth = "35px";
      alphaValue.textContent = "100%";
      alphaContainer.appendChild(alphaValue);

      row.appendChild(alphaContainer);

      // Blend mode dropdown
      const blendContainer = document.createElement("div");
      blendContainer.style.display = "flex";
      blendContainer.style.alignItems = "center";
      blendContainer.style.gap = "4px";

      const blendLabel = document.createElement("span");
      blendLabel.style.fontSize = "10px";
      blendLabel.style.color = "rgba(255, 255, 255, 0.7)";
      blendLabel.textContent = "Blend:";
      blendContainer.appendChild(blendLabel);

      const blendSelect = document.createElement("select");
      blendSelect.style.fontSize = "10px";
      blendSelect.style.padding = "2px 4px";
      blendSelect.style.cursor = "pointer";
      blendSelect.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
      blendSelect.style.color = "white";
      blendSelect.style.border = "1px solid rgba(255, 255, 255, 0.3)";
      blendSelect.style.borderRadius = "3px";

      // PIXI blend modes - npm = non-premultiplied alpha (multiply-npm doesn't exist)
      const blendModes = ["normal", "normal-npm", "add", "add-npm", "multiply", "screen", "screen-npm", "erase"];
      for (const mode of blendModes) {
        const option = document.createElement("option");
        option.value = mode;
        option.textContent = mode;
        blendSelect.appendChild(option);
      }
      // Set default value from LAYER_DEFAULT_BLEND_MODES enum
      blendSelect.value = LAYER_DEFAULT_BLEND_MODES[layerName] || "normal";
      blendSelect.onchange = () => this._setLayerProp(layerName, "blendMode", blendSelect.value);
      blendContainer.appendChild(blendSelect);

      row.appendChild(blendContainer);

      // Z-Index input
      const zIndexContainer = document.createElement("div");
      zIndexContainer.style.display = "flex";
      zIndexContainer.style.alignItems = "center";
      zIndexContainer.style.gap = "4px";

      const zIndexLabel = document.createElement("span");
      zIndexLabel.style.fontSize = "10px";
      zIndexLabel.style.color = "rgba(255, 255, 255, 0.7)";
      zIndexLabel.textContent = "Z:";
      zIndexContainer.appendChild(zIndexLabel);

      const zIndexInput = document.createElement("input");
      zIndexInput.type = "number";
      zIndexInput.value = Z_INDICES[layerName];
      zIndexInput.style.width = "50px";
      zIndexInput.style.fontSize = "10px";
      zIndexInput.style.padding = "2px 4px";
      zIndexInput.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
      zIndexInput.style.color = "white";
      zIndexInput.style.border = "1px solid rgba(255, 255, 255, 0.3)";
      zIndexInput.style.borderRadius = "3px";
      zIndexInput.onchange = () => this._setLayerProp(layerName, "zIndex", parseInt(zIndexInput.value));
      zIndexContainer.appendChild(zIndexInput);

      row.appendChild(zIndexContainer);

      panel.appendChild(row);

      // Store references
      this.elements.layerControls[layerName] = {
        visible: visibleCheckbox,
        alpha: alphaSlider,
        alphaValue: alphaValue,
        blendMode: blendSelect,
        zIndex: zIndexInput,
      };
      this.elements.layerRows[layerName] = row;
    }

    this.container.appendChild(panel);
    this.sections.layers.panel = panel;
  }

  /**
   * Update layer controls availability based on scene config
   * Called when scene is attached
   */
  _updateLayersAvailability() {
    if (!this.scene || !this.elements.layerRows) return;

    const config = this.scene.config;
    const availableLayers = this._getAvailableLayers(config);

    for (const [layerName, row] of Object.entries(this.elements.layerRows)) {
      const isAvailable = availableLayers.has(layerName);
      const controls = this.elements.layerControls[layerName];

      if (isAvailable) {
        row.style.opacity = "1";
        row.style.pointerEvents = "auto";
        controls.visible.disabled = false;
        controls.alpha.disabled = false;
        controls.blendMode.disabled = false;
        controls.zIndex.disabled = false;
      } else {
        row.style.opacity = "0.4";
        row.style.pointerEvents = "none";
        controls.visible.disabled = true;
        controls.alpha.disabled = true;
        controls.blendMode.disabled = true;
        controls.zIndex.disabled = true;
      }
    }
  }

  /**
   * Determine which layers are available based on scene config
   * @param {Object} config - Scene configuration
   * @returns {Set<string>} Set of available layer names
   */
  _getAvailableLayers(config) {
    const available = new Set();

    // ENTITIES is always available
    available.add("ENTITIES");

    // BACKGROUND - check if scene has tilemap or background texture
    // Note: We can't easily know this from config alone, so we assume it's available
    // if the scene has loaded any tilemaps or has a bgTextureName in renderer config
    if (this.scene.loadedTilemaps && Object.keys(this.scene.loadedTilemaps).length > 0) {
      available.add("BACKGROUND");
    }
    if (config.renderer?.bgTextureName) {
      available.add("BACKGROUND");
    }

    // DECALS - check particle.decals config
    if (config.particle?.decals) {
      available.add("DECALS");
    }

    // LIGHTING related layers
    if (config.lighting?.enabled) {
      available.add("LIGHTING");
      available.add("LIGHT_GLOW");

      // CASTED_SHADOWS - only if shadows are enabled within lighting
      if (config.lighting?.shadowsEnabled) {
        available.add("CASTED_SHADOWS");
      }
    }

    return available;
  }

  /**
   * Send layer property change to renderer worker
   */
  _setLayerProp(layer, prop, value) {
    if (!this.scene || !this.scene.workers || !this.scene.workers.renderer) {
      console.warn("DebugUI: Cannot set layer prop, renderer worker not available");
      return;
    }

    const message = {
      msg: "setLayerProps",
      layer: layer,
    };
    message[prop] = value;

    this.scene.workers.renderer.postMessage(message);
  }

  _createToolIndicator() {
    this.elements.toolIndicator = document.createElement("div");
    this.elements.toolIndicator.className = "debug-ui-tool-indicator";
    document.body.appendChild(this.elements.toolIndicator);
  }

  _updateToolIndicator() {
    const indicator = this.elements.toolIndicator;
    if (!indicator) return;

    if (this.activeSpawnerType) {
      const bulkText = this.bulkSpawnEnabled ? " ×50" : "";
      indicator.textContent = `🎨 Painting: ${this.activeSpawnerType}${bulkText} (click & drag to spawn)`;
      indicator.className = "debug-ui-tool-indicator visible spawner";
    } else if (this.eraserActive) {
      indicator.textContent = `🧹 Eraser Active (click & drag to despawn)`;
      indicator.className = "debug-ui-tool-indicator visible eraser";
    } else {
      indicator.className = "debug-ui-tool-indicator";
    }
  }

  _createStat(text, className) {
    const span = document.createElement("span");
    span.className = `debug-ui-stat ${className}`;
    span.textContent = text;
    return span;
  }

  _createDivider() {
    const div = document.createElement("div");
    div.className = "debug-ui-divider";
    return div;
  }

  // ========================================
  // ENTITY TOOLS (Painter/Eraser)
  // ========================================

  /**
   * Auto-generate entity painter and eraser tools
   */
  _autoGenerateEntityTools() {
    if (!this.scene || !this.gameEngine) return;

    const container = this.elements.entityToolsContainer;
    if (!container) return;

    container.innerHTML = "";

    // Internal entity types that shouldn't have tools
    const internalEntities = new Set(["Mouse", "Flash"]);

    // Get spawnable entity classes from the scene
    const spawnableClasses = (this.scene.registeredClasses || []).filter(
      (reg) => reg.count > 0 && !internalEntities.has(reg.class.name)
    );

    if (spawnableClasses.length === 0) return;

    // Painter tools row
    const paintersRow = document.createElement("div");
    paintersRow.className = "debug-ui-row";
    paintersRow.style.gap = "8px";
    paintersRow.style.flexWrap = "wrap";

    // Label
    const paintersLabel = document.createElement("span");
    paintersLabel.className = "debug-ui-stat";
    paintersLabel.textContent = "Paint:";
    paintersRow.appendChild(paintersLabel);

    this.elements.spawnerButtons = {};
    this._spawnerButtonKeys = []; // Cache keys to avoid Object.keys() allocation in tick

    // Generate painter button for each entity type
    for (const reg of spawnableClasses) {
      const className = reg.class.name;

      const btn = document.createElement("button");
      btn.className = "debug-ui-btn tool";
      btn.textContent = "🎨 " + className;
      btn.title =
        "Toggle " + className + " painter (click & drag on canvas to spawn)";
      btn.onclick = () => this._toggleSpawner(className);
      this.elements.spawnerButtons[className] = btn;
      this._spawnerButtonKeys.push(className); // Cache key
      paintersRow.appendChild(btn);
    }

    // Eraser button
    this.elements.eraserButton = document.createElement("button");
    this.elements.eraserButton.className = "debug-ui-btn danger";
    this.elements.eraserButton.textContent = "🧹 Eraser";
    this.elements.eraserButton.title =
      "Toggle eraser (click & drag to despawn entities)";
    this.elements.eraserButton.onclick = () => this._toggleEraser();
    paintersRow.appendChild(this.elements.eraserButton);

    // Divider
    paintersRow.appendChild(this._createDivider());

    // Bulk spawn checkbox
    const bulkLabel = document.createElement("label");
    bulkLabel.style.display = "flex";
    bulkLabel.style.alignItems = "center";
    bulkLabel.style.gap = "4px";
    bulkLabel.style.color = "rgba(255, 255, 255, 0.7)";
    bulkLabel.style.cursor = "pointer";
    bulkLabel.style.fontSize = "10px";

    this.elements.bulkSpawnCheckbox = document.createElement("input");
    this.elements.bulkSpawnCheckbox.type = "checkbox";
    this.elements.bulkSpawnCheckbox.checked = this.bulkSpawnEnabled;
    this.elements.bulkSpawnCheckbox.style.cursor = "pointer";
    this.elements.bulkSpawnCheckbox.onchange = (e) => {
      this.bulkSpawnEnabled = e.target.checked;
      this._updateToolIndicator();
    };

    bulkLabel.appendChild(this.elements.bulkSpawnCheckbox);
    bulkLabel.appendChild(document.createTextNode("×50"));
    paintersRow.appendChild(bulkLabel);

    container.appendChild(paintersRow);

    // Clear all row
    const clearRow = document.createElement("div");
    clearRow.className = "debug-ui-row";
    clearRow.style.marginTop = "8px";
    clearRow.style.gap = "8px";

    const clearLabel = document.createElement("span");
    clearLabel.className = "debug-ui-stat";
    clearLabel.textContent = "Clear:";
    clearRow.appendChild(clearLabel);

    // Clear buttons for each entity type
    for (const reg of spawnableClasses) {
      const className = reg.class.name;
      const clearBtn = document.createElement("button");
      clearBtn.className = "debug-ui-btn danger";
      clearBtn.textContent = `🗑 ${className}`;
      clearBtn.title = `Despawn all ${className} entities`;
      clearBtn.onclick = () => {
        this.gameEngine.despawnAllEntities(className);
      };
      clearRow.appendChild(clearBtn);
    }

    container.appendChild(clearRow);

    this._updateToolButtonStates();
  }

  _toggleSpawner(className) {
    // If already active, deactivate
    if (this.activeSpawnerType === className) {
      this.activeSpawnerType = null;
    } else {
      // Activate this spawner, deactivate eraser
      this.activeSpawnerType = className;
      this.eraserActive = false;
    }
    this._updateDebugToolFlag();
    this._updateToolButtonStates();
    this._updateToolIndicator();
  }

  _toggleEraser() {
    this.eraserActive = !this.eraserActive;
    if (this.eraserActive) {
      this.activeSpawnerType = null;
    }
    this._updateDebugToolFlag();
    this._updateToolButtonStates();
    this._updateToolIndicator();
  }

  /**
   * Update Mouse.isDebugToolActive flag to block game input when tools are active
   */
  _updateDebugToolFlag() {
    Mouse.isDebugToolActive = !!(this.activeSpawnerType || this.eraserActive);
  }

  _updateToolButtonStates() {
    // Update spawner buttons - use pre-cached keys array (no allocation)
    const spawnerButtons = this.elements.spawnerButtons;
    const keys = this._spawnerButtonKeys;
    if (spawnerButtons && keys) {
      const activeType = this.activeSpawnerType;
      for (let i = 0; i < keys.length; i++) {
        const className = keys[i];
        const btn = spawnerButtons[className];
        const shouldBeActive = activeType === className;
        const isActive = btn.classList.contains("active");
        if (shouldBeActive !== isActive) {
          btn.classList.toggle("active", shouldBeActive);
        }
      }
    }

    // Update eraser button - only toggle if state changed
    const eraserBtn = this.elements.eraserButton;
    if (eraserBtn) {
      const isActive = eraserBtn.classList.contains("active");
      if (this.eraserActive !== isActive) {
        eraserBtn.classList.toggle("active", this.eraserActive);
      }
    }
  }

  /**
   * Setup mouse handlers for tool mode button tracking
   * These track button state independently from the game's Mouse class
   */
  _setupToolMouseHandlers() {
    this._onToolMouseDown = (e) => {
      if (e.button !== 0) return; // Only track left button
      if (!this.activeSpawnerType && !this.eraserActive) return;
      this._toolMouseDown = true;
    };

    this._onToolMouseUp = (e) => {
      if (e.button !== 0) return;
      this._toolMouseDown = false;
    };

    // Use capture phase to get events before game handlers
    document.addEventListener("mousedown", this._onToolMouseDown, true);
    document.addEventListener("mouseup", this._onToolMouseUp, true);
  }

  _handlePaintAction() {
    const now = performance.now();

    // Throttle spawning
    if (now - this.lastSpawnTime < this.spawnThrottleMs) return;
    this.lastSpawnTime = now;

    if (this.activeSpawnerType) {
      this._spawnEntityAtMouse(this.activeSpawnerType);
    } else if (this.eraserActive) {
      this._despawnEntityAtMouse();
    }
  }

  /**
   * Spawn entity at current mouse position (uses Mouse entity 0)
   * Spawns multiple entities in a spread pattern when bulk spawn is enabled
   */
  _spawnEntityAtMouse(className) {
    if (!this.gameEngine) return;

    const count = this.bulkSpawnEnabled ? 50 : 1;
    const spreadRadius = 30; // Pixels to spread entities around mouse

    for (let i = 0; i < count; i++) {
      // Add random offset for bulk spawning to spread entities
      const offsetX = count > 1 ? (Math.random() - 0.5) * spreadRadius * 2 : 0;
      const offsetY = count > 1 ? (Math.random() - 0.5) * spreadRadius * 2 : 0;

      this.gameEngine.spawnEntity(className, {
        x: Mouse.x + offsetX,
        y: Mouse.y + offsetY,
      });
    }
  }

  /**
   * Despawn entity nearest to mouse position
   * Uses Mouse entity's neighbor data from spatial worker for efficiency
   */
  _despawnEntityAtMouse() {
    if (!this.scene || !this.gameEngine) return;

    const eraserRadiusSq = 50 * 50; // Squared pixels for comparison with distance data
    const internalEntities = new Set(["Mouse", "Flash"]);

    // Get Mouse's neighbors from spatial worker data (Mouse is always entity 0)
    const neighborData = GameObject.neighborData;
    const distanceData = GameObject.distanceData;

    if (!neighborData) {
      // Fallback if neighbor data not available
      return;
    }

    const maxNeighbors = this.scene.config?.spatial?.maxNeighbors || 100;
    const offset = 0; // Mouse is entity 0, so offset is 0
    const neighborCount = neighborData[offset];

    if (neighborCount === 0) return;

    // Find nearest neighbor within eraser radius
    let nearestIndex = -1;
    let nearestDistSq = eraserRadiusSq;

    for (let n = 0; n < neighborCount; n++) {
      const neighborIdx = neighborData[offset + 1 + n];

      if (!Transform.active[neighborIdx]) continue;

      // Skip internal entities
      const entityType = Transform.entityType[neighborIdx];
      const reg = this.scene.registeredClasses.find(
        (r) => r.entityType === entityType
      );
      if (reg && internalEntities.has(reg.class.name)) continue;

      // Use precomputed squared distance from spatial worker
      const distSq = distanceData ? distanceData[offset + 1 + n] : null;

      if (distSq !== null && distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestIndex = neighborIdx;
      }
    }

    if (nearestIndex >= 0) {
      // Despawn through the scene/worker to properly update the freeList
      // Direct main-thread despawn would corrupt the worker's freeList
      this.scene.despawnEntity(nearestIndex);
    }
  }

  // ========================================
  // KEYBOARD SHORTCUTS
  // ========================================

  _setupKeyboardShortcuts() {
    this._keyHandler = (e) => {
      // Ignore if typing in input
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
        return;

      const key = e.key.toLowerCase();

      if (key === "h") {
        this.toggle();
      } else if (key === "escape") {
        // ESC to deselect all tools
        this.activeSpawnerType = null;
        this.eraserActive = false;
        this._toolMouseDown = false;
        this._updateDebugToolFlag();
        this._updateToolButtonStates();
        this._updateToolIndicator();
      } else if (key >= "1" && key <= "7") {
        const keyMap = {
          1: "colliders",
          2: "velocity",
          3: "acceleration",
          4: "neighbors",
          5: "spatialGrid",
          6: "aabb",
          7: "entityIndices",
        };
        this._toggleVisualAid(keyMap[key]);
      } else if (key === "0") {
        if (this.debugFlags) {
          this.debugFlags.disableAll();
          this._updateVisualAidsState();
        }
      }
    };

    window.addEventListener("keydown", this._keyHandler);
  }

  // ========================================
  // VISIBILITY
  // ========================================

  toggle() {
    this.container.classList.toggle("hidden");
  }

  show() {
    this.container.classList.remove("hidden");
  }

  hide() {
    this.container.classList.add("hidden");
  }

  // ========================================
  // CLEANUP
  // ========================================

  destroy() {
    this.stop();

    if (this._keyHandler) {
      window.removeEventListener("keydown", this._keyHandler);
    }

    if (this._onToolMouseDown) {
      document.removeEventListener("mousedown", this._onToolMouseDown, true);
    }
    if (this._onToolMouseUp) {
      document.removeEventListener("mouseup", this._onToolMouseUp, true);
    }

    // Clear debug tool flag
    Mouse.isDebugToolActive = false;

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    if (this.elements.toolIndicator && this.elements.toolIndicator.parentNode) {
      this.elements.toolIndicator.parentNode.removeChild(
        this.elements.toolIndicator
      );
    }

    const styles = document.getElementById("debug-ui-styles");
    if (styles) {
      styles.parentNode.removeChild(styles);
    }
  }
}
