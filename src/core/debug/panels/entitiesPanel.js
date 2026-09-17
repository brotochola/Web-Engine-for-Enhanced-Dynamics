// EntitiesPanel.js — Per-type chips (count + paint / clear)

import { createPanel, createRow, createStat } from '../ui/debugDom.js';
import { formatNumber } from '../../../util/utils.js';
import { getFreeListCount } from '../../../util/atomicFreeList.js';
import { Transform } from '../../../components/transform.js';
import { PARTICLE_STATS } from '../stats/statsCollector.js';

export class EntitiesPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
    this._internalEntitiesSet = new Set(['Flash', 'Mouse']);
    this._typeRows = [];
  }

  create() {
    this.panel = createPanel();

    const statsRow = createRow();
    this.elements.activeCount = createStat('Active: --');
    statsRow.appendChild(this.elements.activeCount);
    this.panel.appendChild(statsRow);

    const bulkRow = createRow('margin-top:6px');
    const bulkLabel = document.createElement('label');
    bulkLabel.className = 'debug-ui-bulk-label';
    this.elements.bulkSpawnCheckbox = document.createElement('input');
    this.elements.bulkSpawnCheckbox.type = 'checkbox';
    this.elements.bulkSpawnCheckbox.onchange = (e) => {
      this.debugUI.tools.bulkSpawnEnabled = e.target.checked;
      this.debugUI.tools.updateToolIndicator();
    };
    bulkLabel.appendChild(this.elements.bulkSpawnCheckbox);
    bulkLabel.appendChild(document.createTextNode('Paint ×50'));
    bulkRow.appendChild(bulkLabel);

    this.elements.eraserButton = document.createElement('button');
    this.elements.eraserButton.className = 'debug-ui-btn danger';
    this.elements.eraserButton.textContent = 'Eraser';
    this.elements.eraserButton.onclick = () => this.debugUI.tools.toggleEraser();
    bulkRow.appendChild(this.elements.eraserButton);
    this.panel.appendChild(bulkRow);

    this.elements.entityToolsContainer = document.createElement('div');
    this.elements.entityToolsContainer.className = 'debug-ui-type-list';
    this.panel.appendChild(this.elements.entityToolsContainer);

    return this.panel;
  }

  attach() {
    if (this.elements.bulkSpawnCheckbox) {
      this.elements.bulkSpawnCheckbox.checked = this.debugUI.tools.bulkSpawnEnabled;
    }
    this._autoGenerateEntityTools();
  }

  update() {
    this._updateEntitiesSection();
  }

  _updateEntitiesSection() {
    const stats = this.debugUI.stats;
    const pv = stats.prev;
    const particleView = stats.workerStatViews?.particle;
    const engine = this.debugUI.gameEngine;

    if (this.elements.activeCount && particleView) {
      const active = (particleView[PARTICLE_STATS.ACTIVE_ENTITIES] || 0) | 0;
      const total = (particleView[PARTICLE_STATS.TOTAL_ENTITIES] || 0) | 0;
      if (active !== pv.activeEntities || total !== pv.totalEntities) {
        pv.activeEntities = active;
        pv.totalEntities = total;
        this.elements.activeCount.textContent = 'Game objects: ' + formatNumber(active) + ' / ' + formatNumber(total);
      }
    }

    if (!engine) return;
    const rows = this._typeRows;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const t = row.cls.poolSize | 0;
      const a = this._activeInPool(row.cls, t);
      if (a !== row.prevActive || t !== row.prevTotal) {
        row.prevActive = a;
        row.prevTotal = t;
        row.countEl.textContent = formatNumber(a) + '/' + formatNumber(t);
      }
    }
  }

  _activeInPool(cls, total) {
    if (!total) return 0;
    if (cls.freeList && cls.freeListTop) {
      return total - (getFreeListCount(cls.freeListTop) | 0);
    }
    const active = Transform.active;
    if (!active) return 0;
    const start = cls.startIndex | 0;
    const end = cls.endIndex | 0;
    let n = 0;
    for (let i = start; i < end; i++) if (active[i]) n++;
    return n;
  }

  _autoGenerateEntityTools() {
    const scene = this.debugUI.scene;
    const gameEngine = this.debugUI.gameEngine;
    const container = this.elements.entityToolsContainer;
    if (!scene || !gameEngine || !container) return;
    container.textContent = '';
    this._typeRows = [];
    this.elements.spawnerButtons = {};
    this._spawnerButtonKeys = [];

    const regs = scene.registeredClasses;
    if (!regs) return;

    for (let i = 0; i < regs.length; i++) {
      const reg = regs[i];
      if (!(reg.count > 0)) continue;
      const name = reg.class.name;
      if (this._internalEntitiesSet.has(name)) continue;

      const chip = document.createElement('div');
      chip.className = 'debug-ui-type-chip';

      const nameEl = document.createElement('span');
      nameEl.className = 'debug-ui-type-name';
      nameEl.textContent = name;
      nameEl.title = name;
      chip.appendChild(nameEl);

      const countEl = document.createElement('span');
      countEl.className = 'debug-ui-type-count';
      countEl.textContent = '--/--';
      chip.appendChild(countEl);

      const paintBtn = document.createElement('button');
      paintBtn.className = 'debug-ui-btn tool';
      paintBtn.textContent = 'Paint';
      paintBtn.onclick = () => this.debugUI.tools.toggleSpawner(name);
      chip.appendChild(paintBtn);

      const clearBtn = document.createElement('button');
      clearBtn.className = 'debug-ui-btn danger';
      clearBtn.textContent = 'Clear';
      clearBtn.onclick = () => gameEngine.despawnAllEntities(name);
      chip.appendChild(clearBtn);

      container.appendChild(chip);
      this.elements.spawnerButtons[name] = paintBtn;
      this._spawnerButtonKeys.push(name);
      this._typeRows.push({
        cls: reg.class,
        name,
        countEl,
        paintBtn,
        prevActive: -1,
        prevTotal: -1,
      });
    }

    this._updateToolButtonStates();
  }

  _updateToolButtonStates() {
    const tools = this.debugUI.tools;
    const keys = this._spawnerButtonKeys;
    const spawnerButtons = this.elements.spawnerButtons;
    if (spawnerButtons && keys) {
      for (let i = 0; i < keys.length; i++) {
        const btn = spawnerButtons[keys[i]];
        btn.classList.toggle('active', tools.activeSpawnerType === keys[i]);
      }
    }
    const eraserBtn = this.elements.eraserButton;
    if (eraserBtn) eraserBtn.classList.toggle('active', tools.eraserActive);
  }
}
