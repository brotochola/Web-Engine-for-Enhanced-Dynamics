// ToolManager.js — Manages painter, eraser, and inspector tools

import { Mouse } from '../../mouse.js';
import { Transform } from '../../../components/transform.js';
import { Collider } from '../../../components/collider.js';
import { DecorationComponent } from '../../../components/decorationComponent.js';
import { ParticleComponent } from '../../../components/particleComponent.js';
import { BulletComponent } from '../../../components/bulletComponent.js';
import { Grid } from '../../grid.js';
import { DecorationPool } from '../../decorationPool.js';
import { ParticleEmitter } from '../../particleEmitter.js';
import { BulletPool } from '../../bulletPool.js';
import {
  getComponentColor,
  getInspectorPropertyNames,
  formatComponentValue,
  rng,
} from '../../../util/utils.js';
import { pointInCollider } from '../../../util/colliderUtils.js';
import { FloatingPanel } from '../ui/floatingPanel.js';

const PICK_CAP = 64;

/**
 * Unified manager for all debug tools: paint / erase / inspect.
 * Handles mouse event wiring, tool state, and the inspector side-panel.
 */
export class ToolManager {
  constructor(debugUI) {
    this.debugUI = debugUI;

    this.activeSpawnerType = null;
    this.eraserActive = false;
    this.poolPaintKind = null;
    this.poolEraserKind = null;
    this.bulkSpawnEnabled = false;
    this.lastSpawnTime = 0;
    this.spawnThrottleMs = 50;
    this._toolMouseDown = false;

    this.inspectorActive = false;
    this.inspectKind = null;
    this.selectedEntityIndex = -1;
    this.selectedPoolKind = null;
    this.selectedPoolIndex = -1;
    this._inspectorPanelVisible = false;
    this._prevInspectorValues = {};
    this._inspectorCollapsed = Object.create(null);

    this._internalEntitiesSet = new Set(['Flash']);
    this._typeNameById = [];
    this._pickHits = new Uint16Array(PICK_CAP);
    this._pickHitCount = 0;
    this._pickCycle = 0;

    this._toolIndicator = null;
    this._inspectorFloat = null;
    this._inspectorPanel = null;
    this._inspectorEntityInfo = null;
    this._inspectorComponentsContainer = null;
    this._inspectorComponentRows = null;
    this._inspectorWrites = [];

    this._onToolMouseDown = null;
    this._onToolMouseUp = null;

    this._particleCfg = { x: 0, y: 0, count: 1, texture: '_whiteCircle', lifespan: 90, scale: 1.2 };
    this._bulletCfg = { x: 0, y: 0, vx: 12, vy: 0, damage: 0, ownerId: 0xffff, texture: 'bullet', scale: 1 };
  }

  init() {
    this._createToolIndicator();
    this._setupMouseHandlers();
  }

  attach() {
    this.activeSpawnerType = null;
    this.eraserActive = false;
    this.poolPaintKind = null;
    this.poolEraserKind = null;
    this._toolMouseDown = false;
    Mouse.isDebugToolActive = false;

    this.inspectorActive = false;
    this.inspectKind = null;
    this.selectedEntityIndex = -1;
    this.selectedPoolKind = null;
    this.selectedPoolIndex = -1;
    this._prevInspectorValues = {};
    this._inspectorWrites.length = 0;
    this._cacheTypeNames();
    this._hideInspectorPanel();
    this.updateToolIndicator();
    this._syncToolButtons();
  }

  _cacheTypeNames() {
    const names = this._typeNameById;
    names.length = 0;
    const regs = this.debugUI.scene?.registeredClasses;
    if (!regs) return;
    for (let i = 0; i < regs.length; i++) {
      names[regs[i].entityType] = regs[i].class.name;
    }
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
    if (this._inspectorFloat) {
      this._inspectorFloat.onClose = null;
      this._inspectorFloat.close();
      this._inspectorFloat = null;
      this._inspectorPanel = null;
    }
  }

