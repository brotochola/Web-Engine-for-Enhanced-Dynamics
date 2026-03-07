// DebugUI.js - Minimalist debug overlay with self-updating display
// Creates a header bar with expandable sections for Scene, Performance, Visual Aids, and Entities

import { DEBUG_FLAGS } from './DebugFlags.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { Mouse } from './Mouse.js';
import { GameObject } from './gameObject.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { DecorationPool } from './DecorationPool.js';
import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
  WORKER_DISPLAY_CONFIG,
  createStatsReader,
  createMultiWorkerStatsReaderArray,
} from '../workers/workers-utils.js';
import {
  formatNumber,
  getComponentColor,
  getComponentPropertyNames,
  formatComponentValue,
  distanceSq2D,
} from './utils.js';
import { Z_INDICES, LAYER_DEFAULT_BLEND_MODES } from './ConfigDefaults.js';
import { NavGrid } from './NavGrid.js';
import { Grid } from './Grid.js';
import { Constraint } from './Constraint.js';

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

    // Entity Inspector state
    this.inspectorActive = false; // Is inspect mode enabled
    this.selectedEntityIndex = -1; // Currently selected entity (-1 = none)
    this._inspectorPanelVisible = false; // Is the inspector panel currently showing
    this._prevInspectorValues = {}; // Cache previous values to avoid DOM updates

    // Navigation debug state
    this._selectedFlowfieldSlot = -1; // Currently selected flowfield for visualization
    this._selectedPathSlot = -1; // Currently selected path for visualization
    this._selectedStaticFlowfield = null; // Name of selected static flowfield (or null)
    this._showWalkabilityGrid = false; // Show walkable/blocked cells

    // Unified debug canvas (replaces _navVisualizationCanvas)
    // Renders all debug overlays: colliders, velocity, neighbors, raycasts, nav, etc.
    this._debugCanvas = null;
    this._debugCtx = null;
    this._debugRafId = null; // RAF loop for smooth debug rendering

    // Worker stat views (created when scene attaches)
    this.workerStatViews = null;

    // FPS smoothing (60-frame moving average, calculated in DebugUI)
    this.fpsSmoothing = {
      frameCount: 60,
      renderer: { values: new Array(60).fill(60), index: 0, sum: 3600 },
      particle: { values: new Array(60).fill(60), index: 0, sum: 3600 },
      physics: { values: new Array(60).fill(60), index: 0, sum: 3600 },
      preRender: { values: new Array(60).fill(60), index: 0, sum: 3600 },
      spatial: [], // Array of smoothing objects (one per spatial worker)
      logic: [], // Array of smoothing objects (one per logic worker)
    };

    // ========================================
    // PERFORMANCE: Pre-allocated caches to avoid GC
    // ========================================
    // Cache previous values to skip DOM updates when unchanged
    this._prevValues = {
      mainFPS: -1,
      audioActive: -1,
      audioMax: -1,
      audioLoaded: -1,
      audioDropped: -1,
      audioMixGain: -1,
      audioMasterVol: -1,
      audioMuted: false,
      audioRate: -1,
      audioLatency: -1,
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
    this._internalEntitiesSet = new Set(['Flash']);

    // Pre-allocated string builder for pool stats
    this._poolStatsBuffer = '';
    this._prevPoolStatsBuffer = '';

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

    // Reset inspector on scene change
    this.inspectorActive = false;
    this.selectedEntityIndex = -1;
    this._prevInspectorValues = {};
    this._hideInspectorPanel();

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
    this._updateInspectorButtonState();
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
      physics: buffers.physicsStats ? createStatsReader(buffers.physicsStats, PHYSICS_STATS) : null,
      spatial: buffers.spatialStats
        ? createMultiWorkerStatsReaderArray(buffers.spatialStats, SPATIAL_STATS, spatialWorkerCount)
        : [],
      logic: buffers.logicStats
        ? createMultiWorkerStatsReaderArray(buffers.logicStats, LOGIC_STATS, logicWorkerCount)
        : [],
      preRender: buffers.preRenderStats
        ? createStatsReader(buffers.preRenderStats, PRE_RENDER_STATS)
        : null,
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
    container.innerHTML = '';

    // Create table structure
    const table = document.createElement('div');
    table.className = 'debug-ui-worker-table';

    // Storage for worker stat elements
    this.elements.workerStats = {};

    // Calculate max stat count for column width distribution
    let maxStatCount = 0;
    for (const config of Object.values(WORKER_DISPLAY_CONFIG)) {
      maxStatCount = Math.max(maxStatCount, config.stats.length);
    }
    table.setAttribute('data-stat-count', maxStatCount);

    // Main thread FPS row (add as first row in table)
    const mainRow = document.createElement('div');
    mainRow.className = 'debug-ui-worker-row';
    const mainLabel = document.createElement('div');
    mainLabel.className = 'debug-ui-worker-cell label debug-ui-stat main';
    mainLabel.textContent = 'Main:';
    mainRow.appendChild(mainLabel);
    const mainFpsCell = document.createElement('div');
    mainFpsCell.className = 'debug-ui-worker-cell stat';
    mainFpsCell.textContent = 'FPS: --';
    mainRow.appendChild(mainFpsCell);
    this.elements.mainFPS = mainFpsCell;

    table.appendChild(mainRow);

    // Single workers (renderer, particle, physics, preRender)
    const singleWorkers = ['renderer', 'particle', 'physics', 'preRender'];
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
    const multiWorkers = ['spatial', 'logic'];
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

    // Audio row (AudioWorklet metrics)
    const audioRow = document.createElement('div');
    audioRow.className = 'debug-ui-worker-row';
    const audioLabel = document.createElement('div');
    audioLabel.className = 'debug-ui-worker-cell label debug-ui-stat audio';
    audioLabel.textContent = 'Audio:';
    audioRow.appendChild(audioLabel);

    const audioStats = ['SlotsLd', 'DropMix', 'Vol', 'RateLat'];
    this.elements.audioStats = {};
    for (const stat of audioStats) {
      const cell = document.createElement('div');
      cell.className = 'debug-ui-worker-cell stat debug-ui-stat audio';
      cell.textContent = '--';
      audioRow.appendChild(cell);
      this.elements.audioStats[stat] = cell;
    }
    table.appendChild(audioRow);

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
    const row = document.createElement('div');
    row.className = 'debug-ui-worker-row';

    const elements = {};

    // Worker label (e.g., "Spatial #0:", "Render #0:")
    const labelCell = document.createElement('div');
    labelCell.className = `debug-ui-worker-cell label debug-ui-stat ${config.color}`;
    const workerCount =
      workerType === 'spatial' || workerType === 'logic'
        ? this.workerStatViews[workerType].length
        : 1;
    const workerLabel = workerCount > 1 ? `${config.label} #${workerIndex}` : config.label;
    labelCell.textContent = `${workerLabel}:`;
    row.appendChild(labelCell);

    // Create stat elements based on config
    for (const stat of config.stats) {
      const statCell = document.createElement('div');
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
    this._stopDebugVisualizationLoop();
    this._clearDebugCanvas();
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
    this._updateInspectorValues();

    // DEBUG: Uncomment to profile tick time
    // const tickTime = performance.now() - t0;
    // if (tickTime > 1) console.log("DebugUI._tick took", tickTime.toFixed(2), "ms");
  }

  /**
   * Start the debug visualization RAF loop (runs at 60fps for smooth camera tracking)
   * Handles all debug overlays: colliders, velocity, neighbors, raycasts, nav, etc.
   */
  _startDebugVisualizationLoop() {
    if (this._debugRafId) return; // Already running

    const loop = () => {
      if (this._hasActiveDebugVisualization()) {
        this._renderDebugVisualization();
        this._debugRafId = requestAnimationFrame(loop);
      } else {
        this._debugRafId = null;
      }
    };

    this._debugRafId = requestAnimationFrame(loop);
  }

  /**
   * Stop the debug visualization RAF loop
   */
  _stopDebugVisualizationLoop() {
    if (this._debugRafId) {
      cancelAnimationFrame(this._debugRafId);
      this._debugRafId = null;
    }
  }

  /**
   * Poll for paint/erase tool actions
   * Uses _toolMouseDown (tracked by DebugUI) and Mouse position
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
      this.elements.mainFPS.textContent = 'FPS: ' + (mainFPSRounded / 100).toFixed(2);
    }

    // AudioWorklet metrics
    this._updateAudioStats(scene.audioMetrics);

    // Update single workers (renderer, particle, physics, preRender)
    this._updateSingleWorkerStats('renderer', RENDERER_STATS);
    this._updateSingleWorkerStats('particle', PARTICLE_STATS);
    this._updateSingleWorkerStats('physics', PHYSICS_STATS);
    this._updateSingleWorkerStats('preRender', PRE_RENDER_STATS);

    // Update multi-workers (spatial, logic)
    this._updateMultiWorkerStats('spatial', SPATIAL_STATS);
    this._updateMultiWorkerStats('logic', LOGIC_STATS);
  }

  _updateAudioStats(audioMetrics) {
    const els = this.elements.audioStats;
    if (!els || !audioMetrics) return;

    const pv = this._prevValues;
    const active = (audioMetrics.activeSlots || 0) | 0;
    const max = (audioMetrics.maxSlots || 0) | 0;
    const loaded = (audioMetrics.loadedSounds || 0) | 0;
    const rate = (audioMetrics.sampleRate || 0) | 0;
    const baseLat = audioMetrics.baseLatency || 0;
    const outLat = audioMetrics.outputLatency || 0;

    if (active !== pv.audioActive || max !== pv.audioMax || loaded !== pv.audioLoaded) {
      pv.audioActive = active;
      pv.audioMax = max;
      pv.audioLoaded = loaded;
      els.SlotsLd.textContent = active + '/' + max + ' Ld:' + loaded;
    }

    const dropped = (audioMetrics.dropped || 0) | 0;
    const mixGainR = ((audioMetrics.mixGain || 0) * 100 + 0.5) | 0;
    if (dropped !== pv.audioDropped || mixGainR !== pv.audioMixGain) {
      pv.audioDropped = dropped;
      pv.audioMixGain = mixGainR;
      els.DropMix.textContent = 'Dropped:' + dropped + ' Mix:' + mixGainR + '%';
    }

    const muted = audioMetrics.muted;
    const masterVolR = ((audioMetrics.masterVolume || 0) * 100 + 0.5) | 0;
    if (masterVolR !== pv.audioMasterVol || muted !== pv.audioMuted) {
      pv.audioMasterVol = masterVolR;
      pv.audioMuted = muted;
      els.Vol.textContent = 'Vol:' + masterVolR + '%' + (muted ? ' (m)' : '');
    }

    const latencyMs = ((baseLat + outLat) * 100000 + 0.5) | 0;
    if (rate !== pv.audioRate || latencyMs !== pv.audioLatency) {
      pv.audioRate = rate;
      pv.audioLatency = latencyMs;
      const rateStr = rate >= 1000 ? (rate / 1000) + 'k' : rate;
      els.RateLat.textContent = rateStr + ' Lat:' + (latencyMs / 100).toFixed(2) + 'ms';
    }
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
      const visibleGO = rendererView ? (rendererView[RENDERER_STATS.VISIBLE_ENTITIES] || 0) | 0 : 0;

      if (activeGO !== pv.activeGO || totalGO !== pv.totalGO || visibleGO !== pv.visibleGO) {
        pv.activeGO = activeGO;
        pv.totalGO = totalGO;
        pv.visibleGO = visibleGO;
        this.elements.perfGameObjects.textContent =
          'GameObjects: ' +
          formatNumber(activeGO) +
          ' / ' +
          formatNumber(totalGO) +
          ' (👁 ' +
          formatNumber(visibleGO) +
          ')';
      }
    }

    // Particles - only update if any value changed
    if (particleView && this.elements.perfParticles) {
      const activeP = (particleView[PARTICLE_STATS.ACTIVE_PARTICLES] || 0) | 0;
      const totalP = (particleView[PARTICLE_STATS.TOTAL_PARTICLES] || 0) | 0;
      const visibleP = rendererView ? (rendererView[RENDERER_STATS.VISIBLE_PARTICLES] || 0) | 0 : 0;

      if (activeP !== pv.activeP || totalP !== pv.totalP || visibleP !== pv.visibleP) {
        pv.activeP = activeP;
        pv.totalP = totalP;
        pv.visibleP = visibleP;
        this.elements.perfParticles.textContent =
          'Particles: ' +
          formatNumber(activeP) +
          ' / ' +
          formatNumber(totalP) +
          ' (👁 ' +
          formatNumber(visibleP) +
          ')';
      }
    }

    // Decorations - only update if any value changed
    if (rendererView && this.elements.perfDecorations) {
      const activeD = (rendererView[RENDERER_STATS.ACTIVE_DECORATIONS] || 0) | 0;
      const visibleD = (rendererView[RENDERER_STATS.VISIBLE_DECORATIONS] || 0) | 0;
      const totalD = (DecorationPool.maxDecorations || 0) | 0;

      if (activeD !== pv.activeD || totalD !== pv.totalD || visibleD !== pv.visibleD) {
        pv.activeD = activeD;
        pv.totalD = totalD;
        pv.visibleD = visibleD;
        this.elements.perfDecorations.textContent =
          'Decorations: ' +
          formatNumber(activeD) +
          ' / ' +
          formatNumber(totalD) +
          ' (👁 ' +
          formatNumber(visibleD) +
          ')';
      }
    }

    // Flash entities - only update if value changed
    if (particleView && this.elements.perfFlash) {
      const flashesUpdated = (particleView[PARTICLE_STATS.FLASHES_UPDATED] || 0) | 0;

      if (flashesUpdated !== pv.flashUpdated) {
        pv.flashUpdated = flashesUpdated;
        this.elements.perfFlash.textContent = 'Flash: ' + formatNumber(flashesUpdated) + ' updated';
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
    if (!workerStats || !workerStats[workerType] || !workerStats[workerType][0]) return;
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
      if (stat.key === 'FPS') {
        rawValue = this._smoothFPS(rawValue, this.fpsSmoothing[workerType]);
      }

      // Round to avoid floating point noise triggering updates
      const roundedValue = (rawValue * 100) | 0;
      if (prevCache[stat.key] === roundedValue) continue;
      prevCache[stat.key] = roundedValue;

      const formattedValue = stat.format(rawValue);
      elements[stat.key].textContent = stat.key + ': ' + formattedValue;
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
        if (stat.key === 'FPS') {
          rawValue = this._smoothFPS(rawValue, this.fpsSmoothing[workerType][i]);
        }

        // Round to avoid floating point noise triggering updates
        const roundedValue = (rawValue * 100) | 0;
        if (prevCache[stat.key] === roundedValue) continue;
        prevCache[stat.key] = roundedValue;

        const formattedValue = stat.format(rawValue);
        elements[stat.key].textContent = stat.key + ': ' + formattedValue;
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
          'Active: ' + formatNumber(active) + '/' + formatNumber(total);
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
        this.elements.visibleCount.textContent = 'Visible: ' + formatNumber(visible);
      }
    }

    // Pool stats - build string only if values changed, reuse Set
    if (this.elements.poolStats && this.gameEngine) {
      this._poolStatsBuffer = '';
      const registeredClasses = scene.registeredClasses;
      if (registeredClasses) {
        for (let i = 0; i < registeredClasses.length; i++) {
          const reg = registeredClasses[i];
          if (this._internalEntitiesSet.has(reg.class.name)) continue;
          const stats = this.gameEngine.getPoolStats(reg.class);
          if (stats && stats.total > 0) {
            if (this._poolStatsBuffer.length > 0) {
              this._poolStatsBuffer += ' | ';
            }
            this._poolStatsBuffer +=
              reg.class.name + ': ' + formatNumber(stats.active) + '/' + formatNumber(stats.total);
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
        this.elements.decorationTotal.textContent = 'Total: ' + formatNumber(total);
      }
    }

    // Active decorations - only update if changed
    if (this.elements.decorationActive && rendererView) {
      const active = (rendererView[RENDERER_STATS.ACTIVE_DECORATIONS] || 0) | 0;
      if (active !== pv.decorationActive) {
        pv.decorationActive = active;
        this.elements.decorationActive.textContent = 'Active: ' + formatNumber(active);
      }
    }

    // Visible decorations - only update if changed
    if (this.elements.decorationVisible && rendererView) {
      const visible = (rendererView[RENDERER_STATS.VISIBLE_DECORATIONS] || 0) | 0;
      if (visible !== pv.decorationVisible) {
        pv.decorationVisible = visible;
        this.elements.decorationVisible.textContent = 'Visible: ' + formatNumber(visible);
      }
    }

    // PIXI sprites created - only update if changed
    if (this.elements.decorationSprites && rendererView) {
      const spriteCount = (rendererView[RENDERER_STATS.DECORATION_SPRITES] || 0) | 0;
      if (spriteCount !== pv.decorationSprites) {
        pv.decorationSprites = spriteCount;
        this.elements.decorationSprites.textContent = 'Sprites: ' + formatNumber(spriteCount);
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
    for (const [key, btn] of Object.entries(this.elements.visualToggles || {})) {
      if (btn && state[key] !== undefined) {
        btn.classList.toggle('active', state[key]);
      }
    }
  }

  _toggleVisualAid(key) {
    if (!this.debugFlags) return;

    const methodMap = {
      colliders: 'showColliders',
      velocity: 'showVelocity',
      acceleration: 'showAcceleration',
      neighbors: 'showNeighbors',
      collisionCandidates: 'showCollisionCandidates',
      spatialGrid: 'showSpatialGrid',
      aabb: 'showAABB',
      entityIndices: 'showEntityIndices',
      raycasts: 'showRaycasts',
      sleepingEntities: 'showSleepingEntities',
      sleepingCells: 'showSleepingCells',
      constraints: 'showConstraints',
      entityOrigins: 'showEntityOrigins',
    };

    const method = methodMap[key];
    if (method && this.debugFlags[method]) {
      // Handle special cases for flag names
      let flagName = `SHOW_${key.toUpperCase().replace('GRID', '_GRID').replace('INDICES', '_INDICES')}`;
      if (key === 'sleepingEntities') {
        flagName = 'SHOW_SLEEPING_ENTITIES';
      } else if (key === 'sleepingCells') {
        flagName = 'SHOW_SLEEPING_CELLS';
      } else if (key === 'collisionCandidates') {
        flagName = 'SHOW_COLLISION_CANDIDATES';
      } else if (key === 'constraints') {
        flagName = 'SHOW_CONSTRAINTS';
      } else if (key === 'entityOrigins') {
        flagName = 'SHOW_ENTITY_ORIGINS';
      }
      const currentState = this.debugFlags.isEnabled(DEBUG_FLAGS[flagName]);
      this.debugFlags[method](!currentState);
      this._updateVisualAidsState();

      // Start or stop debug visualization loop based on active state
      if (this._hasActiveDebugVisualization()) {
        this._startDebugVisualizationLoop();
      } else {
        this._stopDebugVisualizationLoop();
        this._clearDebugCanvas();
      }
    }
  }

  // ========================================
  // UI CREATION
  // ========================================

  async _injectStyles() {
    if (document.getElementById('debug-ui-styles')) return;

    let cssText = null;

    // Bundle mode: CSS embedded as a string in WEED.DebugUICSS
    if (typeof globalThis.WEED !== 'undefined' && globalThis.WEED.DebugUICSS) {
      cssText = globalThis.WEED.DebugUICSS;
    } else {
      // Dev mode: fetch from source directory
      try {
        const cssPath = new URL('./DebugUI.css', import.meta.url).href;
        const response = await fetch(cssPath);
        cssText = await response.text();
      } catch (error) {
        console.error('Failed to load DebugUI.css:', error);
      }
    }

    if (cssText) {
      const style = document.createElement('style');
      style.id = 'debug-ui-styles';
      style.textContent = cssText;
      document.head.appendChild(style);
    }
  }

  _createUI() {
    // Main container
    this.container = document.createElement('div');
    this.container.className = 'debug-ui';

    // Header bar
    const header = document.createElement('div');
    header.className = 'debug-ui-header';

    // Scene tab (NEW)
    const sceneTab = this._createTab('🎬', 'Scene', 'scene');
    header.appendChild(sceneTab);

    // Performance tab
    const perfTab = this._createTab('⚡', 'Performance', 'performance');
    header.appendChild(perfTab);

    // Visual Aids tab
    const visualTab = this._createTab('👁', 'Visual', 'visual');
    header.appendChild(visualTab);

    // Entities tab
    const entitiesTab = this._createTab('📦', 'Entities', 'entities');
    header.appendChild(entitiesTab);

    // Decorations tab
    const decorationsTab = this._createTab('🌿', 'Decorations', 'decorations');
    header.appendChild(decorationsTab);

    // Layers tab (NEW)
    const layersTab = this._createTab('📚', 'Layers', 'layers');
    header.appendChild(layersTab);

    // Navigation tab (NEW)
    const navTab = this._createTab('🧭', 'Nav', 'navigation');
    header.appendChild(navTab);

    // Spacer
    const spacer = document.createElement('div');
    spacer.className = 'debug-ui-spacer';
    header.appendChild(spacer);

    // Toggle visibility hint
    const toggle = document.createElement('div');
    toggle.className = 'debug-ui-toggle';
    toggle.textContent = '[H] Toggle';
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
    this._createNavigationPanel();

    // Create tool indicator (shows active tool at bottom of screen)
    this._createToolIndicator();

    document.body.appendChild(this.container);
  }

  _createTab(icon, label, sectionId) {
    const tab = document.createElement('div');
    tab.className = 'debug-ui-tab';
    tab.innerHTML = `<span class="icon">${icon}</span><span>${label}</span><span class="arrow">▼</span>`;
    tab.onclick = () => this._toggleSection(sectionId);
    this.sections[sectionId] = { tab };
    return tab;
  }

  _toggleSection(sectionId) {
    const wasOpen = this.openSection === sectionId;

    // Close all sections
    for (const [id, section] of Object.entries(this.sections)) {
      section.tab.classList.remove('active');
      if (section.panel) section.panel.classList.remove('open');
    }

    // Open clicked section (unless it was already open)
    if (!wasOpen) {
      this.openSection = sectionId;
      this.sections[sectionId].tab.classList.add('active');
      if (this.sections[sectionId].panel) {
        this.sections[sectionId].panel.classList.add('open');
      }

      // Auto-refresh navigation lists when opening nav panel
      if (sectionId === 'navigation') {
        this._refreshNavigationLists();
      }
    } else {
      this.openSection = null;

      // Clear navigation visualization when closing nav panel
      if (sectionId === 'navigation') {
        this._clearNavVisualization();
      }
    }
  }

  // ========================================
  // SCENE PANEL (NEW)
  // ========================================

  _createScenePanel() {
    const panel = document.createElement('div');
    panel.className = 'debug-ui-panel';

    // Scene buttons container
    this.elements.sceneSwitchContainer = document.createElement('div');
    this.elements.sceneSwitchContainer.className = 'debug-ui-row';
    this.elements.sceneSwitchContainer.style.gap = '8px';
    panel.appendChild(this.elements.sceneSwitchContainer);

    // Controls row (pause/resume)
    const controlsRow = document.createElement('div');
    controlsRow.className = 'debug-ui-row';
    controlsRow.style.marginTop = '8px';
    controlsRow.style.gap = '8px';

    // Label
    const controlsLabel = document.createElement('span');
    controlsLabel.className = 'debug-ui-stat';
    controlsLabel.textContent = 'Controls:';
    controlsRow.appendChild(controlsLabel);

    // Pause button
    this.elements.pauseBtn = document.createElement('button');
    this.elements.pauseBtn.className = 'debug-ui-btn';
    this.elements.pauseBtn.textContent = '⏸ Pause';
    this.elements.pauseBtn.onclick = () => {
      if (this.gameEngine) {
        this.gameEngine.pause();
        this._updatePlayPauseState();
      }
    };
    controlsRow.appendChild(this.elements.pauseBtn);

    // Resume button
    this.elements.resumeBtn = document.createElement('button');
    this.elements.resumeBtn.className = 'debug-ui-btn';
    this.elements.resumeBtn.textContent = '▶ Play';
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

    container.innerHTML = '';

    // Label
    const label = document.createElement('span');
    label.className = 'debug-ui-stat';
    label.textContent = 'Scene:';
    container.appendChild(label);

    // Add scene buttons
    for (const sceneConfig of this.registeredScenes) {
      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn scene-btn';
      btn.textContent = sceneConfig.name;

      // Mark current scene as active
      if (this.scene && this.scene.constructor === sceneConfig.class) {
        btn.classList.add('active');
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
      this.elements.pauseBtn.classList.toggle('active', isPaused);
    }
    if (this.elements.resumeBtn) {
      this.elements.resumeBtn.classList.toggle('active', !isPaused);
    }
  }

  _createPerformancePanel() {
    const panel = document.createElement('div');
    panel.className = 'debug-ui-panel';

    // Container div for flexible layout
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '12px';

    // Summary section for entity counts
    const summarySection = document.createElement('div');
    summarySection.className = 'debug-ui-performance-summary';
    summarySection.style.display = 'flex';
    summarySection.style.flexDirection = 'column';
    summarySection.style.gap = '4px';
    summarySection.style.padding = '8px';
    summarySection.style.backgroundColor = 'rgba(0, 0, 0, 0.3)';
    summarySection.style.borderRadius = '4px';

    // All pool stats on ONE row with different colors
    const poolStatsRow = document.createElement('div');
    poolStatsRow.className = 'debug-ui-row';
    poolStatsRow.style.justifyContent = 'flex-start';
    poolStatsRow.style.gap = '16px';

    // Pools Stats title (inline with data)
    const poolStatsTitle = document.createElement('span');
    poolStatsTitle.className = 'debug-ui-stat';
    poolStatsTitle.style.fontWeight = 'bold';
    poolStatsTitle.style.color = 'rgba(255, 255, 255, 0.9)';
    poolStatsTitle.textContent = 'Pools Stats:';
    poolStatsRow.appendChild(poolStatsTitle);

    // GameObjects (main green color)
    this.elements.perfGameObjects = document.createElement('span');
    this.elements.perfGameObjects.className = 'debug-ui-stat';
    this.elements.perfGameObjects.style.color = '#4ade80';
    this.elements.perfGameObjects.textContent = 'GameObjects: -- / -- (👁 --)';
    poolStatsRow.appendChild(this.elements.perfGameObjects);

    // Particles (particle orange color)
    this.elements.perfParticles = document.createElement('span');
    this.elements.perfParticles.className = 'debug-ui-stat';
    this.elements.perfParticles.style.color = '#fb923c';
    this.elements.perfParticles.textContent = 'Particles: -- / -- (👁 --)';
    poolStatsRow.appendChild(this.elements.perfParticles);

    // Decorations (nature green-cyan color)
    this.elements.perfDecorations = document.createElement('span');
    this.elements.perfDecorations.className = 'debug-ui-stat';
    this.elements.perfDecorations.style.color = '#34d399';
    this.elements.perfDecorations.textContent = 'Decorations: -- / -- (👁 --)';
    poolStatsRow.appendChild(this.elements.perfDecorations);

    // Flash (bright yellow color)
    this.elements.perfFlash = document.createElement('span');
    this.elements.perfFlash.className = 'debug-ui-stat';
    this.elements.perfFlash.style.color = '#fbbf24';
    this.elements.perfFlash.textContent = 'Flash: -- / -- (👁 --)';
    poolStatsRow.appendChild(this.elements.perfFlash);

    summarySection.appendChild(poolStatsRow);
    container.appendChild(summarySection);

    // Job stealing stats (shown when enabled)
    const jobRow = document.createElement('div');
    jobRow.className = 'debug-ui-row';
    this.elements.jobStealing = this._createStat('Jobs: --', 'jobs');
    jobRow.appendChild(this.elements.jobStealing);
    jobRow.style.display = 'none';
    this.elements.jobStealingRow = jobRow;
    container.appendChild(jobRow);

    // Worker Stats Title
    const workerStatsTitle = document.createElement('div');
    workerStatsTitle.className = 'debug-ui-stat';
    workerStatsTitle.style.fontWeight = 'bold';
    workerStatsTitle.style.fontSize = '12px';
    workerStatsTitle.style.marginTop = '8px';
    workerStatsTitle.style.marginBottom = '4px';
    workerStatsTitle.style.color = 'rgba(255, 255, 255, 0.9)';
    workerStatsTitle.textContent = 'Worker Stats';
    container.appendChild(workerStatsTitle);

    // Container for worker stat rows (will be dynamically populated on scene attach)
    this.elements.workerStatsContainer = document.createElement('div');
    this.elements.workerStatsContainer.style.display = 'flex';
    this.elements.workerStatsContainer.style.flexDirection = 'column';
    this.elements.workerStatsContainer.style.gap = '4px';
    container.appendChild(this.elements.workerStatsContainer);

    panel.appendChild(container);
    this.container.appendChild(panel);
    this.sections.performance.panel = panel;
  }

  _createVisualPanel() {
    const panel = document.createElement('div');
    panel.className = 'debug-ui-panel';

    const row = document.createElement('div');
    row.className = 'debug-ui-row';

    this.elements.visualToggles = {};

    const visualAids = [
      { key: 'colliders', label: 'Colliders', shortcut: '1' },
      { key: 'velocity', label: 'Velocity', shortcut: '2' },
      { key: 'acceleration', label: 'Accel', shortcut: '3' },
      { key: 'neighbors', label: 'Neighbors', shortcut: '4' },
      { key: 'collisionCandidates', label: 'Collision', shortcut: 'C' },
      { key: 'spatialGrid', label: 'Grid', shortcut: '5' },
      { key: 'aabb', label: 'AABB', shortcut: '6' },
      { key: 'entityIndices', label: 'Indices', shortcut: '7' },
      { key: 'raycasts', label: 'Raycasts', shortcut: '8' },
      { key: 'sleepingEntities', label: 'Sleeping', shortcut: '9' },
      { key: 'sleepingCells', label: 'Sleep Cells', shortcut: 'S' },
      { key: 'constraints', label: 'Constraints', shortcut: 'K' },
      { key: 'entityOrigins', label: 'Origins', shortcut: 'O' },
    ];

    for (const aid of visualAids) {
      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn';
      btn.textContent = `[${aid.shortcut}] ${aid.label}`;
      btn.onclick = () => this._toggleVisualAid(aid.key);
      this.elements.visualToggles[aid.key] = btn;
      row.appendChild(btn);
    }

    // Disable all button
    const disableBtn = document.createElement('button');
    disableBtn.className = 'debug-ui-btn danger';
    disableBtn.textContent = '[0] Off';
    disableBtn.onclick = () => {
      if (this.debugFlags) {
        this.debugFlags.disableAll();
        this._updateVisualAidsState();
      }
    };
    row.appendChild(disableBtn);

    // Divider
    row.appendChild(this._createDivider());

    // Entity Inspector button
    this.elements.inspectorBtn = document.createElement('button');
    this.elements.inspectorBtn.className = 'debug-ui-btn tool';
    this.elements.inspectorBtn.textContent = '[I] Inspect';
    this.elements.inspectorBtn.title = 'Click on an entity to inspect its components';
    this.elements.inspectorBtn.onclick = () => this._toggleInspector();
    row.appendChild(this.elements.inspectorBtn);

    panel.appendChild(row);
    this.container.appendChild(panel);
    this.sections.visual.panel = panel;
  }

  _createEntitiesPanel() {
    const panel = document.createElement('div');
    panel.className = 'debug-ui-panel';

    // Stats row
    const statsRow = document.createElement('div');
    statsRow.className = 'debug-ui-row';

    this.elements.activeCount = this._createStat('Active: --', '');
    this.elements.visibleCount = this._createStat('Visible: --', '');
    this.elements.poolStats = this._createStat('Pools: --', '');

    statsRow.appendChild(this.elements.activeCount);
    statsRow.appendChild(this.elements.visibleCount);
    statsRow.appendChild(this._createDivider());
    statsRow.appendChild(this.elements.poolStats);

    panel.appendChild(statsRow);

    // Tools container (populated per-scene)
    this.elements.entityToolsContainer = document.createElement('div');
    this.elements.entityToolsContainer.style.marginTop = '8px';
    panel.appendChild(this.elements.entityToolsContainer);

    this.container.appendChild(panel);
    this.sections.entities.panel = panel;
  }

  _createDecorationsPanel() {
    const panel = document.createElement('div');
    panel.className = 'debug-ui-panel';

    // Stats row
    const statsRow = document.createElement('div');
    statsRow.className = 'debug-ui-row';

    this.elements.decorationTotal = this._createStat('Total: --', '');
    this.elements.decorationActive = this._createStat('Active: --', '');
    this.elements.decorationVisible = this._createStat('Visible: --', '');
    this.elements.decorationSprites = this._createStat('Sprites: --', 'renderer');

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
    const panel = document.createElement('div');
    panel.className = 'debug-ui-panel';

    // Layer names from Z_INDICES enum (imported from ConfigDefaults)
    const layerNames = Object.keys(Z_INDICES);

    // Store layer control elements for potential updates
    this.elements.layerControls = {};
    this.elements.layerRows = {};

    // Create a row for each layer
    for (const layerName of layerNames) {
      const row = document.createElement('div');
      row.className = 'debug-ui-row';
      row.style.gap = '12px';
      row.style.alignItems = 'center';
      row.style.marginBottom = '6px';

      // Layer name label
      const label = document.createElement('span');
      label.className = 'debug-ui-stat';
      label.style.minWidth = '120px';
      label.style.fontWeight = 'bold';
      label.textContent = layerName;
      row.appendChild(label);

      // Visibility checkbox
      const visibleLabel = document.createElement('label');
      visibleLabel.style.display = 'flex';
      visibleLabel.style.alignItems = 'center';
      visibleLabel.style.gap = '4px';
      visibleLabel.style.cursor = 'pointer';
      visibleLabel.style.fontSize = '10px';
      visibleLabel.style.color = 'rgba(255, 255, 255, 0.7)';

      const visibleCheckbox = document.createElement('input');
      visibleCheckbox.type = 'checkbox';
      visibleCheckbox.checked = true;
      visibleCheckbox.style.cursor = 'pointer';
      visibleCheckbox.onchange = () =>
        this._setLayerProp(layerName, 'visible', visibleCheckbox.checked);

      visibleLabel.appendChild(visibleCheckbox);
      visibleLabel.appendChild(document.createTextNode('Visible'));
      row.appendChild(visibleLabel);

      // Alpha slider
      const alphaContainer = document.createElement('div');
      alphaContainer.style.display = 'flex';
      alphaContainer.style.alignItems = 'center';
      alphaContainer.style.gap = '4px';

      const alphaLabel = document.createElement('span');
      alphaLabel.style.fontSize = '10px';
      alphaLabel.style.color = 'rgba(255, 255, 255, 0.7)';
      alphaLabel.textContent = 'Alpha:';
      alphaContainer.appendChild(alphaLabel);

      const alphaSlider = document.createElement('input');
      alphaSlider.type = 'range';
      alphaSlider.min = '0';
      alphaSlider.max = '100';
      alphaSlider.value = '100';
      alphaSlider.style.width = '80px';
      alphaSlider.style.cursor = 'pointer';
      alphaSlider.oninput = () => {
        alphaValue.textContent = alphaSlider.value + '%';
        this._setLayerProp(layerName, 'alpha', parseInt(alphaSlider.value) / 100);
      };
      alphaContainer.appendChild(alphaSlider);

      const alphaValue = document.createElement('span');
      alphaValue.style.fontSize = '10px';
      alphaValue.style.color = 'rgba(255, 255, 255, 0.7)';
      alphaValue.style.minWidth = '35px';
      alphaValue.textContent = '100%';
      alphaContainer.appendChild(alphaValue);

      row.appendChild(alphaContainer);

      // Blend mode dropdown
      const blendContainer = document.createElement('div');
      blendContainer.style.display = 'flex';
      blendContainer.style.alignItems = 'center';
      blendContainer.style.gap = '4px';

      const blendLabel = document.createElement('span');
      blendLabel.style.fontSize = '10px';
      blendLabel.style.color = 'rgba(255, 255, 255, 0.7)';
      blendLabel.textContent = 'Blend:';
      blendContainer.appendChild(blendLabel);

      const blendSelect = document.createElement('select');
      blendSelect.style.fontSize = '10px';
      blendSelect.style.padding = '2px 4px';
      blendSelect.style.cursor = 'pointer';
      blendSelect.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
      blendSelect.style.color = 'white';
      blendSelect.style.border = '1px solid rgba(255, 255, 255, 0.3)';
      blendSelect.style.borderRadius = '3px';

      // PIXI blend modes - npm = non-premultiplied alpha (multiply-npm doesn't exist)
      const blendModes = [
        'normal',
        'normal-npm',
        'add',
        'add-npm',
        'multiply',
        'screen',
        'screen-npm',
        'erase',
      ];
      for (const mode of blendModes) {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = mode;
        blendSelect.appendChild(option);
      }
      // Set default value from LAYER_DEFAULT_BLEND_MODES enum
      blendSelect.value = LAYER_DEFAULT_BLEND_MODES[layerName] || 'normal';
      blendSelect.onchange = () => this._setLayerProp(layerName, 'blendMode', blendSelect.value);
      blendContainer.appendChild(blendSelect);

      row.appendChild(blendContainer);

      // Z-Index input
      const zIndexContainer = document.createElement('div');
      zIndexContainer.style.display = 'flex';
      zIndexContainer.style.alignItems = 'center';
      zIndexContainer.style.gap = '4px';

      const zIndexLabel = document.createElement('span');
      zIndexLabel.style.fontSize = '10px';
      zIndexLabel.style.color = 'rgba(255, 255, 255, 0.7)';
      zIndexLabel.textContent = 'Z:';
      zIndexContainer.appendChild(zIndexLabel);

      const zIndexInput = document.createElement('input');
      zIndexInput.type = 'number';
      zIndexInput.value = Z_INDICES[layerName];
      zIndexInput.style.width = '50px';
      zIndexInput.style.fontSize = '10px';
      zIndexInput.style.padding = '2px 4px';
      zIndexInput.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
      zIndexInput.style.color = 'white';
      zIndexInput.style.border = '1px solid rgba(255, 255, 255, 0.3)';
      zIndexInput.style.borderRadius = '3px';
      zIndexInput.onchange = () =>
        this._setLayerProp(layerName, 'zIndex', parseInt(zIndexInput.value));
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
        row.style.opacity = '1';
        row.style.pointerEvents = 'auto';
        controls.visible.disabled = false;
        controls.alpha.disabled = false;
        controls.blendMode.disabled = false;
        controls.zIndex.disabled = false;
      } else {
        row.style.opacity = '0.4';
        row.style.pointerEvents = 'none';
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
    available.add('ENTITIES');

    // BACKGROUND - always available since it can be set dynamically via
    // setStaticBackground(), setTilingBackground(), or setTilemapBackground()
    available.add('BACKGROUND');

    // DECALS - check particle.decals config
    if (config.particle?.decals) {
      available.add('DECALS');
    }

    // LIGHTING related layers
    if (config.lighting?.enabled) {
      available.add('LIGHTING');

      // CASTED_SHADOWS - only if shadows are enabled within lighting
      if (config.lighting?.shadowsEnabled) {
        available.add('CASTED_SHADOWS');
      }
    }

    return available;
  }

  /**
   * Send layer property change to renderer worker
   */
  _setLayerProp(layer, prop, value) {
    if (!this.scene || !this.scene.workers || !this.scene.workers.renderer) {
      console.warn('DebugUI: Cannot set layer prop, renderer worker not available');
      return;
    }

    const message = {
      msg: 'setLayerProps',
      layer: layer,
    };
    message[prop] = value;

    this.scene.workers.renderer.postMessage(message);
  }

  // ========================================
  // NAVIGATION PANEL
  // ========================================

  _createNavigationPanel() {
    const panel = document.createElement('div');
    panel.className = 'debug-ui-panel debug-ui-nav-panel';

    // Header row with refresh button
    const headerRow = document.createElement('div');
    headerRow.className = 'debug-ui-row';
    headerRow.style.marginBottom = '8px';
    headerRow.style.justifyContent = 'space-between';

    const title = document.createElement('span');
    title.className = 'debug-ui-stat';
    title.style.fontWeight = 'bold';
    title.textContent = 'Navigation Cache';
    headerRow.appendChild(title);

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'debug-ui-btn';
    refreshBtn.textContent = '🔄 Refresh';
    refreshBtn.onclick = () => this._refreshNavigationLists();
    headerRow.appendChild(refreshBtn);

    panel.appendChild(headerRow);

    // Two-column layout for flowfields and paths
    const columnsContainer = document.createElement('div');
    columnsContainer.className = 'debug-ui-nav-columns';

    // Flowfields column
    const flowfieldsCol = document.createElement('div');
    flowfieldsCol.className = 'debug-ui-nav-column';

    const ffHeader = document.createElement('div');
    ffHeader.className = 'debug-ui-nav-header';
    ffHeader.innerHTML = "<span>🎯 Flowfields</span><span class='count' id='nav-ff-count'>0</span>";
    flowfieldsCol.appendChild(ffHeader);

    const ffList = document.createElement('div');
    ffList.className = 'debug-ui-nav-list';
    ffList.id = 'nav-flowfields-list';
    flowfieldsCol.appendChild(ffList);

    columnsContainer.appendChild(flowfieldsCol);

    // Paths column
    const pathsCol = document.createElement('div');
    pathsCol.className = 'debug-ui-nav-column';

    const pathHeader = document.createElement('div');
    pathHeader.className = 'debug-ui-nav-header';
    pathHeader.innerHTML =
      "<span>📍 A* Paths</span><span class='count' id='nav-path-count'>0</span>";
    pathsCol.appendChild(pathHeader);

    const pathList = document.createElement('div');
    pathList.className = 'debug-ui-nav-list';
    pathList.id = 'nav-paths-list';
    pathsCol.appendChild(pathList);

    columnsContainer.appendChild(pathsCol);

    // Static flowfields column
    const staticFfCol = document.createElement('div');
    staticFfCol.className = 'debug-ui-nav-column';

    const staticFfHeader = document.createElement('div');
    staticFfHeader.className = 'debug-ui-nav-header';
    staticFfHeader.innerHTML = "<span>🛣️ Static FF</span><span class='count' id='nav-static-ff-count'>0</span>";
    staticFfCol.appendChild(staticFfHeader);

    const staticFfList = document.createElement('div');
    staticFfList.className = 'debug-ui-nav-list';
    staticFfList.id = 'nav-static-flowfields-list';
    staticFfCol.appendChild(staticFfList);

    columnsContainer.appendChild(staticFfCol);

    panel.appendChild(columnsContainer);

    // Control buttons row
    const controlsRow = document.createElement('div');
    controlsRow.className = 'debug-ui-row';
    controlsRow.style.marginTop = '8px';
    controlsRow.style.gap = '8px';

    // Show walkability grid toggle
    const walkabilityBtn = document.createElement('button');
    walkabilityBtn.className = 'debug-ui-btn';
    walkabilityBtn.textContent = '🗺️ Show Grid';
    walkabilityBtn.onclick = () => {
      this._showWalkabilityGrid = !this._showWalkabilityGrid;
      walkabilityBtn.classList.toggle('active', this._showWalkabilityGrid);
      walkabilityBtn.textContent = this._showWalkabilityGrid ? '🗺️ Hide Grid' : '🗺️ Show Grid';

      // Start/stop RAF loop based on active visualization
      if (this._hasActiveDebugVisualization()) {
        this._startDebugVisualizationLoop();
      } else {
        this._stopDebugVisualizationLoop();
        this._clearDebugCanvas();
      }
    };
    controlsRow.appendChild(walkabilityBtn);
    this.elements.navWalkabilityBtn = walkabilityBtn;

    // Clear visualization button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'debug-ui-btn';
    clearBtn.textContent = '❌ Clear All';
    clearBtn.onclick = () => this._clearNavVisualization();
    controlsRow.appendChild(clearBtn);

    panel.appendChild(controlsRow);

    // Store references
    this.elements.navFlowfieldsList = ffList;
    this.elements.navPathsList = pathList;
    this.elements.navStaticFlowfieldsList = staticFfList;
    this.elements.navFFCount = document.getElementById('nav-ff-count');
    this.elements.navPathCount = document.getElementById('nav-path-count');
    this.elements.navStaticFFCount = document.getElementById('nav-static-ff-count');

    this.container.appendChild(panel);
    this.sections.navigation.panel = panel;
  }

  /**
   * Refresh navigation lists with current cached data
   */
  _refreshNavigationLists() {
    if (!NavGrid._initialized && NavGrid._staticFlowfields.size === 0) {
      this._showNavMessage('NavGrid not initialized');
      return;
    }

    // Get cached dynamic flowfields
    const flowfields = NavGrid._initialized ? NavGrid.getCachedFlowfieldsList() : [];
    const paths = NavGrid._initialized ? NavGrid.getCachedPathsList() : [];

    // Update counts
    const ffCountEl = document.getElementById('nav-ff-count');
    const pathCountEl = document.getElementById('nav-path-count');
    const staticFFCountEl = document.getElementById('nav-static-ff-count');
    if (ffCountEl) ffCountEl.textContent = flowfields.length;
    if (pathCountEl) pathCountEl.textContent = paths.length;
    if (staticFFCountEl) staticFFCountEl.textContent = NavGrid._staticFlowfields.size;

    // Render flowfields list
    this._renderFlowfieldsList(flowfields);

    // Render paths list
    this._renderPathsList(paths);

    // Render static flowfields list
    this._renderStaticFlowfieldsList();
  }

  _showNavMessage(msg) {
    if (this.elements.navFlowfieldsList) {
      this.elements.navFlowfieldsList.innerHTML = `<div class="debug-ui-nav-empty">${msg}</div>`;
    }
    if (this.elements.navPathsList) {
      this.elements.navPathsList.innerHTML = `<div class="debug-ui-nav-empty">${msg}</div>`;
    }
  }

  _renderFlowfieldsList(flowfields) {
    const container = this.elements.navFlowfieldsList;
    if (!container) return;

    container.innerHTML = '';

    if (flowfields.length === 0) {
      container.innerHTML = '<div class="debug-ui-nav-empty">No cached flowfields</div>';
      return;
    }

    for (const ff of flowfields) {
      const item = document.createElement('div');
      item.className = 'debug-ui-nav-item';
      if (this._selectedFlowfieldSlot === ff.slotIndex) {
        item.classList.add('selected');
      }

      item.innerHTML = `
        <span class="slot">#${ff.slotIndex}</span>
        <span class="target">→ (${ff.targetX}, ${ff.targetY})</span>
      `;

      item.onclick = () => this._selectFlowfield(ff.slotIndex);
      container.appendChild(item);
    }
  }

  _renderPathsList(paths) {
    const container = this.elements.navPathsList;
    if (!container) return;

    container.innerHTML = '';

    if (paths.length === 0) {
      container.innerHTML = '<div class="debug-ui-nav-empty">No cached paths</div>';
      return;
    }

    for (const path of paths) {
      const item = document.createElement('div');
      item.className = 'debug-ui-nav-item';
      if (this._selectedPathSlot === path.slotIndex) {
        item.classList.add('selected');
      }

      item.innerHTML = `
        <span class="slot">#${path.slotIndex}</span>
        <span class="path">(${path.fromX},${path.fromY}) → (${path.toX},${path.toY})</span>
        <span class="length">[${path.length}]</span>
      `;

      item.onclick = () => this._selectPath(path.slotIndex);
      container.appendChild(item);
    }
  }

  _selectFlowfield(slotIndex) {
    // Deselect path and static flowfield
    this._selectedPathSlot = -1;
    this._selectedStaticFlowfield = null;

    // Toggle selection
    if (this._selectedFlowfieldSlot === slotIndex) {
      this._selectedFlowfieldSlot = -1;
    } else {
      this._selectedFlowfieldSlot = slotIndex;
    }

    // Start/stop RAF loop based on active visualization
    if (this._hasActiveDebugVisualization()) {
      this._startDebugVisualizationLoop();
    } else {
      this._stopDebugVisualizationLoop();
      this._clearDebugCanvas();
    }

    // Refresh lists to update selection state
    this._refreshNavigationLists();
  }

  _selectPath(slotIndex) {
    // Deselect flowfield and static flowfield
    this._selectedFlowfieldSlot = -1;
    this._selectedStaticFlowfield = null;

    // Toggle selection
    if (this._selectedPathSlot === slotIndex) {
      this._selectedPathSlot = -1;
    } else {
      this._selectedPathSlot = slotIndex;
    }

    // Start/stop RAF loop based on active visualization
    if (this._hasActiveDebugVisualization()) {
      this._startDebugVisualizationLoop();
    } else {
      this._stopDebugVisualizationLoop();
      this._clearDebugCanvas();
    }

    // Refresh lists to update selection state
    this._refreshNavigationLists();
  }

  _renderStaticFlowfieldsList() {
    const container = this.elements.navStaticFlowfieldsList;
    if (!container) return;

    container.innerHTML = '';
    const names = Array.from(NavGrid._staticFlowfields.keys());

    if (names.length === 0) {
      container.innerHTML = '<div class="debug-ui-nav-empty">No static flowfields</div>';
      return;
    }

    for (const name of names) {
      const ff = NavGrid._staticFlowfields.get(name);
      const item = document.createElement('div');
      item.className = 'debug-ui-nav-item';
      if (this._selectedStaticFlowfield === name) {
        item.classList.add('selected');
      }

      item.innerHTML = `
        <span class="slot">${name}</span>
        <span class="target">${ff.gridWidth}x${ff.gridHeight}</span>
      `;

      item.onclick = () => this._selectStaticFlowfield(name);
      container.appendChild(item);
    }
  }

  _selectStaticFlowfield(name) {
    // Deselect dynamic flowfield and path
    this._selectedFlowfieldSlot = -1;
    this._selectedPathSlot = -1;

    // Toggle selection
    if (this._selectedStaticFlowfield === name) {
      this._selectedStaticFlowfield = null;
    } else {
      this._selectedStaticFlowfield = name;
    }

    // Start/stop RAF loop based on active visualization
    if (this._hasActiveDebugVisualization()) {
      this._startDebugVisualizationLoop();
    } else {
      this._stopDebugVisualizationLoop();
      this._clearDebugCanvas();
    }

    // Refresh lists to update selection state
    this._refreshNavigationLists();
  }

  _ensureDebugCanvas() {
    if (this._debugCanvas) return;

    // Create canvas overlay for all debug visualizations
    const canvas = document.createElement('canvas');
    canvas.id = 'debug-visualization-canvas';
    canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 9998;
    `;

    // Set actual canvas dimensions
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    document.body.appendChild(canvas);
    this._debugCanvas = canvas;
    this._debugCtx = canvas.getContext('2d');

    // Handle resize
    this._resizeHandler = () => {
      if (this._debugCanvas) {
        this._debugCanvas.width = window.innerWidth;
        this._debugCanvas.height = window.innerHeight;
      }
    };
    window.addEventListener('resize', this._resizeHandler);
  }

  _clearNavVisualization() {
    this._selectedFlowfieldSlot = -1;
    this._selectedPathSlot = -1;
    this._selectedStaticFlowfield = null;
    this._showWalkabilityGrid = false;

    // Reset walkability button state
    if (this.elements.navWalkabilityBtn) {
      this.elements.navWalkabilityBtn.classList.remove('active');
      this.elements.navWalkabilityBtn.textContent = '🗺️ Show Grid';
    }

    // Refresh lists to clear selection state
    this._refreshNavigationLists();

    // Check if we should stop the debug loop (if no other debug flags active)
    if (!this._hasActiveDebugVisualization()) {
      this._stopDebugVisualizationLoop();
      this._clearDebugCanvas();
    }
  }

  /**
   * Clear the debug visualization canvas
   */
  _clearDebugCanvas() {
    if (this._debugCtx && this._debugCanvas) {
      this._debugCtx.clearRect(0, 0, this._debugCanvas.width, this._debugCanvas.height);
    }
  }

  /**
   * Check if any nav visualization is active
   */
  _hasActiveNavVisualization() {
    return (
      this._showWalkabilityGrid || this._selectedFlowfieldSlot >= 0 || this._selectedPathSlot >= 0 || this._selectedStaticFlowfield !== null
    );
  }

  /**
   * Check if any debug visualization is active (nav + entity debug overlays)
   */
  _hasActiveDebugVisualization() {
    // Check nav visualizations
    if (this._hasActiveNavVisualization()) return true;

    // Check entity debug flags
    if (!this.debugFlags) return false;

    return (
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_COLLIDERS) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_VELOCITY) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_ACCELERATION) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INDICES) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_NEIGHBORS) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_SPATIAL_GRID) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_RAYCASTS) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_CELLS) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_SELECTED_ENTITY) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_CONSTRAINTS) ||
      this.debugFlags.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS)
    );
  }

  /**
   * Unified render method - renders all debug overlays in correct order:
   * 1. Spatial grid (bottom)
   * 2. Nav walkability grid
   * 3. Flowfield arrows
   * 4. Path lines
   * 5. Colliders
   * 6. Velocity/acceleration vectors
   * 7. Neighbor connections
   * 8. Raycasts
   * 9. Entity indices
   * 10. Selected entity (top)
   */
  _renderDebugVisualization() {
    if (!this._hasActiveDebugVisualization()) {
      this._clearDebugCanvas();
      return;
    }

    this._ensureDebugCanvas();
    const ctx = this._debugCtx;
    const canvas = this._debugCanvas;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Get camera (runs at 60fps now, so always use current camera position)
    const camera = this.scene?.camera || { x: 0, y: 0 };
    const zoom = this.scene?.camera?.zoom || 1;

    const flags = this.debugFlags;

    // 1. Draw spatial grid first (bottom layer)
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SPATIAL_GRID)) {
      this._drawSpatialGrid(ctx, canvas, camera, zoom);
    }

    // 1.5. Draw sleeping cells (after grid, before other overlays)
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_CELLS)) {
      this._drawSleepingCells(ctx, canvas, camera, zoom);
    }

    // 2. Draw nav walkability grid
    if (this._showWalkabilityGrid) {
      this._drawWalkabilityGrid(ctx, canvas, camera, zoom);
    }

    // 3. Draw flowfield arrows
    if (this._selectedFlowfieldSlot >= 0) {
      this._drawFlowfield(ctx, canvas, camera, zoom, this._selectedFlowfieldSlot);
    }

    // 3.5. Draw static flowfield arrows
    if (this._selectedStaticFlowfield !== null) {
      this._drawStaticFlowfield(ctx, canvas, camera, zoom, this._selectedStaticFlowfield);
    }

    // 4. Draw path
    if (this._selectedPathSlot >= 0) {
      this._drawPath(ctx, canvas, camera, zoom, this._selectedPathSlot);
    }

    // 5. Draw colliders
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_COLLIDERS)) {
      this._drawColliders(ctx, canvas, camera, zoom);
    }

    // 5.5. Draw entity origins (Transform.x, Transform.y points)
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS)) {
      this._drawEntityOrigins(ctx, canvas, camera, zoom);
    }

    // 6. Draw velocity vectors
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_VELOCITY)) {
      this._drawVelocityVectors(ctx, canvas, camera, zoom);
    }

    // 7. Draw acceleration vectors
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ACCELERATION)) {
      this._drawAccelerationVectors(ctx, canvas, camera, zoom);
    }

    // 8. Draw neighbor connections
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_NEIGHBORS)) {
      this._drawNeighborConnections(ctx, canvas, camera, zoom);
    }

    // 8.5. Draw collision candidate connections
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES)) {
      this._drawCollisionCandidateConnections(ctx, canvas, camera, zoom);
    }

    // 9. Draw raycasts
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_RAYCASTS)) {
      this._drawRaycasts(ctx, canvas, camera, zoom);
    }

    // 10. Draw entity indices
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INDICES)) {
      this._drawEntityIndices(ctx, canvas, camera, zoom);
    }

    // 11. Draw sleeping entities
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES)) {
      this._drawSleepingEntities(ctx, canvas, camera, zoom);
    }

    // 12. Draw distance constraints
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_CONSTRAINTS)) {
      this._drawConstraints(ctx, canvas, camera, zoom);
    }

    // 13. Draw selected entity bounding box (always on top)
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SELECTED_ENTITY)) {
      this._drawSelectedEntity(ctx, canvas, camera, zoom);
    }
  }

  /**
   * Draw walkability grid showing blocked cells and grid lines
   * Optimized: draws continuous lines + only blocked cells
   */
  _drawWalkabilityGrid(ctx, canvas, camera, zoom) {
    if (!NavGrid._initialized) return;

    const gridWidth = NavGrid._gridWidth;
    const gridHeight = NavGrid._gridHeight;
    const cellSize = NavGrid._cellSize;
    const walkability = NavGrid._walkability;

    if (!walkability) return;

    const cellSizeScreen = cellSize * zoom;

    // Calculate visible cell range
    const startCellX = Math.max(0, Math.floor(camera.x / cellSize));
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize));
    const endCellX = Math.min(
      gridWidth,
      Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1
    );
    const endCellY = Math.min(
      gridHeight,
      Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1
    );

    // Calculate world bounds for visible area
    const worldStartX = startCellX * cellSize;
    const worldStartY = startCellY * cellSize;
    const worldEndX = endCellX * cellSize;
    const worldEndY = endCellY * cellSize;

    // 1. Draw only blocked (unwalkable) cells
    ctx.fillStyle = 'rgba(255, 50, 50, 0.5)';
    for (let y = startCellY; y < endCellY; y++) {
      for (let x = startCellX; x < endCellX; x++) {
        const cellIndex = y * gridWidth + x;
        if (walkability[cellIndex] === 0) {
          // Blocked cell - draw it
          const sx = (x * cellSize - camera.x) * zoom;
          const sy = (y * cellSize - camera.y) * zoom;
          ctx.fillRect(sx, sy, cellSizeScreen, cellSizeScreen);
        }
      }
    }

    // 2. Draw grid lines as continuous lines (much faster than individual rects)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Vertical lines
    for (let x = startCellX; x <= endCellX; x++) {
      const sx = (x * cellSize - camera.x) * zoom;
      const sy1 = (worldStartY - camera.y) * zoom;
      const sy2 = (worldEndY - camera.y) * zoom;
      ctx.moveTo(sx, sy1);
      ctx.lineTo(sx, sy2);
    }

    // Horizontal lines
    for (let y = startCellY; y <= endCellY; y++) {
      const sy = (y * cellSize - camera.y) * zoom;
      const sx1 = (worldStartX - camera.x) * zoom;
      const sx2 = (worldEndX - camera.x) * zoom;
      ctx.moveTo(sx1, sy);
      ctx.lineTo(sx2, sy);
    }

    // Single stroke call for all lines
    ctx.stroke();
  }

  /**
   * Draw flowfield arrows (extracted from _visualizeFlowfield)
   */
  _drawFlowfield(ctx, canvas, camera, zoom, slotIndex) {
    const ffData = NavGrid.getFlowfieldForVisualization(slotIndex);
    if (!ffData) return;

    const { vectors, gridWidth, gridHeight, cellSize, targetCell } = ffData;

    // Calculate target position
    const targetX = (targetCell % gridWidth) * cellSize + cellSize / 2;
    const targetY = Math.floor(targetCell / gridWidth) * cellSize + cellSize / 2;

    // Draw arrows for each cell (skip if vector is zero)
    ctx.strokeStyle = 'rgba(0, 200, 255, 0.7)';
    ctx.lineWidth = 1.5;

    const arrowLen = cellSize * 0.35 * zoom;

    // Calculate visible cell range for optimization
    const startCellX = Math.max(0, Math.floor(camera.x / cellSize) - 1);
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize) - 1);
    const endCellX = Math.min(
      gridWidth,
      Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1
    );
    const endCellY = Math.min(
      gridHeight,
      Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1
    );

    for (let y = startCellY; y < endCellY; y++) {
      for (let x = startCellX; x < endCellX; x++) {
        const cellIndex = y * gridWidth + x;
        const vecIdx = cellIndex * 2;

        // Get vector components (Int8 normalized to [-127, 127])
        const vx = vectors[vecIdx];
        const vy = vectors[vecIdx + 1];

        if (vx === 0 && vy === 0) continue; // No direction

        // Convert from Int8 to float [-1, 1]
        const dx = vx / 127;
        const dy = vy / 127;

        // Cell center in world coords
        const wx = x * cellSize + cellSize / 2;
        const wy = y * cellSize + cellSize / 2;

        // Transform to screen coords
        const sx = (wx - camera.x) * zoom;
        const sy = (wy - camera.y) * zoom;

        // Draw arrow line
        ctx.beginPath();
        ctx.moveTo(sx - dx * arrowLen * 0.5, sy - dy * arrowLen * 0.5);
        ctx.lineTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
        ctx.stroke();

        // Arrow head
        const headLen = arrowLen * 0.4;
        const angle = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
        ctx.lineTo(
          sx + dx * arrowLen * 0.5 - headLen * Math.cos(angle - Math.PI / 6),
          sy + dy * arrowLen * 0.5 - headLen * Math.sin(angle - Math.PI / 6)
        );
        ctx.moveTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
        ctx.lineTo(
          sx + dx * arrowLen * 0.5 - headLen * Math.cos(angle + Math.PI / 6),
          sy + dy * arrowLen * 0.5 - headLen * Math.sin(angle + Math.PI / 6)
        );
        ctx.stroke();
      }
    }

    // Draw target marker
    const targetSx = (targetX - camera.x) * zoom;
    const targetSy = (targetY - camera.y) * zoom;

    ctx.fillStyle = 'rgba(255, 100, 100, 0.9)';
    ctx.beginPath();
    ctx.arc(targetSx, targetSy, 8 * zoom, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /**
   * Draw static (pre-baked) flowfield arrows
   */
  _drawStaticFlowfield(ctx, canvas, camera, zoom, name) {
    const ff = NavGrid._staticFlowfields.get(name);
    if (!ff) return;

    const { vectors, gridWidth, gridHeight, cellSize } = ff;

    ctx.strokeStyle = 'rgba(100, 255, 100, 0.7)';
    ctx.lineWidth = 1.5;

    const arrowLen = cellSize * 0.35 * zoom;

    const startCellX = Math.max(0, Math.floor(camera.x / cellSize) - 1);
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize) - 1);
    const endCellX = Math.min(
      gridWidth,
      Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1
    );
    const endCellY = Math.min(
      gridHeight,
      Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1
    );

    for (let y = startCellY; y < endCellY; y++) {
      for (let x = startCellX; x < endCellX; x++) {
        const vecIdx = (y * gridWidth + x) * 2;
        const vx = vectors[vecIdx];
        const vy = vectors[vecIdx + 1];

        if (vx === 0 && vy === 0) continue;

        const dx = vx / 127;
        const dy = vy / 127;

        const wx = x * cellSize + cellSize / 2;
        const wy = y * cellSize + cellSize / 2;

        const sx = (wx - camera.x) * zoom;
        const sy = (wy - camera.y) * zoom;

        ctx.beginPath();
        ctx.moveTo(sx - dx * arrowLen * 0.5, sy - dy * arrowLen * 0.5);
        ctx.lineTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
        ctx.stroke();

        const headLen = arrowLen * 0.4;
        const angle = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
        ctx.lineTo(
          sx + dx * arrowLen * 0.5 - headLen * Math.cos(angle - Math.PI / 6),
          sy + dy * arrowLen * 0.5 - headLen * Math.sin(angle - Math.PI / 6)
        );
        ctx.moveTo(sx + dx * arrowLen * 0.5, sy + dy * arrowLen * 0.5);
        ctx.lineTo(
          sx + dx * arrowLen * 0.5 - headLen * Math.cos(angle + Math.PI / 6),
          sy + dy * arrowLen * 0.5 - headLen * Math.sin(angle + Math.PI / 6)
        );
        ctx.stroke();
      }
    }
  }

  /**
   * Draw path line and waypoints (extracted from _visualizePath)
   */
  _drawPath(ctx, canvas, camera, zoom, slotIndex) {
    const pathPoints = NavGrid.getPathForVisualization(slotIndex);
    if (!pathPoints || pathPoints.length === 0) return;

    // Draw path line
    ctx.strokeStyle = 'rgba(255, 200, 0, 0.9)';
    ctx.lineWidth = 3 * zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    for (let i = 0; i < pathPoints.length; i++) {
      const p = pathPoints[i];
      const sx = (p.x - camera.x) * zoom;
      const sy = (p.y - camera.y) * zoom;

      if (i === 0) {
        ctx.moveTo(sx, sy);
      } else {
        ctx.lineTo(sx, sy);
      }
    }
    ctx.stroke();

    // Draw waypoint markers
    for (let i = 0; i < pathPoints.length; i++) {
      const p = pathPoints[i];
      const sx = (p.x - camera.x) * zoom;
      const sy = (p.y - camera.y) * zoom;

      // Start = green, End = red, Middle = yellow
      if (i === 0) {
        ctx.fillStyle = 'rgba(100, 255, 100, 0.9)';
      } else if (i === pathPoints.length - 1) {
        ctx.fillStyle = 'rgba(255, 100, 100, 0.9)';
      } else {
        ctx.fillStyle = 'rgba(255, 200, 0, 0.7)';
      }

      const radius = i === 0 || i === pathPoints.length - 1 ? 6 * zoom : 4 * zoom;

      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // ========================================
  // ENTITY DEBUG DRAWING METHODS
  // ========================================

  /**
   * Draw sleeping cells - highlights grid cells that are currently sleeping
   * Cyan/blue semi-transparent overlay to distinguish from other debug visualizations
   * A cell is sleeping if ALL entities in it are either sleeping or static
   */
  _drawSleepingCells(ctx, canvas, camera, zoom) {
    // Early exit if cell sleeping buffer not initialized
    if (!Grid.cellSleepingData || !Grid.cellSize) return;

    const cellSize = Grid.cellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSleepingData = Grid.cellSleepingData;

    // Calculate visible cell range for optimization
    const startCellX = Math.max(0, Math.floor(camera.x / cellSize));
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize));
    const endCellX = Math.min(gridCols, Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1);
    const endCellY = Math.min(
      gridRows,
      Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1
    );

    // Cyan/blue color for sleeping cells (distinct from sleeping entities which are magenta)
    ctx.fillStyle = 'rgba(0, 200, 255, 0.3)';
    const cellSizeScreen = cellSize * zoom;

    // Draw only sleeping cells (value === 1)
    for (let row = startCellY; row < endCellY; row++) {
      for (let col = startCellX; col < endCellX; col++) {
        const cellIndex = row * gridCols + col;

        // Check if cell is sleeping
        if (cellSleepingData[cellIndex] === 1) {
          // Calculate cell world position
          const worldX = col * cellSize;
          const worldY = row * cellSize;

          // Transform to screen coordinates
          const screenX = (worldX - camera.x) * zoom;
          const screenY = (worldY - camera.y) * zoom;

          // Draw filled rectangle for sleeping cell
          ctx.fillRect(screenX, screenY, cellSizeScreen, cellSizeScreen);
        }
      }
    }

    // Optional: Draw border around sleeping cells for better visibility
    ctx.strokeStyle = 'rgba(0, 200, 255, 0.6)';
    ctx.lineWidth = 1;
    for (let row = startCellY; row < endCellY; row++) {
      for (let col = startCellX; col < endCellX; col++) {
        const cellIndex = row * gridCols + col;

        if (cellSleepingData[cellIndex] === 1) {
          const worldX = col * cellSize;
          const worldY = row * cellSize;
          const screenX = (worldX - camera.x) * zoom;
          const screenY = (worldY - camera.y) * zoom;

          ctx.strokeRect(screenX, screenY, cellSizeScreen, cellSizeScreen);
        }
      }
    }
  }

  /**
   * Draw spatial grid lines
   * Shows the grid cells used for spatial partitioning
   */
  _drawSpatialGrid(ctx, canvas, camera, zoom) {
    if (!Grid.cellSize) return;

    const cellSize = Grid.cellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const worldWidth = gridCols * cellSize;
    const worldHeight = gridRows * cellSize;

    // Calculate visible cell range
    const startCellX = Math.max(0, Math.floor(camera.x / cellSize));
    const startCellY = Math.max(0, Math.floor(camera.y / cellSize));
    const endCellX = Math.min(gridCols, Math.ceil((camera.x + canvas.width / zoom) / cellSize) + 1);
    const endCellY = Math.min(
      gridRows,
      Math.ceil((camera.y + canvas.height / zoom) / cellSize) + 1
    );

    // Calculate world bounds for visible area
    const worldStartX = startCellX * cellSize;
    const worldStartY = startCellY * cellSize;
    const worldEndX = Math.min(endCellX * cellSize, worldWidth);
    const worldEndY = Math.min(endCellY * cellSize, worldHeight);

    ctx.strokeStyle = 'rgba(255, 255, 0, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Vertical lines
    for (let x = startCellX; x <= endCellX; x++) {
      const sx = (x * cellSize - camera.x) * zoom;
      const sy1 = (worldStartY - camera.y) * zoom;
      const sy2 = (worldEndY - camera.y) * zoom;
      ctx.moveTo(sx, sy1);
      ctx.lineTo(sx, sy2);
    }

    // Horizontal lines
    for (let y = startCellY; y <= endCellY; y++) {
      const sy = (y * cellSize - camera.y) * zoom;
      const sx1 = (worldStartX - camera.x) * zoom;
      const sx2 = (worldEndX - camera.x) * zoom;
      ctx.moveTo(sx1, sy);
      ctx.lineTo(sx2, sy);
    }

    ctx.stroke();
  }

  /**
   * Draw colliders for all active entities on screen
   * Circles = green, Boxes = green, Triggers = yellow
   */
  _drawColliders(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;

    const shapeType = Collider.shapeType;
    const isTrigger = Collider.isTrigger;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;

    // Calculate visible bounds for manual culling (for entities without SpriteRenderer)
    const viewLeft = camera.x - 100;
    const viewRight = camera.x + canvas.width / zoom + 100;
    const viewTop = camera.y - 100;
    const viewBottom = camera.y + canvas.height / zoom + 100;

    ctx.lineWidth = 2; //* zoom;

    for (let i = 0; i < Transform.active.length; i++) {
      if (!active[i]) continue;

      // Check visibility: use SpriteRenderer.isOnScreen if available,
      // otherwise do manual bounds check (for entities without sprites like CarPart)
      const entityX = x[i];
      const entityY = y[i];
      const onScreen = isOnScreen[i] || (
        entityX >= viewLeft && entityX <= viewRight &&
        entityY >= viewTop && entityY <= viewBottom
      );
      if (!onScreen) continue;

      const posX = x[i] + (offsetX?.[i] || 0);
      const posY = y[i] + (offsetY?.[i] || 0);

      // Transform to screen coords
      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom;

      // Choose color based on trigger status
      ctx.strokeStyle = isTrigger[i] ? 'rgba(255, 255, 0, 0.8)' : 'rgba(0, 255, 0, 0.8)';

      if (shapeType[i] === 0) {
        // Circle shape
        const r = radius[i];
        if (r === 0) continue;

        ctx.beginPath();
        ctx.arc(sx, sy, r * zoom, 0, Math.PI * 2);
        ctx.stroke();
      } else if (shapeType[i] === 1) {
        // Box shape
        const w = width[i];
        const h = height[i];
        if (w === 0 || h === 0) continue;

        const halfW = (w / 2) * zoom;
        const halfH = (h / 2) * zoom;
        ctx.strokeRect(sx - halfW, sy - halfH, w * zoom, h * zoom);
      }
    }
  }

  /**
   * Draw entity origin points (Transform.x, Transform.y positions)
   * Small crosshair markers showing the exact world position of each entity
   * Selected entity gets a larger, brighter marker
   */
  _drawEntityOrigins(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;

    const selectedIdx = this.debugFlags?.getSelectedEntity?.() ?? -1;

    // Crosshair sizes
    const crossSize = 4;
    const selectedCrossSize = 8;

    for (let i = 0; i < Transform.active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;

      const posX = x[i];
      const posY = y[i];

      // Transform to screen coords
      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom;

      const isSelected = i === selectedIdx;
      const size = isSelected ? selectedCrossSize : crossSize;

      // Color: bright magenta for selected, dimmer for others
      ctx.strokeStyle = isSelected ? 'rgba(255, 50, 255, 1.0)' : 'rgba(255, 50, 255, 0.7)';
      ctx.lineWidth = isSelected ? 2 : 1;

      // Draw crosshair
      ctx.beginPath();
      ctx.moveTo(sx - size, sy);
      ctx.lineTo(sx + size, sy);
      ctx.moveTo(sx, sy - size);
      ctx.lineTo(sx, sy + size);
      ctx.stroke();

      // Draw center dot
      ctx.fillStyle = isSelected ? 'rgba(255, 50, 255, 1.0)' : 'rgba(255, 50, 255, 0.8)';
      ctx.beginPath();
      ctx.arc(sx, sy, isSelected ? 3 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Draw velocity vectors for all active entities
   * Blue arrows showing direction and magnitude of movement
   */
  _drawVelocityVectors(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;

    const vx = RigidBody.vx;
    const vy = RigidBody.vy;

    ctx.strokeStyle = 'rgba(0, 136, 255, 0.9)';
    ctx.lineWidth = 2 / zoom;

    const scale = 10; // Scale factor for visualization

    for (let i = 0; i < Transform.active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;

      const velX = vx[i];
      const velY = vy[i];

      // Skip if velocity is too small
      if (Math.abs(velX) < 0.01 && Math.abs(velY) < 0.01) continue;

      const posX = x[i];
      const posY = y[i];

      // Transform to screen coords
      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom;
      const endX = sx + velX * scale * zoom;
      const endY = sy + velY * scale * zoom;

      // Draw line
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      // Draw arrowhead
      const angle = Math.atan2(velY, velX);
      const arrowSize = 5 * zoom;
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(
        endX - arrowSize * Math.cos(angle - Math.PI / 6),
        endY - arrowSize * Math.sin(angle - Math.PI / 6)
      );
      ctx.moveTo(endX, endY);
      ctx.lineTo(
        endX - arrowSize * Math.cos(angle + Math.PI / 6),
        endY - arrowSize * Math.sin(angle + Math.PI / 6)
      );
      ctx.stroke();
    }
  }

  /**
   * Draw acceleration vectors for all active entities
   * Red arrows showing direction and magnitude of acceleration
   */
  _drawAccelerationVectors(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;

    const ax = RigidBody.ax;
    const ay = RigidBody.ay;

    ctx.strokeStyle = 'rgba(255, 0, 68, 0.9)';
    ctx.lineWidth = 2 / zoom;

    const scale = 50; // Scale factor for visualization (acceleration is smaller)

    for (let i = 0; i < Transform.active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;

      const accX = ax[i];
      const accY = ay[i];

      // Skip if acceleration is too small
      if (Math.abs(accX) < 0.01 && Math.abs(accY) < 0.01) continue;

      const posX = x[i];
      const posY = y[i];

      // Transform to screen coords
      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom;
      const endX = sx + accX * scale * zoom;
      const endY = sy + accY * scale * zoom;

      // Draw line
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(endX, endY);
      ctx.stroke();

      // Draw arrowhead
      const angle = Math.atan2(accY, accX);
      const arrowSize = 5 * zoom;
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(
        endX - arrowSize * Math.cos(angle - Math.PI / 6),
        endY - arrowSize * Math.sin(angle - Math.PI / 6)
      );
      ctx.moveTo(endX, endY);
      ctx.lineTo(
        endX - arrowSize * Math.cos(angle + Math.PI / 6),
        endY - arrowSize * Math.sin(angle + Math.PI / 6)
      );
      ctx.stroke();
    }
  }

  /**
   * Draw sleeping entities - highlights entities that are currently sleeping
   * Purple/magenta outline to distinguish from other debug visualizations
   */
  _drawSleepingEntities(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;
    const rigidBodyActive = RigidBody.active;
    const sleeping = RigidBody.sleeping;

    // Check if sleeping array exists (may not be initialized in older scenes)
    if (!sleeping) return;

    const shapeType = Collider.shapeType;
    const radius = Collider.radius;
    const width = Collider.width;
    const height = Collider.height;
    const offsetX = Collider.offsetX;
    const offsetY = Collider.offsetY;

    // Purple/magenta color for sleeping entities
    ctx.strokeStyle = 'rgba(255, 0, 255, 0.8)';
    ctx.fillStyle = 'rgba(255, 0, 255, 0.2)';
    ctx.lineWidth = 3 / zoom;

    for (let i = 0; i < Transform.active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;
      if (!rigidBodyActive[i]) continue;
      if (!sleeping[i]) continue; // Only draw sleeping entities

      const posX = x[i] + (offsetX?.[i] || 0);
      const posY = y[i] + (offsetY?.[i] || 0);

      // Transform to screen coords
      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom;

      // Draw based on collider shape (if available) or use default circle
      if (shapeType && shapeType[i] === 0) {
        // Circle shape
        const r = radius?.[i] || 10;
        if (r === 0) continue;

        ctx.beginPath();
        ctx.arc(sx, sy, r * zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (shapeType && shapeType[i] === 1) {
        // Box shape
        const w = width?.[i] || 20;
        const h = height?.[i] || 20;
        if (w === 0 || h === 0) continue;

        const halfW = (w / 2) * zoom;
        const halfH = (h / 2) * zoom;
        ctx.fillRect(sx - halfW, sy - halfH, w * zoom, h * zoom);
        ctx.strokeRect(sx - halfW, sy - halfH, w * zoom, h * zoom);
      } else {
        // Default: draw a circle if no collider shape
        const defaultRadius = 10 * zoom;
        ctx.beginPath();
        ctx.arc(sx, sy, defaultRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  /**
   * Draw neighbor connections for entity closest to mouse
   * Cyan lines connecting entity to its spatial neighbors
   */
  _drawNeighborConnections(ctx, canvas, camera, zoom) {
    if (!Grid.neighborData) return;

    // Get mouse position from Mouse static class
    const mouseX = Mouse.x;
    const mouseY = Mouse.y;

    if (!Mouse.isPresent) return;

    const neighborData = Grid.neighborData;
    const stride = Grid._stride;

    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;

    // Find entity closest to mouse using Grid spatial query
    const { count, entities } = Grid.getEntitiesInRadius(mouseX, mouseY, 150);

    let closestEntity = -1;
    let closestDist2 = Infinity;

    for (let i = 0; i < count; i++) {
      const entityId = entities[i];
      if (!active[entityId]) continue;

      const dist2 = distanceSq2D(mouseX, mouseY, x[entityId], y[entityId]);

      if (dist2 < closestDist2) {
        closestDist2 = dist2;
        closestEntity = entityId;
      }
    }

    if (closestEntity === -1) return;

    const myX = x[closestEntity];
    const myY = y[closestEntity];

    // Transform to screen coords
    const mySx = (myX - camera.x) * zoom;
    const mySy = (myY - camera.y) * zoom;

    // Highlight the selected entity with a bright ring
    const highlightRadius = (Collider.radius[closestEntity] * 1.5 || 10) * zoom;
    ctx.strokeStyle = 'rgba(255, 255, 0, 1.0)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(mySx, mySy, highlightRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Draw neighbor connections using the entity's actual neighbor data
    const offset = closestEntity * stride;
    const neighborCount = neighborData[offset];

    ctx.strokeStyle = 'rgba(0, 255, 255, 0.7)';
    ctx.lineWidth = 2;

    for (let n = 0; n < neighborCount; n++) {
      const neighborIndex = neighborData[offset + 2 + n];
      if (!active[neighborIndex]) continue;

      const neighborX = x[neighborIndex];
      const neighborY = y[neighborIndex];

      const neighborSx = (neighborX - camera.x) * zoom;
      const neighborSy = (neighborY - camera.y) * zoom;

      // Draw line
      ctx.beginPath();
      ctx.moveTo(mySx, mySy);
      ctx.lineTo(neighborSx, neighborSy);
      ctx.stroke();

      // Draw small circle on neighbor
      ctx.fillStyle = 'rgba(0, 255, 255, 0.5)';
      ctx.beginPath();
      ctx.arc(neighborSx, neighborSy, 3 * zoom, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw entity info marker
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.arc(mySx, mySy - 20, 4 * zoom, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Draw collision candidate connections for entity closest to mouse
   * Orange lines connecting entity to its collision candidates (physics-relevant neighbors)
   */
  _drawCollisionCandidateConnections(ctx, canvas, camera, zoom) {
    if (!Grid.neighborData) return;

    // Get mouse position from Mouse static class
    const mouseX = Mouse.x;
    const mouseY = Mouse.y;

    if (!Mouse.isPresent) return;

    const neighborData = Grid.neighborData;
    const stride = Grid._stride;

    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;

    // Find entity closest to mouse using Grid spatial query
    const { count, entities } = Grid.getEntitiesInRadius(mouseX, mouseY, 150);

    let closestEntity = -1;
    let closestDist2 = Infinity;

    for (let i = 0; i < count; i++) {
      const entityId = entities[i];
      if (!active[entityId]) continue;

      const dist2 = distanceSq2D(mouseX, mouseY, x[entityId], y[entityId]);

      if (dist2 < closestDist2) {
        closestDist2 = dist2;
        closestEntity = entityId;
      }
    }

    if (closestEntity === -1) return;

    const myX = x[closestEntity];
    const myY = y[closestEntity];

    // Transform to screen coords
    const mySx = (myX - camera.x) * zoom;
    const mySy = (myY - camera.y) * zoom;

    // Highlight the selected entity with a bright ring
    const highlightRadius = (Collider.radius[closestEntity] * 1.5 || 10) * zoom;
    ctx.strokeStyle = 'rgba(255, 140, 0, 1.0)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(mySx, mySy, highlightRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Draw collision candidate connections using the entity's actual neighbor data
    const offset = closestEntity * stride;
    const collisionCandidateCount = neighborData[offset + 1]; // Collision candidates count is at offset + 1

    ctx.strokeStyle = 'rgba(255, 100, 0, 0.8)';
    ctx.lineWidth = 2;

    for (let n = 0; n < collisionCandidateCount; n++) {
      const candidateIndex = neighborData[offset + 2 + n];
      if (!active[candidateIndex]) continue;

      const candidateX = x[candidateIndex];
      const candidateY = y[candidateIndex];

      const candidateSx = (candidateX - camera.x) * zoom;
      const candidateSy = (candidateY - camera.y) * zoom;

      // Draw line
      ctx.beginPath();
      ctx.moveTo(mySx, mySy);
      ctx.lineTo(candidateSx, candidateSy);
      ctx.stroke();

      // Draw small circle on candidate
      ctx.fillStyle = 'rgba(255, 100, 0, 0.6)';
      ctx.beginPath();
      ctx.arc(candidateSx, candidateSy, 4 * zoom, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw entity info marker with count
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = `${12 * zoom}px monospace`;
    ctx.fillText(`${collisionCandidateCount} candidates`, mySx + 10, mySy - 10);
  }

  /**
   * Draw raycasts from debug buffer
   * Green = hit, Yellow/Orange = miss
   */
  _drawRaycasts(ctx, canvas, camera, zoom) {
    const raycastBuffer = this.scene?.buffers?.raycastDebugData;
    if (!raycastBuffer) return;

    const raycastView = new Float32Array(raycastBuffer);
    const count = Math.min(raycastView[0], this.scene?.maxDebugRaycasts || 100);

    if (count === 0) return;

    for (let i = 0; i < count; i++) {
      const offset = 1 + i * 7;
      const startX = raycastView[offset];
      const startY = raycastView[offset + 1];
      const endX = raycastView[offset + 2];
      const endY = raycastView[offset + 3];
      const hitX = raycastView[offset + 4];
      const hitY = raycastView[offset + 5];
      const didHit = raycastView[offset + 6] === 1;

      // Transform to screen coords
      const sStartX = (startX - camera.x) * zoom;
      const sStartY = (startY - camera.y) * zoom;
      const sEndX = (endX - camera.x) * zoom;
      const sEndY = (endY - camera.y) * zoom;
      const sHitX = (hitX - camera.x) * zoom;
      const sHitY = (hitY - camera.y) * zoom;

      if (didHit) {
        // Hit: Draw line to hit point in green
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sStartX, sStartY);
        ctx.lineTo(sHitX, sHitY);
        ctx.stroke();

        // Draw dashed line from hit to end in red
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(sHitX, sHitY);
        ctx.lineTo(sEndX, sEndY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw hit point circle
        ctx.fillStyle = 'rgba(255, 0, 0, 1.0)';
        ctx.beginPath();
        ctx.arc(sHitX, sHitY, 4, 0, Math.PI * 2);
        ctx.fill();

        // Draw impact cross
        ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
        ctx.lineWidth = 2;
        const crossSize = 8;
        ctx.beginPath();
        ctx.moveTo(sHitX - crossSize, sHitY);
        ctx.lineTo(sHitX + crossSize, sHitY);
        ctx.moveTo(sHitX, sHitY - crossSize);
        ctx.lineTo(sHitX, sHitY + crossSize);
        ctx.stroke();
      } else {
        // Miss: Draw full line in yellow/orange
        ctx.strokeStyle = 'rgba(255, 170, 0, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sStartX, sStartY);
        ctx.lineTo(sEndX, sEndY);
        ctx.stroke();
      }

      // Draw start point
      ctx.fillStyle = 'rgba(0, 255, 255, 0.8)';
      ctx.beginPath();
      ctx.arc(sStartX, sStartY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Draw entity indices above each entity
   * White text on dark background
   */
  _drawEntityIndices(ctx, canvas, camera, zoom) {
    const active = Transform.active;
    const x = Transform.x;
    const y = Transform.y;
    const isOnScreen = SpriteRenderer.isItOnScreen;

    ctx.font = `${Math.max(10, 12 / zoom)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    for (let i = 0; i < Transform.active.length; i++) {
      if (!active[i] || !isOnScreen[i]) continue;

      const posX = x[i];
      const posY = y[i];

      // Transform to screen coords
      const sx = (posX - camera.x) * zoom;
      const sy = (posY - camera.y) * zoom - 15;

      const text = String(i);
      const metrics = ctx.measureText(text);
      const padding = 2;

      // Draw background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(sx - metrics.width / 2 - padding, sy - 12, metrics.width + padding * 2, 14);

      // Draw text
      ctx.fillStyle = 'rgba(255, 255, 255, 1.0)';
      ctx.fillText(text, sx, sy);
    }
  }

  /**
   * Draw distance constraints as lines between connected entities
   * Color indicates stiffness: red (low) to green (high)
   */
  _drawConstraints(ctx, canvas, camera, zoom) {
    // Check if Constraint is initialized
    if (!Constraint.initialized || !Constraint.pairs || !Constraint.active) {
      return;
    }

    const pairs = Constraint.pairs;
    const restLength = Constraint.restLength;
    const stiffness = Constraint.stiffness;
    const constraintActive = Constraint.active;
    const maxConstraints = Constraint.maxCount;

    const x = Transform.x;
    const y = Transform.y;
    const entityActive = Transform.active;

    ctx.lineWidth = 2;

    for (let i = 0; i < maxConstraints; i++) {
      if (!constraintActive[i]) continue;

      // Unpack entity indices
      const packed = pairs[i];
      const entityA = packed >>> 16;
      const entityB = packed & 0xFFFF;

      // Skip if either entity is inactive
      if (!entityActive[entityA] || !entityActive[entityB]) continue;

      // Get positions
      const ax = x[entityA];
      const ay = y[entityA];
      const bx = x[entityB];
      const by = y[entityB];

      // Transform to screen coords
      const sax = (ax - camera.x) * zoom;
      const say = (ay - camera.y) * zoom;
      const sbx = (bx - camera.x) * zoom;
      const sby = (by - camera.y) * zoom;

      // Skip if both points are off-screen (rough culling)
      if ((sax < -50 && sbx < -50) || (sax > canvas.width + 50 && sbx > canvas.width + 50) ||
        (say < -50 && sby < -50) || (say > canvas.height + 50 && sby > canvas.height + 50)) {
        continue;
      }

      // Calculate current distance
      const dx = bx - ax;
      const dy = by - ay;
      const currentDist = Math.sqrt(dx * dx + dy * dy);
      const targetDist = restLength[i];

      // Color based on stretch/compression
      // Green = at rest, Yellow = slightly stretched, Red = very stretched
      // Cyan = compressed
      const stretchRatio = currentDist / targetDist;
      let r, g, b;

      if (stretchRatio < 0.9) {
        // Compressed - cyan
        r = 0; g = 200; b = 255;
      } else if (stretchRatio < 1.1) {
        // Near rest length - green
        r = 50; g = 255; b = 50;
      } else if (stretchRatio < 1.3) {
        // Slightly stretched - yellow
        const t = (stretchRatio - 1.1) / 0.2;
        r = Math.floor(50 + 205 * t);
        g = 255;
        b = Math.floor(50 * (1 - t));
      } else {
        // Very stretched - red
        r = 255; g = Math.max(0, Math.floor(255 * (2 - stretchRatio))); b = 0;
      }

      // Alpha based on stiffness (stiffer = more visible)
      const alpha = 0.4 + stiffness[i] * 0.5;

      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;

      ctx.beginPath();
      ctx.moveTo(sax, say);
      ctx.lineTo(sbx, sby);
      ctx.stroke();

      // Draw small circles at connection points
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha + 0.2})`;
      ctx.beginPath();
      ctx.arc(sax, say, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sbx, sby, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Draw bounding box around selected entity
   * Golden yellow box with corner markers
   */
  _drawSelectedEntity(ctx, canvas, camera, zoom) {
    const selectedIdx = this.debugFlags?.getSelectedEntity?.() ?? -1;

    if (selectedIdx < 0 || !Transform.active[selectedIdx]) return;

    const posX = Transform.x[selectedIdx];
    const posY = Transform.y[selectedIdx];

    // Get sprite dimensions from SpriteRenderer (original unscaled size)
    const width = SpriteRenderer.getOriginalWidth(selectedIdx) || 20;
    const height = SpriteRenderer.getOriginalHeight(selectedIdx) || 20;

    const scaleX = SpriteRenderer.scaleX?.[selectedIdx] || 1;
    const scaleY = SpriteRenderer.scaleY?.[selectedIdx] || 1;
    const anchorX = SpriteRenderer.anchorX?.[selectedIdx] || 0.5;
    const anchorY = SpriteRenderer.anchorY?.[selectedIdx] || 0.5;

    const w = width * Math.abs(scaleX);
    const h = height * Math.abs(scaleY);

    // Calculate bounding box corners
    const left = posX - w * anchorX;
    const top = posY - h * anchorY;

    // Transform to screen coords
    const sLeft = (left - camera.x) * zoom;
    const sTop = (top - camera.y) * zoom;
    const sWidth = w * zoom;
    const sHeight = h * zoom;

    // Draw bounding box
    ctx.strokeStyle = 'rgba(255, 200, 100, 1.0)';
    ctx.lineWidth = 2;
    ctx.strokeRect(sLeft, sTop, sWidth, sHeight);

    // Draw corner markers
    const cornerSize = 6;
    ctx.fillStyle = 'rgba(255, 200, 100, 0.8)';
    const corners = [
      [sLeft, sTop],
      [sLeft + sWidth, sTop],
      [sLeft, sTop + sHeight],
      [sLeft + sWidth, sTop + sHeight],
    ];

    for (const [cx, cy] of corners) {
      ctx.beginPath();
      ctx.arc(cx, cy, cornerSize, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw entity index label above the box
    const sx = (posX - camera.x) * zoom;
    const labelY = sTop - 15;
    const text = String(selectedIdx);

    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const metrics = ctx.measureText(text);
    const padding = 4;

    // Draw label background
    ctx.fillStyle = 'rgba(255, 200, 100, 0.9)';
    ctx.fillRect(sx - metrics.width / 2 - padding, labelY - 12, metrics.width + padding * 2, 16);

    // Draw label text
    ctx.fillStyle = 'rgba(0, 0, 0, 1.0)';
    ctx.fillText(text, sx, labelY);
  }

  _createToolIndicator() {
    this.elements.toolIndicator = document.createElement('div');
    this.elements.toolIndicator.className = 'debug-ui-tool-indicator';
    document.body.appendChild(this.elements.toolIndicator);
  }

  _updateToolIndicator() {
    const indicator = this.elements.toolIndicator;
    if (!indicator) return;

    if (this.activeSpawnerType) {
      const bulkText = this.bulkSpawnEnabled ? ' ×50' : '';
      indicator.textContent = `🎨 Painting: ${this.activeSpawnerType}${bulkText} (click & drag to spawn)`;
      indicator.className = 'debug-ui-tool-indicator visible spawner';
    } else if (this.eraserActive) {
      indicator.textContent = `🧹 Eraser Active (click & drag to despawn)`;
      indicator.className = 'debug-ui-tool-indicator visible eraser';
    } else if (this.inspectorActive) {
      indicator.textContent = `🔍 Inspector Active (click on an entity to inspect)`;
      indicator.className = 'debug-ui-tool-indicator visible inspector';
    } else {
      indicator.className = 'debug-ui-tool-indicator';
    }
  }

  // ========================================
  // ENTITY INSPECTOR
  // ========================================

  /**
   * Create the inspector panel (hidden by default)
   */
  _createInspectorPanel() {
    const panel = document.createElement('div');
    panel.className = 'debug-ui-inspector-panel';
    panel.style.cssText = `
      position: fixed;
      left: 0;
      top: 78px;
      width: 320px;
      max-height: calc(100vh - 200px);
      background: rgba(15, 15, 20, 0.95);
      border-right: 2px solid rgba(255, 200, 100, 0.5);
      border-bottom: 2px solid rgba(255, 200, 100, 0.3);
      border-radius: 0 0 8px 0;
      overflow-y: auto;
      overflow-x: hidden;
      display: none;
      flex-direction: column;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 13px;
      z-index: 10001;
      box-shadow: 4px 4px 12px rgba(0, 0, 0, 0.5);
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 10px 12px;
      background: linear-gradient(135deg, rgba(255, 200, 100, 0.2), rgba(255, 150, 50, 0.1));
      border-bottom: 1px solid rgba(255, 200, 100, 0.3);
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 1;
    `;

    const title = document.createElement('span');
    title.style.cssText = `
      font-weight: bold;
      font-size: 12px;
      color: #ffc864;
    `;
    title.textContent = '🔍 Entity Inspector';
    header.appendChild(title);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = `
      background: rgba(255, 100, 100, 0.3);
      border: 1px solid rgba(255, 100, 100, 0.5);
      color: #ff8888;
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    `;
    closeBtn.textContent = '✕ Close';
    closeBtn.onclick = () => this._clearSelection();
    header.appendChild(closeBtn);

    panel.appendChild(header);

    // Entity info header
    this.elements.inspectorEntityInfo = document.createElement('div');
    this.elements.inspectorEntityInfo.style.cssText = `
      padding: 8px 12px;
      background: rgba(0, 0, 0, 0.3);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      color: #aaa;
    `;
    panel.appendChild(this.elements.inspectorEntityInfo);

    // Components container
    this.elements.inspectorComponentsContainer = document.createElement('div');
    this.elements.inspectorComponentsContainer.style.cssText = `
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;
    panel.appendChild(this.elements.inspectorComponentsContainer);

    document.body.appendChild(panel);
    this.elements.inspectorPanel = panel;
  }

  /**
   * Toggle inspector mode on/off
   */
  _toggleInspector() {
    this.inspectorActive = !this.inspectorActive;

    // Deactivate other tools when inspector is activated
    if (this.inspectorActive) {
      this.activeSpawnerType = null;
      this.eraserActive = false;
    }

    this._updateDebugToolFlag();
    this._updateToolButtonStates();
    this._updateToolIndicator();
    this._updateInspectorButtonState();
  }

  /**
   * Update inspector button visual state
   */
  _updateInspectorButtonState() {
    if (this.elements.inspectorBtn) {
      this.elements.inspectorBtn.classList.toggle('active', this.inspectorActive);
    }
  }

  /**
   * Select an entity at the current mouse position
   * Uses Grid spatial query for efficiency
   */
  _selectEntityAtMouse() {
    if (!this.scene || !this.inspectorActive) return;

    const selectRadius = 100;
    const { count, entities } = Grid.getEntitiesInRadius(Mouse.x, Mouse.y, selectRadius);

    if (count === 0) {
      this._clearSelection();
      return;
    }

    // Find nearest entity, skipping internal entities
    let nearestIndex = -1;
    let nearestDistSq = selectRadius * selectRadius;

    for (let i = 0; i < count; i++) {
      const entityId = entities[i];
      if (!Transform.active[entityId]) continue;

      // Skip internal entities (Flash)
      const entityType = Transform.entityType[entityId];
      const reg = this.scene.registeredClasses.find((r) => r.entityType === entityType);
      if (reg && this._internalEntitiesSet.has(reg.class.name)) continue;

      // Distance check
      const distSq = distanceSq2D(Mouse.x, Mouse.y, Transform.x[entityId], Transform.y[entityId]);

      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestIndex = entityId;
      }
    }

    if (nearestIndex >= 0) {
      this._selectEntity(nearestIndex);
    } else {
      this._clearSelection();
    }
  }

  /**
   * Select a specific entity by index
   * @param {number} entityIndex - Entity index to select
   */
  _selectEntity(entityIndex) {
    this.selectedEntityIndex = entityIndex;

    // Update debug flags to notify renderer
    if (this.debugFlags) {
      this.debugFlags.setSelectedEntity(entityIndex);
    }

    // Start visualization loop for bounding box
    this._startDebugVisualizationLoop();

    // Show and populate inspector panel
    this._showInspectorPanel();
    this._populateInspectorPanel();
  }

  /**
   * Clear entity selection
   */
  _clearSelection() {
    this.selectedEntityIndex = -1;
    this._prevInspectorValues = {};

    // Update debug flags
    if (this.debugFlags) {
      this.debugFlags.clearSelectedEntity();
    }

    // Stop visualization loop if no other visualizations active
    if (!this._hasActiveDebugVisualization()) {
      this._stopDebugVisualizationLoop();
      this._clearDebugCanvas();
    }

    // Hide inspector panel
    this._hideInspectorPanel();
  }

  /**
   * Show the inspector panel
   */
  _showInspectorPanel() {
    if (!this.elements.inspectorPanel) {
      this._createInspectorPanel();
    }
    this.elements.inspectorPanel.style.display = 'flex';
    this._inspectorPanelVisible = true;
  }

  /**
   * Hide the inspector panel
   */
  _hideInspectorPanel() {
    if (this.elements.inspectorPanel) {
      this.elements.inspectorPanel.style.display = 'none';
    }
    this._inspectorPanelVisible = false;
  }

  /**
   * Populate the inspector panel with component data
   * Called once when an entity is selected
   */
  _populateInspectorPanel() {
    if (this.selectedEntityIndex < 0 || !this.scene) return;

    const entityIndex = this.selectedEntityIndex;
    const entityType = Transform.entityType[entityIndex];

    // Find the registered class info
    const regInfo = this.scene.registeredClasses.find((r) => r.entityType === entityType);

    // Update entity info header
    const infoEl = this.elements.inspectorEntityInfo;
    if (infoEl) {
      const className = regInfo ? regInfo.class.name : 'Unknown';
      infoEl.innerHTML = `
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
          <span style="color: #fff; font-weight: bold;">${className}</span>
          <span style="color: #888;">Index: ${entityIndex}</span>
        </div>
        <div style="color: #666; font-size: 12px;">Type ID: ${entityType}</div>
      `;
    }

    // Get components for this entity type
    const components = regInfo ? regInfo.components : [Transform];
    const container = this.elements.inspectorComponentsContainer;
    if (!container) return;

    container.innerHTML = '';
    this.elements.inspectorComponentRows = {};

    // Create section for each component
    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;
      const color = getComponentColor(componentName);

      // Component section
      const section = document.createElement('div');
      section.style.cssText = `
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid ${color.css};
        border-left: 3px solid ${color.css};
        border-radius: 4px;
        overflow: hidden;
      `;

      // Component header
      const header = document.createElement('div');
      header.style.cssText = `
        padding: 6px 8px;
        background: linear-gradient(90deg, ${color.css}22, transparent);
        color: ${color.css};
        font-weight: bold;
        font-size: 11px;
        border-bottom: 1px solid ${color.css}44;
      `;
      header.textContent = componentName;
      section.appendChild(header);

      // Properties table
      const propsContainer = document.createElement('div');
      propsContainer.style.cssText = `
        padding: 4px 0;
      `;

      const propNames = getComponentPropertyNames(ComponentClass);
      this.elements.inspectorComponentRows[componentName] = {};

      for (const propName of propNames) {
        const row = document.createElement('div');
        row.style.cssText = `
          display: flex;
          justify-content: space-between;
          padding: 2px 8px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        `;

        const label = document.createElement('span');
        label.style.cssText = `color: #888; font-size: 12px;`;
        label.textContent = propName;
        row.appendChild(label);

        const value = document.createElement('span');
        value.style.cssText = `color: #fff; font-size: 12px; font-family: monospace;`;
        value.textContent = '--';
        row.appendChild(value);

        propsContainer.appendChild(row);

        // Store reference for updates
        this.elements.inspectorComponentRows[componentName][propName] = value;
      }

      section.appendChild(propsContainer);
      container.appendChild(section);
    }

    // Initial update
    this._updateInspectorValues();
  }

  /**
   * Update inspector panel values (called every tick)
   * OPTIMIZED: Only updates DOM when values change
   */
  _updateInspectorValues() {
    if (this.selectedEntityIndex < 0 || !this._inspectorPanelVisible) return;

    const entityIndex = this.selectedEntityIndex;

    // Check if entity was despawned
    if (!Transform.active[entityIndex]) {
      this._clearSelection();
      return;
    }

    const rows = this.elements.inspectorComponentRows;
    if (!rows) return;

    // Core components with their static arrays
    const coreComponents = {
      Transform: Transform,
      RigidBody: RigidBody,
      Collider: Collider,
      SpriteRenderer: SpriteRenderer,
    };

    // Get registered class info for custom components
    const entityType = Transform.entityType[entityIndex];
    const regInfo = this.scene?.registeredClasses?.find((r) => r.entityType === entityType);
    const components = regInfo ? regInfo.components : [Transform];

    // Update each component's values
    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;
      const componentRows = rows[componentName];
      if (!componentRows) continue;

      // Get the static arrays for this component
      const schema = ComponentClass.ARRAY_SCHEMA;
      if (!schema) continue;

      // Initialize previous values cache for this component
      if (!this._prevInspectorValues[componentName]) {
        this._prevInspectorValues[componentName] = {};
      }
      const prevCache = this._prevInspectorValues[componentName];

      for (const propName of Object.keys(componentRows)) {
        const arr = ComponentClass[propName];
        if (!arr || arr[entityIndex] === undefined) continue;

        const value = arr[entityIndex];

        // Skip update if value hasn't changed (use rounded comparison for floats)
        const roundedValue = typeof value === 'number' ? (value * 1000) | 0 : value;
        if (prevCache[propName] === roundedValue) continue;
        prevCache[propName] = roundedValue;

        // Format and update DOM
        const formatted = formatComponentValue(propName, value);
        componentRows[propName].textContent = formatted;
      }
    }
  }

  _createStat(text, className) {
    const span = document.createElement('span');
    span.className = `debug-ui-stat ${className}`;
    span.textContent = text;
    return span;
  }

  _createDivider() {
    const div = document.createElement('div');
    div.className = 'debug-ui-divider';
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

    container.innerHTML = '';

    // Internal entity types that shouldn't have tools
    const internalEntities = new Set(['Mouse', 'Flash']);

    // Get spawnable entity classes from the scene
    const spawnableClasses = (this.scene.registeredClasses || []).filter(
      (reg) => reg.count > 0 && !internalEntities.has(reg.class.name)
    );

    if (spawnableClasses.length === 0) return;

    // Painter tools row
    const paintersRow = document.createElement('div');
    paintersRow.className = 'debug-ui-row';
    paintersRow.style.gap = '8px';
    paintersRow.style.flexWrap = 'wrap';

    // Label
    const paintersLabel = document.createElement('span');
    paintersLabel.className = 'debug-ui-stat';
    paintersLabel.textContent = 'Paint:';
    paintersRow.appendChild(paintersLabel);

    this.elements.spawnerButtons = {};
    this._spawnerButtonKeys = []; // Cache keys to avoid Object.keys() allocation in tick

    // Generate painter button for each entity type
    for (const reg of spawnableClasses) {
      const className = reg.class.name;

      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn tool';
      btn.textContent = '🎨 ' + className;
      btn.title = 'Toggle ' + className + ' painter (click & drag on canvas to spawn)';
      btn.onclick = () => this._toggleSpawner(className);
      this.elements.spawnerButtons[className] = btn;
      this._spawnerButtonKeys.push(className); // Cache key
      paintersRow.appendChild(btn);
    }

    // Eraser button
    this.elements.eraserButton = document.createElement('button');
    this.elements.eraserButton.className = 'debug-ui-btn danger';
    this.elements.eraserButton.textContent = '🧹 Eraser';
    this.elements.eraserButton.title = 'Toggle eraser (click & drag to despawn entities)';
    this.elements.eraserButton.onclick = () => this._toggleEraser();
    paintersRow.appendChild(this.elements.eraserButton);

    // Divider
    paintersRow.appendChild(this._createDivider());

    // Bulk spawn checkbox
    const bulkLabel = document.createElement('label');
    bulkLabel.style.display = 'flex';
    bulkLabel.style.alignItems = 'center';
    bulkLabel.style.gap = '4px';
    bulkLabel.style.color = 'rgba(255, 255, 255, 0.7)';
    bulkLabel.style.cursor = 'pointer';
    bulkLabel.style.fontSize = '10px';

    this.elements.bulkSpawnCheckbox = document.createElement('input');
    this.elements.bulkSpawnCheckbox.type = 'checkbox';
    this.elements.bulkSpawnCheckbox.checked = this.bulkSpawnEnabled;
    this.elements.bulkSpawnCheckbox.style.cursor = 'pointer';
    this.elements.bulkSpawnCheckbox.onchange = (e) => {
      this.bulkSpawnEnabled = e.target.checked;
      this._updateToolIndicator();
    };

    bulkLabel.appendChild(this.elements.bulkSpawnCheckbox);
    bulkLabel.appendChild(document.createTextNode('×50'));
    paintersRow.appendChild(bulkLabel);

    container.appendChild(paintersRow);

    // Clear all row
    const clearRow = document.createElement('div');
    clearRow.className = 'debug-ui-row';
    clearRow.style.marginTop = '8px';
    clearRow.style.gap = '8px';

    const clearLabel = document.createElement('span');
    clearLabel.className = 'debug-ui-stat';
    clearLabel.textContent = 'Clear:';
    clearRow.appendChild(clearLabel);

    // Clear buttons for each entity type
    for (const reg of spawnableClasses) {
      const className = reg.class.name;
      const clearBtn = document.createElement('button');
      clearBtn.className = 'debug-ui-btn danger';
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
      // Activate this spawner, deactivate eraser and inspector
      this.activeSpawnerType = className;
      this.eraserActive = false;
      this.inspectorActive = false;
    }
    this._updateDebugToolFlag();
    this._updateToolButtonStates();
    this._updateToolIndicator();
    this._updateInspectorButtonState();
  }

  _toggleEraser() {
    this.eraserActive = !this.eraserActive;
    if (this.eraserActive) {
      this.activeSpawnerType = null;
      this.inspectorActive = false;
    }
    this._updateDebugToolFlag();
    this._updateToolButtonStates();
    this._updateToolIndicator();
    this._updateInspectorButtonState();
  }

  /**
   * Update Mouse.isDebugToolActive flag to block game input when tools are active
   */
  _updateDebugToolFlag() {
    Mouse.isDebugToolActive = !!(
      this.activeSpawnerType ||
      this.eraserActive ||
      this.inspectorActive
    );
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
        const isActive = btn.classList.contains('active');
        if (shouldBeActive !== isActive) {
          btn.classList.toggle('active', shouldBeActive);
        }
      }
    }

    // Update eraser button - only toggle if state changed
    const eraserBtn = this.elements.eraserButton;
    if (eraserBtn) {
      const isActive = eraserBtn.classList.contains('active');
      if (this.eraserActive !== isActive) {
        eraserBtn.classList.toggle('active', this.eraserActive);
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

      // Ignore clicks on debug UI elements (header, panels, inspector, etc.)
      if (this.container?.contains(e.target)) return;
      if (this.elements.inspectorPanel?.contains(e.target)) return;
      if (this.elements.toolIndicator?.contains(e.target)) return;

      // Handle inspector click (single click to select)
      if (this.inspectorActive) {
        this._selectEntityAtMouse();
        return;
      }

      if (!this.activeSpawnerType && !this.eraserActive) return;
      this._toolMouseDown = true;
    };

    this._onToolMouseUp = (e) => {
      if (e.button !== 0) return;
      this._toolMouseDown = false;
    };

    // Use capture phase to get events before game handlers
    document.addEventListener('mousedown', this._onToolMouseDown, true);
    document.addEventListener('mouseup', this._onToolMouseUp, true);
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
   * Spawn entity at current mouse position
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
   * Uses Grid spatial query for efficiency
   */
  _despawnEntityAtMouse() {
    if (!this.scene || !this.gameEngine) return;

    const eraserRadius = 50;
    const { count, entities } = Grid.getEntitiesInRadius(Mouse.x, Mouse.y, eraserRadius);
    if (count === 0) return;

    // Find nearest entity, skipping internal entities
    let nearestIndex = -1;
    let nearestDistSq = eraserRadius * eraserRadius;

    for (let i = 0; i < count; i++) {
      const entityId = entities[i];
      if (!Transform.active[entityId]) continue;

      // Skip internal entities (Flash)
      const entityType = Transform.entityType[entityId];
      const reg = this.scene.registeredClasses.find((r) => r.entityType === entityType);
      if (reg && this._internalEntitiesSet.has(reg.class.name)) continue;

      // Distance check
      const distSq = distanceSq2D(Mouse.x, Mouse.y, Transform.x[entityId], Transform.y[entityId]);

      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestIndex = entityId;
      }
    }

    if (nearestIndex >= 0) {
      this.scene.despawnEntity(nearestIndex);
    }
  }

  // ========================================
  // KEYBOARD SHORTCUTS
  // ========================================

  _setupKeyboardShortcuts() {
    this._keyHandler = (e) => {
      // Ignore if typing in input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      const key = e.key.toLowerCase();

      if (key === 'h') {
        this.toggle();
      } else if (key === 'escape') {
        // ESC to deselect all tools and clear selection
        this.activeSpawnerType = null;
        this.eraserActive = false;
        this.inspectorActive = false;
        this._toolMouseDown = false;
        this._clearSelection();
        this._updateDebugToolFlag();
        this._updateToolButtonStates();
        this._updateToolIndicator();
        this._updateInspectorButtonState();
      } else if (key === 'i') {
        // Toggle inspector mode
        this._toggleInspector();
      } else if (key >= '1' && key <= '9') {
        const keyMap = {
          1: 'colliders',
          2: 'velocity',
          3: 'acceleration',
          4: 'neighbors',
          5: 'spatialGrid',
          6: 'aabb',
          7: 'entityIndices',
          8: 'raycasts',
          9: 'sleepingEntities',
        };
        this._toggleVisualAid(keyMap[key]);
      } else if (key === 's') {
        // Toggle sleeping cells visualization
        // this._toggleVisualAid('sleepingCells');
      } else if (key === 'k') {
        // Toggle constraints visualization
        this._toggleVisualAid('constraints');
      } else if (key === 'c') {
        // Toggle collision candidates visualization
        this._toggleVisualAid('collisionCandidates');
      } else if (key === 'o') {
        // Toggle entity origins visualization
        this._toggleVisualAid('entityOrigins');
      } else if (key === '0') {
        if (this.debugFlags) {
          this.debugFlags.disableAll();
          this._updateVisualAidsState();
        }
      }
    };

    window.addEventListener('keydown', this._keyHandler);
  }

  // ========================================
  // VISIBILITY
  // ========================================

  toggle() {
    this.container.classList.toggle('hidden');
  }

  show() {
    this.container.classList.remove('hidden');
  }

  hide() {
    this.container.classList.add('hidden');
  }

  // ========================================
  // CLEANUP
  // ========================================

  destroy() {
    this.stop();

    if (this._keyHandler) {
      window.removeEventListener('keydown', this._keyHandler);
    }

    if (this._onToolMouseDown) {
      document.removeEventListener('mousedown', this._onToolMouseDown, true);
    }
    if (this._onToolMouseUp) {
      document.removeEventListener('mouseup', this._onToolMouseUp, true);
    }

    // Clear debug tool flag
    Mouse.isDebugToolActive = false;

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    if (this.elements.toolIndicator && this.elements.toolIndicator.parentNode) {
      this.elements.toolIndicator.parentNode.removeChild(this.elements.toolIndicator);
    }

    const styles = document.getElementById('debug-ui-styles');
    if (styles) {
      styles.parentNode.removeChild(styles);
    }
  }
}
