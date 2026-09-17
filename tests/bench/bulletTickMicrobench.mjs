// Microbenchmark + correctness for src/util/bulletTick.js (Node, no workers).
//
// One op = one tick of the live set (move + linecastDir).
// tickOpen / tickCrowded: hypot vs cached speed (pool full).
// Scan vs compact: optional liveIndices, no lock (single thread).
// Sparse cases show empty-slot scan cost (256 live / 2048 and 256 / 8192).
//
//   node tests/bench/bulletTickMicrobench.mjs
//   node tests/bench/bulletTickMicrobench.mjs --bullets 2048 --steps 800 --output tests/results/bullet-tick-micro.json

import { Ray } from '../../src/core/ray.js';
import { Grid } from '../../src/core/grid.js';
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { collectLiveBulletIndices, tickBulletsBuffers } from '../../src/util/bulletTick.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const WORLD_W = 4000;
const WORLD_H = 3000;
const CELL_SIZE = Number(args['cell-size'] ?? 128);
const MAX_PER_CELL = 64;
const ENTITY_COUNT = Number(args.entities ?? 2000);
const BULLET_COUNT = Number(args.bullets ?? 2048);
const SPARSE_LIVE = Number(args['sparse-live'] ?? 256);
const SPARSE_POOL_BIG = Number(args['sparse-pool'] ?? 8192);
const STEPS_OPEN = Number(args['steps-open'] ?? args.steps ?? 2000);
const STEPS_CROWDED = Number(args['steps-crowded'] ?? args.steps ?? 800);
const STEPS_SPARSE = Number(args['steps-sparse'] ?? args.steps ?? 800);
const SEED = Number(args.seed ?? 0xc0ffee);
const MARGIN = 64;
const OUTPUT = args.output ? String(args.output) : null;
const BULLET_SPEED = 1500;
const KEEP_OPS_PCT = 3;

const gridCols = Math.ceil(WORLD_W / CELL_SIZE);
const gridRows = Math.ceil(WORLD_H / CELL_SIZE);
const totalCells = gridCols * gridRows;
const cellByteSize = 4 + MAX_PER_CELL * 2;

function setupGrid(entityCount, rng) {
  Grid.cellSize = CELL_SIZE;
  Grid.invCellSize = 1 / CELL_SIZE;
  Grid.gridWidth = gridCols;
  Grid.gridHeight = gridRows;
  Grid.totalCells = totalCells;
  Grid.maxEntitiesPerCell = MAX_PER_CELL;
  Grid.cellByteSize = cellByteSize;

  const gridBuffer = new ArrayBuffer(totalCells * cellByteSize);
  Grid._gridBuffer = gridBuffer;
  Grid._gridCounts = new Uint8Array(gridBuffer);
  Grid._gridEntities = new Uint16Array(gridBuffer);

  const n = entityCount;
  Transform.active = new Uint8Array(Math.max(n, 1));
  Transform.x = new Float32Array(Math.max(n, 1));
  Transform.y = new Float32Array(Math.max(n, 1));
  Collider.active = new Uint8Array(Math.max(n, 1));
  Collider.shapeType = new Uint8Array(Math.max(n, 1));
  Collider.offsetX = new Float32Array(Math.max(n, 1));
  Collider.offsetY = new Float32Array(Math.max(n, 1));
  Collider.radius = new Float32Array(Math.max(n, 1));
  Collider.width = new Float32Array(Math.max(n, 1));
  Collider.height = new Float32Array(Math.max(n, 1));
  Collider.collisionLayer = new Uint8Array(Math.max(n, 1));

  if (n === 0) {
    Transform.active[0] = 0;
    Collider.active[0] = 0;
    return;
  }

  Transform.active.fill(1);
  Collider.active.fill(1);

  for (let i = 0; i < n; i++) {
    Transform.x[i] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
    Transform.y[i] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
    Collider.shapeType[i] = rng() < 0.7 ? 1 : 0;
    Collider.radius[i] = 4 + rng() * 16;
    Collider.width[i] = 8 + rng() * 32;
    Collider.height[i] = 8 + rng() * 32;
    Collider.collisionLayer[i] = (rng() * 8) | 0;
  }

  for (let i = 0; i < n; i++) {
    const px = Transform.x[i];
    const py = Transform.y[i];
    let halfW;
    let halfH;
    if (Collider.shapeType[i] === 1) {
      halfW = halfH = Collider.radius[i];
    } else {
      halfW = Collider.width[i] * 0.5;
      halfH = Collider.height[i] * 0.5;
    }
    const minCol = Math.max(0, ((px - halfW) / CELL_SIZE) | 0);
    const maxCol = Math.min(gridCols - 1, ((px + halfW) / CELL_SIZE) | 0);
    const minRow = Math.max(0, ((py - halfH) / CELL_SIZE) | 0);
    const maxRow = Math.min(gridRows - 1, ((py + halfH) / CELL_SIZE) | 0);
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        if (!Grid.addEntityToCell(row * gridCols + col, i)) {
          throw new Error(`cell overflow at ${row},${col} - raise MAX_PER_CELL`);
        }
      }
    }
  }
}

