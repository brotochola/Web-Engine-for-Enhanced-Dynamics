// palette.js — the editor's palette (VISUAL_EDITOR_PLAN.md ED-11): the running scene's entity classes, each with how
// many the open scene file places against its pool, and a button that places new ones (each click on the view puts
// one there, until Esc or the button again). Shown while edit mode is on; its rows are rebuilt when the document
// changes, never per frame.

import { FloatingPanel } from '../ui/floatingPanel.js';

/** Classes the editor does not offer: the engine's own helpers. */
const UNPLACEABLE = new Set(['Flash']);

export class Palette {
  /** @param {object} editMode - the EditMode it places through */
  constructor(editMode) {
    this.editMode = editMode;
    this._panel = null;
    this._list = null;
  }

  show() {
    if (this._panel === null) this._create();
    else this._panel.show();
    this.refresh();
  }

  hide() {
    if (this._panel !== null) this._panel.hide();
  }

  destroy() {
    if (this._panel === null) return;
    this._panel.onClose = null;
    this._panel.close();
    this._panel = null;
  }

  /** The rows again: after a change to the document, a swap, or a change of what is being placed. */
  refresh() {
    const list = this._list;
    if (list === null) return;
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

  _create() {
    const left = typeof window !== 'undefined' ? Math.max(12, window.innerWidth - 252) : 12;
    const panel = new FloatingPanel({
      title: 'Palette',
      left,
      top: 78,
      width: 240,
      onClose: () => {
        this._panel = null;
        this._list = null;
      },
    });
    this._list = document.createElement('div');
    panel.body.appendChild(this._list);
    panel.mount();
    this._panel = panel;
  }
}
