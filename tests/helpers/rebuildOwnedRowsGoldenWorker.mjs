// One run of tests/node/rebuildOwnedRowsGolden.test.js, in its own thread (Grid and the component columns are
// static state): real SpatialWorkers on a scripted world, SpatialWorker.rebuildOwnedRows called on each worker frame
// after frame, and a hash a frame of every byte it writes. Posts { sums, crossers, capped, points }.
import { parentPort, workerData } from 'node:worker_threads';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Grid } from '../../src/core/grid.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

const { workers: workerCount, idWidth, rowsPerBlock } = workerData;
const N = 3000;
const W = 1000;
const H = 1000;
const CELL = 20;

let seed = 0x471 + workerCount * 31 + idWidth;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
};

const k = await setupSpatialKernel({
  n: N,
  workers: workerCount,
  idWidth,
  seed: 0x471,
  spatial: { worldWidth: W, worldHeight: H, cellSize: CELL, maxNeighbors: 32, maxEntitiesPerCell: 4, rowsPerBlock },
});
const workers = k.workers;
const meta = k.gridMetadata;

// The world. Kinds, by draw: sprite-only points (offsets, some NaN), circles (radius 0 and NaN among them), turned
// boxes (zero sizes among them), polygons without vertices (getColliderBounds' own branch), entities with neither a
// collider nor a sprite, colliders without a sprite, and points whose Y lands a hair from a row's edge, so that the
// float32 home row and the row of the cell they cover differ. Places reach past the world on every side (clamps), and
// clusters overfill cells past maxEntitiesPerCell.
const vx = new Float32Array(N);
const vy = new Float32Array(N);
const kind = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const d = rnd();
  const kd = d < 0.3 ? 0 : d < 0.45 ? 1 : d < 0.6 ? 2 : d < 0.65 ? 3 : d < 0.7 ? 4 : d < 0.75 ? 5 : 6;
  kind[i] = kd;
  const clustered = rnd() < 0.3;
  Transform.active[i] = 1;
  Transform.x[i] = clustered ? 500 + rnd() * 30 : -60 + rnd() * (W + 120);
  Transform.y[i] = kd === 6 ? ((rnd() * (H / CELL)) | 0) * CELL : clustered ? 500 + rnd() * 30 : -60 + rnd() * (H + 120);
  const a = rnd() * 2 * Math.PI;
  Transform.rotC[i] = Math.cos(a);
  Transform.rotS[i] = Math.sin(a);
  Collider.offsetX[i] = rnd() < 0.5 ? 0 : (rnd() - 0.5) * 10;
  Collider.offsetY[i] = kd === 6 ? (rnd() < 0.5 ? -1 : 1) * (rnd() < 0.5 ? 1e-7 : 1e-6) : rnd() < 0.5 ? 0 : (rnd() - 0.5) * 10;
  if (kd === 0 && rnd() < 0.03) Collider.offsetX[i] = NaN;
  Collider.active[i] = kd === 1 || kd === 2 || kd === 3 || kd === 5 ? 1 : 0;
  Collider.shapeType[i] = kd === 1 ? ShapeType.Circle : kd === 2 ? ShapeType.Box : kd === 3 ? ShapeType.Polygon : rnd() < 0.5 ? ShapeType.Circle : ShapeType.Box;
  Collider.radius[i] = kd === 1 && rnd() < 0.1 ? (rnd() < 0.5 ? 0 : NaN) : rnd() * 25;
  Collider.width[i] = rnd() < 0.05 ? 0 : rnd() * 40;
  Collider.height[i] = rnd() < 0.05 ? 0 : rnd() * 40;
  if (kd === 3) {
    Collider.polyCount[i] = 0;
    if (Collider.fixtureCount) Collider.fixtureCount[i] = 0;
  }
  SpriteRenderer.active[i] = kd === 5 || kd === 4 ? 0 : 1;
  RigidBody.active[i] = rnd() < 0.5 ? 1 : 0;
  vx[i] = rnd() < 0.7 ? (rnd() - 0.5) * 8 : 0;
  vy[i] = rnd() < 0.7 ? (rnd() - 0.5) * 8 : 0;
}

// Coverage of the cases the hash is meant to hold: points across a row edge, cells over their cap.
let crossers = 0;
let points = 0;
for (let i = 0; i < N; i++) {
  if (kind[i] !== 6) continue;
  const posY = Transform.y[i] + Collider.offsetY[i];
  if (((Math.fround(posY) * (1 / CELL)) | 0) !== ((posY * (1 / CELL)) | 0)) crossers++;
}

function fnv(h, v) {
  return Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
}
const gridWords = new Int32Array(k.mem.buffer, meta.gridByte, (meta.totalCells * Grid.cellByteSize) >> 2);
const posWords = new Int32Array(k.mem.buffer, meta.posByte, N * 4);
function hash() {
  let h = 2166136261;
  for (let i = 0; i < gridWords.length; i++) h = fnv(h, gridWords[i]);
  for (let i = 0; i < posWords.length; i++) h = fnv(h, posWords[i]);
  for (const w of workers) {
    h = fnv(h, w._ownedEntityCount);
    for (let i = 0; i < w._ownedEntityCount; i++) h = fnv(h, w._ownedEntityList[i]);
    h = fnv(h, w._noBodyCount);
    h = fnv(h, w._poseChanged ? 1 : 0);
    for (let c = 0; c < w._writtenCounts.length; c++) h = fnv(h, w._writtenCounts[c]);
    w._poseChanged = false;
  }
  return h;
}

const sums = [];
const FRAMES = 8;
for (let f = 0; f < FRAMES; f++) {
  // Frame 3 moves nobody: every pose compare runs to its end and finds nothing changed.
  if (f !== 3) {
    for (let i = 0; i < N; i++) {
      Transform.x[i] += vx[i];
      Transform.y[i] += vy[i];
    }
  }
  for (const w of workers) {
    w.collectDetailedStats = (f & 1) === 0;
    w.rebuildOwnedRows();
  }
  sums.push(hash());
}

// A worker without an active list (a hand-made layout: _rebuildGrid calls the rebuild with none) bins nothing.
const lists = workers.map((w) => w.activeEntitiesData);
for (const w of workers) {
  w.activeEntitiesData = null;
  w.rebuildOwnedRows();
}
sums.push(hash());
workers.forEach((w, j) => {
  w.activeEntitiesData = lists[j];
  w.rebuildOwnedRows();
});
sums.push(hash());

let capped = 0;
for (let c = 0; c < meta.totalCells; c++) if (Grid._gridCounts[c * Grid.cellByteSize] === Grid.maxEntitiesPerCell) capped++;
// Points: the rebuild's sprite-only branch (every worker but their row's owner bins nothing for them).
for (let i = 0; i < N; i++) if (kind[i] === 0 || kind[i] === 6) points++;
parentPort.postMessage({ sums, crossers, capped, points });
