// selection.js — what the editor has selected (VISUAL_EDITOR_PLAN.md ED-8): one entity, picked with a left click in
// edit mode (pick.js), boxed by the debug overlay's selected-entity drawing, and named in the editor's panel with
// whether it is authored (placed by the running scene file: editing and saving it changes the level) or runtime
// (spawned by code, which the file does not hold: read-only).
//
// The selection is the entity, not its slot: it keeps the spawn generation, and an entity that despawns (or whose
// slot goes to another) is not selected any more. A fast swap clears it.
//
// An authored entity's panel has a field per spawn param (paramWidgets.js, ED-7). A change edits its record in the
// scene file's document and respawns it (sceneDocument.js, ED-9); the selection moves to the respawned entity.
//
// Cost: the panel is made on the first selection, its fields on each selection. A click or an edit allocates; a
// frame does not.

import { Transform } from '../../../components/transform.js';
import { Messages } from '../../messages.js';
import { FloatingPanel } from '../ui/floatingPanel.js';
import { pickEntityAt } from './pick.js';
import { buildParamFields } from './paramWidgets.js';
import { recordOf, paramsOf, setParam, setConfig } from './sceneDocument.js';

export class Selection {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.index = -1;
    /** index · 65536 + spawn generation when selected. */
    this.packed = -1;
    /** Its name in the running scene file, or null for a runtime entity. */
    this.name = null;
    this.className = '';

    /** Called after each edit (EditMode marks the document unsaved). */
    this.onEdit = null;

    this._panel = null;
    this._title = null;
    this._detail = null;
    this._fields = null;
    this._classNameOf = (entityType) => debugUI.tools._classNameForType(entityType);
    this._hooks = {
      onChange: (key, value) => this._edited(setParam(debugUI.scene, this.name, key, value)),
      onConfig: (config) => this._edited(setConfig(debugUI.scene, this.name, config)),
      entityNames: (className) => namesOf(debugUI.scene, className, this.name),
    };
  }

  /** Placed by the running scene file (it has a name there). */
  get authored() {
    return this.name !== null;
  }

  /** A left click at a world point: what is there (the next one on a click at the same spot), or nothing. */
  pickAt(x, y) {
    const index = pickEntityAt(x, y, this.index, this._classNameOf);
    if (index < 0) this.clear();
    else this.select(index);
  }

  /** @param {number} index */
  select(index) {
    const debugUI = this.debugUI;
    this.index = index;
    this.packed = index * 65536 + (Messages.spawnGen[index] | 0);
    this.name = nameOf(debugUI.scene, this.packed);
    this.className = this._classNameOf(Transform.entityType[index]);
    debugUI.debugFlags?.setSelectedEntity(index);
    debugUI.canvas.startLoop();
    this._show();
  }

  clear() {
    if (this.index < 0) return;
    this.index = -1;
    this.packed = -1;
    this.name = null;
    this.className = '';
    this.debugUI.debugFlags?.clearSelectedEntity();
    this.debugUI.canvas.syncLoop();
    if (this._panel) this._panel.hide();
  }

  /**
   * The debug UI's tick: an entity that despawned, or whose slot went to another, is not selected any more. A
   * despawn bumps the slot's generation; a spawn waiting for logic0 is not active yet, and stays selected.
   */
  update() {
    const i = this.index;
    if (i < 0) return;
    if (i * 65536 + (Messages.spawnGen[i] | 0) !== this.packed) this.clear();
  }

  /** After an edit: select the respawned entity (its fields from the record as it is now). */
  _edited(index) {
    if (index >= 0) this.select(index);
    else this.clear();
    if (this.onEdit) this.onEdit();
  }

  destroy() {
    this.clear();
    if (this._panel) {
      this._panel.onClose = null;
      this._panel.close();
      this._panel = null;
    }
  }

  _show() {
    if (this._panel === null) this._createPanel();
    else this._panel.show();
    const scene = this.debugUI.scene;
    if (this.authored) {
      this._title.textContent = `${this.name}  ·  ${this.className} #${this.index}`;
      const file = scene?.sceneFileUrl ? new URL(scene.sceneFileUrl).pathname.split('/').pop() : 'the scene file';
      this._detail.textContent = `Placed by ${file}: changes to it are saved there.`;
      this._detail.style.color = '#34d399';
    } else {
      this._title.textContent = `${this.className} #${this.index}`;
      this._detail.textContent = 'Spawned by code, not by the scene file: read-only.';
      this._detail.style.color = '#888';
    }
    const found = this.authored ? recordOf(scene, this.name) : null;
    if (found === null) {
      this._fields.textContent = '';
      return;
    }
    buildParamFields(this._fields, paramsOf(scene, found.record), found.record.config || {}, this._hooks);
  }

  _createPanel() {
    const panel = new FloatingPanel({ title: 'Editor', left: 12, top: 78, width: 320, onClose: () => this._onPanelClosed() });
    this._title = document.createElement('div');
    this._title.style.cssText = 'color:#fff;font-weight:bold;margin-bottom:4px';
    this._detail = document.createElement('div');
    this._detail.style.cssText = 'font-size:12px;margin-bottom:6px';
    this._fields = document.createElement('div');
    panel.body.appendChild(this._title);
    panel.body.appendChild(this._detail);
    panel.body.appendChild(this._fields);
    panel.mount();
    this._panel = panel;
  }

  _onPanelClosed() {
    this._panel = null;
    this.clear();
  }
}

/** The names an entity param can take: the file's entities of `className` (any class without one), but `self`. */
function namesOf(scene, className, self) {
  const names = [];
  for (const record of scene?.sceneFile?.entities || []) {
    if (record.name !== self && (className === undefined || record.class === className)) names.push(record.name);
  }
  return names;
}

/** The running scene file's name for an entity (index and generation), or null. */
function nameOf(scene, packed) {
  const names = scene?._namedEntities;
  if (!names) return null;
  for (const [name, p] of names) if (p === packed) return name;
  return null;
}
