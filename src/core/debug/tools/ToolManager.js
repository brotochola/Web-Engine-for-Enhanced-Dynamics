// ToolManager.js — Manages painter, eraser, and inspector tools

import { Mouse } from '../../Mouse.js';
import { Transform } from '../../../components/Transform.js';
import { Grid } from '../../Grid.js';
import {
  distanceSq2D,
  getComponentColor,
  getComponentPropertyNames,
  formatComponentValue,
} from '../../utils.js';

/**
 * Unified manager for all debug tools: paint / erase / inspect.
 * Handles mouse event wiring, tool state, and the inspector side-panel.
 */
export class ToolManager {
  constructor(debugUI) {
    this.debugUI = debugUI;

    // Painter / eraser
    this.activeSpawnerType = null;
    this.eraserActive = false;
    this.bulkSpawnEnabled = false;
    this.lastSpawnTime = 0;
    this.spawnThrottleMs = 50;
    this._toolMouseDown = false;

    // Inspector
    this.inspectorActive = false;
    this.selectedEntityIndex = -1;
    this._inspectorPanelVisible = false;
    this._prevInspectorValues = {};

    // Internal entities that should be skipped
    this._internalEntitiesSet = new Set(['Flash']);

    // DOM references
    this._toolIndicator = null;
    this._inspectorPanel = null;
    this._inspectorEntityInfo = null;
    this._inspectorComponentsContainer = null;
    this._inspectorComponentRows = null;

    // Mouse handlers (store references for cleanup)
    this._onToolMouseDown = null;
    this._onToolMouseUp = null;
  }

  // ------- lifecycle -------

  init() {
    this._createToolIndicator();
    this._setupMouseHandlers();
  }

  attach() {
    this.activeSpawnerType = null;
    this.eraserActive = false;
    this._toolMouseDown = false;
    Mouse.isDebugToolActive = false;

    this.inspectorActive = false;
    this.selectedEntityIndex = -1;
    this._prevInspectorValues = {};
    this._hideInspectorPanel();
    this.updateToolIndicator();
  }

  update() {
    this._updatePaintTool();
    this._updateInspectorValues();
  }

  destroy() {
    Mouse.isDebugToolActive = false;
    if (this._onToolMouseDown) document.removeEventListener('mousedown', this._onToolMouseDown, true);
    if (this._onToolMouseUp) document.removeEventListener('mouseup', this._onToolMouseUp, true);
    if (this._toolIndicator?.parentNode) this._toolIndicator.parentNode.removeChild(this._toolIndicator);
    if (this._inspectorPanel?.parentNode) this._inspectorPanel.parentNode.removeChild(this._inspectorPanel);
  }

  // ------- toggling tools -------

  toggleSpawner(className) {
    if (this.activeSpawnerType === className) {
      this.activeSpawnerType = null;
    } else {
      this.activeSpawnerType = className;
      this.eraserActive = false;
      this.inspectorActive = false;
    }
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this.debugUI.panels.visual?.updateInspectorButtonState(this.inspectorActive);
  }

  toggleEraser() {
    this.eraserActive = !this.eraserActive;
    if (this.eraserActive) {
      this.activeSpawnerType = null;
      this.inspectorActive = false;
    }
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this.debugUI.panels.visual?.updateInspectorButtonState(this.inspectorActive);
  }

  toggleInspector() {
    this.inspectorActive = !this.inspectorActive;
    if (this.inspectorActive) {
      this.activeSpawnerType = null;
      this.eraserActive = false;
    }
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this.debugUI.panels.visual?.updateInspectorButtonState(this.inspectorActive);
  }

  deactivateAll() {
    this.activeSpawnerType = null;
    this.eraserActive = false;
    this.inspectorActive = false;
    this._toolMouseDown = false;
    this.clearSelection();
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this.debugUI.panels.visual?.updateInspectorButtonState(false);
  }

  // ------- tool indicator bar -------

  _createToolIndicator() {
    this._toolIndicator = document.createElement('div');
    this._toolIndicator.className = 'debug-ui-tool-indicator';
    document.body.appendChild(this._toolIndicator);
  }

  updateToolIndicator() {
    const el = this._toolIndicator;
    if (!el) return;

    if (this.activeSpawnerType) {
      const bulk = this.bulkSpawnEnabled ? ' ×50' : '';
      el.textContent = `🎨 Painting: ${this.activeSpawnerType}${bulk} (click & drag to spawn)`;
      el.className = 'debug-ui-tool-indicator visible spawner';
    } else if (this.eraserActive) {
      el.textContent = '🧹 Eraser Active (click & drag to despawn)';
      el.className = 'debug-ui-tool-indicator visible eraser';
    } else if (this.inspectorActive) {
      el.textContent = '🔍 Inspector Active (click on an entity to inspect)';
      el.className = 'debug-ui-tool-indicator visible inspector';
    } else {
      el.className = 'debug-ui-tool-indicator';
    }
  }

  // ------- mouse handlers -------