function setupBullets(poolSize) {
  const sab = new SharedArrayBuffer(BulletComponent.getBufferSize(poolSize));
  BulletComponent.initializeArrays(sab, poolSize);
  BulletComponent.bulletCount = poolSize;
}

function fillBulletSlot(i, rng, originX, originY) {
  const ang = rng() * Math.PI * 2;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  BulletComponent.active[i] = 1;
  BulletComponent.x[i] = originX;
  BulletComponent.y[i] = originY;
  BulletComponent.prevX[i] = originX;
  BulletComponent.prevY[i] = originY;
  BulletComponent.vx[i] = c * BULLET_SPEED;
  BulletComponent.vy[i] = s * BULLET_SPEED;
  BulletComponent.speed[i] = BULLET_SPEED;
  BulletComponent.bulletRotC[i] = c;
  BulletComponent.bulletRotS[i] = s;
  BulletComponent.damage[i] = 1;
  BulletComponent.ownerId[i] = 0;
  BulletComponent.shooterEntityType[i] = 0;
}

function fillBulletsDense(rng, originX, originY, poolSize) {
  BulletComponent.active.fill(0);
  for (let i = 0; i < poolSize; i++) {
    fillBulletSlot(i, rng, originX, originY);
  }
}

function fillBulletsSparse(rng, originX, originY, poolSize, liveCount) {
  BulletComponent.active.fill(0);
  const stride = Math.max(1, (poolSize / liveCount) | 0);
  const live = [];
  for (let i = 0; i < poolSize && live.length < liveCount; i += stride) {
    fillBulletSlot(i, rng, originX, originY);
    live.push(i);
  }
  if (live.length !== liveCount) {
    throw new Error(`sparse fill got ${live.length}, want ${liveCount}`);
  }
  return new Uint16Array(live);
}

function collectLiveIndices(poolSize) {
  const live = [];
  const active = BulletComponent.active;
  for (let i = 0; i < poolSize; i++) {
    if (active[i]) live.push(i);
  }
  return new Uint16Array(live);
}

function snapshotLive(poolSize) {
  return {
    active: BulletComponent.active.slice(0, poolSize),
    x: BulletComponent.x.slice(0, poolSize),
    y: BulletComponent.y.slice(0, poolSize),
    prevX: BulletComponent.prevX.slice(0, poolSize),
    prevY: BulletComponent.prevY.slice(0, poolSize),
  };
}

function restoreLive(snap) {
  BulletComponent.active.set(snap.active);
  BulletComponent.x.set(snap.x);
  BulletComponent.y.set(snap.y);
  BulletComponent.prevX.set(snap.prevX);
  BulletComponent.prevY.set(snap.prevY);
}

function tickArgs(useCached, excludeSet, activeData, poolSize, liveIndices) {
  return {
    maxBullets: poolSize,
    dtRatio: 1,
    active: BulletComponent.active,
    x: BulletComponent.x,
    y: BulletComponent.y,
    prevX: BulletComponent.prevX,
    prevY: BulletComponent.prevY,
    vx: BulletComponent.vx,
    vy: BulletComponent.vy,
    speed: useCached ? BulletComponent.speed : null,
    bulletRotC: BulletComponent.bulletRotC,
    bulletRotS: BulletComponent.bulletRotS,
    damage: BulletComponent.damage,
    ownerId: BulletComponent.ownerId,
    shooterEntityType: BulletComponent.shooterEntityType,
    activeData,
    impactHeader: null,
    impactData: null,
    maxImpacts: 0,
    excludeSet: useCached ? null : excludeSet,
    liveIndices: liveIndices || null,
    liveCount: liveIndices ? liveIndices.length : 0,
    onDespawn: null,
  };
}

