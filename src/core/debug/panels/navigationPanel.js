// NavigationPanel.js — Flowfield / A* path / walkability grid visualization controls

import { createPanel, createRow, createStat, createButton } from '../ui/DebugDOM.js';
import { NavGrid } from '../../NavGrid.js';

export class NavigationPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
  }

  // ------- DOM creation -------

  create() {
    this.panel = createPanel();
    this.panel.classList.add('debug-ui-nav-panel');

    // Header + refresh
    const headerRow = createRow('margin-bottom:8px;justify-content:space-between');
    const title = createStat('Navigation Cache');
    title.style.fontWeight = 'bold';
    headerRow.appendChild(title);
    headerRow.appendChild(createButton('🔄 Refresh', '', () => this._refreshLists()));
    this.panel.appendChild(headerRow);

    // Columns
    const cols = document.createElement('div'); cols.className = 'debug-ui-nav-columns';

    this.elements.navFlowfieldsList = this._addColumn(cols, '🎯 Flowfields', 'nav-ff-count', 'nav-flowfields-list');
    this.elements.navPathsList = this._addColumn(cols, '📍 A* Paths', 'nav-path-count', 'nav-paths-list');
    this.elements.navStaticFlowfieldsList = this._addColumn(cols, '🛣️ Static FF', 'nav-static-ff-count', 'nav-static-flowfields-list');

    this.panel.appendChild(cols);

    // Controls row
    const controlsRow = createRow('margin-top:8px;gap:8px');

    const walkBtn = createButton('🗺️ Show Grid', '', () => {
      const nav = this.debugUI.canvas.nav;
      nav.showWalkabilityGrid = !nav.showWalkabilityGrid;
      walkBtn.classList.toggle('active', nav.showWalkabilityGrid);
      walkBtn.textContent = nav.showWalkabilityGrid ? '🗺️ Hide Grid' : '🗺️ Show Grid';
      this.debugUI.canvas.syncLoop();
    });
    controlsRow.appendChild(walkBtn);
    this.elements.navWalkabilityBtn = walkBtn;

    controlsRow.appendChild(createButton('❌ Clear All', '', () => this._clearVisualization()));
    this.panel.appendChild(controlsRow);

    return this.panel;
  }

  // ------- lifecycle -------

  attach() {}

  update() {}

  onOpen() {
    this._refreshLists();
  }

  onClose() {
    this._clearVisualization();
  }

  // ------- list rendering -------

  _refreshLists() {
    if (!NavGrid._initialized && NavGrid._staticFlowfields.size === 0) {
      this._showMessage('NavGrid not initialized');
      return;
    }

    const flowfields = NavGrid._initialized ? NavGrid.getCachedFlowfieldsList() : [];
    const paths = NavGrid._initialized ? NavGrid.getCachedPathsList() : [];

    this._setCount('nav-ff-count', flowfields.length);
    this._setCount('nav-path-count', paths.length);
    this._setCount('nav-static-ff-count', NavGrid._staticFlowfields.size);

    this._renderFlowfieldsList(flowfields);
    this._renderPathsList(paths);
    this._renderStaticFlowfieldsList();
  }

  _renderFlowfieldsList(flowfields) {
    const container = this.elements.navFlowfieldsList;
    if (!container) return;
    container.innerHTML = '';
    if (flowfields.length === 0) { container.innerHTML = '<div class="debug-ui-nav-empty">No cached flowfields</div>'; return; }

    const nav = this.debugUI.canvas.nav;
    for (const ff of flowfields) {
      const item = document.createElement('div');
      item.className = 'debug-ui-nav-item';
      if (nav.selectedFlowfieldSlot === ff.slotIndex) item.classList.add('selected');
      item.innerHTML = `<span class="slot">#${ff.slotIndex}</span><span class="target">→ (${ff.targetX}, ${ff.targetY})</span>`;
      item.onclick = () => this._selectFlowfield(ff.slotIndex);
      container.appendChild(item);
    }
  }

  _renderPathsList(paths) {
    const container = this.elements.navPathsList;
    if (!container) return;
    container.innerHTML = '';
    if (paths.length === 0) { container.innerHTML = '<div class="debug-ui-nav-empty">No cached paths</div>'; return; }

    const nav = this.debugUI.canvas.nav;
    for (const path of paths) {
      const item = document.createElement('div');
      item.className = 'debug-ui-nav-item';
      if (nav.selectedPathSlot === path.slotIndex) item.classList.add('selected');
      item.innerHTML = `<span class="slot">#${path.slotIndex}</span><span class="path">(${path.fromX},${path.fromY}) → (${path.toX},${path.toY})</span><span class="length">[${path.length}]</span>`;
      item.onclick = () => this._selectPath(path.slotIndex);
      container.appendChild(item);
    }
  }

  _renderStaticFlowfieldsList() {
    const container = this.elements.navStaticFlowfieldsList;
    if (!container) return;
    container.innerHTML = '';
    const names = Array.from(NavGrid._staticFlowfields.keys());
    if (names.length === 0) { container.innerHTML = '<div class="debug-ui-nav-empty">No static flowfields</div>'; return; }

    const nav = this.debugUI.canvas.nav;
    for (const name of names) {
      const ff = NavGrid._staticFlowfields.get(name);
      const item = document.createElement('div');
      item.className = 'debug-ui-nav-item';
      if (nav.selectedStaticFlowfield === name) item.classList.add('selected');
      item.innerHTML = `<span class="slot">${name}</span><span class="target">${ff.gridWidth}x${ff.gridHeight}</span>`;
      item.onclick = () => this._selectStaticFlowfield(name);
      container.appendChild(item);
    }
  }

  // ------- selection -------

  _selectFlowfield(slot) {
    const nav = this.debugUI.canvas.nav;
    nav.selectedPathSlot = -1;
    nav.selectedStaticFlowfield = null;
    nav.selectedFlowfieldSlot = nav.selectedFlowfieldSlot === slot ? -1 : slot;
    this.debugUI.canvas.syncLoop();
    this._refreshLists();
  }

  _selectPath(slot) {
    const nav = this.debugUI.canvas.nav;
    nav.selectedFlowfieldSlot = -1;
    nav.selectedStaticFlowfield = null;
    nav.selectedPathSlot = nav.selectedPathSlot === slot ? -1 : slot;
    this.debugUI.canvas.syncLoop();
    this._refreshLists();
  }

  _selectStaticFlowfield(name) {
    const nav = this.debugUI.canvas.nav;
    nav.selectedFlowfieldSlot = -1;
    nav.selectedPathSlot = -1;
    nav.selectedStaticFlowfield = nav.selectedStaticFlowfield === name ? null : name;
    this.debugUI.canvas.syncLoop();
    this._refreshLists();
  }

  _clearVisualization() {
    this.debugUI.canvas.nav.clearSelection();
    if (this.elements.navWalkabilityBtn) {
      this.elements.navWalkabilityBtn.classList.remove('active');
      this.elements.navWalkabilityBtn.textContent = '🗺️ Show Grid';
    }
    this._refreshLists();
    this.debugUI.canvas.syncLoop();
  }

  // ------- helpers -------

  _addColumn(parent, headerHTML, countId, listId) {
    const col = document.createElement('div'); col.className = 'debug-ui-nav-column';
    const header = document.createElement('div'); header.className = 'debug-ui-nav-header';
    header.innerHTML = `<span>${headerHTML}</span><span class='count' id='${countId}'>0</span>`;
    col.appendChild(header);
    const list = document.createElement('div'); list.className = 'debug-ui-nav-list'; list.id = listId;
    col.appendChild(list);
    parent.appendChild(col);
    return list;
  }

  _setCount(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  _showMessage(msg) {
    if (this.elements.navFlowfieldsList) this.elements.navFlowfieldsList.innerHTML = `<div class="debug-ui-nav-empty">${msg}</div>`;
    if (this.elements.navPathsList) this.elements.navPathsList.innerHTML = `<div class="debug-ui-nav-empty">${msg}</div>`;
  }
}
