// Thread for tests/node/spatialGridMovers.test.js (E-126). Three real spatial workers in WASM mode
// (the grid in the spatial publish memory, the WASM gather) run one scripted world for some frames,
// with the grid rebuilt every frame (mode 1), chosen by the moved fraction (mode 0) or rewritten for
// what changed whenever the state allows (mode 2). Every frame posts a checksum of the whole publish
// memory (cells, poses, neighbour rows, candidates, markers) and of each worker's owned list, cell
// counts and counters, so the paths are compared byte for byte. Each thread has its own Grid statics
// and its own moved-bodies buffer, which this script publishes as the physics worker would.
import { parentPort, workerData } from 'node:worker_threads';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Grid } from '../../src/core/grid.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { getColliderBounds, getCellRange, _boundsResult, _cellRangeResult, SHAPE_CIRCLE } from '../../src/util/colliderUtils.js';
import {
  bindMovedBodies,
  copyMovedBodies,
  createMovedBodiesSab,
  HDR_SEQ,
  publishMovedBodies,
  viewsFromSab,
} from '../../src/box2d/box2dMovedBodies.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { variantClass } from '../bench/methodVariant.mjs';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

const { mode, detailed = false, patches = null, frames = 90 } = workerData;

const N = 3000;
const MAX_PER_CELL = 32;
const CFG = {
  worldWidth: 4096,
  worldHeight: 3072,
  cellSize: 128,
  maxNeighbors: 48,
  maxEntitiesPerCell: MAX_PER_CELL,
  rowsPerBlock: 2,
  neighborReuseSkin: 0.02,
  neighborReuseMaxFrames: 10,
  neighborTickInterval: 3,
};
const MAX_POLY = Collider.MAX_POLYGON_VERTICES;

// What _rebuildMovedRows reads from its module, for a variant compiled from its source.
const SCOPE = {
  Transform,
  RigidBody,
  Collider,
  SpriteRenderer,
  Grid,
  getColliderBounds,
  getCellRange,
  _boundsResult,
  _cellRangeResult,
  SHAPE_CIRCLE,
  copyMovedBodies,
  MV_PRESENT: 1,
  MV_IN_GRID: 2,
  MV_OWNED: 4,
  MV_LOOSE: 8,
  MV_SPRITE: 16,
};

const k = await setupSpatialKernel({
  n: N,
  workers: 3,
  spatial: CFG,
  publishMemory: 'product',
  wasm: {},
  make: patches ? (Base) => variantClass(Base, patches, SCOPE) : undefined,
});
const { workers } = k;
const movedSab = createMovedBodiesSab(N);
bindMovedBodies(movedSab);
const movedHeader = viewsFromSab(movedSab).hdrI32;
const queryVersion = new Int32Array(new SharedArrayBuffer(4));
for (const w of workers) {
  w.queryVersionData = queryVersion;
  w._gridMoversMode = mode;
  w.collectDetailedStats = detailed;
}

// ---- The world -----------------------------------------------------------------------------
// kind (i % 12): 0-5 circles with a rigid body, 6 rotated boxes up to 300 px (many cells), 7
// polygons (some compound), 8 chains, 9 sprites without a body (moved by "logic", in no list),
// 10 sprites with a rigid body and no collider, 11 sprites without a body, hidden half the time.
// Ids 64-127 sit in a 30 px square inside cell (7, 7), so it holds more than MAX_PER_CELL: the
// lowest ids, these. Ids 128-159 (32, the cap) sit in cell (12, 5), which entities passing through
// push over the cap and back. Ids under 160 sleep and stay put unless an event below moves them;
// the others have higher ids, so a full cell does not hold them.
const rng = mulberry32(0xe126);
const W = CFG.worldWidth;
const H = CFG.worldHeight;
const vx = new Float32Array(N);
const vy = new Float32Array(N);
const awake = new Uint8Array(N);
const present = new Uint8Array(N);
const kindOf = (i) => i % 12;
const isBody = (i) => Collider.active[i] !== 0 || RigidBody.active[i] !== 0;
const inCluster = (i) => i >= 64 && i < 128;
const inClusterB = (i) => i >= 128 && i < 160;
const scripted = (i) => i < 160;