  _setupMouseHandlers() {
    this._onToolMouseDown = (e) => {
      if (e.button !== 0) return;
      if (this.debugUI.container?.contains(e.target)) return;
      if (this._inspectorPanel?.contains(e.target)) return;
      if (this._toolIndicator?.contains(e.target)) return;

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

    document.addEventListener('mousedown', this._onToolMouseDown, true);
    document.addEventListener('mouseup', this._onToolMouseUp, true);
  }

  // ------- paint / erase per tick -------

  _updatePaintTool() {
    if (!this.activeSpawnerType && !this.eraserActive) return;
    if (this._toolMouseDown && Mouse.isPresent) this._handlePaintAction();
  }

  _handlePaintAction() {
    const now = performance.now();
    if (now - this.lastSpawnTime < this.spawnThrottleMs) return;
    this.lastSpawnTime = now;

    if (this.activeSpawnerType) {
      this._spawnEntityAtMouse(this.activeSpawnerType);
    } else if (this.eraserActive) {
      this._despawnEntityAtMouse();
    }
  }

  _spawnEntityAtMouse(className) {
    const engine = this.debugUI.gameEngine;
    if (!engine) return;

    const count = this.bulkSpawnEnabled ? 50 : 1;
    const spread = 30;

    for (let i = 0; i < count; i++) {
      const ox = count > 1 ? (Math.random() - 0.5) * spread * 2 : 0;
      const oy = count > 1 ? (Math.random() - 0.5) * spread * 2 : 0;
      engine.spawnEntity(className, { x: Mouse.x + ox, y: Mouse.y + oy });
    }
  }

  _despawnEntityAtMouse() {
    const scene = this.debugUI.scene;
    if (!scene || !this.debugUI.gameEngine) return;

    const radius = 50;
    const nearest = this._findNearestEntity(Mouse.x, Mouse.y, radius);
    if (nearest >= 0) scene.despawnEntity(nearest);
  }

  // ------- inspector -------

  _selectEntityAtMouse() {
    if (!this.debugUI.scene || !this.inspectorActive) return;

    const selectRadius = 100;
    const nearest = this._findNearestEntity(Mouse.x, Mouse.y, selectRadius);

    if (nearest >= 0) {
      this._selectEntity(nearest);
    } else {
      this.clearSelection();
    }
  }

  _selectEntity(entityIndex) {
    this.selectedEntityIndex = entityIndex;
    const flags = this.debugUI.debugFlags;
    if (flags) flags.setSelectedEntity(entityIndex);
    this.debugUI.canvas.startLoop();
    this._showInspectorPanel();
    this._populateInspectorPanel();
  }

  clearSelection() {
    this.selectedEntityIndex = -1;
    this._prevInspectorValues = {};
    const flags = this.debugUI.debugFlags;
    if (flags) flags.clearSelectedEntity();
    this.debugUI.canvas.syncLoop();
    this._hideInspectorPanel();
  }

  // ------- inspector DOM -------

  _showInspectorPanel() {
    if (!this._inspectorPanel) this._createInspectorPanel();
    this._inspectorPanel.style.display = 'flex';
    this._inspectorPanelVisible = true;
  }

  _hideInspectorPanel() {
    if (this._inspectorPanel) this._inspectorPanel.style.display = 'none';
    this._inspectorPanelVisible = false;
  }

  _createInspectorPanel() {
    const panel = document.createElement('div');
    panel.className = 'debug-ui-inspector-panel';
    panel.style.cssText = `
      position:fixed;left:0;top:78px;width:320px;max-height:calc(100vh - 200px);
      background:rgba(15,15,20,0.95);border-right:2px solid rgba(255,200,100,0.5);
      border-bottom:2px solid rgba(255,200,100,0.3);border-radius:0 0 8px 0;
      overflow-y:auto;overflow-x:hidden;display:none;flex-direction:column;
      font-family:'Consolas','Monaco',monospace;font-size:13px;z-index:10001;
      box-shadow:4px 4px 12px rgba(0,0,0,0.5);
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = `
      padding:10px 12px;background:linear-gradient(135deg,rgba(255,200,100,0.2),rgba(255,150,50,0.1));
      border-bottom:1px solid rgba(255,200,100,0.3);display:flex;justify-content:space-between;
      align-items:center;position:sticky;top:0;z-index:1;
    `;
    const title = document.createElement('span');
    title.style.cssText = 'font-weight:bold;font-size:12px;color:#ffc864';
    title.textContent = '🔍 Entity Inspector';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:rgba(255,100,100,0.3);border:1px solid rgba(255,100,100,0.5);color:#ff8888;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:12px';
    closeBtn.textContent = '✕ Close';
    closeBtn.onclick = () => this.clearSelection();
    header.appendChild(closeBtn);
    panel.appendChild(header);

    this._inspectorEntityInfo = document.createElement('div');
    this._inspectorEntityInfo.style.cssText = 'padding:8px 12px;background:rgba(0,0,0,0.3);border-bottom:1px solid rgba(255,255,255,0.1);color:#aaa';
    panel.appendChild(this._inspectorEntityInfo);

    this._inspectorComponentsContainer = document.createElement('div');
    this._inspectorComponentsContainer.style.cssText = 'padding:8px;display:flex;flex-direction:column;gap:8px';
    panel.appendChild(this._inspectorComponentsContainer);

    document.body.appendChild(panel);
    this._inspectorPanel = panel;
  }

  _populateInspectorPanel() {
    if (this.selectedEntityIndex < 0 || !this.debugUI.scene) return;
    const entityIndex = this.selectedEntityIndex;
    const entityType = Transform.entityType[entityIndex];
    const regInfo = this.debugUI.scene.registeredClasses?.find((r) => r.entityType === entityType);

    if (this._inspectorEntityInfo) {
      const name = regInfo ? regInfo.class.name : 'Unknown';
      this._inspectorEntityInfo.innerHTML = `
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <span style="color:#fff;font-weight:bold;">${name}</span>
          <span style="color:#888;">Index: ${entityIndex}</span>
        </div>
        <div style="color:#666;font-size:12px;">Type ID: ${entityType}</div>
      `;
    }

    const components = regInfo ? regInfo.components : [Transform];
    const container = this._inspectorComponentsContainer;
    if (!container) return;
    container.innerHTML = '';
    this._inspectorComponentRows = {};

    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;
      const color = getComponentColor(componentName);

      const section = document.createElement('div');
      section.style.cssText = `background:rgba(0,0,0,0.3);border:1px solid ${color.css};border-left:3px solid ${color.css};border-radius:4px;overflow:hidden`;

      const header = document.createElement('div');
      header.style.cssText = `padding:6px 8px;background:linear-gradient(90deg,${color.css}22,transparent);color:${color.css};font-weight:bold;font-size:11px;border-bottom:1px solid ${color.css}44`;
      header.textContent = componentName;
      section.appendChild(header);

      const propsContainer = document.createElement('div');
      propsContainer.style.cssText = 'padding:4px 0';

      const propNames = getComponentPropertyNames(ComponentClass);
      this._inspectorComponentRows[componentName] = {};

      for (const propName of propNames) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;padding:2px 8px;border-bottom:1px solid rgba(255,255,255,0.05)';

        const label = document.createElement('span');
        label.style.cssText = 'color:#888;font-size:12px';
        label.textContent = propName;
        row.appendChild(label);

        const value = document.createElement('span');
        value.style.cssText = 'color:#fff;font-size:12px;font-family:monospace';
        value.textContent = '--';
        row.appendChild(value);

        propsContainer.appendChild(row);
        this._inspectorComponentRows[componentName][propName] = value;
      }

      section.appendChild(propsContainer);
      container.appendChild(section);
    }

    this._updateInspectorValues();
  }

  _updateInspectorValues() {
    if (this.selectedEntityIndex < 0 || !this._inspectorPanelVisible) return;
    const entityIndex = this.selectedEntityIndex;

    if (!Transform.active[entityIndex]) {
      this.clearSelection();
      return;
    }

    const rows = this._inspectorComponentRows;
    if (!rows) return;

    const entityType = Transform.entityType[entityIndex];
    const regInfo = this.debugUI.scene?.registeredClasses?.find((r) => r.entityType === entityType);
    const components = regInfo ? regInfo.components : [Transform];

    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;
      const componentRows = rows[componentName];
      if (!componentRows) continue;

      const schema = ComponentClass.ARRAY_SCHEMA;
      if (!schema) continue;

      if (!this._prevInspectorValues[componentName]) this._prevInspectorValues[componentName] = {};
      const prevCache = this._prevInspectorValues[componentName];

      for (const propName of Object.keys(componentRows)) {
        const arr = ComponentClass[propName];
        if (!arr || arr[entityIndex] === undefined) continue;
        const value = arr[entityIndex];
        const rounded = typeof value === 'number' ? (value * 1000) | 0 : value;
        if (prevCache[propName] === rounded) continue;
        prevCache[propName] = rounded;
        componentRows[propName].textContent = formatComponentValue(propName, value);
      }
    }
  }

  // ------- helpers -------

  _syncDebugToolFlag() {
    Mouse.isDebugToolActive = !!(this.activeSpawnerType || this.eraserActive || this.inspectorActive);
  }

  _findNearestEntity(mx, my, radius) {
    const { count, entities } = Grid.getEntitiesInRadius(mx, my, radius);
    let nearest = -1;
    let nearestD2 = radius * radius;

    for (let i = 0; i < count; i++) {
      const id = entities[i];
      if (!Transform.active[id]) continue;

      const entityType = Transform.entityType[id];
      const reg = this.debugUI.scene?.registeredClasses?.find((r) => r.entityType === entityType);
      if (reg && this._internalEntitiesSet.has(reg.class.name)) continue;

      const d2 = distanceSq2D(mx, my, Transform.x[id], Transform.y[id]);
      if (d2 < nearestD2) { nearestD2 = d2; nearest = id; }
    }
    return nearest;
  }
}
