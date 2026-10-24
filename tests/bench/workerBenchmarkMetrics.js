import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
  createStatsReader,
  createMultiWorkerStatsReaderArray,
} from '../../src/util/workersUtils.js';
import { frameClockSlot } from '../../src/util/frameClock.js';

const FRAME_RATE_STRIDE_FLOATS = 16;

/** Keys in frozen stat schemas that are not Float32 buffer column indices */
const STAT_SCHEMA_META_KEYS = new Set([
  'STRIDE_FLOATS',
  'BUFFER_SIZE',
  'BUFFER_SIZE_PER_WORKER',
]);

export function readWorkerStatsFields(statsView, statsSchema) {
  if (!statsView || !statsSchema) return null;
  const stride = statsSchema.STRIDE_FLOATS;
  if (typeof stride !== 'number' || stride <= 0) return null;
  const out = Object.create(null);
  for (const key of Object.keys(statsSchema)) {
    if (STAT_SCHEMA_META_KEYS.has(key)) continue;
    const idx = statsSchema[key];
    if (typeof idx !== 'number' || idx < 0 || idx >= stride) continue;
    out[key] = Number(statsView[idx]) || 0;
  }
  return out;
}

function averageStatFieldMaps(statMaps) {
  const keys = new Set();
  for (const m of statMaps) {
    if (m && typeof m === 'object') {
      for (const k of Object.keys(m)) keys.add(k);
    }
  }
  if (keys.size === 0) return null;
  const out = Object.create(null);
  for (const k of keys) {
    let sum = 0;
    let n = 0;
    for (const m of statMaps) {
      if (m && typeof m === 'object' && typeof m[k] === 'number') {
        sum += m[k];
        n++;
      }
    }
    out[k] = n > 0 ? sum / n : 0;
  }
  return out;
}

export function getWorkerFrameRateLayout({
  spatialWorkerCount = 0,
  logicWorkerCount = 0,
  preRenderWorkerCount = 1,
  physicsEnabled = true,
} = {}) {
  const layout = [];

  for (let i = 0; i < spatialWorkerCount; i++) {
    layout.push({
      id: `spatial${i}`,
      type: 'spatial',
      workerIndex: i,
      frameRateIndex: i,
    });
  }

  const physicsIndex = spatialWorkerCount;
  const rendererIndex = spatialWorkerCount + 1;
  const particleIndex = spatialWorkerCount + 2;
  const logicStartIndex = spatialWorkerCount + 3;

  if (physicsEnabled !== false) {
    layout.push({
      id: 'physics',
      type: 'physics',
      workerIndex: 0,
      frameRateIndex: physicsIndex,
    });
  }
  layout.push({
    id: 'renderer',
    type: 'renderer',
    workerIndex: 0,
    frameRateIndex: rendererIndex,
  });
  layout.push({
    id: 'particle',
    type: 'particle',
    workerIndex: 0,
    frameRateIndex: particleIndex,
  });

  for (let i = 0; i < logicWorkerCount; i++) {
    layout.push({
      id: `logic${i}`,
      type: 'logic',
      workerIndex: i,
      frameRateIndex: logicStartIndex + i,
    });
  }

  const preCount = preRenderWorkerCount > 0 ? preRenderWorkerCount : 1;
  const preStart = logicStartIndex + logicWorkerCount;
  for (let i = 0; i < preCount; i++) {
    layout.push({
      id: preCount === 1 ? 'preRender' : `preRender${i}`,
      type: 'preRender',
      workerIndex: i,
      frameRateIndex: preStart + i,
    });
  }

  return layout;
}

function getSceneWorkerCounts(scene) {
  return {
    spatialWorkerCount: scene?.config?.spatial?.numberOfSpatialWorkers || 0,
    logicWorkerCount: scene?.numberOfLogicWorkers ?? scene?.config?.logic?.numberOfLogicWorkers ?? 1,
    preRenderWorkerCount: scene?.numberOfPreRenderWorkers
      ?? scene?.config?.preRender?.numberOfPreRenderWorkers
      ?? 1,
    physicsEnabled: scene?._physicsEnabled !== false,
  };
}

function getFrameRateValue(scene, frameRateIndex) {
  const view = scene?.views?.frameRate;
  if (!view || frameRateIndex < 0) return 0;
  return view[frameRateIndex * FRAME_RATE_STRIDE_FLOATS] || 0;
}

