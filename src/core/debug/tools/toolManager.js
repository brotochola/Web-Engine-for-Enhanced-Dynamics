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
  rng,
} from '../../../util/utils.js';
import { pointInCollider } from '../../../util/colliderUtils.js';
import { entityIdNone } from '../../../util/entityIdWidth.js';
import { GameObject } from '../../gameObject.js';
import { FloatingPanel } from '../ui/floatingPanel.js';
import { childrenOf, formatInspectorField } from './inspectorFormat.js';
import { elem } from '../ui/debugDom.js';
import { SpriteRenderer } from '../../../components/spriteRenderer.js';
import { SpriteSheetRegistry } from '../../spriteSheetRegistry.js';
import { BigAtlasInspector } from '../../bigAtlasInspector.js';
import { frameMapsImage } from '../../atlasMapsView.js';

/**
 * DBG-6: the atlas frame sprite `i` draws now: a texture is its own frame; a sheet's is its animation's current frame.
 * Null when the registry does not know it.
 */
function spriteFrameName(i, json) {
  const sheet = SpriteSheetRegistry.getSpritesheetName(SpriteRenderer.spritesheetId[i]);
  if (!sheet) return null;
  if (json.frames[sheet]) return sheet;
  const anim = SpriteSheetRegistry.getAnimationName(sheet, SpriteRenderer.animationState[i]);
  if (anim === undefined) return null;
  return SpriteSheetRegistry.getFrameName(sheet, anim, SpriteRenderer.animationFrame[i]);
}

