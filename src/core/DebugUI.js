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

/**
 * DebugUI - Self-contained debug overlay that pulls data and updates itself
 * Managed by GameEngine, attaches/detaches when scenes change
 */
export class DebugUI {
  constructor(options = {}) {
    this.scene = null;
    this.debugFlags = null;
    this.gameEngine = null;

    this.updateInterval = options.updateInterval || 100; // ms
    this.intervalId = null;

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
      statCell.className = "debug-ui-worker-cell stat";
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
   * Start the self-update loop
   */
  start() {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this._tick(), this.updateInterval);
  }

  /**
   * Stop the update loop
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Main update loop - pulls all data and updates UI
   */
  _tick() {
    if (!this.scene) return;

    this._updatePerformanceSection();
    this._updateEntitiesSection();
    this._updateDecorationsSection();
    this._updateToolButtonStates();
    this._updatePaintTool();
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

    // Main thread FPS
    if (this.elements.mainFPS && scene.mainFPS !== undefined) {
      this.elements.mainFPS.textContent = `Main: ${scene.mainFPS.toFixed(2)}`;
    }

    // Job stealing stats
    if (
      this.elements.jobStealing &&
      this.elements.jobStealingRow &&
      scene.mainThreadHelper
    ) {
      const stats = scene.mainThreadHelper.getStats();
      if (stats && scene.mainThreadHelper.enabled) {
        this.elements.jobStealing.textContent = `Jobs: ${stats.jobsThisFrame} (${stats.entitiesThisFrame} entities)`;
        this.elements.jobStealingRow.style.display = "";
      } else {
        this.elements.jobStealingRow.style.display = "none";
      }
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
   * Update stats for a single worker
   * @param {string} workerType - Type of worker (renderer, particle, physics)
   * @param {Object} statsSchema - Stats schema object
   */
  _updateSingleWorkerStats(workerType, statsSchema) {
    const view = this.workerStatViews[workerType];
    if (!view) return;

    const elements = this.elements.workerStats?.[workerType]?.[0];
    if (!elements) return;

    const config = WORKER_DISPLAY_CONFIG[workerType];

    for (const stat of config.stats) {
      const statIndex = statsSchema[stat.key];
      let rawValue = view[statIndex];

      // Smooth FPS values
      // if (stat.key === "FPS") {
      //   rawValue = this._smoothFPS(rawValue, this.fpsSmoothing[workerType]);
      // }

      const formattedValue = stat.format(rawValue);
      elements[stat.key].textContent = `${stat.key}: ${formattedValue}`;
    }
  }

  /**
   * Update stats for multi-workers
   * @param {string} workerType - Type of worker (spatial, logic)
   * @param {Object} statsSchema - Stats schema object
   */
  _updateMultiWorkerStats(workerType, statsSchema) {
    const views = this.workerStatViews[workerType];
    if (!views || views.length === 0) return;

    const workerElements = this.elements.workerStats?.[workerType];
    if (!workerElements) return;

    const config = WORKER_DISPLAY_CONFIG[workerType];

    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      const elements = workerElements[i];
      if (!elements) continue;

      for (const stat of config.stats) {
        const statIndex = statsSchema[stat.key];
        let rawValue = view[statIndex];

        // Smooth FPS values
        if (stat.key === "FPS") {
          rawValue = this._smoothFPS(
            rawValue,
            this.fpsSmoothing[workerType][i]
          );
        }

        const formattedValue = stat.format(rawValue);
        elements[stat.key].textContent = `${stat.key}: ${formattedValue}`;
      }
    }
  }

  // ========================================
  // ENTITIES SECTION
  // ========================================

  _updateEntitiesSection() {
    const scene = this.scene;
    if (!scene) return;

    // Count active entities from Transform arrays
    if (this.elements.activeCount && Transform.active) {
      let active = 0;
      const total = scene.totalEntityCount || 0;
      for (let i = 0; i < total; i++) {
        if (Transform.active[i]) active++;
      }
      this.elements.activeCount.textContent = `Active: ${active}/${total}`;
    }

    // Visible units (from renderer stats)
    if (this.elements.visibleCount && scene.workerStats?.renderer) {
      const visible =
        (scene.workerStats.renderer.visibleEntities || 0) +
        (scene.workerStats.renderer.visibleParticles || 0);
      this.elements.visibleCount.textContent = `Visible: ${visible}`;
    }

    // Pool stats
    if (this.elements.poolStats && this.gameEngine) {
      const poolTexts = [];
      const internalEntities = new Set(["Mouse", "Flash"]);
      for (const reg of scene.registeredClasses || []) {
        if (internalEntities.has(reg.class.name)) continue;
        const stats = this.gameEngine.getPoolStats(reg.class);
        if (stats && stats.total > 0) {
          poolTexts.push(`${reg.class.name}: ${stats.active}/${stats.total}`);
        }
      }
      if (poolTexts.length > 0) {
        this.elements.poolStats.textContent = poolTexts.join(" | ");
      }
    }
  }

  // ========================================
  // DECORATIONS SECTION
  // ========================================

  _updateDecorationsSection() {
    const scene = this.scene;
    if (!scene) return;

    // Total decoration pool size
    if (this.elements.decorationTotal) {
      const total = DecorationPool.maxDecorations || 0;
      this.elements.decorationTotal.textContent = `Total: ${total}`;
    }

    // Count active decorations
    if (this.elements.decorationActive && DecorationComponent.active) {
      let active = 0;
      const total = DecorationPool.maxDecorations || 0;
      for (let i = 0; i < total; i++) {
        if (DecorationComponent.active[i]) active++;
      }
      this.elements.decorationActive.textContent = `Active: ${active}`;
    }

    // Count visible decorations (on screen)
    if (this.elements.decorationVisible && DecorationComponent.isItOnScreen) {
      let visible = 0;
      const total = DecorationPool.maxDecorations || 0;
      for (let i = 0; i < total; i++) {
        if (
          DecorationComponent.active[i] &&
          DecorationComponent.isItOnScreen[i]
        ) {
          visible++;
        }
      }
      this.elements.decorationVisible.textContent = `Visible: ${visible}`;
    }

    // PIXI sprites created (from renderer worker stat buffer)
    if (this.elements.decorationSprites && this.workerStatViews?.renderer) {
      const spriteCount =
        this.workerStatViews.renderer[RENDERER_STATS.DECORATION_SPRITES];
      this.elements.decorationSprites.textContent = `Sprites: ${spriteCount}`;
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
    container.style.gap = "8px";

    // Main thread FPS row
    const mainRow = document.createElement("div");
    mainRow.className = "debug-ui-row";
    this.elements.mainFPS = this._createStat("Main: --", "main");
    mainRow.appendChild(this.elements.mainFPS);
    container.appendChild(mainRow);

    // Job stealing stats (shown when enabled)
    const jobRow = document.createElement("div");
    jobRow.className = "debug-ui-row";
    this.elements.jobStealing = this._createStat("Jobs: --", "jobs");
    this.elements.jobStealing.style.display = "none";
    jobRow.appendChild(this.elements.jobStealing);
    jobRow.style.display = "none";
    this.elements.jobStealingRow = jobRow;
    container.appendChild(jobRow);

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

    // Generate painter button for each entity type
    for (const reg of spawnableClasses) {
      const className = reg.class.name;

      const btn = document.createElement("button");
      btn.className = "debug-ui-btn tool";
      btn.textContent = `🎨 ${className}`;
      btn.title = `Toggle ${className} painter (click & drag on canvas to spawn)`;
      btn.onclick = () => this._toggleSpawner(className);
      this.elements.spawnerButtons[className] = btn;
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
    // Update spawner buttons
    for (const [className, btn] of Object.entries(
      this.elements.spawnerButtons || {}
    )) {
      btn.classList.toggle("active", this.activeSpawnerType === className);
    }

    // Update eraser button
    if (this.elements.eraserButton) {
      this.elements.eraserButton.classList.toggle("active", this.eraserActive);
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
