// StatsCollector.js — Reads worker shared buffers and provides smoothed stats

import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
  WORKER_DISPLAY_CONFIG,
  createStatsReader,
  createMultiWorkerStatsReaderArray,
} from '../../../workers/workers-utils.js';

/**
 * Manages worker stat buffer views, FPS smoothing, and cached previous values.
 * Panels read from this collector instead of touching buffers directly.
 */
export class StatsCollector {
  constructor() {
    this.workerStatViews = null;

    // 60-frame circular buffer for smoothed FPS
    this.fpsSmoothing = {
      frameCount: 60,
      renderer: this._createSmoother(),
      particle: this._createSmoother(),
      physics: this._createSmoother(),
      preRender: this._createSmoother(),
      spatial: [],
      logic: [],
    };

    // Previous-value caches (shared across panels to avoid duplicate DOM writes)
    this._prevValues = {
      mainFPS: -1,
      audioActive: -1,
      audioMax: -1,
      audioLoaded: -1,
      audioDropped: -1,
      audioMixGain: -1,
      audioMasterVol: -1,
      audioMuted: false,
      audioRate: -1,
      audioLatency: -1,
      activeGO: -1,
      totalGO: -1,
      visibleGO: -1,
      activeP: -1,
      totalP: -1,
      visibleP: -1,
      activeD: -1,
      totalD: -1,
      visibleD: -1,
      flashUpdated: -1,
      activeEntities: -1,
      totalEntities: -1,
      visibleEntities: -1,
      decorationTotal: -1,
      decorationActive: -1,
      decorationVisible: -1,
      decorationSprites: -1,
    };

    // Per-worker previous stat cache: { workerType: { workerIndex: { statKey: prev } } }
    this._prevWorkerStats = {};
  }

  // ------- lifecycle -------

  attach(scene) {
    if (!scene || !scene.buffers) return;

    const buffers = scene.buffers;
    const spatialCount = scene.config.spatial.numberOfSpatialWorkers;
    const logicCount = scene.numberOfLogicWorkers;

    this.workerStatViews = {
      renderer: buffers.rendererStats ? createStatsReader(buffers.rendererStats, RENDERER_STATS) : null,
      particle: buffers.particleStats ? createStatsReader(buffers.particleStats, PARTICLE_STATS) : null,
      physics: buffers.physicsStats ? createStatsReader(buffers.physicsStats, PHYSICS_STATS) : null,
      spatial: buffers.spatialStats
        ? createMultiWorkerStatsReaderArray(buffers.spatialStats, SPATIAL_STATS, spatialCount)
        : [],
      logic: buffers.logicStats
        ? createMultiWorkerStatsReaderArray(buffers.logicStats, LOGIC_STATS, logicCount)
        : [],
      preRender: buffers.preRenderStats
        ? createStatsReader(buffers.preRenderStats, PRE_RENDER_STATS)
        : null,
    };

    this.fpsSmoothing.spatial = [];
    for (let i = 0; i < spatialCount; i++) {
      this.fpsSmoothing.spatial.push(this._createSmoother());
    }

    this.fpsSmoothing.logic = [];
    for (let i = 0; i < logicCount; i++) {
      this.fpsSmoothing.logic.push(this._createSmoother());
    }

    this._prevWorkerStats = {};

    const pv = this._prevValues;
    pv.mainFPS = -1;
    pv.audioActive = -1; pv.audioMax = -1; pv.audioLoaded = -1;
    pv.audioDropped = -1; pv.audioMixGain = -1; pv.audioMasterVol = -1;
    pv.audioMuted = false; pv.audioRate = -1; pv.audioLatency = -1;
    pv.activeGO = -1; pv.totalGO = -1; pv.visibleGO = -1;
    pv.activeP = -1; pv.totalP = -1; pv.visibleP = -1;
    pv.activeD = -1; pv.totalD = -1; pv.visibleD = -1;
    pv.flashUpdated = -1;
    pv.activeEntities = -1; pv.totalEntities = -1; pv.visibleEntities = -1;
    pv.decorationTotal = -1; pv.decorationActive = -1;
    pv.decorationVisible = -1; pv.decorationSprites = -1;
  }

  detach() {
    this.workerStatViews = null;
  }

  // ------- helpers -------

  get prev() {
    return this._prevValues;
  }

  get prevWorker() {
    return this._prevWorkerStats;
  }

  smoothFPS(rawFPS, smoothing) {
    smoothing.sum -= smoothing.values[smoothing.index];
    smoothing.values[smoothing.index] = rawFPS;
    smoothing.sum += rawFPS;
    smoothing.index = (smoothing.index + 1) % smoothing.values.length;
    return smoothing.sum / smoothing.values.length;
  }

  _createSmoother() {
    return { values: new Array(60).fill(60), index: 0, sum: 3600 };
  }
}

// Re-export stat constants for convenience
export {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
  WORKER_DISPLAY_CONFIG,
};
