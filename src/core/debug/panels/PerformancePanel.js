// PerformancePanel.js — Worker stats table, FPS, entity counts, audio metrics

import { createPanel, createStat } from '../ui/DebugDOM.js';
import { formatNumber } from '../../utils.js';
import { DecorationPool } from '../../DecorationPool.js';
import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
  WORKER_DISPLAY_CONFIG,
} from '../stats/StatsCollector.js';

export class PerformancePanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
  }

  // ------- DOM creation -------

  create() {
    this.panel = createPanel();

    const container = document.createElement('div');
    container.style.cssText = 'display:flex;flex-direction:column;gap:12px';

    // Summary section
    const summary = document.createElement('div');
    summary.className = 'debug-ui-performance-summary';
    summary.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:8px;background:rgba(0,0,0,0.3);border-radius:4px';

    const poolRow = document.createElement('div');
    poolRow.className = 'debug-ui-row';
    poolRow.style.cssText = 'justify-content:flex-start;gap:16px';

    const poolTitle = document.createElement('span');
    poolTitle.className = 'debug-ui-stat';
    poolTitle.style.cssText = 'font-weight:bold;color:rgba(255,255,255,0.9)';
    poolTitle.textContent = 'Pools Stats:';
    poolRow.appendChild(poolTitle);

    this.elements.perfGameObjects = this._colorStat('#4ade80', 'GameObjects: -- / -- (👁 --)');
    poolRow.appendChild(this.elements.perfGameObjects);

    this.elements.perfParticles = this._colorStat('#fb923c', 'Particles: -- / -- (👁 --)');
    poolRow.appendChild(this.elements.perfParticles);

    this.elements.perfDecorations = this._colorStat('#34d399', 'Decorations: -- / -- (👁 --)');
    poolRow.appendChild(this.elements.perfDecorations);

    this.elements.perfFlash = this._colorStat('#fbbf24', 'Flash: -- / -- (👁 --)');
    poolRow.appendChild(this.elements.perfFlash);

    summary.appendChild(poolRow);
    container.appendChild(summary);

    // Job stealing row (hidden by default)
    const jobRow = document.createElement('div');
    jobRow.className = 'debug-ui-row';
    this.elements.jobStealing = createStat('Jobs: --', 'jobs');
    jobRow.appendChild(this.elements.jobStealing);
    jobRow.style.display = 'none';
    this.elements.jobStealingRow = jobRow;
    container.appendChild(jobRow);

    // Worker stats title
    const workerTitle = document.createElement('div');
    workerTitle.className = 'debug-ui-stat';
    workerTitle.style.cssText = 'font-weight:bold;font-size:12px;margin-top:8px;margin-bottom:4px;color:rgba(255,255,255,0.9)';
    workerTitle.textContent = 'Worker Stats';
    container.appendChild(workerTitle);

    // Container for dynamic worker rows
    this.elements.workerStatsContainer = document.createElement('div');
    this.elements.workerStatsContainer.style.cssText = 'display:flex;flex-direction:column;gap:4px';
    container.appendChild(this.elements.workerStatsContainer);

    this.panel.appendChild(container);
    return this.panel;
  }

  // ------- lifecycle -------

  attach() {
    this._createWorkerStatElements();
  }

  update() {
    this._updatePerformanceSection();
  }

  // ------- worker DOM builder -------

  _createWorkerStatElements() {
    const stats = this.debugUI.stats;
    if (!stats.workerStatViews) return;

    const container = this.elements.workerStatsContainer;
    container.innerHTML = '';

    const table = document.createElement('div');
    table.className = 'debug-ui-worker-table';

    let maxStatCount = 0;
    for (const config of Object.values(WORKER_DISPLAY_CONFIG)) {
      maxStatCount = Math.max(maxStatCount, config.stats.length);
    }
    table.setAttribute('data-stat-count', maxStatCount);

    this.elements.workerStats = {};

    // Main thread FPS
    const mainRow = document.createElement('div');
    mainRow.className = 'debug-ui-worker-row';
    const mainLabel = document.createElement('div');
    mainLabel.className = 'debug-ui-worker-cell label debug-ui-stat main';
    mainLabel.textContent = 'Main:';
    mainRow.appendChild(mainLabel);
    const mainFps = document.createElement('div');
    mainFps.className = 'debug-ui-worker-cell stat';
    mainFps.textContent = 'FPS: --';
    mainRow.appendChild(mainFps);
    this.elements.mainFPS = mainFps;
    table.appendChild(mainRow);

    // Single workers
    for (const type of ['renderer', 'particle', 'physics', 'preRender']) {
      if (stats.workerStatViews[type]) {
        const row = this._createWorkerStatRow(type, 0);
        table.appendChild(row.row);
        if (!this.elements.workerStats[type]) this.elements.workerStats[type] = [];
        this.elements.workerStats[type].push(row.elements);
      }
    }

    // Multi-workers
    for (const type of ['spatial', 'logic']) {
      const views = stats.workerStatViews[type];
      if (views && views.length > 0) {
        this.elements.workerStats[type] = [];
        for (let i = 0; i < views.length; i++) {
          const row = this._createWorkerStatRow(type, i);
          table.appendChild(row.row);
          this.elements.workerStats[type].push(row.elements);
        }
      }
    }

    // Audio row
    const audioRow = document.createElement('div');
    audioRow.className = 'debug-ui-worker-row';
    const audioLabel = document.createElement('div');
    audioLabel.className = 'debug-ui-worker-cell label debug-ui-stat audio';
    audioLabel.textContent = 'Audio:';
    audioRow.appendChild(audioLabel);

    this.elements.audioStats = {};
    for (const stat of ['SlotsLd', 'DropMix', 'Vol', 'RateLat']) {
      const cell = document.createElement('div');
      cell.className = 'debug-ui-worker-cell stat debug-ui-stat audio';
      cell.textContent = '--';
      audioRow.appendChild(cell);
      this.elements.audioStats[stat] = cell;
    }
    table.appendChild(audioRow);

    container.appendChild(table);
  }

  _createWorkerStatRow(workerType, workerIndex) {
    const stats = this.debugUI.stats;
    const config = WORKER_DISPLAY_CONFIG[workerType];
    const row = document.createElement('div');
    row.className = 'debug-ui-worker-row';
    const elements = {};

    const labelCell = document.createElement('div');
    labelCell.className = `debug-ui-worker-cell label debug-ui-stat ${config.color}`;
    const count = (workerType === 'spatial' || workerType === 'logic')
      ? stats.workerStatViews[workerType].length
      : 1;
    labelCell.textContent = (count > 1 ? `${config.label} #${workerIndex}` : config.label) + ':';
    row.appendChild(labelCell);

    for (const stat of config.stats) {
      const cell = document.createElement('div');
      cell.className = `debug-ui-worker-cell stat debug-ui-stat ${config.color}`;
      cell.textContent = `${stat.key}: --`;
      row.appendChild(cell);
      elements[stat.key] = cell;
    }

    return { row, elements };
  }

  // ------- tick updates -------

  _updatePerformanceSection() {
    const scene = this.debugUI.scene;
    const stats = this.debugUI.stats;
    if (!scene || !stats.workerStatViews) return;

    this._updateSummary(stats, scene);

    // Main FPS
    const mainFPSRounded = (scene.mainFPS * 100) | 0;
    if (this.elements.mainFPS && mainFPSRounded !== stats.prev.mainFPS) {
      stats.prev.mainFPS = mainFPSRounded;
      this.elements.mainFPS.textContent = 'FPS: ' + (mainFPSRounded / 100).toFixed(2);
    }

    this._updateAudioStats(scene.audioMetrics, stats);

    this._updateSingleWorkerStats('renderer', RENDERER_STATS, stats);
    this._updateSingleWorkerStats('particle', PARTICLE_STATS, stats);
    this._updateSingleWorkerStats('physics', PHYSICS_STATS, stats);
    this._updateSingleWorkerStats('preRender', PRE_RENDER_STATS, stats);

    this._updateMultiWorkerStats('spatial', SPATIAL_STATS, stats);
    this._updateMultiWorkerStats('logic', LOGIC_STATS, stats);
  }

  _updateSummary(stats, scene) {
    const pv = stats.prev;
    const particleView = stats.workerStatViews?.particle;
    const rendererView = stats.workerStatViews?.renderer;

    if (particleView && this.elements.perfGameObjects) {
      const aGO = (particleView[PARTICLE_STATS.ACTIVE_ENTITIES] || 0) | 0;
      const tGO = (particleView[PARTICLE_STATS.TOTAL_ENTITIES] || 0) | 0;
      const vGO = rendererView ? (rendererView[RENDERER_STATS.VISIBLE_ENTITIES] || 0) | 0 : 0;
      if (aGO !== pv.activeGO || tGO !== pv.totalGO || vGO !== pv.visibleGO) {
        pv.activeGO = aGO; pv.totalGO = tGO; pv.visibleGO = vGO;
        this.elements.perfGameObjects.textContent = 'GameObjects: ' + formatNumber(aGO) + ' / ' + formatNumber(tGO) + ' (👁 ' + formatNumber(vGO) + ')';
      }
    }

    if (particleView && this.elements.perfParticles) {
      const aP = (particleView[PARTICLE_STATS.ACTIVE_PARTICLES] || 0) | 0;
      const tP = (particleView[PARTICLE_STATS.TOTAL_PARTICLES] || 0) | 0;
      const vP = rendererView ? (rendererView[RENDERER_STATS.VISIBLE_PARTICLES] || 0) | 0 : 0;
      if (aP !== pv.activeP || tP !== pv.totalP || vP !== pv.visibleP) {
        pv.activeP = aP; pv.totalP = tP; pv.visibleP = vP;
        this.elements.perfParticles.textContent = 'Particles: ' + formatNumber(aP) + ' / ' + formatNumber(tP) + ' (👁 ' + formatNumber(vP) + ')';
      }
    }

    if (rendererView && this.elements.perfDecorations) {
      const aD = (rendererView[RENDERER_STATS.ACTIVE_DECORATIONS] || 0) | 0;
      const vD = (rendererView[RENDERER_STATS.VISIBLE_DECORATIONS] || 0) | 0;
      const tD = (DecorationPool.maxDecorations || 0) | 0;
      if (aD !== pv.activeD || tD !== pv.totalD || vD !== pv.visibleD) {
        pv.activeD = aD; pv.totalD = tD; pv.visibleD = vD;
        this.elements.perfDecorations.textContent = 'Decorations: ' + formatNumber(aD) + ' / ' + formatNumber(tD) + ' (👁 ' + formatNumber(vD) + ')';
      }
    }

    if (particleView && this.elements.perfFlash) {
      const flash = (particleView[PARTICLE_STATS.FLASHES_UPDATED] || 0) | 0;
      if (flash !== pv.flashUpdated) {
        pv.flashUpdated = flash;
        this.elements.perfFlash.textContent = 'Flash: ' + formatNumber(flash) + ' updated';
      }
    }
  }

  _updateAudioStats(audioMetrics, stats) {
    const els = this.elements.audioStats;
    if (!els || !audioMetrics) return;
    const pv = stats.prev;

    const active = (audioMetrics.activeSlots || 0) | 0;
    const max = (audioMetrics.maxSlots || 0) | 0;
    const loaded = (audioMetrics.loadedSounds || 0) | 0;
    const rate = (audioMetrics.sampleRate || 0) | 0;
    const baseLat = audioMetrics.baseLatency || 0;
    const outLat = audioMetrics.outputLatency || 0;

    if (active !== pv.audioActive || max !== pv.audioMax || loaded !== pv.audioLoaded) {
      pv.audioActive = active; pv.audioMax = max; pv.audioLoaded = loaded;
      els.SlotsLd.textContent = active + '/' + max + ' Ld:' + loaded;
    }

    const dropped = (audioMetrics.dropped || 0) | 0;
    const mixGainR = ((audioMetrics.mixGain || 0) * 100 + 0.5) | 0;
    if (dropped !== pv.audioDropped || mixGainR !== pv.audioMixGain) {
      pv.audioDropped = dropped; pv.audioMixGain = mixGainR;
      els.DropMix.textContent = 'Dropped:' + dropped + ' Mix:' + mixGainR + '%';
    }

    const muted = audioMetrics.muted;
    const masterVolR = ((audioMetrics.masterVolume || 0) * 100 + 0.5) | 0;
    if (masterVolR !== pv.audioMasterVol || muted !== pv.audioMuted) {
      pv.audioMasterVol = masterVolR; pv.audioMuted = muted;
      els.Vol.textContent = 'Vol:' + masterVolR + '%' + (muted ? ' (m)' : '');
    }

    const latencyMs = ((baseLat + outLat) * 100000 + 0.5) | 0;
    if (rate !== pv.audioRate || latencyMs !== pv.audioLatency) {
      pv.audioRate = rate; pv.audioLatency = latencyMs;
      const rateStr = rate >= 1000 ? (rate / 1000) + 'k' : rate;
      els.RateLat.textContent = rateStr + ' Lat:' + (latencyMs / 100).toFixed(2) + 'ms';
    }
  }

  _updateSingleWorkerStats(workerType, statsSchema, stats) {
    const view = stats.workerStatViews[workerType];
    if (!view) return;
    const ws = this.elements.workerStats;
    if (!ws || !ws[workerType] || !ws[workerType][0]) return;
    const elements = ws[workerType][0];
    const config = WORKER_DISPLAY_CONFIG[workerType];

    if (!stats.prevWorker[workerType]) stats.prevWorker[workerType] = { 0: {} };
    const prevCache = stats.prevWorker[workerType][0];

    for (let s = 0; s < config.stats.length; s++) {
      const stat = config.stats[s];
      let rawValue = view[statsSchema[stat.key]];
      if (stat.key === 'FPS') rawValue = stats.smoothFPS(rawValue, stats.fpsSmoothing[workerType]);
      const rounded = (rawValue * 100) | 0;
      if (prevCache[stat.key] === rounded) continue;
      prevCache[stat.key] = rounded;
      elements[stat.key].textContent = stat.key + ': ' + stat.format(rawValue);
    }
  }

  _updateMultiWorkerStats(workerType, statsSchema, stats) {
    const views = stats.workerStatViews[workerType];
    if (!views || views.length === 0) return;
    const ws = this.elements.workerStats;
    if (!ws || !ws[workerType]) return;
    const config = WORKER_DISPLAY_CONFIG[workerType];

    if (!stats.prevWorker[workerType]) stats.prevWorker[workerType] = {};

    for (let i = 0; i < views.length; i++) {
      const view = views[i];
      const elements = ws[workerType][i];
      if (!elements) continue;

      if (!stats.prevWorker[workerType][i]) stats.prevWorker[workerType][i] = {};
      const prevCache = stats.prevWorker[workerType][i];

      for (let s = 0; s < config.stats.length; s++) {
        const stat = config.stats[s];
        let rawValue = view[statsSchema[stat.key]];
        if (stat.key === 'FPS') rawValue = stats.smoothFPS(rawValue, stats.fpsSmoothing[workerType][i]);
        const rounded = (rawValue * 100) | 0;
        if (prevCache[stat.key] === rounded) continue;
        prevCache[stat.key] = rounded;
        elements[stat.key].textContent = stat.key + ': ' + stat.format(rawValue);
      }
    }
  }

  // ------- util -------

  _colorStat(color, text) {
    const el = createStat(text);
    el.style.color = color;
    return el;
  }
}
