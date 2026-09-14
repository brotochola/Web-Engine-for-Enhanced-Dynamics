// SavesPanel.js — Save / load sparse entity saves for the current scene

import { createPanel, createRow, createStat, createButton } from '../ui/DebugDOM.js';
import { SaveStore } from '../../save/SaveStore.js';

export class SavesPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
    this.selectedId = null;
    this._busy = false;
  }

  create() {
    this.panel = createPanel();

    const actions = createRow('gap:8px;flex-wrap:wrap');
    this.elements.saveBtn = createButton('Save', '', () => this._onSave());
    this.elements.loadBtn = createButton('Load', '', () => this._onLoad());
    this.elements.refreshBtn = createButton('Refresh', '', () => this.refreshList());
    actions.appendChild(this.elements.saveBtn);
    actions.appendChild(this.elements.loadBtn);
    actions.appendChild(this.elements.refreshBtn);
    this.panel.appendChild(actions);

    this.elements.status = createStat('No saves for this scene');
    this.elements.status.style.display = 'block';
    this.elements.status.style.marginTop = '8px';
    this.panel.appendChild(this.elements.status);

    this.elements.list = document.createElement('div');
    this.elements.list.style.cssText =
      'margin-top:8px;max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:4px';
    this.panel.appendChild(this.elements.list);

    this._updateLoadEnabled();
    return this.panel;
  }

  attach() {
    this.selectedId = null;
    this.refreshList();
  }

  update() {
    /* list refreshed on attach / save / load */
  }

  _sceneName() {
    return this.debugUI.scene?.constructor?.name || null;
  }

  _setStatus(text, isError = false) {
    if (!this.elements.status) return;
    this.elements.status.textContent = text;
    this.elements.status.style.color = isError ? '#f88' : '';
  }

  _updateLoadEnabled() {
    if (this.elements.loadBtn) {
      this.elements.loadBtn.disabled = !this.selectedId || this._busy;
    }
    if (this.elements.saveBtn) {
      this.elements.saveBtn.disabled = this._busy || !this.debugUI.scene;
    }
  }

  async refreshList() {
    const sceneName = this._sceneName();
    const list = this.elements.list;
    if (!list) return;

    list.innerHTML = '';
    if (!sceneName) {
      this._setStatus('No scene');
      this.selectedId = null;
      this._updateLoadEnabled();
      return;
    }

    let entries = [];
    try {
      entries = await SaveStore.listForScene(sceneName);
    } catch (err) {
      this._setStatus(String(err?.message || err), true);
      this._updateLoadEnabled();
      return;
    }

    if (entries.length === 0) {
      this._setStatus('No saves for this scene');
      this.selectedId = null;
      this._updateLoadEnabled();
      return;
    }

    this._setStatus(`${entries.length} save(s) for ${sceneName}`);

    if (this.selectedId && !entries.some((e) => e.id === this.selectedId)) {
      this.selectedId = null;
    }

    for (const meta of entries) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:stretch;gap:4px;width:100%';

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'debug-ui-btn';
      selectBtn.style.cssText = 'text-align:left;flex:1;white-space:normal';
      if (meta.id === this.selectedId) selectBtn.classList.add('active');

      const when = meta.savedAt ? new Date(meta.savedAt).toLocaleString() : '?';
      const kb = meta.bytes != null ? `${(meta.bytes / 1024).toFixed(1)} KB` : '?';
      const ents = meta.entityCount != null ? `${meta.entityCount} ents` : '';
      const lf = (meta.particleCount | 0) > 0 ? `${meta.particleCount} lf` : '';
      const counts = [ents, lf].filter(Boolean).join(' · ');
      selectBtn.textContent = `${meta.id}\n${when} · ${kb}${counts ? ` · ${counts}` : ''}`;

      selectBtn.onclick = () => {
        this.selectedId = meta.id;
        this.refreshList();
      };
      selectBtn.ondblclick = () => {
        this.selectedId = meta.id;
        this._onLoad();
      };

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'debug-ui-btn';
      deleteBtn.title = `Delete ${meta.id}`;
      deleteBtn.setAttribute('aria-label', `Delete ${meta.id}`);
      deleteBtn.textContent = '×';
      deleteBtn.style.cssText =
        'flex:0 0 28px;padding:0;font-size:18px;line-height:1;color:#f88';
      deleteBtn.disabled = this._busy;
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this._onDelete(meta.id);
      };

      row.appendChild(selectBtn);
      row.appendChild(deleteBtn);
      list.appendChild(row);
    }

    this._updateLoadEnabled();
  }

  async _onSave() {
    const scene = this.debugUI.scene;
    if (!scene || this._busy) return;
    this._busy = true;
    this._updateLoadEnabled();
    this._setStatus('Saving…');
    try {
      const result = await scene.saveGame();
      this.selectedId = result.meta.id;
      const pc = result.particleCount | 0;
      this._setStatus(
        `Saved ${result.entityCount} entities, ${pc} particles (${(result.bytes / 1024).toFixed(1)} KB)`
      );
    } catch (err) {
      console.error(err);
      this._setStatus(String(err?.message || err), true);
    } finally {
      this._busy = false;
      this._updateLoadEnabled();
      await this.refreshList();
    }
  }

  async _onLoad() {
    const scene = this.debugUI.scene;
    if (!scene || !this.selectedId || this._busy) return;
    this._busy = true;
    this._updateLoadEnabled();
    this._setStatus(`Loading ${this.selectedId}…`);
    try {
      await scene.loadGame(this.selectedId);
      this._setStatus(`Loaded ${this.selectedId}`);
    } catch (err) {
      console.error(err);
      this._setStatus(String(err?.message || err), true);
    } finally {
      this._busy = false;
      this._updateLoadEnabled();
      await this.refreshList();
    }
  }

  async _onDelete(slotId) {
    if (!slotId || this._busy) return;
    this._busy = true;
    this._updateLoadEnabled();
    this._setStatus(`Deleting ${slotId}…`);
    try {
      await SaveStore.remove(slotId);
      if (this.selectedId === slotId) this.selectedId = null;
      this._setStatus(`Deleted ${slotId}`);
    } catch (err) {
      console.error(err);
      this._setStatus(String(err?.message || err), true);
    } finally {
      this._busy = false;
      this._updateLoadEnabled();
      await this.refreshList();
    }
  }
}