function assertApprox(actual, expected, eps, msg) {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

function opsDeltaPct(compactOps, scanOps) {
  if (!(scanOps > 0)) return null;
  return ((compactOps - scanOps) / scanOps) * 100;
}

function checksumX(liveIndices) {
  let sum = 0;
  for (let n = 0; n < liveIndices.length; n++) {
    sum += BulletComponent.x[liveIndices[n]];
  }
  return sum;
}

Ray._rayGenStamp = new Uint32Array(Math.max(ENTITY_COUNT, SPARSE_POOL_BIG, 1));

setupBullets(BULLET_COUNT);
let activeData = new Uint16Array(1 + BULLET_COUNT);
const excludeSet = new Set();
const rngOpen = mulberry32(SEED);

setupGrid(0, rngOpen);
fillBulletsDense(rngOpen, WORLD_W * 0.5, WORLD_H * 0.5, BULLET_COUNT);

for (let i = 0; i < BULLET_COUNT; i++) {
  assertApprox(BulletComponent.speed[i], BULLET_SPEED, 1e-3, `speed[${i}]`);
  const n = BulletComponent.bulletRotC[i] ** 2 + BulletComponent.bulletRotS[i] ** 2;
  assertApprox(n, 1, 1e-4, `rot unit[${i}]`);
}

const x0 = BulletComponent.x[0];
const y0 = BulletComponent.y[0];
const vx0 = BulletComponent.vx[0];
const vy0 = BulletComponent.vy[0];
tickBulletsBuffers(tickArgs(true, excludeSet, activeData, BULLET_COUNT, null));
assertApprox(BulletComponent.x[0], x0 + vx0 / 60, 1e-3, 'open step x');
assertApprox(BulletComponent.y[0], y0 + vy0 / 60, 1e-3, 'open step y');
if (activeData[0] !== BULLET_COUNT) {
  throw new Error(`open field lost bullets: ${activeData[0]}`);
}

fillBulletsDense(mulberry32(SEED), WORLD_W * 0.5, WORLD_H * 0.5, BULLET_COUNT);
const openSnap = snapshotLive(BULLET_COUNT);
const cases = {};

cases.tickOpenHypot = timeIt(
  `tickOpen hypot (${BULLET_COUNT} bullets, empty grid)`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(openSnap);
      tickBulletsBuffers(tickArgs(false, excludeSet, activeData, BULLET_COUNT, null));
    }
  },
  { iterations: STEPS_OPEN }
);

cases.tickOpen = timeIt(
  `tickOpen cached speed (${BULLET_COUNT} bullets, empty grid)`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(openSnap);
      tickBulletsBuffers(tickArgs(true, excludeSet, activeData, BULLET_COUNT, null));
    }
  },
  { iterations: STEPS_OPEN }
);

const rngCrowd = mulberry32(SEED ^ 1);
setupGrid(ENTITY_COUNT, rngCrowd);
fillBulletsDense(rngCrowd, MARGIN + 40, WORLD_H * 0.5, BULLET_COUNT);
const crowdSnap = snapshotLive(BULLET_COUNT);

cases.tickCrowdedHypot = timeIt(
  `tickCrowded hypot (${BULLET_COUNT} bullets, ${ENTITY_COUNT} colliders)`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(crowdSnap);
      tickBulletsBuffers(tickArgs(false, excludeSet, activeData, BULLET_COUNT, null));
    }
  },
  { iterations: STEPS_CROWDED }
);

cases.tickCrowded = timeIt(
  `tickCrowded cached speed (${BULLET_COUNT} bullets, ${ENTITY_COUNT} colliders)`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(crowdSnap);
      tickBulletsBuffers(tickArgs(true, excludeSet, activeData, BULLET_COUNT, null));
    }
  },
  { iterations: STEPS_CROWDED }
);

const denseLive = collectLiveIndices(BULLET_COUNT);
if (denseLive.length !== BULLET_COUNT) {
  throw new Error(`dense live ${denseLive.length} != ${BULLET_COUNT}`);
}

