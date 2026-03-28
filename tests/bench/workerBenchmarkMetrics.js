import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
  createStatsReader,
  createMultiWorkerStatsReaderArray,
} from '../../src/workers/workers-utils.js';

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

  layout.push({
    id: 'physics',
    type: 'physics',
    workerIndex: 0,
    frameRateIndex: physicsIndex,
  });
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

  layout.push({
    id: 'preRender',
    type: 'preRender',
    workerIndex: 0,
    frameRateIndex: logicStartIndex + logicWorkerCount,
  });

  return layout;
}

function getSceneWorkerCounts(scene) {
  return {
    spatialWorkerCount: scene?.config?.spatial?.numberOfSpatialWorkers || 0,
    logicWorkerCount: scene?.numberOfLogicWorkers ?? scene?.config?.logic?.numberOfLogicWorkers ?? 1,
  };
}

function getFrameRateValue(scene, frameRateIndex) {
  const view = scene?.views?.frameRate;
  if (!view || frameRateIndex < 0) return 0;
  return view[frameRateIndex * FRAME_RATE_STRIDE_FLOATS] || 0;
}

function buildWorkerReaders(scene) {
  const counts = getSceneWorkerCounts(scene);
  const layout = getWorkerFrameRateLayout(counts);
  const buffers = scene?.buffers || {};

  const singleReaders = {
    physics: buffers.physicsStats ? createStatsReader(buffers.physicsStats, PHYSICS_STATS) : null,
    renderer: buffers.rendererStats ? createStatsReader(buffers.rendererStats, RENDERER_STATS) : null,
    particle: buffers.particleStats ? createStatsReader(buffers.particleStats, PARTICLE_STATS) : null,
    preRender: buffers.preRenderStats ? createStatsReader(buffers.preRenderStats, PRE_RENDER_STATS) : null,
  };
  const multiReaders = {
    spatial: buffers.spatialStats
      ? createMultiWorkerStatsReaderArray(buffers.spatialStats, SPATIAL_STATS, counts.spatialWorkerCount)
      : [],
    logic: buffers.logicStats
      ? createMultiWorkerStatsReaderArray(buffers.logicStats, LOGIC_STATS, counts.logicWorkerCount)
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
      statsView = singleReaders.preRender;
      statsSchema = PRE_RENDER_STATS;
    }

    return {
      ...entry,
      statsView,
      statsSchema,
    };
  });
}

export function createWorkerBenchmarkReader(scene) {
  const workerReaders = buildWorkerReaders(scene);
  const sceneName = scene?.constructor?.name || 'UnknownScene';

  return {
    sceneName,
    workerLayout: workerReaders.map(({ id, type, workerIndex, frameRateIndex }) => ({
      id,
      type,
      workerIndex,
      frameRateIndex,
    })),
    snapshot(takenAtMs = performance.now()) {
      return {
        sceneName,
        takenAtMs,
        mainFrameNumber: scene?.mainFrameNumber || 0,
        mainFPS: scene?.mainFPS || 0,
        workers: workerReaders.map(({ id, type, workerIndex, frameRateIndex, statsView, statsSchema }) => ({
          id,
          type,
          workerIndex,
          frameRateIndex,
          currentFPS:
            (statsView && statsSchema ? statsView[statsSchema.FPS] : 0) ||
            getFrameRateValue(scene, frameRateIndex),
          stats: readWorkerStatsFields(statsView, statsSchema),
        })),
      };
    },
  };
}

export function summarizeWorkerBenchmarkWindow(
  startSnapshot,
  endSnapshot,
  { measurementDurationMs, sampleSnapshots = [] } = {}
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

    return {
      id: worker.id,
      type: worker.type,
      workerIndex: worker.workerIndex,
      frameRateIndex: worker.frameRateIndex,
      instantaneousFPS: worker.currentFPS,
      averageFPS,
      sampleCount,
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
    },
    workers,
    workersByType,
  };
}