/** The worker's slot in the frame clock and the frame totals; -1 when it has none (a second pre-render). */
function totalsSlotOf(entry) {
  if (entry.type === 'preRender') return entry.workerIndex === 0 ? frameClockSlot('preRender') : -1;
  if (entry.type === 'spatial' || entry.type === 'logic') return frameClockSlot(entry.type, entry.workerIndex);
  return frameClockSlot(entry.type);
}

function buildWorkerReaders(scene) {
  const counts = getSceneWorkerCounts(scene);
  const layout = getWorkerFrameRateLayout(counts);
  const buffers = scene?.buffers || {};

  const singleReaders = {
    physics: buffers.physicsStats ? createStatsReader(buffers.physicsStats, PHYSICS_STATS) : null,
    renderer: buffers.rendererStats ? createStatsReader(buffers.rendererStats, RENDERER_STATS) : null,
    particle: buffers.particleStats ? createStatsReader(buffers.particleStats, PARTICLE_STATS) : null,
  };
  const preRenderCount = counts.preRenderWorkerCount > 0 ? counts.preRenderWorkerCount : 1;
  const multiReaders = {
    spatial: buffers.spatialStats
      ? createMultiWorkerStatsReaderArray(buffers.spatialStats, SPATIAL_STATS, counts.spatialWorkerCount)
      : [],
    logic: buffers.logicStats
      ? createMultiWorkerStatsReaderArray(buffers.logicStats, LOGIC_STATS, counts.logicWorkerCount)
      : [],
    preRender: buffers.preRenderStats
      ? createMultiWorkerStatsReaderArray(buffers.preRenderStats, PRE_RENDER_STATS, preRenderCount)
      : [],
  };

  return layout.map((entry) => {
    let statsView = null;
    let statsSchema = null;

    if (entry.type === 'spatial') {
      statsView = multiReaders.spatial[entry.workerIndex] || null;
      statsSchema = SPATIAL_STATS;
    } else if (entry.type === 'logic') {
      statsView = multiReaders.logic[entry.workerIndex] || null;
      statsSchema = LOGIC_STATS;
    } else if (entry.type === 'physics') {
      statsView = singleReaders.physics;
      statsSchema = PHYSICS_STATS;
    } else if (entry.type === 'renderer') {
      statsView = singleReaders.renderer;
      statsSchema = RENDERER_STATS;
    } else if (entry.type === 'particle') {
      statsView = singleReaders.particle;
      statsSchema = PARTICLE_STATS;
    } else if (entry.type === 'preRender') {
      statsView = multiReaders.preRender[entry.workerIndex] || null;
      statsSchema = PRE_RENDER_STATS;
    }

    return {
      ...entry,
      statsView,
      statsSchema,
      totalsSlot: totalsSlotOf(entry),
    };
  });
}

/**
 * @param {object} scene
 * @param {{ frameTotals?: null | typeof import('../../src/util/frameTotals.js') }} [opts] the totals module,
 *   passed only when the scene has the buffer: a baseline revision older than it has neither, and its windows
 *   stay sampled
 */
export function createWorkerBenchmarkReader(scene, { frameTotals = null } = {}) {
  const workerReaders = buildWorkerReaders(scene);
  const sceneName = scene?.constructor?.name || 'UnknownScene';
  const totalsView = frameTotals && scene?.buffers?.frameTotals ? frameTotals.bindFrameTotals(scene.buffers.frameTotals) : null;
  const mainSlot = frameClockSlot('main');

  return {
    sceneName,
    /** Diffs two snapshots' totals of one worker (frameTotals.totalsWindow), or null without the buffer. */
    totalsWindow: totalsView ? frameTotals.totalsWindow : null,
    workerLayout: workerReaders.map(({ id, type, workerIndex, frameRateIndex }) => ({
      id,
      type,
      workerIndex,
      frameRateIndex,
    })),
    /** `totals`: also copy every worker's running totals (the window's two ends need them, samples do not). */
    snapshot(takenAtMs = performance.now(), { totals = false } = {}) {
      const withTotals = totals && totalsView;
      return {
        sceneName,
        takenAtMs,
        mainFrameNumber: scene?.mainFrameNumber || 0,
        mainFPS: scene?.mainFPS || 0,
        mainTotals: withTotals ? frameTotals.readTotals(totalsView, mainSlot) : null,
        workers: workerReaders.map(({ id, type, workerIndex, frameRateIndex, statsView, statsSchema, totalsSlot }) => ({
          id,
          type,
          workerIndex,
          frameRateIndex,
          currentFPS:
            (statsView && statsSchema ? statsView[statsSchema.FPS] : 0) ||
            getFrameRateValue(scene, frameRateIndex),
          stats: readWorkerStatsFields(statsView, statsSchema),
          totals: withTotals ? frameTotals.readTotals(totalsView, totalsSlot) : null,
        })),
      };
    },
  };
}

