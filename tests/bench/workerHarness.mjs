/**
 * Run a real engine worker in Node for kernels.
 *
 * The worker module is imported as-is: it constructs its own instance with
 * `new XWorker(self)` like in the browser, so kernels call the shipped methods
 * on an object built by the shipped constructor and `initialize()`. Nothing is
 * copied out of the worker; the kernel only feeds SABs and calls methods.
 *
 * The init payload is synthetic but goes through the real path
 * (`handleMessage({ msg: 'init' })` → initializeCommonBuffers → initialize).
 * Fields the kernel does not set are absent, so the instance can have fewer
 * properties than in a full scene; kernels that measure named access on
 * `this` say so in their report.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { entityIdBytes, EntityIdArray } from '../../src/util/entityIdWidth.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const posted = [];

function installSelf() {
  if (globalThis.self && globalThis.self.__weedHarness) return globalThis.self;
  const self = {
    __weedHarness: true,
    postMessage: (m) => {
      posted.push(m);
    },
    addEventListener() {},
    removeEventListener() {},
    onmessage: null,
    location: { origin: '' },
  };
  globalThis.self = self;
  return self;
}

/** Silence worker console chatter while `fn` runs (init logs a lot). */
export async function quietly(fn) {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.info = console.debug = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * Import `src/workers/<file>` and return the instance it put on `self`.
 * @param {string} file e.g. 'spatialWorker.js'
 * @param {string} selfKey e.g. 'spatialWorker'
 */
export async function loadWorker(file, selfKey) {
  const self = installSelf();
  await quietly(() => import(pathToFileURL(path.join(repoRoot, 'src/workers', file)).href));
  const worker = self[selfKey];
  if (!worker) throw new Error(`${file} did not set self.${selfKey}`);
  return worker;
}

/** Core component SABs for `n` entities (the ones every worker binds). */
export function coreComponentData(n) {
  const out = {};
  for (const C of [Transform, RigidBody, Collider, SpriteRenderer]) {
    out[C.name] = new SharedArrayBuffer(C.getBufferSize(n));
  }
  return out;
}

/**
 * Spatial grid buffers + metadata, sized like sceneSharedBuffers does.
 * @param {{ worldWidth: number, worldHeight: number, cellSize: number, maxEntitiesPerCell: number, maxNeighbors: number, rowsPerBlock?: number }} cfg
 * @param {number} n entity count
 */
export function spatialBuffers(cfg, n) {
  const idBytes = entityIdBytes();
  const gridCols = Math.ceil(cfg.worldWidth / cfg.cellSize);
  const gridRows = Math.ceil(cfg.worldHeight / cfg.cellSize);
  const totalCells = gridCols * gridRows;
  const cellByteSize = 4 + cfg.maxEntitiesPerCell * idBytes;
  const buffers = {
    gridBuffer: new SharedArrayBuffer(totalCells * cellByteSize),
    cellSleepingBuffer: new SharedArrayBuffer(totalCells),
    cellVersionBuffer: new SharedArrayBuffer(totalCells * 4),
    entityPosData: new SharedArrayBuffer(n * 16),
    neighborData: new SharedArrayBuffer(n * (1 + cfg.maxNeighbors) * idBytes),
    activeEntitiesData: new SharedArrayBuffer((n + 1) * idBytes),
  };
  const gridMetadata = {
    cellSize: cfg.cellSize,
    invCellSize: 1 / cfg.cellSize,
    gridCols,
    gridRows,
    totalCells,
    maxEntitiesPerCell: cfg.maxEntitiesPerCell,
    maxNeighbors: cfg.maxNeighbors,
    rowsPerBlock: cfg.rowsPerBlock ?? 1,
    entityIdBytes: idBytes,
  };
  return { buffers, gridMetadata };
}

/**
 * Send the real `init` message. `extra` goes on the payload root
 * (workerIndex, totalSpatialWorkers, …).
 */
export async function initWorker(worker, { config, globalEntityCount, buffers, gridMetadata = null, extra = {} }) {
  const data = {
    msg: 'init',
    pageOrigin: '',
    config: { seed: 123456, canvasWidth: 1280, canvasHeight: 720, debug: {}, ...config },
    globalEntityCount,
    buffers,
    gridMetadata,
    registeredClasses: [],
    componentPools: {},
    frameRateStride: 16,
    frameRateIndex: 0,
    ...extra,
  };
  await quietly(() => worker.handleMessage({ data }));
  return data;
}

/**
 * Pose columns (Transform.x/y/rotC/rotS, RigidBody.vx/vy/angularVelocity) are
 * bound from the Box2D heap on `box2dReady` in the engine. Kernels without a
 * physics worker bind plain Float32Arrays of the same element kind.
 */
export function bindPoseColumns(n) {
  for (const k of ['x', 'y', 'rotC', 'rotS']) {
    if (!(Transform[k] instanceof Float32Array) || Transform[k].length < n) Transform[k] = new Float32Array(n);
  }
  for (const k of ['vx', 'vy', 'angularVelocity']) {
    if (!(RigidBody[k] instanceof Float32Array) || RigidBody[k].length < n) RigidBody[k] = new Float32Array(n);
  }
}

/** Fill the shared active list `[count, id0, id1, …]`. */
export function setActiveList(sab, ids) {
  const list = new (EntityIdArray())(sab);
  list[0] = ids.length;
  for (let i = 0; i < ids.length; i++) list[1 + i] = ids[i];
  return list;
}

export function postedMessages() {
  return posted;
}
