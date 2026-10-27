// selection.js — what the editor has selected (VISUAL_EDITOR_PLAN.md ED-8): one entity, picked with a left click in
// edit mode (pick.js), boxed by the debug overlay's selected-entity drawing, and named in the editor's panel with
// whether it is authored (placed by the running scene file: editing and saving it changes the level) or runtime
// (spawned by code, which the file does not hold: read-only).
//
// The selection is the entity, not its slot: it keeps the spawn generation, and an entity that despawns (or whose
// slot goes to another) is not selected any more. A fast swap clears it.
//
// An authored entity's panel has a field per spawn param (paramWidgets.js, ED-7). A change goes through the editor
// (EditMode.editSelected): it edits the record in the scene file's document, respawns the entity (sceneDocument.js,
// ED-9), keeps the change for undo, and selects the respawned entity.
//
// In the editor page (D9) the panel's body goes into its Inspector dock instead of a floating panel, and the scene
// list hears of each change of the selection.
//
// Below the params, the live values of the entity's components (liveInspector.js, ED-17): the selection stays while
// the game plays, so they show the entity as it plays; they change the live entity, and "Copy to scene" its record.
//
// Cost: the panel is made on the first selection, its fields on each selection. A click or an edit allocates; a
// frame does not.

import { Transform } from '../../../components/transform.js';
import { Messages } from '../../messages.js';
import { FloatingPanel } from '../ui/floatingPanel.js';
import { pickEntityAt } from './pick.js';
import { buildParamFields } from './paramWidgets.js';
import { LiveInspector } from './liveInspector.js';
import { recordOf, paramsOf, writeParam, writeConfig } from './sceneDocument.js';

export class Selection {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.index = -1;
    /** index · 65536 + spawn generation when selected. */
    this.packed = -1;
    /** Its name in the running scene file, or null for a runtime entity. */
    this.name = null;
    this.className = '';

    /** The editor the selection's changes go through (EditMode.editSelected). */
    this.editor = null;

    this._panel = null;
    /** The panel's content: in the floating panel, or in the editor page's Inspector dock. */
    this._body = null;
    this._title = null;
    this._detail = null;
    this._nameRow = null;
    this._nameInput = null;
    this._fields = null;
    /** The live values (liveInspector.js), made with the panel. */
    this.live = null;
    this._classNameOf = (entityType) => debugUI.tools._classNameForType(entityType);
    this._hooks = {
      onChange: (key, value) =>
        this.editor.editSelected(`${this.name}.${key}`, (record, description) => writeParam(record, description, key, value)),
      onConfig: (config) => this.editor.editSelected(`${this.name} config`, (record) => writeConfig(record, config)),
      entityNames: (className) => namesOf(debugUI.scene, className, this.name),
      // Stage 4: an entity param picked in the view, a point added to a points param (entityPicker.js, handles.js).
      pickEntity: (key, className, button) => this.editor.picker?.start(key, className, button),
      addPoint: (key) => this.editor.handles?.addPoint(key),
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
    debugUI.hosted?.onSelectionChanged();
  }

  clear() {
    if (this.index < 0) return;
    this.index = -1;
    this.packed = -1;
    this.name = null;
    this.className = '';
    this.debugUI.debugFlags?.clearSelectedEntity();
    this.debugUI.canvas.syncLoop();
    this.live?.clear();
    if (this._panel) this._panel.hide();
    else if (this._body !== null) this._body.remove(); // the Inspector dock says nothing is selected
    this.debugUI.hosted?.onSelectionChanged();
  }

  /**
   * The debug UI's tick: an entity that despawned, or whose slot went to another, is not selected any more. A
   * despawn bumps the slot's generation; a spawn waiting for logic0 is not active yet, and stays selected.
   */
  update() {
    const i = this.index;
    if (i < 0) return;
    if (i * 65536 + (Messages.spawnGen[i] | 0) !== this.packed) this.clear();
    else this.live?.update();
  }

  destroy() {
    this.clear();
    if (this._panel) {
      this._panel.onClose = null;
      this._panel.close();
      this._panel = null;
    }
  }

  /** Put the panel's body where it shows: the editor page's Inspector dock, or a floating panel of this page. */
  _mount() {
    if (this._body === null) this._createBody();
    const dock = this.debugUI.hosted?.slot('inspector') ?? null;
    if (dock !== null) {
      if (this._body.parentNode !== dock) dock.replaceChildren(this._body);
      return;
    }
    if (this._panel === null) {
      const panel = new FloatingPanel({ title: 'Editor', left: 12, top: 78, width: 320, onClose: () => this._onPanelClosed() });
      panel.body.appendChild(this._body);
      panel.mount();
      this._panel = panel;
    } else {
      this._panel.show();
    }
  }

  _show() {
    this._mount();
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
    this._nameRow.style.display = found === null ? 'none' : 'flex';
    if (found === null) {
      this._fields.textContent = '';
    } else {
      this._nameInput.value = this.name;
      buildParamFields(this._fields, paramsOf(scene, found.record), found.record.config || {}, this._hooks);
    }
    this.live.show(this.index);
  }

  _createBody() {
    this._body = document.createElement('div');
    this._title = document.createElement('div');
    this._title.style.cssText = 'color:#fff;font-weight:bold;margin-bottom:4px';
    this._detail = document.createElement('div');
    this._detail.style.cssText = 'font-size:12px;margin-bottom:6px';
    // The name in the file: renaming keeps names unique and follows the entity params that name it (ED-11).
    this._nameRow = document.createElement('div');
    this._nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = 'Name';
    nameLabel.style.cssText = 'font-size:11px;color:#ccc;width:84px;flex:none';
    this._nameInput = document.createElement('input');
    this._nameInput.type = 'text';
    this._nameInput.style.cssText =
      'flex:1;min-width:0;font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;' +
      'border:1px solid rgba(255,255,255,0.3);border-radius:3px';
    this._nameInput.onchange = () => {
      if (!this.editor.renameSelected(this._nameInput.value)) this._nameInput.value = this.name;
    };
    this._nameRow.appendChild(nameLabel);
    this._nameRow.appendChild(this._nameInput);
    this._fields = document.createElement('div');
    this.live = new LiveInspector(this);
    this._body.append(this._title, this._detail, this._nameRow, this._fields, this.live.el);
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
