// DebugUI.js - Minimalist debug overlay with self-updating display
// Creates a header bar with expandable sections for Scene, Performance, Visual Aids, and Entities

import { DEBUG_FLAGS } from "./DebugFlags.js";
import { Transform } from "../components/Transform.js";
import { Mouse } from "./Mouse.js";

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
    this.isMouseDown = false;
    this.lastSpawnTime = 0;
    this.spawnThrottleMs = 50; // Minimum ms between spawns while painting

    // Inject styles and create UI
    this._injectStyles();
    this._createUI();
    this._setupKeyboardShortcuts();
    this._setupCanvasMouseHandlers();
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

    this._updateVisualAidsState();
    this._updateScenePanel();
    this._autoGenerateEntityTools();
    this.start();
  }

  /**
   * Detach from scene (called by GameEngine before scene unloads)
   */
  detach() {
    this.stop();
    this.activeSpawnerType = null;
    this.eraserActive = false;
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
    this._updateToolButtonStates();
  }

  // ========================================
  // PERFORMANCE SECTION
  // ========================================

  _updatePerformanceSection() {
    const scene = this.scene;
    if (!scene) return;

    // Main thread FPS
    if (this.elements.mainFPS && scene.mainFPS !== undefined) {
      this.elements.mainFPS.textContent = `Main: ${scene.mainFPS.toFixed(1)}`;
    }

    // Worker stats from scene.workerStats
    const ws = scene.workerStats;
    if (!ws) return;

    if (this.elements.spatialFPS && ws.spatial) {
      this.elements.spatialFPS.textContent = `Spatial: ${ws.spatial.fps}`;
    }

    // Logic workers (dynamic count)
    if (ws.logic && this.elements.logicFPS) {
      const logicTexts = ws.logic.map((l, i) => `L${i}: ${l.fps}`);
      this.elements.logicFPS.textContent = logicTexts.join(" | ");
    }

    if (this.elements.physicsFPS && ws.physics) {
      this.elements.physicsFPS.textContent = `Physics: ${ws.physics.fps}`;
    }

    if (this.elements.rendererFPS && ws.renderer) {
      const r = ws.renderer;
      this.elements.rendererFPS.textContent = `Render: ${r.fps} (${
        r.drawCalls || 0
      } draws)`;
    }

    if (this.elements.particleFPS && ws.particle) {
      const p = ws.particle;
      this.elements.particleFPS.textContent = `Particle: ${p.fps} (${
        p.active || 0
      }/${p.total || 0})`;
    }

    // Job stealing stats
    if (this.elements.jobStealing && scene.mainThreadHelper) {
      const stats = scene.mainThreadHelper.getStats();
      if (stats && scene.mainThreadHelper.enabled) {
        this.elements.jobStealing.textContent = `Jobs: ${stats.jobsThisFrame} (${stats.entitiesThisFrame} entities)`;
        this.elements.jobStealing.style.display = "";
      } else {
        this.elements.jobStealing.style.display = "none";
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
      trail: "showTrail",
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

  _injectStyles() {
    if (document.getElementById("debug-ui-styles")) return;

    const style = document.createElement("style");
    style.id = "debug-ui-styles";
    style.textContent = `
      .debug-ui {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        z-index: 10000;
        font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
        font-size: 14px;
        user-select: none;
      }

      .debug-ui-header {
        display: flex;
        background: rgba(15, 15, 20, 0.95);
        backdrop-filter: blur(12px);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        height: 32px;
      }

      .debug-ui-tab {
        padding: 0 16px;
        height: 32px;
        display: flex;
        align-items: center;
        gap: 6px;
        color: rgba(255, 255, 255, 0.6);
        cursor: pointer;
        border-right: 1px solid rgba(255, 255, 255, 0.05);
        transition: all 0.15s ease;
      }

      .debug-ui-tab:hover {
        background: rgba(255, 255, 255, 0.05);
        color: rgba(255, 255, 255, 0.9);
      }

      .debug-ui-tab.active {
        background: rgba(255, 255, 255, 0.08);
        color: #4ade80;
      }

      .debug-ui-tab .icon {
        font-size: 12px;
      }

      .debug-ui-tab .arrow {
        font-size: 8px;
        transition: transform 0.2s ease;
      }

      .debug-ui-tab.active .arrow {
        transform: rotate(180deg);
      }

      .debug-ui-spacer {
        flex: 1;
      }

      .debug-ui-toggle {
        padding: 0 12px;
        color: rgba(255, 255, 255, 0.4);
        display: flex;
        align-items: center;
        cursor: pointer;
        font-size: 10px;
      }

      .debug-ui-toggle:hover {
        color: rgba(255, 255, 255, 0.8);
      }

      .debug-ui-panel {
        background: rgba(15, 15, 20, 0.95);
        backdrop-filter: blur(12px);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        padding: 12px 16px;
        display: none;
        animation: slideDown 0.15s ease;
      }

      .debug-ui-panel.open {
        display: block;
      }

      @keyframes slideDown {
        from {
          opacity: 0;
          transform: translateY(-8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .debug-ui-row {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: center;
      }

      .debug-ui-stat {
        color: rgba(255, 255, 255, 0.7);
      }

      .debug-ui-stat.main { color: #4ade80; }
      .debug-ui-stat.spatial { color: #a78bfa; }
      .debug-ui-stat.logic { color: #f87171; }
      .debug-ui-stat.physics { color: #22d3d3; }
      .debug-ui-stat.renderer { color: #fbbf24; }
      .debug-ui-stat.particle { color: #fb923c; }
      .debug-ui-stat.jobs { color: #818cf8; }

      .debug-ui-btn {
        padding: 4px 10px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.7);
        cursor: pointer;
        font-family: inherit;
        font-size: 10px;
        transition: all 0.15s ease;
      }

      .debug-ui-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        border-color: rgba(255, 255, 255, 0.2);
        color: white;
      }

      .debug-ui-btn.active {
        background: rgba(74, 222, 128, 0.2);
        border-color: rgba(74, 222, 128, 0.4);
        color: #4ade80;
      }

      .debug-ui-btn.danger {
        background: rgba(248, 113, 113, 0.15);
        border-color: rgba(248, 113, 113, 0.3);
      }

      .debug-ui-btn.danger:hover {
        background: rgba(248, 113, 113, 0.25);
      }

      .debug-ui-btn.danger.active {
        background: rgba(248, 113, 113, 0.3);
        border-color: rgba(248, 113, 113, 0.5);
        color: #f87171;
      }

      .debug-ui-btn.tool {
        background: rgba(99, 102, 241, 0.15);
        border-color: rgba(99, 102, 241, 0.3);
      }

      .debug-ui-btn.tool:hover {
        background: rgba(99, 102, 241, 0.25);
      }

      .debug-ui-btn.tool.active {
        background: rgba(99, 102, 241, 0.3);
        border-color: rgba(99, 102, 241, 0.5);
        color: #818cf8;
      }

      .debug-ui-btn.scene-btn {
        background: rgba(251, 191, 36, 0.15);
        border-color: rgba(251, 191, 36, 0.3);
      }

      .debug-ui-btn.scene-btn:hover {
        background: rgba(251, 191, 36, 0.25);
      }

      .debug-ui-btn.scene-btn.active {
        background: rgba(251, 191, 36, 0.3);
        border-color: rgba(251, 191, 36, 0.5);
        color: #fbbf24;
      }

      .debug-ui-section-title {
        color: rgba(255, 255, 255, 0.4);
        font-size: 9px;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 8px;
      }

      .debug-ui-divider {
        width: 1px;
        height: 16px;
        background: rgba(255, 255, 255, 0.1);
        margin: 0 8px;
      }

      .debug-ui.hidden .debug-ui-header {
        opacity: 0.3;
      }

      .debug-ui.hidden .debug-ui-panel {
        display: none !important;
      }

      .debug-ui-tool-indicator {
        position: fixed;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(15, 15, 20, 0.95);
        backdrop-filter: blur(12px);
        padding: 8px 16px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: rgba(255, 255, 255, 0.9);
        font-size: 12px;
        z-index: 10001;
        pointer-events: none;
        display: none;
      }

      .debug-ui-tool-indicator.visible {
        display: block;
      }

      .debug-ui-tool-indicator.spawner {
        border-color: rgba(99, 102, 241, 0.5);
        color: #818cf8;
      }

      .debug-ui-tool-indicator.eraser {
        border-color: rgba(248, 113, 113, 0.5);
        color: #f87171;
      }
    `;
    document.head.appendChild(style);
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

    const row = document.createElement("div");
    row.className = "debug-ui-row";

    // Create stat elements
    this.elements.mainFPS = this._createStat("Main: --", "main");
    this.elements.spatialFPS = this._createStat("Spatial: --", "spatial");
    this.elements.logicFPS = this._createStat("Logic: --", "logic");
    this.elements.physicsFPS = this._createStat("Physics: --", "physics");
    this.elements.rendererFPS = this._createStat("Render: --", "renderer");
    this.elements.particleFPS = this._createStat("Particle: --", "particle");
    this.elements.jobStealing = this._createStat("Jobs: --", "jobs");
    this.elements.jobStealing.style.display = "none";

    row.appendChild(this.elements.mainFPS);
    row.appendChild(this._createDivider());
    row.appendChild(this.elements.spatialFPS);
    row.appendChild(this.elements.logicFPS);
    row.appendChild(this.elements.physicsFPS);
    row.appendChild(this._createDivider());
    row.appendChild(this.elements.rendererFPS);
    row.appendChild(this.elements.particleFPS);
    row.appendChild(this.elements.jobStealing);

    panel.appendChild(row);
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
      { key: "trail", label: "Trails", shortcut: "7" },
      { key: "entityIndices", label: "Indices", shortcut: "8" },
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

  _createToolIndicator() {
    this.elements.toolIndicator = document.createElement("div");
    this.elements.toolIndicator.className = "debug-ui-tool-indicator";
    document.body.appendChild(this.elements.toolIndicator);
  }

  _updateToolIndicator() {
    const indicator = this.elements.toolIndicator;
    if (!indicator) return;

    if (this.activeSpawnerType) {
      indicator.textContent = `🎨 Painting: ${this.activeSpawnerType} (click & drag to spawn)`;
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
    this._updateToolButtonStates();
    this._updateToolIndicator();
  }

  _toggleEraser() {
    this.eraserActive = !this.eraserActive;
    if (this.eraserActive) {
      this.activeSpawnerType = null;
    }
    this._updateToolButtonStates();
    this._updateToolIndicator();
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

  // ========================================
  // CANVAS MOUSE HANDLERS (for painting)
  // ========================================

  _setupCanvasMouseHandlers() {
    // We need to attach to the canvas, but it might not exist yet
    // So we use event delegation on the document
    this._canvasMouseDown = (e) => {
      if (!this.gameEngine?.canvas) return;
      if (e.target !== this.gameEngine.canvas) return;
      if (!this.activeSpawnerType && !this.eraserActive) return;

      this.isMouseDown = true;
      this._handlePaintAction();
    };

    this._canvasMouseUp = () => {
      this.isMouseDown = false;
    };

    this._canvasMouseMove = (e) => {
      if (!this.isMouseDown) return;
      if (!this.gameEngine?.canvas) return;
      if (e.target !== this.gameEngine.canvas) return;
      if (!this.activeSpawnerType && !this.eraserActive) return;

      this._handlePaintAction();
    };

    document.addEventListener("mousedown", this._canvasMouseDown);
    document.addEventListener("mouseup", this._canvasMouseUp);
    document.addEventListener("mousemove", this._canvasMouseMove);
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
   */
  _spawnEntityAtMouse(className) {
    if (!this.gameEngine) return;

    if (Mouse.x > 0 && Mouse.y > 0) {
      this.gameEngine.spawnEntity(className, {
        x: Mouse.x,
        y: Mouse.y,
        vx: 0,
        vy: 0,
      });
    }
  }

  /**
   * Despawn entity nearest to mouse position
   */
  _despawnEntityAtMouse() {
    if (!this.scene || !this.gameEngine) return;
    if (Mouse.x <= 0 || Mouse.y <= 0) return;

    const eraserRadius = 50; // Pixels
    const internalEntities = new Set(["Mouse", "Flash"]);

    // Find the nearest active entity within eraser radius
    let nearestIndex = -1;
    let nearestDist = eraserRadius;

    const total = this.scene.totalEntityCount || 0;
    for (let i = 0; i < total; i++) {
      if (!Transform.active[i]) continue;

      // Skip internal entities
      const entityType = Transform.entityType[i];
      const reg = this.scene.registeredClasses.find(
        (r) => r.entityType === entityType
      );
      if (reg && internalEntities.has(reg.class.name)) continue;

      const dx = Transform.x[i] - Mouse.x;
      const dy = Transform.y[i] - Mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIndex = i;
      }
    }

    if (nearestIndex >= 0) {
      // Despawn the entity by setting it inactive
      Transform.active[nearestIndex] = 0;
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
        this._updateToolButtonStates();
        this._updateToolIndicator();
      } else if (key >= "1" && key <= "8") {
        const keyMap = {
          1: "colliders",
          2: "velocity",
          3: "acceleration",
          4: "neighbors",
          5: "spatialGrid",
          6: "aabb",
          7: "trail",
          8: "entityIndices",
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

    if (this._canvasMouseDown) {
      document.removeEventListener("mousedown", this._canvasMouseDown);
    }
    if (this._canvasMouseUp) {
      document.removeEventListener("mouseup", this._canvasMouseUp);
    }
    if (this._canvasMouseMove) {
      document.removeEventListener("mousemove", this._canvasMouseMove);
    }

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
