// DebugUI.js — Thin orchestrator that wires panels, tools, stats, and canvas together
// All heavy logic lives in src/core/debug/ sub-modules.
//
// Static draw API (DebugUI.drawLine, etc.) delegates to DebugDraw so game scripts
// can call DebugUI.drawLine(...) from any worker or the main thread.

import { injectStyles, createTab } from './ui/debugDom.js';
import { StatsCollector } from './stats/statsCollector.js';
import { DebugCanvas } from './rendering/debugCanvas.js';
import { ToolManager } from './tools/toolManager.js';
import { DebugDraw } from './debugDraw.js';
import { DEBUG_DEFAULTS } from '../../util/configDefaults.js';

// Panels
import { ScenePanel } from './panels/scenePanel.js';
import { PerformancePanel } from './panels/performancePanel.js';
import { VisualAidsPanel } from './panels/visualAidsPanel.js';
import { EntitiesPanel } from './panels/entitiesPanel.js';
import { PoolsPanel } from './panels/poolsPanel.js';
import { LayersPanel } from './panels/layersPanel.js';
import { NavigationPanel } from './panels/navigationPanel.js';
import { MemoryPanel } from './panels/memoryPanel.js';
import { SavesPanel } from './panels/savesPanel.js';

/**
 * DebugUI — Self-contained debug overlay managed by GameEngine.
 * Orchestrates panels, tools, stats, and a debug canvas overlay.
 */
export class DebugUI {
  constructor(options = {}) {
    this.scene = null;
    this.debugFlags = null;
    this.gameEngine = null;
    this.caps = {
      physics: true,
      spatial: true,
      particles: false,
      bullets: false,
      nav: false,
      lighting: false,
      joints: false,
    };

    this.updateInterval = options.updateInterval ?? DEBUG_DEFAULTS.updateInterval;
    this._rafId = null;
    this._lastTickTime = 0;

    // Section accordion state
    this.openSection = options.defaultOpen ?? DEBUG_DEFAULTS.defaultOpen;
    this.sections = {};

    // Registered scenes for the scene-switcher panel
    this.registeredScenes = [];

    // DOM root
    this.container = null;

    // Sub-systems
    this.stats = new StatsCollector();
    this.canvas = new DebugCanvas(this);
    this.tools = new ToolManager(this);

    // Panels (keyed by section id for the accordion)
    this.panels = {
      scene: new ScenePanel(this),
      performance: new PerformancePanel(this),
      memory: new MemoryPanel(this),
      saves: new SavesPanel(this),
      visual: new VisualAidsPanel(this),
      entities: new EntitiesPanel(this),
      pools: new PoolsPanel(this),
      layers: new LayersPanel(this),
      navigation: new NavigationPanel(this),
    };
    this._panelList = [
      this.panels.scene,
      this.panels.performance,
      this.panels.memory,
      this.panels.saves,
      this.panels.visual,
      this.panels.entities,
      this.panels.pools,
      this.panels.layers,
      this.panels.navigation,
    ];

    // Build DOM
    injectStyles();
    this._createUI();
    this.tools.init();
  }

  // ========================================
  // PUBLIC API (called by GameEngine)
  // ========================================

  /**
   * Scene switcher entries. Each row is `{ name, class }` or `{ name, load }`.
   * `load` should return a Scene class; the first resolve caches it on `class`.
   * @param {{ name: string, class?: Function, load?: () => Promise<Function>|Function }[]} scenes
   */
  registerScenes(scenes) {
    this.registeredScenes = scenes;
    this.panels.scene.updateSceneList();
  }

  attach(gameEngine, scene) {
    this.gameEngine = gameEngine;
    this.scene = scene;
    this.debugFlags = scene.debugFlags;
    this.refreshCaps();

    if (this.debugFlags) {
      this.debugFlags.disableAll();
      this.debugFlags.showDebugDraws(true);
    }

    this.stats.attach(scene);
    this.canvas.attach(scene);
    this.tools.attach();

    const list = this._panelList;
    for (let i = 0; i < list.length; i++) list[i].attach();

    this.canvas.syncLoop();
    this.start();
  }

  detach() {
    this.stop();
    this.canvas.detach();
    this.tools.attach(); // resets tool state
    this.stats.detach();
    this.scene = null;
    this.debugFlags = null;
    this.refreshCaps();
  }