restoreLive(crowdSnap);
tickBulletsBuffers(tickArgs(true, excludeSet, activeData, BULLET_COUNT, null));
const scanChecksum = checksumX(denseLive);
restoreLive(crowdSnap);
tickBulletsBuffers(tickArgs(true, excludeSet, activeData, BULLET_COUNT, denseLive));
assertApprox(checksumX(denseLive), scanChecksum, 1e-3, 'dense compact checksum');

cases.tickCrowdedScan = timeIt(
  `tickCrowded scan (${BULLET_COUNT}/${BULLET_COUNT})`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(crowdSnap);
      tickBulletsBuffers(tickArgs(true, excludeSet, activeData, BULLET_COUNT, null));
    }
  },
  { iterations: STEPS_CROWDED }
);

cases.tickCrowdedCompact = timeIt(
  `tickCrowded compact (${BULLET_COUNT}/${BULLET_COUNT})`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(crowdSnap);
      tickBulletsBuffers(tickArgs(true, excludeSet, activeData, BULLET_COUNT, denseLive));
    }
  },
  { iterations: STEPS_CROWDED }
);

function runSparsePair(label, poolSize, liveCount, crowded, steps) {
  setupBullets(poolSize);
  activeData = new Uint16Array(1 + poolSize);
  const rng = mulberry32(SEED ^ poolSize ^ liveCount);
  if (crowded) {
    setupGrid(ENTITY_COUNT, mulberry32(SEED ^ 1));
  } else {
    setupGrid(0, rng);
  }
  const originX = crowded ? MARGIN + 40 : WORLD_W * 0.5;
  const originY = WORLD_H * 0.5;
  const live = fillBulletsSparse(rng, originX, originY, poolSize, liveCount);
  const snap = snapshotLive(poolSize);
  const i0 = live[0];
  const xBefore = BulletComponent.x[i0];
  const vx = BulletComponent.vx[i0];
  if (!crowded) {
    tickBulletsBuffers(tickArgs(true, excludeSet, activeData, poolSize, null));
    assertApprox(BulletComponent.x[i0], xBefore + vx / 60, 1e-3, `${label} scan step x`);
    restoreLive(snap);
  }
  restoreLive(snap);
  tickBulletsBuffers(tickArgs(true, excludeSet, activeData, poolSize, null));
  const scanSum = checksumX(live);
  const scanCount = activeData[0];
  restoreLive(snap);
  tickBulletsBuffers(tickArgs(true, excludeSet, activeData, poolSize, live));
  assertApprox(checksumX(live), scanSum, 1e-3, `${label} compact checksum`);
  if (activeData[0] !== scanCount) {
    throw new Error(`${label} compact vs scan live ${activeData[0]} != ${scanCount}`);
  }

  const scan = timeIt(
    `${label} scan (${liveCount}/${poolSize})`,
    (iters) => {
      for (let s = 0; s < iters; s++) {
        restoreLive(snap);
        tickBulletsBuffers(tickArgs(true, excludeSet, activeData, poolSize, null));
      }
    },
    { iterations: steps }
  );
  const compact = timeIt(
    `${label} compact (${liveCount}/${poolSize})`,
    (iters) => {
      for (let s = 0; s < iters; s++) {
        restoreLive(snap);
        tickBulletsBuffers(tickArgs(true, excludeSet, activeData, poolSize, live));
      }
    },
    { iterations: steps }
  );
  return { scan, compact, liveCount, poolSize };
}

const sparseOpen2048 = runSparsePair('tickSparseOpen2048', BULLET_COUNT, SPARSE_LIVE, false, STEPS_SPARSE);
const sparseCrowd2048 = runSparsePair('tickSparseCrowded2048', BULLET_COUNT, SPARSE_LIVE, true, STEPS_SPARSE);
const sparseOpen8192 = runSparsePair('tickSparseOpen8192', SPARSE_POOL_BIG, SPARSE_LIVE, false, STEPS_SPARSE);
const sparseCrowd8192 = runSparsePair('tickSparseCrowded8192', SPARSE_POOL_BIG, SPARSE_LIVE, true, STEPS_SPARSE);

cases.tickSparseOpen2048Scan = sparseOpen2048.scan;
cases.tickSparseOpen2048Compact = sparseOpen2048.compact;
cases.tickSparseCrowded2048Scan = sparseCrowd2048.scan;
cases.tickSparseCrowded2048Compact = sparseCrowd2048.compact;
cases.tickSparseOpen8192Scan = sparseOpen8192.scan;
cases.tickSparseOpen8192Compact = sparseOpen8192.compact;
cases.tickSparseCrowded8192Scan = sparseCrowd8192.scan;
cases.tickSparseCrowded8192Compact = sparseCrowd8192.compact;