  toggleSpawner(className) {
    if (this.activeSpawnerType === className) {
      this.activeSpawnerType = null;
    } else {
      this.activeSpawnerType = className;
      this.eraserActive = false;
      this.poolPaintKind = null;
      this.poolEraserKind = null;
      this.inspectorActive = false;
      this.inspectKind = null;
    }
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this._syncToolButtons();
    this.debugUI._ensureTickLoop();
  }

  toggleEraser() {
    this.eraserActive = !this.eraserActive;
    if (this.eraserActive) {
      this.activeSpawnerType = null;
      this.poolPaintKind = null;
      this.poolEraserKind = null;
      this.inspectorActive = false;
      this.inspectKind = null;
    }
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this._syncToolButtons();
    this.debugUI._ensureTickLoop();
  }

  togglePoolPaint(kind) {
    this.poolPaintKind = this.poolPaintKind === kind ? null : kind;
    if (this.poolPaintKind) {
      this.activeSpawnerType = null;
      this.eraserActive = false;
      this.poolEraserKind = null;
      this.inspectorActive = false;
      this.inspectKind = null;
    }
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this._syncToolButtons();
    this.debugUI._ensureTickLoop();
  }

  togglePoolEraser(kind) {
    this.poolEraserKind = this.poolEraserKind === kind ? null : kind;
    if (this.poolEraserKind) {
      this.activeSpawnerType = null;
      this.eraserActive = false;
      this.poolPaintKind = null;
      this.inspectorActive = false;
      this.inspectKind = null;
    }
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this._syncToolButtons();
    this.debugUI._ensureTickLoop();
  }

  toggleDecoEraser() {
    this.togglePoolEraser('decoration');
  }

  toggleInspector(kind = 'entity') {
    if (this.inspectorActive && this.inspectKind === kind) {
      this.inspectorActive = false;
      this.inspectKind = null;
    } else {
      this.inspectorActive = true;
      this.inspectKind = kind;
      this.activeSpawnerType = null;
      this.eraserActive = false;
      this.poolPaintKind = null;
      this.poolEraserKind = null;
    }
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this._syncToolButtons();
    this.debugUI._ensureTickLoop();
  }