function place(i) {
  if (inCluster(i)) {
    Transform.x[i] = 940 + rng() * 30;
    Transform.y[i] = 940 + rng() * 30;
  } else if (inClusterB(i)) {
    Transform.x[i] = 1580 + rng() * 30;
    Transform.y[i] = 690 + rng() * 30;
  } else {
    // Not near cell (12, 5), so its count is the cluster's until something walks in.
    let x;
    let y;
    do {
      x = 2 + rng() * (W - 4);
      y = 2 + rng() * (H - 4);
    } while (x > 1536 - 320 && x < 1664 + 320 && y > 640 - 320 && y < 768 + 320);
    Transform.x[i] = x;
    Transform.y[i] = y;
  }
}

function setKind(i) {
  const kind = kindOf(i);
  const a = rng() * Math.PI * 2;
  Transform.rotC[i] = kind === 6 || kind === 7 || kind === 8 ? Math.cos(a) : 1;
  Transform.rotS[i] = kind === 6 || kind === 7 || kind === 8 ? Math.sin(a) : 0;
  Collider.offsetX[i] = i % 37 === 0 ? NaN : i % 41 === 0 ? -0 : (rng() - 0.5) * 8;
  Collider.offsetY[i] = i % 43 === 0 ? -0 : (rng() - 0.5) * 8;
  Collider.radius[i] = 2 + rng() * 12;
  Collider.width[i] = 10 + rng() * 290;
  Collider.height[i] = 10 + rng() * 120;
  Collider.polyCentroidX[i] = (rng() - 0.5) * 10;
  Collider.polyCentroidY[i] = (rng() - 0.5) * 10;
  Collider.fixtureCount[i] = 0;
  Collider.polyCount[i] = 0;
  Collider.visualRange[i] = i % 3 === 0 ? 0 : i % 3 === 1 ? 60 : 150;
  Collider.active[i] = kind <= 8 ? 1 : 0;
  RigidBody.active[i] = kind <= 5 || kind === 10 ? 1 : 0;
  SpriteRenderer.active[i] = kind === 11 ? (i & 1) : 1;
  if (kind <= 5) Collider.shapeType[i] = ShapeType.Circle;
  else if (kind === 6) Collider.shapeType[i] = ShapeType.Box;
  else if (kind === 7) {
    Collider.shapeType[i] = ShapeType.Polygon;
    if (i % 5 === 0) Collider.fixtureCount[i] = 2;
    else {
      const count = 3 + (i % (MAX_POLY - 2));
      Collider.polyCount[i] = count;
      for (let v = 0; v < count; v++) {
        const t = (v / count) * Math.PI * 2;
        Collider.polyVertexX[i * MAX_POLY + v] = Math.cos(t) * (5 + rng() * 40);
        Collider.polyVertexY[i * MAX_POLY + v] = Math.sin(t) * (5 + rng() * 40);
      }
    }
  } else if (kind === 8) Collider.shapeType[i] = ShapeType.Chain;
  else Collider.shapeType[i] = ShapeType.Circle;
  vx[i] = (rng() - 0.5) * 60;
  vy[i] = (rng() - 0.5) * 60;
}

for (let i = 0; i < N; i++) {
  Transform.active[i] = 0;
  setKind(i);
  place(i);
  present[i] = i % 10 === 3 && !scripted(i) ? 0 : 1;
  Transform.active[i] = present[i];
}

const activeList = workers[0].activeEntitiesData;
function writeActiveList() {
  let c = 0;
  for (let i = 0; i < N; i++) if (present[i]) activeList[1 + c++] = i;
  activeList[0] = c;
  Atomics.add(queryVersion, 0, 1);
}
writeActiveList();

/** Share of the bodies awake, by frame: low, high (the full rebuild in auto), low, half, low. */
function awakeShare(f) {
  if (f < 15) return 0.05;
  if (f < 25) return 0.7;
  if (f < 45) return 0.04;
  if (f < 55) return 0.5;
  return 0.06;
}

/** A random entity present (or absent), not one the scripted events move. */
function pick(want) {
  for (let tries = 0; tries < 64; tries++) {
    const i = (rng() * N) | 0;
    if (!scripted(i) && !!present[i] === want) return i;
  }
  return -1;
}

/** Move a body (it is in physics' list) or a sprite without one (in no list). */
function moveTo(i, x, y) {
  Transform.x[i] = x;
  Transform.y[i] = y;
  if (isBody(i)) list1(i);
}

const listed = new Uint8Array(N);
const list = new Int32Array(N);
let listCount = 0;
function list1(i) {
  if (listed[i]) return;
  listed[i] = 1;
  list[listCount++] = i;
}

