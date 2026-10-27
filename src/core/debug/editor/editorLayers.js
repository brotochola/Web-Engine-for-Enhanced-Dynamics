// editorLayers.js — per-layer hide and lock in edit mode (VISUAL_EDITOR_PLAN.md ED-24).
//
// Each render layer of the running scene (entities, the scene's own sprite layers, its scenery, lighting, …) gets two
// switches in the palette (in the editor page, its Assets dock):
// - hide: the layer is not drawn while editing. It writes Layer.visible, as the Layers panel's checkbox does, and it
//   is a view setting of the editor's: no file holds it. The layer shows again when edit mode is left (the game plays
//   with what it had) and when a fast swap puts the level's layers back to their boot values; while editing, the
//   choice is applied again after the swap. An entity drawn only in hidden layers is left out of a click in the view.
// - lock: the editor does not pick the layer's entities in the view or move them (a drag, the arrow keys), and the
//   scene list marks them. A locked entity can still be selected in the scene list and edited in the inspector, as
//   in Godot and Unity.
// An entity is in the layers its renderers' and collider's layer masks name (GameObject.setLayer, a spawn's `layer`),
// and in `entities` when no sprite layer is among them, as the renderer draws it (preRenderWorker collectRenderable).
// The choices last while the scene runs, fast swaps included, and go with it (a full load).
//
// Unlit (ED-78, Unity's scene-lighting switch): with the scene's lighting on, L or the toolbar's 💡 hides the engine's
// lighting layer while editing, so a dark level shows its entities as their sprites are, not as its lights leave them
// (the platformer's ambient is 0.05). It is the lighting row's hide, remembered for the viewer (localStorage, every
// access guarded) and taken to the next scene that has lighting.
//
// The game's layers come first (ED-67): the ones its config.layers declares, and `entities`, where its entities draw
// unless they name another. The engine's own pipeline layers (Layer.builtIn: decals, castedShadows, lighting,
// lightGlows) follow under a folded "Engine layers" line, which says how many of them are hidden while folded.
//
// Cost: nothing per frame. A click asks each entity under the pointer for its layers (a few array reads); the rows
// are built when the scene changes, and a switch or the fold changes only what it shows.

import { Layer } from '../../layer.js';
import { SpriteRenderer } from '../../../components/spriteRenderer.js';
import { MeshRenderer } from '../../../components/meshRenderer.js';
import { AdobeAnimComponent } from '../../../components/adobeAnimComponent.js';
import { Collider } from '../../../components/collider.js';
import { isSkipSubscribeKind } from '../../../util/configDefaults.js';

/** The engine's layer the lights are drawn into (multiplied over the scene). */
const LIGHTING = 'lighting';
const UNLIT_KEY = 'weed.editor.unlit';

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // a sandboxed page: localStorage throws when read
  }
}

/** Whether this viewer last chose to edit unlit. */
export function loadUnlit() {
  try {
    return storage()?.getItem(UNLIT_KEY) === '1';
  } catch {
    return false;
  }
}

function saveUnlit(unlit) {
  try {
    storage()?.setItem(UNLIT_KEY, unlit ? '1' : '0');
  } catch {
    // full or blocked: the choice lasts as long as the page
  }
}

/**
 * The layers entity `i` is in, as a mask (bit = Layer.id): its renderers' and collider's masks, with `entities` when
 * none of them is a sprite layer (the renderer draws it there).
 * @param {number} i
 * @returns {number}
 */
export function entityLayerMask(i) {
  let mask = 0;
  if (SpriteRenderer.active && SpriteRenderer.active[i] && SpriteRenderer.layerMask) mask |= SpriteRenderer.layerMask[i];
  if (AdobeAnimComponent.active && AdobeAnimComponent.active[i] && AdobeAnimComponent.layerMask) {
    mask |= AdobeAnimComponent.layerMask[i];
  }
  if (MeshRenderer.active && MeshRenderer.active[i] && MeshRenderer.layerMask) mask |= MeshRenderer.layerMask[i];
  if (Collider.active && Collider.active[i] === 1 && Collider.layerMask) mask |= Collider.layerMask[i];
  if ((mask & Layer._spriteQueueBits) === 0) mask |= Layer.entitiesMask();
  return mask;
}

