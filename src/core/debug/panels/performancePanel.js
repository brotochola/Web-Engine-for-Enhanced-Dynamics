// PerformancePanel.js — Full-width worker rows (expandable details), pools, audio

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
  WORKER_ROW_ORDER,
  workerLoadPct,
} from '../stats/StatsCollector.js';

const COMMON_KEYS = ['STEP_MS', 'LOAD', 'FPS', 'MSG_MS'];
const LEAN_KEYS = ['STEP_MS', 'LOAD', 'FPS'];
const SCHEMA_BY_TYPE = {
  renderer: RENDERER_STATS,
  particle: PARTICLE_STATS,
  physics: PHYSICS_STATS,
  spatial: SPATIAL_STATS,
  logic: LOGIC_STATS,
  preRender: PRE_RENDER_STATS,
};

/** Worker types that start expanded (empty = all collapsed). */
const DEFAULT_EXPANDED = new Set();

function fmtMs(v) {
  return v == null || Number.isNaN(v) ? '—' : v.toFixed(2) + ' ms';
}

function fmtFps(v) {
  return v == null || Number.isNaN(v) ? '—' : v.toFixed(1);
}

function fmtLoad(v) {
  return v == null || Number.isNaN(v) ? '—' : Math.round(v) + '%';
}

export class PerformancePanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
    /** @type {Map<string, boolean>} */
    this._expandedById = new Map();
  }

  // ------- DOM creation -------

  create() {
    this.panel = createPanel();
    this.panel.classList.add('debug-ui-performance-panel');

    const container = document.createElement('div');
    container.className = 'debug-ui-performance-body';

    const summary = document.createElement('div');
    summary.className = 'debug-ui-performance-summary';

    const poolRow = document.createElement('div');
    poolRow.className = 'debug-ui-row debug-ui-pool-row';

    const poolTitle = document.createElement('span');
    poolTitle.className = 'debug-ui-stat debug-ui-pool-title';
    poolTitle.textContent = 'Pools';
    poolRow.appendChild(poolTitle);

    this.elements.perfGameObjects = this._colorStat('#4ade80', 'Game objects: -- / -- (👁 --)');
    poolRow.appendChild(this.elements.perfGameObjects);

    this.elements.perfParticles = this._colorStat('#fb923c', 'Particles: -- / -- (👁 --)');
    poolRow.appendChild(this.elements.perfParticles);

    this.elements.perfDecorations = this._colorStat('#34d399', 'Decorations: -- / -- (👁 --)');
    poolRow.appendChild(this.elements.perfDecorations);

    this.elements.perfFlash = this._colorStat('#fbbf24', 'Flash: --');
    poolRow.appendChild(this.elements.perfFlash);

    summary.appendChild(poolRow);
    container.appendChild(summary);

    const jobRow = document.createElement('div');
    jobRow.className = 'debug-ui-row';
    this.elements.jobStealing = createStat('Jobs: --', 'jobs');
    jobRow.appendChild(this.elements.jobStealing);
    jobRow.style.display = 'none';
    this.elements.jobStealingRow = jobRow;
    container.appendChild(jobRow);

    this.elements.workerStatsContainer = document.createElement('div');
    this.elements.workerStatsContainer.className = 'debug-ui-worker-list';
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

    const list = this.elements.workerStatsContainer;
    list.innerHTML = '';
    this.elements.workerStats = {};

    list.appendChild(
      this._createFixedRow('main', 'Main', 'main', {
        STEP_MS: true,
        LOAD: true,
        FPS: true,
        MSG_MS: false,
      }),
    );

    for (const type of WORKER_ROW_ORDER) {
      if (type === 'spatial' || type === 'logic') {
        const views = stats.workerStatViews[type];
        if (!views || views.length === 0) continue;
        this.elements.workerStats[type] = [];
        for (let i = 0; i < views.length; i++) {
          const built = this._createWorkerStatRow(type, i);
          list.appendChild(built.row);
          this.elements.workerStats[type].push(built.elements);
        }
      } else if (stats.workerStatViews[type]) {
        const built = this._createWorkerStatRow(type, 0);
        list.appendChild(built.row);
        if (!this.elements.workerStats[type]) this.elements.workerStats[type] = [];
        this.elements.workerStats[type].push(built.elements);
      }
    }

    list.appendChild(this._createAudioRow());
  }

  _isExpanded(rowId, expandable) {
    if (!expandable) return false;
    if (this._expandedById.has(rowId)) return this._expandedById.get(rowId);
    const type = rowId.split(':')[0];
    return DEFAULT_EXPANDED.has(type);
  }

  _setExpanded(rowId, row, expanded) {
    this._expandedById.set(rowId, expanded);
    row.classList.toggle('expanded', expanded);
    row.classList.toggle('collapsed', !expanded);
    const chevron = row.querySelector('.debug-ui-worker-chevron');
    if (chevron) chevron.textContent = expanded ? '▾' : '▸';
    row.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  _createRowShell(rowId, colorClass, title, { expandable = false } = {}) {
    const row = document.createElement('div');
    row.className = `debug-ui-worker-row ${colorClass}`;
    row.dataset.rowId = rowId;

    const head = document.createElement('div');
    head.className = 'debug-ui-worker-row-head';

    const chevron = document.createElement('span');
    chevron.className = 'debug-ui-worker-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    if (!expandable) {
      chevron.classList.add('hidden');
      chevron.textContent = '';
    }
    head.appendChild(chevron);

    const label = document.createElement('span');
    label.className = `debug-ui-worker-row-label debug-ui-stat ${colorClass}`;
    label.textContent = title;
    head.appendChild(label);

    const metrics = document.createElement('div');
    metrics.className = 'debug-ui-worker-row-metrics';
    head.appendChild(metrics);

    const loadTrack = document.createElement('div');
    loadTrack.className = 'debug-ui-worker-load-track';
    const loadFill = document.createElement('div');
    loadFill.className = 'debug-ui-worker-load-fill';
    loadTrack.appendChild(loadFill);
    head.appendChild(loadTrack);

    row.appendChild(head);

    const details = document.createElement('div');
    details.className = 'debug-ui-worker-row-details';
    row.appendChild(details);

    if (expandable) {
      row.classList.add('expandable');
      const expanded = this._isExpanded(rowId, true);
      this._setExpanded(rowId, row, expanded);
      head.addEventListener('click', () => {
        this._setExpanded(rowId, row, !row.classList.contains('expanded'));
      });
      head.title = 'Click to expand / collapse details';
    } else {
      row.classList.add('collapsed');
      details.classList.add('empty');
    }

    return { row, metrics, loadFill, details };
  }

  _metricCell(colorClass, key, empty = false) {
    const cell = document.createElement('span');
    cell.className = `debug-ui-worker-metric debug-ui-stat ${colorClass}`;
    cell.dataset.key = key;
    if (empty) cell.classList.add('empty');
    cell.textContent = '—';
    return cell;
  }

  _setLoadBar(loadFill, loadPct) {
    if (!loadFill) return;
    const pct = Math.max(0, Number(loadPct) || 0);
    loadFill.style.width = `${Math.min(pct, 100)}%`;
    loadFill.classList.toggle('over', pct > 100);
  }

  _createFixedRow(id, label, colorClass, commonFlags) {
    const { row, metrics, loadFill, details } = this._createRowShell(id, colorClass, label, {
      expandable: false,
    });
    const elements = { _loadFill: loadFill, _extras: details };

    for (const key of COMMON_KEYS) {
      const cell = this._metricCell(colorClass, key, !commonFlags[key]);
      metrics.appendChild(cell);
      if (commonFlags[key]) elements[key] = cell;
    }

    if (id === 'main') {
      this.elements.mainStep = elements.STEP_MS;
      this.elements.mainLoad = elements.LOAD;
      this.elements.mainFPS = elements.FPS;
      this.elements.mainLoadFill = loadFill;
      this.elements.mainExtras = details;
    }

    return row;
  }

  _createAudioRow() {
    const rowId = 'audio';
    const { row, metrics, loadFill, details } = this._createRowShell(rowId, 'audio', 'Audio', {
      expandable: true,
    });
    this.elements.audioStats = { _loadFill: loadFill, _extras: details };

    const step = this._metricCell('audio', 'STEP_MS');
    metrics.appendChild(step);
    this.elements.audioStats.STEP_MS = step;

    for (const key of ['LOAD', 'FPS', 'MSG_MS']) {
      metrics.appendChild(this._metricCell('audio', key, true));
    }

    return row;
  }

  _collectDetailedStatsEnabled() {
    return !!this.debugUI.scene?.config?.debug?.collectDetailedStats;
  }

  _createWorkerStatRow(workerType, workerIndex) {
    const stats = this.debugUI.stats;
    const config = WORKER_DISPLAY_CONFIG[workerType];
    const count =
      workerType === 'spatial' || workerType === 'logic'
        ? stats.workerStatViews[workerType].length
        : 1;
    const title = count > 1 ? `${config.label} #${workerIndex}` : config.label;
    const detailed = this._collectDetailedStatsEnabled();
    const headKeys = detailed ? COMMON_KEYS : LEAN_KEYS;
    const detailCount = detailed ? Math.max(0, config.stats.length - COMMON_KEYS.length) : 0;
    const rowId = `${workerType}:${workerIndex}`;
    const { row, metrics, loadFill, details } = this._createRowShell(rowId, config.color, title, {
      expandable: detailCount > 0,
    });

    const elements = { _loadFill: loadFill, _extras: details };

    for (const key of headKeys) {
      const cell = this._metricCell(config.color, key);
      metrics.appendChild(cell);
      elements[key] = cell;
    }

    if (detailed) {
      for (let s = COMMON_KEYS.length; s < config.stats.length; s++) {
        const stat = config.stats[s];
        const chip = document.createElement('span');
        chip.className = 'debug-ui-worker-detail';
        chip.textContent = `${stat.label}: —`;
        details.appendChild(chip);
        elements[stat.key] = chip;
      }
    }

    return { row, elements };
  }

  // ------- tick updates -------

  _updatePerformanceSection() {
    const scene = this.debugUI.scene;
    const stats = this.debugUI.stats;
    if (!scene || !stats.workerStatViews) return;

    this._updateSummary(stats, scene);

    const mainStepRounded = (scene.mainStepMs * 100) | 0;
    if (this.elements.mainStep && mainStepRounded !== stats.prev.mainStepMs) {
      stats.prev.mainStepMs = mainStepRounded;
      const stepMs = mainStepRounded / 100;
      this.elements.mainStep.textContent = fmtMs(stepMs);
      const load = workerLoadPct(stepMs);
      if (this.elements.mainLoad) this.elements.mainLoad.textContent = fmtLoad(load);
      this._setLoadBar(this.elements.mainLoadFill, load);
    }
    const mainFPSRounded = (scene.mainFPS * 100) | 0;
    if (this.elements.mainFPS && mainFPSRounded !== stats.prev.mainFPS) {
      stats.prev.mainFPS = mainFPSRounded;
      this.elements.mainFPS.textContent = fmtFps(mainFPSRounded / 100);
    }

    this._updateAudioStats(scene.audioMetrics, stats);

    for (const type of WORKER_ROW_ORDER) {
      const schema = SCHEMA_BY_TYPE[type];
      if (!schema) continue;
      if (type === 'spatial' || type === 'logic') {
        this._updateMultiWorkerStats(type, schema, stats);
      } else {
        this._updateSingleWorkerStats(type, schema, stats);
      }
    }
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
        pv.activeGO = aGO;
        pv.totalGO = tGO;
        pv.visibleGO = vGO;
        this.elements.perfGameObjects.textContent =
          'Game objects: ' +
          formatNumber(aGO) +
          ' / ' +
          formatNumber(tGO) +
          ' (👁 ' +
          formatNumber(vGO) +
          ')';
      }
    }

    if (particleView && this.elements.perfParticles) {
      const aP = (particleView[PARTICLE_STATS.ACTIVE_PARTICLES] || 0) | 0;
      const tP = (particleView[PARTICLE_STATS.TOTAL_PARTICLES] || 0) | 0;
      const vP = rendererView ? (rendererView[RENDERER_STATS.VISIBLE_PARTICLES] || 0) | 0 : 0;
      if (aP !== pv.activeP || tP !== pv.totalP || vP !== pv.visibleP) {
        pv.activeP = aP;
        pv.totalP = tP;
        pv.visibleP = vP;
        this.elements.perfParticles.textContent =
          'Particles: ' +
          formatNumber(aP) +
          ' / ' +
          formatNumber(tP) +
          ' (👁 ' +
          formatNumber(vP) +
          ')';
      }
    }

    if (rendererView && this.elements.perfDecorations) {
      const aD = (rendererView[RENDERER_STATS.ACTIVE_DECORATIONS] || 0) | 0;
      const vD = (rendererView[RENDERER_STATS.VISIBLE_DECORATIONS] || 0) | 0;
      const tD = (DecorationPool.maxCount || 0) | 0;
      if (aD !== pv.activeD || tD !== pv.totalD || vD !== pv.visibleD) {
        pv.activeD = aD;
        pv.totalD = tD;
        pv.visibleD = vD;
        this.elements.perfDecorations.textContent =
          'Decorations: ' +
          formatNumber(aD) +
          ' / ' +
          formatNumber(tD) +
          ' (👁 ' +
          formatNumber(vD) +
          ')';
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

    const processMs = audioMetrics.processMs || 0;
    const processRounded = (processMs * 100) | 0;
    if (processRounded !== pv.audioProcessMs) {
      pv.audioProcessMs = processRounded;
      if (els.STEP_MS) els.STEP_MS.textContent = fmtMs(processRounded / 100);
      this._setLoadBar(els._loadFill, workerLoadPct(processRounded / 100));
    }

    const active = (audioMetrics.activeSlots || 0) | 0;
    const max = (audioMetrics.maxSlots || 0) | 0;
    const loaded = (audioMetrics.loadedSounds || 0) | 0;
    const dropped = (audioMetrics.dropped || 0) | 0;
    const masterVolR = ((audioMetrics.masterVolume || 0) * 100 + 0.5) | 0;
    const muted = audioMetrics.muted;
    const baseLat = audioMetrics.baseLatency || 0;
    const outLat = audioMetrics.outputLatency || 0;
    const latencyMs = ((baseLat + outLat) * 100000 + 0.5) | 0;
    const rate = (audioMetrics.sampleRate || 0) | 0;

    if (
      active !== pv.audioActive ||
      max !== pv.audioMax ||
      loaded !== pv.audioLoaded ||
      dropped !== pv.audioDropped ||
      masterVolR !== pv.audioMasterVol ||
      muted !== pv.audioMuted ||
      rate !== pv.audioRate ||
      latencyMs !== pv.audioLatency
    ) {
      pv.audioActive = active;
      pv.audioMax = max;
      pv.audioLoaded = loaded;
      pv.audioDropped = dropped;
      pv.audioMasterVol = masterVolR;
      pv.audioMuted = muted;
      pv.audioRate = rate;
      pv.audioLatency = latencyMs;

      const rateStr = rate >= 1000 ? rate / 1000 + ' kHz' : rate ? rate + ' Hz' : '—';
      const parts = [
        `Slots ${active}/${max}`,
        `Loaded ${loaded}`,
        `Dropped ${dropped}`,
        `Vol ${masterVolR}%${muted ? ' (muted)' : ''}`,
        `Lat ${(latencyMs / 100).toFixed(2)} ms`,
        rateStr,
      ];
      if (els._extras) {
        els._extras.textContent = '';
        for (const part of parts) {
          const chip = document.createElement('span');
          chip.className = 'debug-ui-worker-detail';
          chip.textContent = part;
          els._extras.appendChild(chip);
        }
      }
    }
  }

  _updateSingleWorkerStats(workerType, statsSchema, stats) {
    const view = stats.workerStatViews[workerType];
    if (!view) return;
    const ws = this.elements.workerStats;
    if (!ws || !ws[workerType] || !ws[workerType][0]) return;
    this._writeWorkerCells(workerType, 0, view, statsSchema, stats, ws[workerType][0]);
  }

  _updateMultiWorkerStats(workerType, statsSchema, stats) {
    const views = stats.workerStatViews[workerType];
    if (!views || views.length === 0) return;
    const ws = this.elements.workerStats;
    if (!ws || !ws[workerType]) return;

    for (let i = 0; i < views.length; i++) {
      const elements = ws[workerType][i];
      if (!elements) continue;
      this._writeWorkerCells(workerType, i, views[i], statsSchema, stats, elements);
    }
  }

  _writeWorkerCells(workerType, workerIndex, view, statsSchema, stats, elements) {
    const config = WORKER_DISPLAY_CONFIG[workerType];
    if (!stats.prevWorker[workerType]) stats.prevWorker[workerType] = {};
    if (!stats.prevWorker[workerType][workerIndex]) stats.prevWorker[workerType][workerIndex] = {};
    const prevCache = stats.prevWorker[workerType][workerIndex];

    const smoother =
      workerType === 'spatial' || workerType === 'logic'
        ? stats.fpsSmoothing[workerType][workerIndex]
        : stats.fpsSmoothing[workerType];

    for (let s = 0; s < config.stats.length; s++) {
      const stat = config.stats[s];
      const el = elements[stat.key];
      if (!el) continue;

      let rawValue;
      if (stat.key === 'LOAD') {
        rawValue = workerLoadPct(view[statsSchema.STEP_MS] || 0);
      } else {
        rawValue = view[statsSchema[stat.key]];
        if (stat.key === 'FPS' && smoother) {
          rawValue = stats.smoothFPS(rawValue, smoother);
        }
      }
      const rounded = (rawValue * 100) | 0;
      if (prevCache[stat.key] === rounded) continue;
      prevCache[stat.key] = rounded;

      const formatted = stat.format(rawValue);
      if (COMMON_KEYS.includes(stat.key)) {
        el.textContent = formatted;
        if (stat.key === 'LOAD') this._setLoadBar(elements._loadFill, rawValue);
      } else {
        el.textContent = `${stat.label}: ${formatted}`;
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