const compactPairs = {
  denseCrowded: opsDeltaPct(cases.tickCrowdedCompact.opsPerSec, cases.tickCrowdedScan.opsPerSec),
  sparseOpen2048: opsDeltaPct(sparseOpen2048.compact.opsPerSec, sparseOpen2048.scan.opsPerSec),
  sparseCrowded2048: opsDeltaPct(sparseCrowd2048.compact.opsPerSec, sparseCrowd2048.scan.opsPerSec),
  sparseOpen8192: opsDeltaPct(sparseOpen8192.compact.opsPerSec, sparseOpen8192.scan.opsPerSec),
  sparseCrowded8192: opsDeltaPct(sparseCrowd8192.compact.opsPerSec, sparseCrowd8192.scan.opsPerSec),
};

const compactKernelKeep = Object.values(compactPairs).some((d) => d != null && d >= KEEP_OPS_PCT);

const caseSummary = {};
for (const [key, result] of Object.entries(cases)) {
  caseSummary[key] = {
    ms: result.ms,
    opsPerSec: result.opsPerSec,
    iterations: result.iterations,
  };
}

console.log(
  `tickOpen hypot→cached: ${Math.round(cases.tickOpenHypot.opsPerSec)} → ${Math.round(cases.tickOpen.opsPerSec)} ops/s`
);
console.log(
  `tickCrowded hypot→cached: ${Math.round(cases.tickCrowdedHypot.opsPerSec)} → ${Math.round(cases.tickCrowded.opsPerSec)} ops/s`
);
console.log(
  `dense scan→compact: ${Math.round(cases.tickCrowdedScan.opsPerSec)} → ${Math.round(cases.tickCrowdedCompact.opsPerSec)} ops/s (${compactPairs.denseCrowded.toFixed(1)}%)`
);
console.log(
  `sparse 256/2048 open scan→compact: ${Math.round(sparseOpen2048.scan.opsPerSec)} → ${Math.round(sparseOpen2048.compact.opsPerSec)} ops/s (${compactPairs.sparseOpen2048.toFixed(1)}%)`
);
console.log(
  `sparse 256/2048 crowded scan→compact: ${Math.round(sparseCrowd2048.scan.opsPerSec)} → ${Math.round(sparseCrowd2048.compact.opsPerSec)} ops/s (${compactPairs.sparseCrowded2048.toFixed(1)}%)`
);
console.log(
  `sparse 256/8192 open scan→compact: ${Math.round(sparseOpen8192.scan.opsPerSec)} → ${Math.round(sparseOpen8192.compact.opsPerSec)} ops/s (${compactPairs.sparseOpen8192.toFixed(1)}%)`
);
console.log(
  `sparse 256/8192 crowded scan→compact: ${Math.round(sparseCrowd8192.scan.opsPerSec)} → ${Math.round(sparseCrowd8192.compact.opsPerSec)} ops/s (${compactPairs.sparseCrowded8192.toFixed(1)}%)`
);
console.log(`compact kernel keep (≥${KEEP_OPS_PCT}% ops/s on any sparse/dense pair): ${compactKernelKeep ? 'YES' : 'NO'}`);

const OCCUPANCY = [10, 50, 95];
const OCC_POOLS = [BULLET_COUNT, SPARSE_POOL_BIG];
const STEPS_OCC = Number(args['steps-occ'] ?? args.steps ?? 400);
const occupancyPairs = {};

function twoPassTick(poolSize, scratch, args) {
  const n = collectLiveBulletIndices(BulletComponent.active, poolSize, scratch);
  tickBulletsBuffers({ ...args, liveIndices: scratch, liveCount: n });
}