function frameWorld(f) {
  listCount = 0;
  listed.fill(0);
  let population = false;
  // Physics did not step: no body moves, nothing is published (the movers path sees no new list).
  const physicsIdle = f % 9 === 8;

  if (f === 0 || f === 15 || f === 25 || f === 45 || f === 55) {
    const share = awakeShare(f);
    for (let i = 0; i < N; i++) awake[i] = !scripted(i) && rng() < share ? 1 : 0;
  }
  // Some fall asleep, as many wake.
  for (let t = 0; t < 20; t++) {
    const i = (rng() * N) | 0;
    if (!scripted(i)) awake[i] = awake[i] ? 0 : 1;
  }

  for (let i = 0; i < N; i++) {
    if (!present[i] || !awake[i]) continue;
    const body = isBody(i);
    if (body && physicsIdle) continue;
    let x = Transform.x[i] + vx[i];
    let y = Transform.y[i] + vy[i];
    if (x < 1 || x > W - 1) {
      vx[i] = -vx[i];
      x = Transform.x[i];
    }
    if (y < 1 || y > H - 1) {
      vy[i] = -vy[i];
      y = Transform.y[i];
    }
    if (rng() < 0.01) {
      x = 2 + rng() * (W - 4);
      y = 2 + rng() * (H - 4);
    }
    Transform.x[i] = x;
    Transform.y[i] = y;
    if (body) {
      // A turning box or polygon moves its bounds too.
      if (kindOf(i) >= 6 && kindOf(i) <= 8) {
        const a = rng() * Math.PI * 2;
        Transform.rotC[i] = Math.cos(a);
        Transform.rotS[i] = Math.sin(a);
      }
      list1(i);
    }
  }

  if (!physicsIdle) {
    // Despawns and spawns (a body created or destroyed is in physics' list).
    for (let t = 0; t < 6; t++) {
      const i = pick(true);
      if (i < 0) continue;
      present[i] = 0;
      Transform.active[i] = 0;
      population = true;
      if (isBody(i)) list1(i);
    }
    for (let t = 0; t < 6; t++) {
      const i = pick(false);
      if (i < 0) continue;
      setKind(i);
      place(i);
      present[i] = 1;
      Transform.active[i] = 1;
      awake[i] = rng() < 0.5 ? 1 : 0;
      population = true;
      if (isBody(i)) list1(i);
    }
    // A pooled index despawned and spawned again elsewhere between two frames: the active list
    // does not change, the query version does.
    for (let t = 0; t < 2; t++) {
      const i = pick(true);
      if (i < 0) continue;
      setKind(i);
      place(i);
      population = true;
      if (isBody(i)) list1(i);
    }
    // A collider switched off and on again on a rigid body (the body stays, LIFECYCLE lists it).
    if (f % 7 === 3) {
      for (let t = 0; t < 3; t++) {
        const i = pick(true);
        if (i < 0 || kindOf(i) > 5) continue;
        Collider.active[i] = Collider.active[i] ? 0 : 1;
        list1(i);
      }
    }
    // A sleeping body reshaped (GEOMETRY lists it).
    if (f % 5 === 1) {
      for (let t = 0; t < 8; t++) {
        const i = pick(true);
        if (i < 0 || !Collider.active[i]) continue;
        Collider.radius[i] = 2 + rng() * 40;
        Collider.width[i] = 10 + rng() * 290;
        Collider.offsetX[i] = (rng() - 0.5) * 60;
        list1(i);
      }
    }
    // A body at NaN, and back.
    if (f === 30) {
      Transform.y[12] = NaN;
      list1(12);
    }
    if (f === 34) {
      Transform.y[12] = 500;
      list1(12);
    }
    // The cell over its cap holds its lowest ids. One of those leaves (the movers path gives up:
    // it does not know which entity takes the place) and comes back (it takes a place again);
    // one it does not hold leaves and comes back (nothing to give up on); one despawns and spawns.
    if (f === 12) moveTo(64, 2000, 2000);
    if (f === 14) moveTo(64, 950, 960);
    if (f === 28) moveTo(124, 3000, 300);
    if (f === 33) moveTo(124, 955, 945);
    if (f === 64) {
      present[70] = 0;
      Transform.active[70] = 0;
      population = true;
      list1(70);
    }
    if (f === 70) {
      place(70);
      present[70] = 1;
      Transform.active[70] = 1;
      population = true;
      list1(70);
    }
    // Cell (12, 5) at its cap takes one more, a lower id (the highest one drops out), which then
    // leaves: the cell is over its cap until then, and the path gives up.
    if (f === 16) moveTo(61, 1600, 700);
    if (f === 19) moveTo(61, 2600, 2600);
    // A body whose Y rounds up to the next row in float32 (the home row findNeighbors reads).
    if (f === 24) {
      Transform.x[62] = 2000;
      Transform.y[62] = 767.5;
      Collider.offsetY[62] = 0.49999988;
      list1(62);
    }
    // The sprite below got a collider on the idle frame; physics lists its new body now, and later
    // the collider goes again.
    if (f === 27) list1(57);
    if (f === 60) {
      Collider.active[57] = 0;
      list1(57);
    }
  }
  // A sprite without a body walks into the full cell (taking a place) and out again.
  if (f === 38) moveTo(45, 952, 948);
  if (f === 58) moveTo(45, 300, 2500);
  // A sprite without a body gets a collider while physics does not step: no list has it yet.
  if (f === 26) Collider.active[57] = 1;
  // Sprites without a body: shown and hidden, moved to NaN and back. No list has them.
  if (f % 3 === 0) {
    for (let t = 0; t < 10; t++) {
      const i = pick(true);
      if (i < 0 || (kindOf(i) !== 9 && kindOf(i) !== 11)) continue;
      SpriteRenderer.active[i] = SpriteRenderer.active[i] ? 0 : 1;
    }
  }
  if (f === 31) Transform.x[21] = NaN;
  if (f === 36) Transform.x[21] = 700;
  // A sprite whose position becomes -0 + -0: the same bin, a different pose.
  if (f === 20) {
    Transform.x[9] = 0;
    Collider.offsetX[9] = 0;
  }
  if (f === 22) {
    Transform.x[9] = -0;
    Collider.offsetX[9] = -0;
  }

  if (population) writeActiveList();
  if (!physicsIdle) {
    // Physics' order is not the id order.
    for (let a = listCount - 1; a > 0; a--) {
      const b = (rng() * (a + 1)) | 0;
      const t = list[a];
      list[a] = list[b];
      list[b] = t;
    }
    publishMovedBodies(list, null, listCount, null, 0, null);
    // Two publishes between two spatial frames: the first list is lost to the movers path.
    if (f === 40) publishMovedBodies(list, null, 0, null, 0, null);
  }
}