  start() {
    if (this._rafId) return;
    this._lastTickTime = 0;

    const loop = (time) => {
      if (!this._needsTick()) {
        this._rafId = null;
        return;
      }
      if (time - this._lastTickTime >= this.updateInterval) {
        this._lastTickTime = time;
        this._tick();
      }
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  /** True while panel/tool updates are needed (overlay visible or active tools). */
  _needsTick() {
    if (!this.scene) return false;
    if (!this.container?.classList.contains('hidden')) return true;
    const tools = this.tools;
    return !!(
      tools.inspectorActive ||
      tools.activeSpawnerType ||
      tools.eraserActive ||
      tools.poolPaintKind ||
      tools.poolEraserKind
    );
  }

  /** Restart the RAF loop after hide/toggle if work resumed. */
  _ensureTickLoop() {
    if (this._needsTick() && !this._rafId) {
      this.start();
    }
  }

  stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  toggle() {
    this.container.classList.toggle('hidden');
    this._ensureTickLoop();
  }
  show() {
    this.container.classList.remove('hidden');
    this._ensureTickLoop();
  }
  hide() {
    this.container.classList.add('hidden');
  }

  destroy() {
    this.stop();
    this.canvas.destroy();
    this.tools.destroy();

    if (this.container?.parentNode) this.container.parentNode.removeChild(this.container);

    const styles = document.getElementById('debug-ui-styles');
    if (styles?.parentNode) styles.parentNode.removeChild(styles);
  }

  // ========================================
  // TICK
  // ========================================

  _tick() {
    if (!this.scene) return;

    if (this.openSection && !this.container?.classList.contains('hidden')) {
      this.panels[this.openSection].update();
    }

    this.tools.update();
  }

  // ========================================
  // UI SHELL (header tabs + section accordion)
  // ========================================

  _createUI() {
    this.container = document.createElement('div');
    this.container.className = 'debug-ui';

    const header = document.createElement('div');
    header.className = 'debug-ui-header';

    const tabDefs = [
      ['🎬', 'Scene', 'scene'],
      ['⚡', 'Performance', 'performance'],
      ['💾', 'Memory', 'memory'],
      ['💿', 'Saves', 'saves'],
      ['👁', 'Visual', 'visual'],
      ['📦', 'Entities', 'entities'],
      ['🌿', 'Pools', 'pools'],
      ['📚', 'Layers', 'layers'],
      ['🧭', 'Nav', 'navigation'],
    ];

    for (const [icon, label, id] of tabDefs) {
      const tab = createTab(icon, label, id, (sid) => this._toggleSection(sid));
      header.appendChild(tab);
      this.sections[id] = { tab };
    }

    // Spacer
    const spacer = document.createElement('div');
    spacer.className = 'debug-ui-spacer';
    header.appendChild(spacer);

    // Toggle hint
    const toggleHint = document.createElement('div');
    toggleHint.className = 'debug-ui-toggle';
    toggleHint.textContent = 'Hide';
    toggleHint.onclick = () => this.toggle();
    header.appendChild(toggleHint);

    this.container.appendChild(header);

    // Create & attach each panel's DOM
    for (const [id, panel] of Object.entries(this.panels)) {
      const panelEl = panel.create();
      this.container.appendChild(panelEl);
      this.sections[id].panel = panelEl;
    }

    document.body.appendChild(this.container);
  }

  refreshCaps() {
    const s = this.scene;
    const cfg = s?.config;
    const physics = !!(s && s._physicsEnabled);
    this.caps = {
      physics,
      spatial: !!(s && (s.numberOfSpatialWorkers | 0) > 0),
      particles: (cfg?.particle?.maxParticles | 0) > 0,
      bullets: (cfg?.bullet?.maxBullets | 0) > 0,
      nav: !!cfg?.navigation?.enabled,
      lighting: cfg?.lighting?.enabled === true,
      joints: physics && (cfg?.physics?.maxJoints | 0) > 0,
    };
    this._applyNavTabCap();
  }

  _applyNavTabCap() {
    const tab = this.sections?.navigation?.tab;
    if (!tab) return;
    const on = this.caps.nav;
    tab.classList.toggle('disabled', !on);
    tab.title = on ? '' : 'Requires config.navigation.enabled';
    if (!on && this.openSection === 'navigation') {
      this.openSection = null;
      tab.classList.remove('active');
      if (this.sections.navigation.panel) this.sections.navigation.panel.classList.remove('open');
      this.panels.navigation.onClose?.();
    }
  }

  _toggleSection(sectionId) {
    if (sectionId === 'navigation' && !this.caps.nav) return;
    const wasOpen = this.openSection === sectionId;

    // Close all
    for (const [, section] of Object.entries(this.sections)) {
      section.tab.classList.remove('active');
      if (section.panel) section.panel.classList.remove('open');
    }

    if (!wasOpen) {
      this.openSection = sectionId;
      this.sections[sectionId].tab.classList.add('active');
      if (this.sections[sectionId].panel) this.sections[sectionId].panel.classList.add('open');

      if (sectionId === 'navigation') this.panels.navigation.onOpen();
      this.panels[sectionId].update();
    } else {
      this.openSection = null;
      if (sectionId === 'navigation') this.panels.navigation.onClose();
    }
  }

}

// Static draw API — delegates to DebugDraw so the same call works on workers
// (where DebugDraw is imported directly) and on the main thread (via DebugUI).
DebugUI.drawLine      = DebugDraw.drawLine;
DebugUI.drawCircle    = DebugDraw.drawCircle;
DebugUI.drawRect      = DebugDraw.drawRect;
DebugUI.drawText      = DebugDraw.drawText;
DebugUI.drawPoint     = DebugDraw.drawPoint;
DebugUI.highlightCell = DebugDraw.highlightCell;