function runOccupancy(poolSize, occPct, steps) {
  const liveCount = Math.max(1, Math.round((poolSize * occPct) / 100));
  setupBullets(poolSize);
  activeData = new Uint16Array(1 + poolSize);
  const scratch = new Uint16Array(poolSize);
  const rng = mulberry32(SEED ^ poolSize ^ occPct);
  setupGrid(ENTITY_COUNT, mulberry32(SEED ^ 1));
  const live = fillBulletsSparse(rng, MARGIN + 40, WORLD_H * 0.5, poolSize, liveCount);
  const snap = snapshotLive(poolSize);
  const label = `occ${occPct}_${poolSize}`;

  restoreLive(snap);
  tickBulletsBuffers(tickArgs(true, excludeSet, activeData, poolSize, null));
  const fusedSum = checksumX(live);
  const fusedCount = activeData[0];

  restoreLive(snap);
  twoPassTick(poolSize, scratch, tickArgs(true, excludeSet, activeData, poolSize, null));
  assertApprox(checksumX(live), fusedSum, 1e-3, `${label} two-pass checksum`);
  if (activeData[0] !== fusedCount) {
    throw new Error(`${label} two-pass vs fused live ${activeData[0]} != ${fusedCount}`);
  }

  restoreLive(snap);
  tickBulletsBuffers(tickArgs(true, excludeSet, activeData, poolSize, live));
  assertApprox(checksumX(live), fusedSum, 1e-3, `${label} live-given checksum`);
  if (activeData[0] !== fusedCount) {
    throw new Error(`${label} live-given vs fused live ${activeData[0]} != ${fusedCount}`);
  }

  const fused = timeIt(
    `${label} fused (${liveCount}/${poolSize})`,
    (iters) => {
      for (let s = 0; s < iters; s++) {
        restoreLive(snap);
        tickBulletsBuffers(tickArgs(true, excludeSet, activeData, poolSize, null));
      }
    },
    { iterations: steps }
  );
  const twoPass = timeIt(
    `${label} two-pass (${liveCount}/${poolSize})`,
    (iters) => {
      for (let s = 0; s < iters; s++) {
        restoreLive(snap);
        twoPassTick(poolSize, scratch, tickArgs(true, excludeSet, activeData, poolSize, null));
      }
    },
    { iterations: steps }
  );
  const given = timeIt(
    `${label} live-given (${liveCount}/${poolSize})`,
    (iters) => {
      for (let s = 0; s < iters; s++) {
        restoreLive(snap);
        tickBulletsBuffers(tickArgs(true, excludeSet, activeData, poolSize, live));
      }
    },
    { iterations: steps }
  );
  return { fused, twoPass, given, liveCount, poolSize, occPct };
}

for (const poolSize of OCC_POOLS) {
  for (const occ of OCCUPANCY) {
    const row = runOccupancy(poolSize, occ, STEPS_OCC);
    const key = `occ${occ}_${poolSize}`;
    cases[`${key}Fused`] = row.fused;
    cases[`${key}TwoPass`] = row.twoPass;
    cases[`${key}Given`] = row.given;
    occupancyPairs[key] = {
      twoPassVsFused: opsDeltaPct(row.twoPass.opsPerSec, row.fused.opsPerSec),
      givenVsFused: opsDeltaPct(row.given.opsPerSec, row.fused.opsPerSec),
      liveCount: row.liveCount,
      poolSize,
      occPct: occ,
    };
    console.log(
      `occ ${occ}% ${row.liveCount}/${poolSize} fused→two-pass→given: ${Math.round(row.fused.opsPerSec)} → ${Math.round(row.twoPass.opsPerSec)} → ${Math.round(row.given.opsPerSec)} ops/s (${occupancyPairs[key].twoPassVsFused.toFixed(1)}% / ${occupancyPairs[key].givenVsFused.toFixed(1)}%)`
    );
  }
}

const twoPassSparseKeep = Object.entries(occupancyPairs).some(
  ([key, row]) => row.occPct <= 10 && row.twoPassVsFused != null && row.twoPassVsFused >= KEEP_OPS_PCT
);

for (const [key, result] of Object.entries(cases)) {
  caseSummary[key] = {
    ms: result.ms,
    opsPerSec: result.opsPerSec,
    iterations: result.iterations,
  };
}

if (OUTPUT) {
  writeReport(OUTPUT, {
    feature: 'bullets',
    layer: 'L1',
    seed: SEED,
    bulletCount: BULLET_COUNT,
    sparseLive: SPARSE_LIVE,
    sparsePoolBig: SPARSE_POOL_BIG,
    occupancy: OCCUPANCY,
    occupancyPairs,
    twoPassSparseKeep,
    entityCount: ENTITY_COUNT,
    cellSize: CELL_SIZE,
    compactPairs,
    compactKernelKeep,
    cases: caseSummary,
  });
}