  deactivateAll() {
    this.activeSpawnerType = null;
    this.eraserActive = false;
    this.poolPaintKind = null;
    this.poolEraserKind = null;
    this.inspectorActive = false;
    this.inspectKind = null;
    this._toolMouseDown = false;
    this.clearSelection();
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this._syncToolButtons();
  }

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
      el.textContent = `Painting: ${this.activeSpawnerType}${bulk} (click & drag to spawn)`;
      el.className = 'debug-ui-tool-indicator visible spawner';
    } else if (this.eraserActive) {
      el.textContent = 'Eraser Active (click & drag to despawn entities)';
      el.className = 'debug-ui-tool-indicator visible eraser';
    } else if (this.poolPaintKind) {
      el.textContent = 'Painting: ' + this.poolPaintKind + ' (click & drag)';
      el.className = 'debug-ui-tool-indicator visible spawner';
    } else if (this.poolEraserKind) {
      el.textContent = 'Eraser: ' + this.poolEraserKind + ' (click & drag)';
      el.className = 'debug-ui-tool-indicator visible eraser';
    } else if (this.inspectorActive) {
      el.textContent = 'Inspector: click a ' + (this.inspectKind || 'entity');
      el.className = 'debug-ui-tool-indicator visible inspector';
    } else {
      el.className = 'debug-ui-tool-indicator';
    }
  }

  _setupMouseHandlers() {
    this._onToolMouseDown = (e) => {
      if (e.button !== 0) return;
      if (this.debugUI.container?.contains(e.target)) return;
      if (this._inspectorPanel?.contains(e.target)) return;
      if (this._toolIndicator?.contains(e.target)) return;

      if (this.inspectorActive) {
        this._selectAtMouse();
        return;
      }
      if (!this.activeSpawnerType && !this.eraserActive && !this.poolPaintKind && !this.poolEraserKind) return;
      this._toolMouseDown = true;
    };

    this._onToolMouseUp = (e) => {
      if (e.button !== 0) return;
      this._toolMouseDown = false;
    };

    document.addEventListener('mousedown', this._onToolMouseDown, true);
    document.addEventListener('mouseup', this._onToolMouseUp, true);
  }

  _updatePaintTool() {
    if (!this.activeSpawnerType && !this.eraserActive && !this.poolPaintKind && !this.poolEraserKind) return;
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
    } else if (this.poolPaintKind) {
      this._spawnPoolAtMouse(this.poolPaintKind);
    } else if (this.poolEraserKind) {
      const idx = this._findNearestPool(this.poolEraserKind, Mouse.x, Mouse.y, 48);
      if (idx >= 0) this._despawnPoolIndex(this.poolEraserKind, idx);
    }
  }

  _spawnPoolAtMouse(kind) {
    const count = this.bulkSpawnEnabled ? 20 : 1;
    const spread = 24;
    for (let i = 0; i < count; i++) {
      const ox = count > 1 ? (rng() - 0.5) * spread * 2 : 0;
      const oy = count > 1 ? (rng() - 0.5) * spread * 2 : 0;
      const x = Mouse.x + ox;
      const y = Mouse.y + oy;
      if (kind === 'particle') {
        const cfg = this._particleCfg;
        cfg.x = x;
        cfg.y = y;
        cfg.count = 1;
        ParticleEmitter.emitFlat(cfg);
      } else if (kind === 'bullet') {
        const cfg = this._bulletCfg;
        cfg.x = x;
        cfg.y = y;
        BulletPool.spawn(cfg);
      }
    }
  }

  _despawnPoolIndex(kind, idx) {
    if (kind === 'decoration') DecorationPool.despawn(idx);
    else if (kind === 'particle') {
      if (ParticleComponent.active && ParticleComponent.active[idx]) {
        ParticleComponent.active[idx] = 0;
        ParticleEmitter.returnToPool(idx);
      }
    } else if (kind === 'bullet') {
      BulletPool.despawn(idx);
    }
  }

  clearPool(kind) {
    if (kind === 'decoration') {
      DecorationPool.despawnAll();
      return;
    }
    if (kind === 'particle') {
      const active = ParticleComponent.active;
      if (!active) return;
      for (let i = 0; i < active.length; i++) {
        if (!active[i]) continue;
        active[i] = 0;
        ParticleEmitter.returnToPool(i);
      }
      return;
    }
    if (kind === 'bullet') {
      const active = BulletComponent.active;
      if (!active) return;
      for (let i = 0; i < active.length; i++) {
        if (active[i]) BulletPool.despawn(i);
      }
    }
  }

  _spawnEntityAtMouse(className) {
    const engine = this.debugUI.gameEngine;
    if (!engine) return;

    const count = this.bulkSpawnEnabled ? 50 : 1;
    const spread = 30;

    for (let i = 0; i < count; i++) {
      const ox = count > 1 ? (rng() - 0.5) * spread * 2 : 0;
      const oy = count > 1 ? (rng() - 0.5) * spread * 2 : 0;
      engine.spawnEntity(className, { x: Mouse.x + ox, y: Mouse.y + oy });
    }
  }

  _despawnEntityAtMouse() {
    const scene = this.debugUI.scene;
    if (!scene || !this.debugUI.gameEngine) return;
    const nearest = this._pickEntity(Mouse.x, Mouse.y, 50, false);
    if (nearest >= 0) scene.despawnEntity(nearest);
  }

  _selectAtMouse() {
    if (!this.debugUI.scene || !this.inspectorActive) return;
    const kind = this.inspectKind || 'entity';
    if (kind === 'entity') {
      const nearest = this._pickEntity(Mouse.x, Mouse.y, 80, true);
      if (nearest >= 0) this._selectEntity(nearest);
      else this.clearSelection();
      return;
    }
    const idx = this._findNearestPool(kind, Mouse.x, Mouse.y, 64);
    if (idx >= 0) this._selectPool(kind, idx);
    else this.clearSelection();
  }

  _selectEntity(entityIndex) {
    this.selectedEntityIndex = entityIndex;
    this.selectedPoolKind = null;
    this.selectedPoolIndex = -1;
    const flags = this.debugUI.debugFlags;
    if (flags) flags.setSelectedEntity(entityIndex);
    this.debugUI.canvas.startLoop();
    this._showInspectorPanel();
    this._populateInspectorPanel();
  }

  _selectPool(kind, index) {
    this.selectedEntityIndex = -1;
    this.selectedPoolKind = kind;
    this.selectedPoolIndex = index;
    const flags = this.debugUI.debugFlags;
    if (flags) flags.clearSelectedEntity();
    this.debugUI.canvas.startLoop();
    this._showInspectorPanel();
    this._populatePoolInspector(kind, index);
  }

  clearSelection() {
    this.selectedEntityIndex = -1;
    this.selectedPoolKind = null;
    this.selectedPoolIndex = -1;
    this._prevInspectorValues = {};
    this._inspectorWrites.length = 0;
    const flags = this.debugUI.debugFlags;
    if (flags) flags.clearSelectedEntity();
    this.debugUI.canvas.syncLoop();
    this._hideInspectorPanel();
  }

  _closeInspectorTool() {
    this.inspectorActive = false;
    this.inspectKind = null;
    this.clearSelection();
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this._syncToolButtons();
  }

  _showInspectorPanel() {
    if (!this._inspectorFloat) this._createInspectorPanel();
    else this._inspectorFloat.show();
    this._inspectorPanelVisible = true;
  }

  _hideInspectorPanel() {
    this._inspectorPanelVisible = false;
    if (this._inspectorFloat) this._inspectorFloat.hide();
  }

  _onInspectorFloatClosed() {
    this._inspectorFloat = null;
    this._inspectorPanel = null;
    this._inspectorPanelVisible = false;
    if (this.inspectorActive || this.selectedEntityIndex >= 0 || this.selectedPoolKind) {
      this._closeInspectorTool();
    }
  }

  _createInspectorPanel() {
    const float = new FloatingPanel({
      title: 'Inspector',
      left: 12,
      top: 78,
      width: 320,
      className: 'debug-ui-inspector-panel',
      onClose: () => this._onInspectorFloatClosed(),
    });
    float.body.className = 'debug-ui-inspector-body';
    float.body.style.padding = '0';

    this._inspectorEntityInfo = document.createElement('div');
    this._inspectorEntityInfo.className = 'debug-ui-inspector-info';
    float.body.appendChild(this._inspectorEntityInfo);

    this._inspectorComponentsContainer = document.createElement('div');
    this._inspectorComponentsContainer.className = 'debug-ui-inspector-sections';
    float.body.appendChild(this._inspectorComponentsContainer);

    float.mount();
    this._inspectorFloat = float;
    this._inspectorPanel = float.el;
  }

  _setInfoText(name, index, extra) {
    const info = this._inspectorEntityInfo;
    if (!info) return;
    info.textContent = '';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:4px';
    const left = document.createElement('span');
    left.style.cssText = 'color:#fff;font-weight:bold';
    left.textContent = name;
    const right = document.createElement('span');
    right.style.color = '#888';
    right.textContent = 'Index: ' + index;
    row.appendChild(left);
    row.appendChild(right);
    info.appendChild(row);
    if (extra) {
      const sub = document.createElement('div');
      sub.style.cssText = 'color:#666;font-size:12px';
      sub.textContent = extra;
      info.appendChild(sub);
    }
  }

  _populateInspectorPanel() {
    if (this.selectedEntityIndex < 0 || !this.debugUI.scene) return;
    const entityIndex = this.selectedEntityIndex;
    const entityType = Transform.entityType[entityIndex];
    const name = this._typeNameById[entityType] || 'Unknown';
    if (this._inspectorFloat) this._inspectorFloat.setTitle('Entity Inspector');
    this._setInfoText(name, entityIndex, 'Type ID: ' + entityType);

    const regs = this.debugUI.scene.registeredClasses;
    let components = null;
    if (regs) {
      for (let i = 0; i < regs.length; i++) {
        if (regs[i].entityType === entityType) {
          components = regs[i].components;
          break;
        }
      }
    }
    if (!components) components = [Transform];
    this._fillComponentSections(components);
  }

  _populatePoolInspector(kind, index) {
    const Comp = kind === 'decoration' ? DecorationComponent : kind === 'particle' ? ParticleComponent : BulletComponent;
    if (this._inspectorFloat) this._inspectorFloat.setTitle(kind + ' Inspector');
    this._setInfoText(kind, index, '');
    this._fillComponentSections([Comp]);
  }

  _fillComponentSections(components) {
    const container = this._inspectorComponentsContainer;
    if (!container) return;
    container.textContent = '';
    this._inspectorComponentRows = {};
    this._inspectorWrites.length = 0;
    this._prevInspectorValues = {};

    for (let c = 0; c < components.length; c++) {
      const ComponentClass = components[c];
      const componentName = ComponentClass.name;
      const color = getComponentColor(componentName);

      const saved = this._inspectorCollapsed[componentName];
      const open = saved === undefined ? c === 0 : !saved;

      const section = document.createElement('div');
      section.className = 'debug-ui-inspector-section';
      section.style.borderColor = color.css;
      section.style.borderLeftColor = color.css;

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'debug-ui-inspector-section-head';
      header.style.color = color.css;
      header.style.background = 'linear-gradient(90deg,' + color.css + '22,transparent)';

      const chevron = document.createElement('span');
      chevron.className = 'debug-ui-inspector-chevron';
      chevron.textContent = open ? '▾' : '▸';
      const title = document.createElement('span');
      title.textContent = componentName;
      header.appendChild(chevron);
      header.appendChild(title);
      section.appendChild(header);

      const propsContainer = document.createElement('div');
      propsContainer.className = 'debug-ui-inspector-props';
      if (!open) propsContainer.style.display = 'none';

      const propNames = getInspectorPropertyNames(ComponentClass);
      const rows = {};
      const prev = {};
      this._inspectorComponentRows[componentName] = rows;
      this._prevInspectorValues[componentName] = prev;
      const rec = { Comp: ComponentClass, names: propNames, rows, prev, open, propsEl: propsContainer, chevron };
      this._inspectorWrites.push(rec);

      header.onclick = () => {
        rec.open = !rec.open;
        this._inspectorCollapsed[componentName] = !rec.open;
        rec.propsEl.style.display = rec.open ? '' : 'none';
        rec.chevron.textContent = rec.open ? '▾' : '▸';
        if (rec.open) {
          const idx = this.selectedPoolKind ? this.selectedPoolIndex : this.selectedEntityIndex;
          if (idx >= 0) this._flushInspectorWrites(idx);
        }
      };

      for (let p = 0; p < propNames.length; p++) {
        const propName = propNames[p];
        const row = document.createElement('div');
        row.className = 'debug-ui-inspector-prop';

        const label = document.createElement('span');
        label.className = 'debug-ui-inspector-prop-label';
        label.textContent = propName;
        row.appendChild(label);

        const value = document.createElement('span');
        value.className = 'debug-ui-inspector-prop-value';
        value.textContent = '--';
        row.appendChild(value);

        propsContainer.appendChild(row);
        rows[propName] = value;
      }

      section.appendChild(propsContainer);
      container.appendChild(section);
    }

    this._updateInspectorValues();
  }

  _updateInspectorValues() {
    if (!this._inspectorPanelVisible) return;

    if (this.selectedPoolKind) {
      const Comp = this.selectedPoolKind === 'decoration'
        ? DecorationComponent
        : this.selectedPoolKind === 'particle'
          ? ParticleComponent
          : BulletComponent;
      const idx = this.selectedPoolIndex;
      if (!Comp.active || !Comp.active[idx]) {
        this.clearSelection();
        return;
      }
      this._flushInspectorWrites(idx);
      return;
    }

    if (this.selectedEntityIndex < 0) return;
    const entityIndex = this.selectedEntityIndex;
    if (!Transform.active[entityIndex]) {
      this.clearSelection();
      return;
    }
    this._flushInspectorWrites(entityIndex);
  }

  _flushInspectorWrites(index) {
    const writes = this._inspectorWrites;
    for (let w = 0; w < writes.length; w++) {
      const rec = writes[w];
      if (!rec.open) continue;
      const Comp = rec.Comp;
      const names = rec.names;
      const rows = rec.rows;
      const prev = rec.prev;
      for (let p = 0; p < names.length; p++) {
        const propName = names[p];
        const arr = Comp[propName];
        if (!arr || arr[index] === undefined) continue;
        const value = arr[index];
        const rounded = typeof value === 'number' ? (value * 1000) | 0 : value;
        if (prev[propName] === rounded) continue;
        prev[propName] = rounded;
        rows[propName].textContent = formatComponentValue(propName, value);
      }
    }
  }

  _syncToolButtons() {
    const panels = this.debugUI.panels;
    panels.visual?.updateInspectorButtonState(this.inspectorActive && this.inspectKind === 'entity');
    panels.pools?.updateInspectButtons();
    panels.entities?._updateToolButtonStates();
  }

  _syncDebugToolFlag() {
    Mouse.isDebugToolActive = !!(
      this.activeSpawnerType ||
      this.eraserActive ||
      this.poolPaintKind ||
      this.poolEraserKind ||
      this.inspectorActive
    );
  }

  _classNameForType(entityType) {
    return this._typeNameById[entityType] || '';
  }

  _pickEntity(mx, my, radius, cycle) {
    const { count, entities } = Grid.getEntitiesInRadius(mx, my, radius);
    const hits = this._pickHits;
    let n = 0;
    const r2 = radius * radius;

    for (let i = 0; i < count; i++) {
      const id = entities[i];
      if (!Transform.active[id]) continue;
      if (this._internalEntitiesSet.has(this._classNameForType(Transform.entityType[id]))) continue;

      let hit = false;
      if (Collider.active && Collider.active[id]) {
        hit = pointInCollider(id, mx, my);
      }
      if (!hit) {
        const dx = mx - Transform.x[id];
        const dy = my - Transform.y[id];
        hit = dx * dx + dy * dy < r2;
      }
      if (!hit) continue;
      if (n < PICK_CAP) hits[n++] = id;
    }
    this._pickHitCount = n;
    if (n === 0) return -1;

    if (cycle && this.selectedEntityIndex >= 0) {
      let found = -1;
      for (let i = 0; i < n; i++) {
        if (hits[i] === this.selectedEntityIndex) {
          found = i;
          break;
        }
      }
      if (found >= 0) return hits[(found + 1) % n];
    }

    let best = hits[0];
    let bestD2 = Infinity;
    for (let i = 0; i < n; i++) {
      const id = hits[i];
      const dx = mx - Transform.x[id];
      const dy = my - Transform.y[id];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = id;
      }
    }
    return best;
  }

  _findNearestPool(kind, mx, my, radius) {
    let active;
    let xs;
    let ys;
    if (kind === 'decoration') {
      active = DecorationComponent.active;
      xs = DecorationComponent.x;
      ys = DecorationComponent.y;
    } else if (kind === 'particle') {
      active = ParticleComponent.active;
      xs = ParticleComponent.x;
      ys = ParticleComponent.y;
    } else {
      active = BulletComponent.active;
      xs = BulletComponent.x;
      ys = BulletComponent.y;
    }
    if (!active || !xs) return -1;
    const r2 = radius * radius;
    let best = -1;
    let bestD2 = r2;
    const n = active.length;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      const dx = mx - xs[i];
      const dy = my - ys[i];
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }
}