// ---- The checksum ----------------------------------------------------------------------------
const memWords = new Int32Array(k.mem.buffer);
function hashWords(h, words, n = words.length) {
  for (let i = 0; i < n; i++) h = Math.imul(h ^ words[i], 16777619) >>> 0;
  return h;
}
function checksum() {
  let h = hashWords(2166136261, memWords);
  for (const w of workers) {
    for (const c of [
      w._ownedEntityCount,
      w._noBodyCount,
      w.entitiesProcessedThisFrame,
      w.neighborsReusedThisFrame,
      w.cellsCheckedThisFrame,
      w.neighborsFoundThisFrame,
    ]) {
      h = Math.imul(h ^ (c >>> 0), 16777619) >>> 0;
    }
    // The owned list up to its count: the full rebuild writes each entity there before it knows whether its row is
    // this worker's (E-166), so what lies past the count is not state either path reads.
    h = hashWords(h, w._ownedEntityList, w._ownedEntityCount);
    h = hashWords(h, w._localCellCounts);
  }
  return h >>> 0;
}

const sums = [];
const paths = workers.map(() => []);
let overfull = 0;
for (let f = 0; f < frames; f++) {
  frameWorld(f);
  // A publish in progress while the spatial workers read the header.
  if (f === 50) Atomics.add(movedHeader, HDR_SEQ, 1);
  for (const w of workers) w.update(16.67, 1, false);
  if (f === 50) Atomics.sub(movedHeader, HDR_SEQ, 1);
  sums.push(checksum());
  for (let w = 0; w < workers.length; w++) {
    paths[w].push(workers[w]._gridMoversThisFrame);
    const trueCount = workers[w]._mvTrue;
    if (workers[w]._mvSeeded) {
      for (let c = 0; c < trueCount.length; c++) if (trueCount[c] > MAX_PER_CELL) overfull++;
    }
  }
}
let noBody = 0;
for (const w of workers) noBody += w._noBodyCount;
parentPort.postMessage({ sums, paths, overfull, noBody, maxPerCell: Grid.maxEntitiesPerCell });
