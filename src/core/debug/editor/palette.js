// palette.js — the editor's palette (VISUAL_EDITOR_PLAN.md ED-11): the running scene's entity classes, each with how
// many the open scene file places against its pool, and a button that places new ones (each click on the view puts
// one there, until Esc or the button again). Above them, the level row (ED-38): the scene files of the running one's
// folder, Open, New and Save As. Below it, the scene's layers with hide and lock (editorLayers.js, ED-24), and its
// Tiled tilemaps with a button that loads one again in place (tilemapList.js, ED-26). Shown while edit mode is on;
// rebuilt when the document or the file list changes, never per frame (the layers and tilemaps when the scene
// changes). In the editor page (D9) it is the Assets dock, shown whether or not edit mode is on: its + enters edit
// mode.

import { FloatingPanel } from '../ui/floatingPanel.js';
import { TilemapList } from './tilemapList.js';

/** Classes the editor does not offer: the engine's own helpers. */
const UNPLACEABLE = new Set(['Flash']);

/** A section above the classes: the level row, the layers, the tilemaps. */
const SECTION_STYLE = 'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.1)';

const SELECT_STYLE =
  'flex:1;min-width:0;font-size:11px;padding:2px 4px;background:rgba(0,0,0,0.5);color:white;' +
  'border:1px solid rgba(255,255,255,0.3);border-radius:3px;cursor:pointer';

export class Palette {
  /** @param {object} editMode - the EditMode it places through */
  constructor(editMode) {
    this.editMode = editMode;
    this._panel = null;
    /** The palette's content: in the floating panel, or in the editor page's Assets dock. */
    this._body = null;
    this._files = null;
    /** The Layers section: hide and lock per layer (editorLayers.js, ED-24), built when the scene changes. */
    this._layers = null;
    /** The Tilemaps section (ED-26), built when the scene changes; hidden without tilemaps. */
    this._tilemaps = null;
    this._tilemapList = new TilemapList(editMode);
    this._list = null;
  }

  show() {
    if (this._body === null) this._createBody();
    const dock = this.editMode.debugUI.hosted?.slot('assets') ?? null;
    if (dock !== null) {
      if (this._body.parentNode !== dock) dock.replaceChildren(this._body);
    } else if (this._panel === null) {
      this._createPanel();
    } else {
      this._panel.show();
    }
    this.refresh();
  }

  /** Leaving edit mode: the floating panel goes; the editor page's Assets dock stays. */
  hide() {
    if (this._panel !== null) this._panel.hide();
  }

  destroy() {
    if (this._panel === null) return;
    this._panel.onClose = null;
    this._panel.close();
    this._panel = null;
  }

  /** The rows again: after a change to the document, a swap, the file list, or what is being placed. */
  refresh() {
    const list = this._list;
    if (list === null) return;
    this._fillFiles();
    if (this._layers !== null) this.editMode.layers?.fill(this._layers);
    if (this._tilemaps !== null) this._tilemapList.fill(this._tilemaps);
    list.textContent = '';
    const scene = this.editMode.debugUI.scene;
    const placed = new Map();
    for (const record of scene?.sceneFile?.entities || []) placed.set(record.class, (placed.get(record.class) || 0) + 1);
    for (const { class: EntityClass } of scene?.registeredClasses || []) {
      const name = EntityClass.name;
      if (UNPLACEABLE.has(name)) continue;
      list.appendChild(this._row(name, placed.get(name) || 0, EntityClass.poolSize | 0));
    }
  }

  /** The level row: the folder's scene files (the running one chosen), Open, New and Save As. */
  _fillFiles() {
    const box = this._files;
    if (box === null) return;
    box.textContent = '';
    const editMode = this.editMode;
    const current = editMode.sceneFileName;
    if (current === null) {
      const note = document.createElement('div');
      note.textContent = 'This scene was loaded from its class, not a scene file: nothing to open or save.';
      note.style.cssText = 'font-size:10px;color:#888;white-space:normal';
      box.appendChild(note);
      return;
    }
    const names = editMode.sceneFiles.includes(current) ? editMode.sceneFiles : [current, ...editMode.sceneFiles];
    const select = document.createElement('select');
    select.style.cssText = SELECT_STYLE;
    select.title = 'The scene files of this folder';
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    select.value = current;
    const open = this._button('Open', 'Open the chosen file (a fast swap for this scene class)', () => editMode.openSceneFile(select.value));
    const create = this._button('New', 'A new, empty scene file of this scene class, in this folder', () => {
      const name = prompt('A new scene file, in this folder:', 'level.scene.json');
      if (name !== null) editMode.newSceneFile(name);
    });
    const saveAs = this._button('Save As', 'Write this level to another file of this folder, and keep editing that one', () => {
      const name = prompt('Save this scene file as:', current);
      if (name !== null) editMode.saveSceneFileAs(name);
    });
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;align-items:center';
    row.appendChild(select);
    row.appendChild(open);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:4px;margin-top:4px';
    actions.appendChild(create);
    actions.appendChild(saveAs);
    box.appendChild(row);
    box.appendChild(actions);
  }

  _button(text, title, onclick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'debug-ui-btn';
    button.textContent = text;
    button.title = title;
    button.onclick = onclick;
    return button;
  }

  _row(className, placed, pool) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0';
    row.dataset.className = className;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'debug-ui-btn';
    button.textContent = '+';
    button.title = `Place ${className}: each click on the view puts one there (Esc stops)`;
    if (this.editMode.placing === className) button.classList.add('active');
    button.onclick = () => this.editMode.startPlacing(className);
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;font-size:11px;color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    label.textContent = className;
    const count = document.createElement('span');
    count.style.cssText = `font-size:10px;color:${placed >= pool ? '#f87171' : '#888'}`;
    count.textContent = `${placed} / ${pool}`;
    count.title = `${placed} placed by this file; the scene's pool holds ${pool}`;
    row.appendChild(button);
    row.appendChild(label);
    row.appendChild(count);
    return row;
  }

  _createBody() {
    this._body = document.createElement('div');
    this._files = document.createElement('div');
    this._files.style.cssText = SECTION_STYLE;
    this._layers = document.createElement('div');
    this._layers.style.cssText = SECTION_STYLE;
    this._tilemaps = document.createElement('div');
    this._tilemaps.style.cssText = SECTION_STYLE;
    this._list = document.createElement('div');
    this._body.append(this._files, this._layers, this._tilemaps, this._list);
  }

  _createPanel() {
    const left = typeof window !== 'undefined' ? Math.max(12, window.innerWidth - 252) : 12;
    const panel = new FloatingPanel({
      title: 'Palette',
      left,
      top: 78,
      width: 240,
      onClose: () => {
        this._panel = null;
      },
    });
    panel.body.appendChild(this._body);
    panel.mount();
    this._panel = panel;
  }
}
