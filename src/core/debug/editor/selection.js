// selection.js — what the editor has selected (VISUAL_EDITOR_PLAN.md ED-8): one entity, picked with a left click in
// edit mode (pick.js), boxed by the debug overlay's selected-entity drawing, and named in the editor's panel with
// whether it is authored (placed by the running scene file: editing and saving it changes the level) or runtime
// (spawned by code, which the file does not hold: read-only).
//
// The selection is the entity, not its slot: it keeps the spawn generation, and an entity that despawns (or whose
// slot goes to another) is not selected any more. A fast swap clears it.
//
// An authored entity's panel has its position, rotation and scale first (transformFields.js, ED-53), then a field
// per spawn param (paramWidgets.js, ED-7). A change goes through the editor
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
import { JointsPanel } from './jointsPanel.js';
import { recordOf, paramsOf, writeParam, writeConfig } from './sceneDocument.js';
import { AssetCatalog } from './assetPicker.js';
import { TransformFields } from './transformFields.js';
import { InspectorSection } from './inspectorSection.js';
import { RigidBody } from '../../../components/rigidBody.js';
import { describeSpawnParams } from '../../spawnParams.js';
import { jointsOf } from './sceneJoints.js';

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
    /** Position, rotation and scale (transformFields.js, ED-53), made with the panel. */
    this.transform = null;
    /** The sections that fold (inspectorSection.js, ED-54): transform, params, joints, live. */
    this._sections = null;
    /** The live values (liveInspector.js), made with the panel. */
    this.live = null;
    /** The file's joints that name the entity (jointsPanel.js, ED-21), made with the panel. */
    this.joints = null;
    this._classNameOf = (entityType) => debugUI.tools._classNameForType(entityType);
    /** A click in the view leaves out what a locked or hidden layer holds (editorLayers.js, ED-24). */
    this._unpickable = (index) => this.editor?.layers?.unpickable(index) === true;
    this._hooks = {
      onChange: (key, value) =>
        this.editor.editSelected(`${this.name}.${key}`, (record, description) => writeParam(record, description, key, value)),
      onConfig: (config) => this.editor.editSelected(`${this.name} config`, (record) => writeConfig(record, config)),
      entityNames: (className) => namesOf(debugUI.scene, className, this.name),
      // Stage 4: an entity param picked in the view, a point added to a points param (entityPicker.js, handles.js).
      pickEntity: (key, className, button) => this.editor.picker?.start(key, className, button),
      addPoint: (key) => this.editor.handles?.addPoint(key),
    };

    // What the scene loaded, for the sprite and animation params' pickers (assetPicker.js, ED-45).
    this._hooks.assets = new AssetCatalog(() => debugUI.scene);
  }

  /** Placed by the running scene file (it has a name there). */
  get authored() {
    return this.name !== null;
  }

  /** A left click at a world point: what is there (the next one on a click at the same spot), or nothing. */
  pickAt(x, y) {
    const index = pickEntityAt(x, y, this.index, this._classNameOf, this._unpickable);
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
    this.transform?.cancelDrag();
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
    const sections = this._sections;
    this._nameRow.style.display = found === null ? 'none' : 'flex';
    this.transform.show(found === null ? null : found.record, this.index);
    sections.transform.visible = found !== null;
    sections.params.visible = found !== null;
    if (found === null) {
      this._fields.textContent = '';
    } else {
      this._nameInput.value = this.name;
      const description = paramsOf(scene, found.record);
      sections.params.title = description === null ? 'Config' : 'Params';
      buildParamFields(this._fields, description, found.record.config || {}, this._hooks);
    }
    // Joints: for a class with a body; open when the entity has joints, else as the author left it (folded at first).
    const registered = registeredOf(scene, Transform.entityType[this.index]);
    const withBody = found !== null && registered !== null && (registered.components || []).includes(RigidBody);
    let joints = 0;
    if (withBody) for (const joint of jointsOf(scene)) if (joint.a === this.name || joint.b === this.name) joints++;
    sections.joints.visible = withBody;
    sections.joints.note.textContent = joints > 0 ? String(joints) : '';
    sections.joints.setOpen(joints > 0 || sections.joints.rememberedOpen(false), false);
    this.joints.show(withBody ? this.name : null);
    // Live: folded until opened; folded, it has no rows and its tick reads nothing.
    sections.live.note.textContent = registered !== null ? describeLive(registered) : '';
    if (sections.live.open) this.live.show(this.index);
    else this.live.clear();
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
    // Another look (ED-56): a new seed for what onSpawned draws at random; with several selected, for each.
    const reroll = document.createElement('button');
    reroll.type = 'button';
    reroll.className = 'debug-ui-btn';
    reroll.textContent = '🎲';
    reroll.title = 'Another look: a new seed for what its onSpawned draws at random (a house picks another sprite); with several selected, each its own. Ctrl+Z goes back';
    reroll.style.cssText = 'flex:none;padding:1px 6px';
    reroll.onclick = () => this.editor.rerollSelected();
    this._nameRow.appendChild(reroll);
    this._fields = document.createElement('div');
    this.transform = new TransformFields(this);
    this.joints = new JointsPanel(this);
    this.live = new LiveInspector(this);
    const sections = {
      transform: new InspectorSection('transform', 'Transform'),
      params: new InspectorSection('params', 'Params'),
      joints: new InspectorSection('joints', 'Joints', { open: false }),
      live: new InspectorSection('live', 'Live', {
        open: false,
        onToggle: (open) => {
          if (open && this.index >= 0) this.live.show(this.index);
          else this.live.clear();
        },
      }),
    };
    sections.transform.body.appendChild(this.transform.el);
    sections.params.body.appendChild(this._fields);
    sections.joints.body.appendChild(this.joints.el);
    sections.live.body.appendChild(this.live.el);
    this._sections = sections;
    this._body.append(this._title, this._detail, this._nameRow, sections.transform.el, sections.params.el, sections.joints.el, sections.live.el);
  }

  /** How many others are selected with it (ED-28): a line under its name. */
  showCount(count) {
    if (this._detail === null || !this.authored) return;
    const file = this.debugUI.scene?.sceneFileUrl ? new URL(this.debugUI.scene.sceneFileUrl).pathname.split('/').pop() : 'the scene file';
    this._detail.textContent =
      count > 0
        ? `And ${count} more selected: a move, Del and Ctrl+D act on all; Ctrl+G groups them.`
        : `Placed by ${file}: changes to it are saved there.`;
  }

  _onPanelClosed() {
    this._panel = null;
    this.clear();
  }
}

/** The scene's registered class for an entity type, or null. */
function registeredOf(scene, entityType) {
  for (const registered of scene?.registeredClasses || []) if (registered.entityType === entityType) return registered;
  return null;
}

/** The Live section's note: its components. */
function describeLive(registered) {
  const names = (registered.components || []).map((C) => C.name).filter((name) => name !== 'Transform');
  return names.length > 0 ? `Transform, ${names.join(', ')}` : 'Transform';
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