const PICK_CAP = 64;
/** DBG-10: how many children the Transform section names (it counts them all). */
const CHILDREN_SHOWN = 8;

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
    this._onToolMouseMove = null;

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
    if (this._onToolMouseDown) document.removeEventListener('pointerdown', this._onToolMouseDown);
    if (this._onToolMouseUp) document.removeEventListener('pointerup', this._onToolMouseUp);
    if (this._onToolMouseMove) document.removeEventListener('pointermove', this._onToolMouseMove);
    if (this._toolIndicator?.parentNode) this._toolIndicator.parentNode.removeChild(this._toolIndicator);
    if (this._inspectorFloat) {
      this._inspectorFloat.onClose = null;
      this._inspectorFloat.close();
      this._inspectorFloat = null;
      this._inspectorPanel = null;
    }
  }

  /** Every tool off (one is on at a time: turning one on turns the others off). */
  _clearTools() {
    this.activeSpawnerType = null;
    this.eraserActive = false;
    this.poolPaintKind = null;
    this.poolEraserKind = null;
    this.inspectorActive = false;
    this.inspectKind = null;
  }

  /** After a tool turned on or off: the workers' tool flag, the indicator, the buttons and the tick loop. */
  _toolsChanged() {
    this._syncDebugToolFlag();
    this.updateToolIndicator();
    this._syncToolButtons();
    this.debugUI._ensureTickLoop();
  }

  toggleSpawner(className) {
    const on = this.activeSpawnerType !== className;
    this._clearTools();
    if (on) this.activeSpawnerType = className;
    this._toolsChanged();
  }

  toggleEraser() {
    const on = !this.eraserActive;
    this._clearTools();
    this.eraserActive = on;
    this._toolsChanged();
  }

  togglePoolPaint(kind) {
    const on = this.poolPaintKind !== kind;
    this._clearTools();
    if (on) this.poolPaintKind = kind;
    this._toolsChanged();
  }

  togglePoolEraser(kind) {
    const on = this.poolEraserKind !== kind;
    this._clearTools();
    if (on) this.poolEraserKind = kind;
    this._toolsChanged();
  }

  toggleInspector(kind = 'entity') {
    const on = !(this.inspectorActive && this.inspectKind === kind);
    this._clearTools();
    if (on) {
      this.inspectorActive = true;
      this.inspectKind = kind;
    }
    this._toolsChanged();
  }

  _createToolIndicator() {
    this._toolIndicator = elem('div', 'debug-ui-tool-indicator');
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

    // pointerup fires only for the last button of a chord; releasing the primary while
    // another button is held arrives as a pointermove. Both read the `buttons` mask.
    const primaryReleased = (e) => (typeof e.buttons === 'number' ? (e.buttons & 1) === 0 : e.button === 0);

    this._onToolMouseUp = (e) => {
      if (primaryReleased(e)) this._toolMouseDown = false;
    };

    this._onToolMouseMove = (e) => {
      if (this._toolMouseDown && typeof e.buttons === 'number' && (e.buttons & 1) === 0) {
        this._toolMouseDown = false;
      }
    };

    document.addEventListener('pointerdown', this._onToolMouseDown);
    document.addEventListener('pointerup', this._onToolMouseUp);
    document.addEventListener('pointermove', this._onToolMouseMove);
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
    const EntityClass = this.debugUI.scene?.registeredClasses.find((r) => r.class.name === className)?.class;
    if (!EntityClass) return;

    const count = this.bulkSpawnEnabled ? 50 : 1;
    const spread = 30;

    for (let i = 0; i < count; i++) {
      const ox = count > 1 ? (rng() - 0.5) * spread * 2 : 0;
      const oy = count > 1 ? (rng() - 0.5) * spread * 2 : 0;
      EntityClass.spawn({ x: Mouse.x + ox, y: Mouse.y + oy });
    }
  }

  _despawnEntityAtMouse() {
    const scene = this.debugUI.scene;
    if (!scene || !this.debugUI.gameEngine) return;
    const nearest = this._pickEntity(Mouse.x, Mouse.y, 50, false);
    if (nearest >= 0) GameObject.despawn(nearest);
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

    this._inspectorEntityInfo = elem('div', 'debug-ui-inspector-info');
    float.body.appendChild(this._inspectorEntityInfo);

    this._inspectorComponentsContainer = elem('div', 'debug-ui-inspector-sections');
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
    this._addFrameMapsSection(entityIndex);
  }

  /** DBG-6: a sprite's current atlas frame, and a button that shows its colours, height and normals. */
  _addFrameMapsSection(entityIndex) {
    const scene = this.debugUI.scene;
    const container = this._inspectorComponentsContainer;
    if (!container || !scene?.bigAtlasJson || !SpriteRenderer.active || SpriteRenderer.active[entityIndex] !== 1) return;
    const frameName = spriteFrameName(entityIndex, scene.bigAtlasJson);
    if (!frameName) return;
    const section = elem('div', 'debug-ui-inspector-section');
    section.appendChild(elem('div', 'debug-ui-inspector-section-head', `Frame ${frameName}`));
    const body = elem('div', 'debug-ui-inspector-props');
    const button = elem('button', 'debug-ui-btn', 'Show its maps');
    button.onclick = () => this._showFrameMaps(body, frameName, button);
    body.appendChild(button);
    section.appendChild(body);
    container.appendChild(section);
  }

  /** DBG-6: the frame cut from the atlas, beside its height and normals from the twin page. */
  async _showFrameMaps(body, frameName, button) {
    const scene = this.debugUI.scene;
    const json = scene?.bigAtlasJson;
    const rect = json?.frames?.[frameName]?.frame;
    if (!rect) return;
    button.disabled = true;
    button.textContent = 'reading the atlas...';
    const [atlas, page] = await Promise.all([BigAtlasInspector.atlasCanvas(scene), BigAtlasInspector.mapsPage(scene)]);
    button.remove();
    const row = elem('div', '');
    row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:flex-end';
    const add = (label, paint) => {
      const cell = elem('div', '');
      cell.appendChild(elem('div', '', label));
      const canvas = document.createElement('canvas');
      canvas.width = rect.w;
      canvas.height = rect.h;
      canvas.style.cssText = `width:${Math.min(96, rect.w)}px;image-rendering:pixelated;background:#222`;
      paint(canvas.getContext('2d'));
      cell.appendChild(canvas);
      row.appendChild(cell);
    };
    if (atlas) add('colour', (ctx) => ctx.drawImage(atlas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h));
    let maps = 0;
    if (page) {
      for (const mode of ['height', 'normals']) {
        const img = frameMapsImage(page, json, frameName, mode);
        if (!img) continue;
        maps++;
        add(mode === 'height' ? `height (to ${img.maxZ.toFixed(0)} px)` : mode, (ctx) => ctx.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0));
      }
    }
    if (maps === 0) row.appendChild(elem('div', '', 'no maps for this frame'));
    body.appendChild(row);
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

      const section = elem('div', 'debug-ui-inspector-section');
      section.style.borderColor = color.css;
      section.style.borderLeftColor = color.css;

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'debug-ui-inspector-section-head';
      header.style.color = color.css;
      header.style.background = 'linear-gradient(90deg,' + color.css + '22,transparent)';

      const chevron = elem('span', 'debug-ui-inspector-chevron', open ? '▾' : '▸');
      const title = elem('span', '', componentName);
      header.appendChild(chevron);
      header.appendChild(title);
      section.appendChild(header);

      const propsContainer = elem('div', 'debug-ui-inspector-props');
      if (!open) propsContainer.style.display = 'none';

      const propNames = getInspectorPropertyNames(ComponentClass);
      const rows = {};
      const prev = {};
      this._inspectorComponentRows[componentName] = rows;
      this._prevInspectorValues[componentName] = prev;
      const rec = { Comp: ComponentClass, names: propNames, rows, prev, open, propsEl: propsContainer, chevron, children: null };
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
        const row = elem('div', 'debug-ui-inspector-prop');

        const label = elem('span', 'debug-ui-inspector-prop-label', propName);
        row.appendChild(label);

        const value = elem('span', 'debug-ui-inspector-prop-value', '--');
        row.appendChild(value);

        // DBG-10: the parent is a link: a click inspects it.
        if (componentName === 'Transform' && propName === 'parent') {
          value.style.cursor = 'pointer';
          value.style.textDecoration = 'underline';
          value.title = 'Inspect the parent';
          value.onclick = () => this._inspectParent();
        }

        propsContainer.appendChild(row);
        rows[propName] = value;
      }

      // DBG-10: an entity's children (the entities whose Transform.parent is it), each a link.
      if (componentName === 'Transform' && Transform.parent && !this.selectedPoolKind) {
        const row = elem('div', 'debug-ui-inspector-prop');
        const label = elem('span', 'debug-ui-inspector-prop-label', 'children');
        row.appendChild(label);
        const value = elem('span', 'debug-ui-inspector-prop-value', '--');
        row.appendChild(value);
        propsContainer.appendChild(row);
        rec.children = { el: value, key: '', list: [] };
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
        rows[propName].textContent = formatInspectorField(Comp.name, propName, value, index, Comp);
      }
      if (rec.children !== null) this._updateChildrenLine(rec.children, index);
    }
  }

  /** DBG-10: the Transform section's children line, rebuilt only when the list changes. */
  _updateChildrenLine(children, index) {
    const count = childrenOf(Transform.parent, Transform.active, index, CHILDREN_SHOWN, children.list);
    const key = `${count}:${children.list.join(',')}`;
    if (key === children.key) return;
    children.key = key;
    const el = children.el;
    el.textContent = '';
    if (count === 0) {
      el.textContent = 'none';
      return;
    }
    for (let k = 0; k < children.list.length; k++) {
      const child = children.list[k];
      const link = elem('span', '', `#${child}`);
      link.style.cssText = 'cursor:pointer;text-decoration:underline;margin-right:6px';
      link.title = 'Inspect this child';
      link.onclick = () => {
        if (Transform.active[child]) this._selectEntity(child);
      };
      el.appendChild(link);
    }
    if (count > children.list.length) el.appendChild(document.createTextNode(`+${count - children.list.length} more`));
  }

  /** DBG-10: the parent link: inspect the selected entity's parent, while it lives. */
  _inspectParent() {
    const i = this.selectedEntityIndex;
    if (i < 0 || !Transform.parent) return;
    const parent = Transform.parent[i];
    if (parent < entityIdNone && Transform.active[parent]) this._selectEntity(parent);
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

  _tryPickHit(id, mx, my, r2) {
    if (!Transform.active?.[id]) return false;
    if (this._internalEntitiesSet.has(this._classNameForType(Transform.entityType[id]))) return false;
    if (Collider.active && Collider.active[id] && pointInCollider(id, mx, my)) return true;
    const dx = mx - Transform.x[id];
    const dy = my - Transform.y[id];
    return dx * dx + dy * dy < r2;
  }

  _pickEntity(mx, my, radius, cycle) {
    const { count, entities } = Grid.getEntitiesInRadius(mx, my, radius);
    const hits = this._pickHits;
    let n = 0;
    const r2 = radius * radius;

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const id = entities[i];
        if (this._tryPickHit(id, mx, my, r2) && n < PICK_CAP) hits[n++] = id;
      }
    } else {
      // No spatial grid (0 workers) or empty cells — click-only scan, not hover.
      const active = Transform.active;
      const xs = Transform.x;
      const nEntities = active && xs ? active.length : 0;
      for (let id = 0; id < nEntities && n < PICK_CAP; id++) {
        if (this._tryPickHit(id, mx, my, r2)) hits[n++] = id;
      }
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
