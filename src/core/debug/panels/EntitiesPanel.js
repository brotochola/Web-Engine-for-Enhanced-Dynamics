// EntitiesPanel.js — Active/visible counts, pool stats, and entity tool buttons

import { createPanel, createRow, createStat, createDivider } from '../ui/DebugDOM.js';
import { formatNumber } from '../../utils.js';
import { PARTICLE_STATS, RENDERER_STATS } from '../stats/StatsCollector.js';

export class EntitiesPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;

    this._internalEntitiesSet = new Set(['Flash']);
    this._poolStatsBuffer = '';
    this._prevPoolStatsBuffer = '';
    this._spawnerButtonKeys = null;
  }

  // ------- DOM creation -------

  create() {
    this.panel = createPanel();

    const statsRow = createRow();
    this.elements.activeCount = createStat('Active: --');
    this.elements.visibleCount = createStat('Visible: --');
    this.elements.poolStats = createStat('Pools: --');

    statsRow.appendChild(this.elements.activeCount);
    statsRow.appendChild(this.elements.visibleCount);
    statsRow.appendChild(createDivider());
    statsRow.appendChild(this.elements.poolStats);
    this.panel.appendChild(statsRow);

    this.elements.entityToolsContainer = document.createElement('div');
    this.elements.entityToolsContainer.style.marginTop = '8px';
    this.panel.appendChild(this.elements.entityToolsContainer);

    return this.panel;
  }

  // ------- lifecycle -------

  attach() {
    this._autoGenerateEntityTools();
  }

  update() {
    this._updateEntitiesSection();
    this._updateToolButtonStates();
  }

  // ------- entity counts -------

  _updateEntitiesSection() {
    const stats = this.debugUI.stats;
    const pv = stats.prev;
    const particleView = stats.workerStatViews?.particle;
    const rendererView = stats.workerStatViews?.renderer;

    if (this.elements.activeCount && particleView) {
      const active = (particleView[PARTICLE_STATS.ACTIVE_ENTITIES] || 0) | 0;
      const total = (particleView[PARTICLE_STATS.TOTAL_ENTITIES] || 0) | 0;
      if (active !== pv.activeEntities || total !== pv.totalEntities) {
        pv.activeEntities = active;
        pv.totalEntities = total;
        this.elements.activeCount.textContent = 'Active: ' + formatNumber(active) + '/' + formatNumber(total);
      }
    }

    if (this.elements.visibleCount && rendererView) {
      const visible = ((rendererView[RENDERER_STATS.VISIBLE_ENTITIES] || 0) + (rendererView[RENDERER_STATS.VISIBLE_PARTICLES] || 0)) | 0;
      if (visible !== pv.visibleEntities) {
        pv.visibleEntities = visible;
        this.elements.visibleCount.textContent = 'Visible: ' + formatNumber(visible);
      }
    }

    if (this.elements.poolStats && this.debugUI.gameEngine) {
      this._poolStatsBuffer = '';
      const registeredClasses = this.debugUI.scene?.registeredClasses;
      if (registeredClasses) {
        for (let i = 0; i < registeredClasses.length; i++) {
          const reg = registeredClasses[i];
          if (this._internalEntitiesSet.has(reg.class.name)) continue;
          const poolStats = this.debugUI.gameEngine.getPoolStats(reg.class);
          if (poolStats && poolStats.total > 0) {
            if (this._poolStatsBuffer.length > 0) this._poolStatsBuffer += ' | ';
            this._poolStatsBuffer += reg.class.name + ': ' + formatNumber(poolStats.active) + '/' + formatNumber(poolStats.total);
          }
        }
      }
      if (this._poolStatsBuffer !== this._prevPoolStatsBuffer) {
        this._prevPoolStatsBuffer = this._poolStatsBuffer;
        this.elements.poolStats.textContent = this._poolStatsBuffer;
      }
    }
  }

  // ------- entity tool generation -------

  _autoGenerateEntityTools() {
    const scene = this.debugUI.scene;
    const gameEngine = this.debugUI.gameEngine;
    if (!scene || !gameEngine) return;

    const container = this.elements.entityToolsContainer;
    if (!container) return;
    container.innerHTML = '';

    const internalEntities = new Set(['Mouse', 'Flash']);
    const spawnableClasses = (scene.registeredClasses || []).filter(
      (reg) => reg.count > 0 && !internalEntities.has(reg.class.name)
    );
    if (spawnableClasses.length === 0) return;

    const paintersRow = createRow('gap:8px;flex-wrap:wrap');
    paintersRow.appendChild(createStat('Paint:'));

    this.elements.spawnerButtons = {};
    this._spawnerButtonKeys = [];

    for (const reg of spawnableClasses) {
      const name = reg.class.name;
      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn tool';
      btn.textContent = '🎨 ' + name;
      btn.title = 'Toggle ' + name + ' painter';
      btn.onclick = () => this.debugUI.tools.toggleSpawner(name);
      this.elements.spawnerButtons[name] = btn;
      this._spawnerButtonKeys.push(name);
      paintersRow.appendChild(btn);
    }

    // Eraser
    this.elements.eraserButton = document.createElement('button');
    this.elements.eraserButton.className = 'debug-ui-btn danger';
    this.elements.eraserButton.textContent = '🧹 Eraser';
    this.elements.eraserButton.title = 'Toggle eraser (click & drag to despawn)';
    this.elements.eraserButton.onclick = () => this.debugUI.tools.toggleEraser();
    paintersRow.appendChild(this.elements.eraserButton);

    paintersRow.appendChild(createDivider());

    // Bulk spawn checkbox
    const bulkLabel = document.createElement('label');
    bulkLabel.style.cssText = 'display:flex;align-items:center;gap:4px;color:rgba(255,255,255,0.7);cursor:pointer;font-size:10px';
    this.elements.bulkSpawnCheckbox = document.createElement('input');
    this.elements.bulkSpawnCheckbox.type = 'checkbox';
    this.elements.bulkSpawnCheckbox.checked = this.debugUI.tools.bulkSpawnEnabled;
    this.elements.bulkSpawnCheckbox.style.cursor = 'pointer';
    this.elements.bulkSpawnCheckbox.onchange = (e) => {
      this.debugUI.tools.bulkSpawnEnabled = e.target.checked;
      this.debugUI.tools.updateToolIndicator();
    };
    bulkLabel.appendChild(this.elements.bulkSpawnCheckbox);
    bulkLabel.appendChild(document.createTextNode('×50'));
    paintersRow.appendChild(bulkLabel);

    container.appendChild(paintersRow);

    // Clear-all row
    const clearRow = createRow('margin-top:8px;gap:8px');
    clearRow.appendChild(createStat('Clear:'));
    for (const reg of spawnableClasses) {
      const name = reg.class.name;
      const btn = document.createElement('button');
      btn.className = 'debug-ui-btn danger';
      btn.textContent = `🗑 ${name}`;
      btn.title = `Despawn all ${name}`;
      btn.onclick = () => gameEngine.despawnAllEntities(name);
      clearRow.appendChild(btn);
    }
    container.appendChild(clearRow);

    this._updateToolButtonStates();
  }

  _updateToolButtonStates() {
    const tools = this.debugUI.tools;
    const keys = this._spawnerButtonKeys;
    const spawnerButtons = this.elements.spawnerButtons;
    if (spawnerButtons && keys) {
      for (let i = 0; i < keys.length; i++) {
        const btn = spawnerButtons[keys[i]];
        const shouldBeActive = tools.activeSpawnerType === keys[i];
        if (shouldBeActive !== btn.classList.contains('active')) {
          btn.classList.toggle('active', shouldBeActive);
        }
      }
    }

    const eraserBtn = this.elements.eraserButton;
    if (eraserBtn) {
      if (tools.eraserActive !== eraserBtn.classList.contains('active')) {
        eraserBtn.classList.toggle('active', tools.eraserActive);
      }
    }
  }
}