/**
 * `totalsWindow` (the reader's): each worker's `exact` window from the two ends' running totals, every frame
 * it published between them, next to the sampled averages.
 */
export function summarizeWorkerBenchmarkWindow(
  startSnapshot,
  endSnapshot,
  { measurementDurationMs, sampleSnapshots = [], totalsWindow = null } = {}
) {
  const elapsedWallTimeMs = Math.max(
    0,
    measurementDurationMs ?? (endSnapshot.takenAtMs - startSnapshot.takenAtMs)
  );
  const effectiveSamples =
    sampleSnapshots.length > 0 ? [...sampleSnapshots, endSnapshot] : [endSnapshot];

  const workers = endSnapshot.workers.map((worker) => {
    let sumFPS = 0;
    let sampleCount = 0;
    const statMaps = [];

    for (const sample of effectiveSamples) {
      const sampledWorker = sample.workers.find((candidate) => candidate.id === worker.id);
      if (!sampledWorker) continue;
      sumFPS += sampledWorker.currentFPS || 0;
      sampleCount++;
      if (sampledWorker.stats) statMaps.push(sampledWorker.stats);
    }

    const averageFPS = sampleCount > 0 ? sumFPS / sampleCount : 0;
    const statsSamplesAverage = averageStatFieldMaps(statMaps);
    const statsEnd = worker.stats || null;
    let spritesUploadMs = null;
    let spritesUploadSamples = 0;
    let spritesSkipSamples = 0;
    if (worker.type === 'renderer') {
      let sum = 0;
      for (const sample of effectiveSamples) {
        const sampledWorker = sample.workers.find((candidate) => candidate.id === worker.id);
        const sprites = sampledWorker?.stats?.SPRITES_MS;
        if (sprites > 0) {
          sum += sprites;
          spritesUploadSamples++;
        } else {
          spritesSkipSamples++;
        }
      }
      spritesUploadMs = spritesUploadSamples > 0 ? sum / spritesUploadSamples : 0;
    }

    const startWorker = startSnapshot.workers?.find((candidate) => candidate.id === worker.id);
    const exact = totalsWindow ? totalsWindow(startWorker?.totals, worker.totals) : null;

    return {
      id: worker.id,
      type: worker.type,
      workerIndex: worker.workerIndex,
      frameRateIndex: worker.frameRateIndex,
      instantaneousFPS: worker.currentFPS,
      averageFPS,
      sampleCount,
      exact,
      ...(spritesUploadMs != null
        ? { spritesUploadMs, spritesUploadSamples, spritesSkipSamples }
        : {}),
      ...(statsEnd || statsSamplesAverage
        ? {
            statsEnd,
            statsSamplesAverage,
          }
        : {}),
    };
  });

  const workersByType = Object.create(null);
  for (const worker of workers) {
    if (!workersByType[worker.type]) {
      workersByType[worker.type] = [];
    }
    workersByType[worker.type].push(worker);
  }

  const mainFrameDelta = Math.max(0, endSnapshot.mainFrameNumber - startSnapshot.mainFrameNumber);

  return {
    sceneName: endSnapshot.sceneName || startSnapshot.sceneName || 'UnknownScene',
    measurementDurationMs: elapsedWallTimeMs,
    mainThread: {
      averageFPS:
        effectiveSamples.length > 0
          ? effectiveSamples.reduce((sum, sample) => sum + (sample.mainFPS || 0), 0) /
            effectiveSamples.length
          : elapsedWallTimeMs > 0
            ? (mainFrameDelta * 1000) / elapsedWallTimeMs
            : 0,
      instantaneousFPS: endSnapshot.mainFPS || 0,
      frameDelta: mainFrameDelta,
      // The frames the page presented in the window over its length, and the main thread's step (exact).
      exactFPS: totalsWindow && elapsedWallTimeMs > 0 ? (mainFrameDelta * 1000) / elapsedWallTimeMs : null,
      exact: totalsWindow ? totalsWindow(startSnapshot.mainTotals, endSnapshot.mainTotals) : null,
    },
    workers,
    workersByType,
  };
}