/**
 * The layers of the scene the editor offers, highest z first (as the Layers panel orders them): the scene's own, and
 * the engine's that the scene uses (decals, lighting, shadows, glows only when its config turns them on).
 * @param {object} scene
 * @returns {Layer[]}
 */
export function editorLayersOf(scene) {
  if (!scene || !Layer.initialized) return [];
  const config = scene.config || {};
  const lighting = config.lighting?.enabled === true;
  const used = (layer) => {
    if (!layer.builtIn || layer.name === 'entities') return true;
    if (layer.name === 'decals') return config.particle?.decals === true;
    if (layer.name === 'castedShadows') return lighting && config.lighting?.shadowsEnabled === true;
    return lighting; // lighting, lightGlows
  };
  return Layer.getAll()
    .filter(used)
    .sort((a, b) => b.zIndex - a.zIndex || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Whether entities can be in a layer (a sprite, density, compute or mesh layer), so locking it means something. */
export const lockable = (layer) => !isSkipSubscribeKind(layer.kind);

/**
 * Whether a layer is the engine's own: one it makes for its pipeline (decals, castedShadows, lighting, lightGlows),
 * not one the scene declares in its config.layers (the platformer's bloom is the platformer's). `entities` is made by
 * the engine too, but it is where the game's entities draw unless they name another layer: it is the game's.
 * @param {Layer} layer
 */
export const isEngineLayer = (layer) => layer.builtIn === true && layer.name !== 'entities';

const ROW_STYLE = 'display:grid;grid-template-columns:34px 34px 1fr auto;align-items:center;gap:2px;margin:1px 0';
const HEAD_STYLE = `${ROW_STYLE};font-size:9px;color:#888;text-transform:uppercase;letter-spacing:0.4px`;
const FOLD_STYLE =
  'display:block;width:100%;box-sizing:border-box;margin:3px 0 1px;padding:2px 0;border:0;background:none;' +
  'color:#999;font:inherit;font-size:10px;text-align:left;cursor:pointer';

export class EditorLayers {
  /** @param {object} editMode - the EditMode these switches belong to */
  constructor(editMode) {
    this.editMode = editMode;
    /** Layers chosen hidden while editing (bit = Layer.id). */
    this.hiddenMask = 0;
    /** Layers chosen locked: their entities are not picked in the view or moved. */
    this.lockedMask = 0;
    /** Layers the editor has hidden now (edit mode on), to put back. */
    this._appliedMask = 0;
    /** Of those, the ones that were showing before the editor hid them. */
    this._shownBefore = 0;
    /** The palette's section and the scene its rows were built for. */
    this._box = null;
    this._boxScene = null;
    /** The engine's layers are shown under their line (ED-67); folded until opened, for as long as the page lives. */
    this.engineOpen = false;
    /** That line (null when the scene uses none of them), their rows, and their ids as a mask. */
    this._fold = null;
    this._engineRows = [];
    this._engineMask = 0;
    /** The rows' hide switches by layer id: a switch made elsewhere (the toolbar's 💡) shows on its row too. */
    this._hideBoxes = new Map();
    /** The viewer's choice: the scene unlit while editing (ED-78). */
    this.unlit = loadUnlit();
  }

  /** The running scene's lighting layer, -1 when its lighting is off (nothing to hide). */
  lightingId() {
    const scene = this.editMode.debugUI.scene ?? null;
    if (scene?.config?.lighting?.enabled !== true || !Layer._visible) return -1;
    const layer = Layer.get(LIGHTING);
    return layer ? layer.id : -1;
  }

  /** Whether the scene shows lit while editing: null when it has no lighting. */
  get lit() {
    const id = this.lightingId();
    return id < 0 ? null : !this.isHidden(id);
  }

  /** L, the toolbar's 💡: the scene unlit while editing, or lit again. Remembered. */
  toggleLighting() {
    const id = this.lightingId();
    if (id < 0) return false;
    this.setHidden(id, !this.isHidden(id));
    return true;
  }

  isHidden(id) {
    return (this.hiddenMask & (1 << id)) !== 0;
  }

  isLocked(id) {
    return (this.lockedMask & (1 << id)) !== 0;
  }

  /** Hide the layers chosen hidden: entering edit mode, or after a swap while editing. */
  apply() {
    // The viewer's unlit choice reaches a scene the choices were not made in.
    const lighting = this.unlit ? this.lightingId() : -1;
    if (lighting >= 0) this.hiddenMask |= 1 << lighting;
    let pending = this.hiddenMask & ~this._appliedMask;
    while (pending !== 0) {
      const bit = pending & -pending;
      pending ^= bit;
      this._hide(31 - Math.clz32(bit));
    }
  }

  /** Put back what the editor hid (leaving edit mode, a full load). */
  restore() {
    let applied = this._appliedMask;
    while (applied !== 0) {
      const bit = applied & -applied;
      applied ^= bit;
      this._show(31 - Math.clz32(bit));
    }
  }

  /**
   * A fast swap put every layer's visibility back to its boot value (Layer.restoreBootLiveValues): what the editor
   * hid shows again. While editing, the choices hide again.
   */
  onSwapped(editing) {
    this._appliedMask = 0;
    this._shownBefore = 0;
    if (editing) this.apply();
  }

  /** The scene goes (a full load): put back, and drop the choices; the next scene's layers are others. */
  reset() {
    this.restore();
    this.hiddenMask = 0;
    this.lockedMask = 0;
    this._boxScene = null;
  }

  /**
   * Hide or show layer `id` while editing. In the editor page the palette shows while the game plays: the choice is
   * then kept for edit mode, and the game plays on with all its layers (going back to editing is a Stop, ED-80).
   */
  setHidden(id, hidden) {
    const bit = 1 << id;
    this.hiddenMask = hidden ? this.hiddenMask | bit : this.hiddenMask & ~bit;
    if ((this._engineMask & bit) !== 0) this._showFold();
    const box = this._hideBoxes.get(id);
    if (box !== undefined) box.checked = hidden;
    if (id === this.lightingId() && this.unlit !== hidden) {
      this.unlit = hidden;
      saveUnlit(hidden);
    }
    this.editMode.debugUI.hosted?.onEditorChanged?.();
    if (!this.editMode.active) return;
    if (hidden) this._hide(id);
    else this._show(id);
  }

  /** Lock or unlock layer `id`: the scene list marks its entities again. */
  setLocked(id, locked) {
    const bit = 1 << id;
    this.lockedMask = locked ? this.lockedMask | bit : this.lockedMask & ~bit;
    this.editMode.debugUI.hosted?.tree?.render();
  }

  /** Whether the editor leaves entity `i` where it is: a layer of its is locked. */
  locked(i) {
    return this.lockedMask !== 0 && (entityLayerMask(i) & this.lockedMask) !== 0;
  }

  /** Whether a click in the view leaves entity `i` out: a layer of its is locked, or every one is hidden now. */
  unpickable(i) {
    if (this.lockedMask === 0 && this._appliedMask === 0) return false;
    const mask = entityLayerMask(i);
    if ((mask & this.lockedMask) !== 0) return true;
    return mask !== 0 && (mask & ~this._appliedMask) === 0;
  }

  /** The name of a locked layer entity `i` is in, for the status line; null when none is. */
  lockedLayerOf(i) {
    const mask = entityLayerMask(i) & this.lockedMask;
    return mask === 0 ? null : Layer.getName(31 - Math.clz32(mask & -mask));
  }

  _hide(id) {
    const bit = 1 << id;
    const layer = Layer._visible ? Layer.getById(id) : null;
    if (!layer || (this._appliedMask & bit) !== 0) return;
    if (layer.visible) this._shownBefore |= bit;
    else this._shownBefore &= ~bit;
    layer.visible = false;
    this._appliedMask |= bit;
  }

  _show(id) {
    const bit = 1 << id;
    if ((this._appliedMask & bit) === 0) return;
    this._appliedMask &= ~bit;
    const layer = Layer._visible ? Layer.getById(id) : null;
    // What it showed before; something else that showed it meanwhile (the Layers panel) is left as it is.
    if (layer && !layer.visible && (this._shownBefore & bit) !== 0) layer.visible = true;
    this._shownBefore &= ~bit;
  }

  // ---- the palette's Layers section ----

  /**
   * The rows of the running scene's layers into `box`: built when the scene changes, not on every palette refresh.
   * @param {HTMLElement} box
   */
  fill(box) {
    const scene = this.editMode.debugUI.scene ?? null;
    if (box === this._box && scene === this._boxScene) return;
    this._box = box;
    this._boxScene = scene;
    box.textContent = '';
    this._fold = null;
    this._engineRows = [];
    this._engineMask = 0;
    this._hideBoxes.clear();
    const layers = editorLayersOf(scene);
    if (layers.length === 0) return;
    const head = document.createElement('div');
    head.style.cssText = HEAD_STYLE;
    head.append(cell('hide', 'Not drawn while editing'), cell('lock', 'Not picked or moved by the editor'), cell('layers', ''));
    box.appendChild(head);
    for (const layer of layers) if (!isEngineLayer(layer)) box.appendChild(this._row(layer));
    for (const layer of layers) {
      if (!isEngineLayer(layer)) continue;
      if (this._fold === null) {
        this._fold = this._foldLine();
        box.appendChild(this._fold);
      }
      const row = this._row(layer);
      row.dataset.engine = '';
      row.style.display = this.engineOpen ? 'grid' : 'none';
      this._engineRows.push(row);
      this._engineMask |= 1 << layer.id;
      box.appendChild(row);
    }
    this._showFold();
  }

  /** Show or fold the engine's layers. */
  setEngineOpen(open) {
    if (open === this.engineOpen) return;
    this.engineOpen = open;
    const display = open ? 'grid' : 'none';
    for (const row of this._engineRows) row.style.display = display;
    this._showFold();
  }

  /** The line over the engine's layers: a click shows or folds them. */
  _foldLine() {
    const line = document.createElement('button');
    line.type = 'button';
    line.className = 'weed-layers-fold';
    line.dataset.engineLayers = '';
    line.style.cssText = FOLD_STYLE;
    line.title =
      'The layers the engine makes for lighting, glows, shadows and decals (the game’s own are above): ' +
      'click to show or fold them. Hide works on them too.';
    line.onclick = () => this.setEngineOpen(!this.engineOpen);
    return line;
  }

  /** The fold line's text: open or folded, how many, and folded, how many of them are hidden while editing. */
  _showFold() {
    const line = this._fold;
    if (line === null) return;
    let hidden = 0;
    for (let bits = this.hiddenMask & this._engineMask; bits !== 0; bits &= bits - 1) hidden++;
    const count = this._engineRows.length;
    const text = `${this.engineOpen ? '▾' : '▸'} Engine layers · ${count}${!this.engineOpen && hidden > 0 ? ` · ${hidden} hidden` : ''}`;
    if (line.textContent === text) return;
    line.textContent = text; // its arrow says open or folded: the state changes only with it
    line.setAttribute('aria-expanded', this.engineOpen ? 'true' : 'false');
  }

  _row(layer) {
    const row = document.createElement('div');
    row.style.cssText = ROW_STYLE;
    row.dataset.layer = layer.name;
    const hide = checkbox(this.isHidden(layer.id), `Hide ${layer.name} while editing (a view setting: not saved)`);
    hide.dataset.switch = 'hide';
    hide.onchange = () => this.setHidden(layer.id, hide.checked);
    this._hideBoxes.set(layer.id, hide);
    row.appendChild(hide);
    if (lockable(layer)) {
      const lock = checkbox(this.isLocked(layer.id), `Lock ${layer.name}: the editor does not pick or move its entities`);
      lock.dataset.switch = 'lock';
      lock.onchange = () => this.setLocked(layer.id, lock.checked);
      row.appendChild(lock);
    } else {
      row.appendChild(document.createElement('span'));
    }
    const name = document.createElement('span');
    name.textContent = layer.name;
    name.style.cssText = 'font-size:11px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const kind = document.createElement('span');
    kind.textContent = layer.kind;
    kind.style.cssText = 'font-size:10px;color:#777';
    row.append(name, kind);
    return row;
  }
}

function cell(text, title) {
  const span = document.createElement('span');
  span.textContent = text;
  span.title = title;
  return span;
}

function checkbox(checked, title) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'debug-ui-checkbox';
  box.checked = checked;
  box.title = title;
  return box;
}
