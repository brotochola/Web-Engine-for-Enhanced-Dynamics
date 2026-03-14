// DebugUI.js — Thin orchestrator that wires panels, tools, stats, and canvas together
// All heavy logic lives in src/core/debug/ sub-modules.
//
// Static draw API (DebugUI.drawLine, etc.) delegates to DebugDraw so game scripts
// can call DebugUI.drawLine(...) from any worker or the main thread.

import { injectStyles, createTab } from './ui/DebugDOM.js';
import { StatsCollector } from './stats/StatsCollector.js';
import { DebugCanvas } from './rendering/DebugCanvas.js';
import { ToolManager } from './tools/ToolManager.js';
import { DebugDraw } from './DebugDraw.js';

// Panels
import { ScenePanel } from './panels/ScenePanel.js';
import { PerformancePanel } from './panels/PerformancePanel.js';
import { VisualAidsPanel } from './panels/VisualAidsPanel.js';
import { EntitiesPanel } from './panels/EntitiesPanel.js';
import { DecorationsPanel } from './panels/DecorationsPanel.js';
import { LayersPanel } from './panels/LayersPanel.js';
import { NavigationPanel } from './panels/NavigationPanel.js';

/**
 * DebugUI — Self-contained debug overlay managed by GameEngine.
 * Orchestrates panels, tools, stats, and a debug canvas overlay.
 */
export class DebugUI {
  constructor(options = {}) {
    this.scene = null;
    this.debugFlags = null;
    this.gameEngine = null;

    this.updateInterval = options.updateInterval || 100;
    this._rafId = null;
    this._lastTickTime = 0;

    // Section accordion state
    this.openSection = options.defaultOpen || null;
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
      visual: new VisualAidsPanel(this),
      entities: new EntitiesPanel(this),
      decorations: new DecorationsPanel(this),
      layers: new LayersPanel(this),
      navigation: new NavigationPanel(this),
    };

    // Build DOM
    injectStyles();
    this._createUI();
    this._setupKeyboardShortcuts();
    this.tools.init();
  }

  // ========================================
  // PUBLIC API (called by GameEngine)
  // ========================================

  registerScenes(scenes) {
    this.registeredScenes = scenes;
    this.panels.scene.updateSceneList();
  }

  attach(gameEngine, scene) {
    this.gameEngine = gameEngine;
    this.scene = scene;
    this.debugFlags = scene.debugFlags;

    if (this.debugFlags) this.debugFlags.disableAll();

    this.stats.attach(scene);
    this.canvas.attach(scene);
    this.tools.attach();

    for (const panel of Object.values(this.panels)) {
      panel.attach();
    }

    this.start();
  }

  detach() {
    this.stop();
    this.canvas.detach();
    this.tools.attach(); // resets tool state
    this.stats.detach();
    this.scene = null;
    this.debugFlags = null;
  }

  start() {
    if (this._rafId) return;
    this._lastTickTime = 0;

    const loop = (time) => {
      if (time - this._lastTickTime >= this.updateInterval) {
        this._lastTickTime = time;
        this._tick();
      }
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  toggle() { this.container.classList.toggle('hidden'); }
  show() { this.container.classList.remove('hidden'); }
  hide() { this.container.classList.add('hidden'); }

  destroy() {
    this.stop();
    this.canvas.destroy();
    this.tools.destroy();

    if (this._keyHandler) window.removeEventListener('keydown', this._keyHandler);

    if (this.container?.parentNode) this.container.parentNode.removeChild(this.container);

    const styles = document.getElementById('debug-ui-styles');
    if (styles?.parentNode) styles.parentNode.removeChild(styles);
  }

  // ========================================
  // TICK
  // ========================================

  _tick() {
    if (!this.scene) return;

    for (const panel of Object.values(this.panels)) {
      panel.update();
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
      ['👁', 'Visual', 'visual'],
      ['📦', 'Entities', 'entities'],
      ['🌿', 'Decorations', 'decorations'],
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
    toggleHint.textContent = '[H] Toggle';
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

  _toggleSection(sectionId) {
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
    } else {
      this.openSection = null;
      if (sectionId === 'navigation') this.panels.navigation.onClose();
    }
  }

  // ========================================
  // KEYBOARD SHORTCUTS
  // ========================================

  _setupKeyboardShortcuts() {
    this._keyHandler = (e) => {

      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        this.tools.deactivateAll();
        return;
      }

      if (!e.shiftKey) return;

      const key = e.key.toLowerCase();

      if (key === 'h') {
        e.preventDefault();
        this.toggle();
      } else if (key === 'i') {
        e.preventDefault();
        this.tools.toggleInspector();
      } else if (e.code >= 'Digit1' && e.code <= 'Digit8') {
        e.preventDefault();
        const digit = e.code.charAt(5);
        const map = { 1: 'colliders', 2: 'velocity', 3: 'acceleration', 4: 'neighbors', 5: 'spatialGrid', 6: 'entityIndices', 7: 'debugDraws', 8: 'sleepingEntities' };
        this.panels.visual.toggleVisualAid(map[digit]);
      } else if (key === 'k') {
        e.preventDefault();
        this.panels.visual.toggleVisualAid('constraints');
      } else if (key === 'c') {
        e.preventDefault();
        this.panels.visual.toggleVisualAid('collisionCandidates');
      } else if (key === 'o') {
        e.preventDefault();
        this.panels.visual.toggleVisualAid('entityOrigins');
      } else if (e.code === 'Digit0') {
        e.preventDefault();
        if (this.debugFlags) {
          this.debugFlags.disableAll();
          this.panels.visual.updateState();
          this.canvas.syncLoop();
        }
      }
    };

    window.addEventListener('keydown', this._keyHandler);
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
