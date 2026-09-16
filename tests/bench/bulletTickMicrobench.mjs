// Microbenchmark + correctness for src/util/bulletTick.js (Node, no workers).
//
// One op = one tick of N live bullets (move + linecastDir).
// tickOpen: empty grid (hypot vs cached speed). tickCrowded: ~2000 colliders.
//
//   node tests/bench/bulletTickMicrobench.mjs
//   node tests/bench/bulletTickMicrobench.mjs --bullets 2048 --steps 800 --output tests/results/bullet-tick-micro.json

import { Ray } from '../../src/core/ray.js';
import { Grid } from '../../src/core/grid.js';
import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { tickBulletsBuffers } from '../../src/util/bulletTick.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const WORLD_W = 4000;
const WORLD_H = 3000;
const CELL_SIZE = Number(args['cell-size'] ?? 128);
const MAX_PER_CELL = 64;
const ENTITY_COUNT = Number(args.entities ?? 2000);
const BULLET_COUNT = Number(args.bullets ?? 2048);
const STEPS_OPEN = Number(args['steps-open'] ?? args.steps ?? 2000);
const STEPS_CROWDED = Number(args['steps-crowded'] ?? args.steps ?? 800);
const SEED = Number(args.seed ?? 0xc0ffee);
const MARGIN = 64;
const OUTPUT = args.output ? String(args.output) : null;
const BULLET_SPEED = 1500;

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

function setupBullets() {
  const sab = new SharedArrayBuffer(BulletComponent.getBufferSize(BULLET_COUNT));
  BulletComponent.initializeArrays(sab, BULLET_COUNT);
  BulletComponent.bulletCount = BULLET_COUNT;
}

function fillBullets(rng, originX, originY) {
  const active = BulletComponent.active;
  const x = BulletComponent.x;
  const y = BulletComponent.y;
  const prevX = BulletComponent.prevX;
  const prevY = BulletComponent.prevY;
  const vx = BulletComponent.vx;
  const vy = BulletComponent.vy;
  const speed = BulletComponent.speed;
  const rotC = BulletComponent.bulletRotC;
  const rotS = BulletComponent.bulletRotS;
  const damage = BulletComponent.damage;
  const ownerId = BulletComponent.ownerId;
  const shooter = BulletComponent.shooterEntityType;

  active.fill(0);
  for (let i = 0; i < BULLET_COUNT; i++) {
    const ang = rng() * Math.PI * 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    active[i] = 1;
    x[i] = originX;
    y[i] = originY;
    prevX[i] = originX;
    prevY[i] = originY;
    vx[i] = c * BULLET_SPEED;
    vy[i] = s * BULLET_SPEED;
    speed[i] = BULLET_SPEED;
    rotC[i] = c;
    rotS[i] = s;
    damage[i] = 1;
    ownerId[i] = 0;
    shooter[i] = 0;
  }
}

function snapshotLive() {
  return {
    active: BulletComponent.active.slice(),
    x: BulletComponent.x.slice(),
    y: BulletComponent.y.slice(),
    prevX: BulletComponent.prevX.slice(),
    prevY: BulletComponent.prevY.slice(),
  };
}

function restoreLive(snap) {
  BulletComponent.active.set(snap.active);
  BulletComponent.x.set(snap.x);
  BulletComponent.y.set(snap.y);
  BulletComponent.prevX.set(snap.prevX);
  BulletComponent.prevY.set(snap.prevY);
}

function tickArgs(useCached, excludeSet, activeData) {
  return {
    maxBullets: BULLET_COUNT,
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
    onDespawn: null,
  };
}

function assertApprox(actual, expected, eps, msg) {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

Ray._rayGenStamp = new Uint32Array(Math.max(ENTITY_COUNT, 1));

setupBullets();
const activeData = new Uint16Array(1 + BULLET_COUNT);
const excludeSet = new Set();
const rngOpen = mulberry32(SEED);

setupGrid(0, rngOpen);
fillBullets(rngOpen, WORLD_W * 0.5, WORLD_H * 0.5);

for (let i = 0; i < BULLET_COUNT; i++) {
  assertApprox(BulletComponent.speed[i], BULLET_SPEED, 1e-3, `speed[${i}]`);
  const n = BulletComponent.bulletRotC[i] ** 2 + BulletComponent.bulletRotS[i] ** 2;
  assertApprox(n, 1, 1e-4, `rot unit[${i}]`);
}

const x0 = BulletComponent.x[0];
const y0 = BulletComponent.y[0];
const vx0 = BulletComponent.vx[0];
const vy0 = BulletComponent.vy[0];
tickBulletsBuffers(tickArgs(true, excludeSet, activeData));
assertApprox(BulletComponent.x[0], x0 + vx0 / 60, 1e-3, 'open step x');
assertApprox(BulletComponent.y[0], y0 + vy0 / 60, 1e-3, 'open step y');
if (activeData[0] !== BULLET_COUNT) {
  throw new Error(`open field lost bullets: ${activeData[0]}`);
}

fillBullets(mulberry32(SEED), WORLD_W * 0.5, WORLD_H * 0.5);
const openSnap = snapshotLive();
const cases = {};

cases.tickOpenHypot = timeIt(
  `tickOpen hypot (${BULLET_COUNT} bullets, empty grid)`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(openSnap);
      tickBulletsBuffers(tickArgs(false, excludeSet, activeData));
    }
  },
  { iterations: STEPS_OPEN }
);

cases.tickOpen = timeIt(
  `tickOpen cached speed (${BULLET_COUNT} bullets, empty grid)`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(openSnap);
      tickBulletsBuffers(tickArgs(true, excludeSet, activeData));
    }
  },
  { iterations: STEPS_OPEN }
);

const rngCrowd = mulberry32(SEED ^ 1);
setupGrid(ENTITY_COUNT, rngCrowd);
fillBullets(rngCrowd, MARGIN + 40, WORLD_H * 0.5);
const crowdSnap = snapshotLive();

cases.tickCrowdedHypot = timeIt(
  `tickCrowded hypot (${BULLET_COUNT} bullets, ${ENTITY_COUNT} colliders)`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(crowdSnap);
      tickBulletsBuffers(tickArgs(false, excludeSet, activeData));
    }
  },
  { iterations: STEPS_CROWDED }
);

cases.tickCrowded = timeIt(
  `tickCrowded cached speed (${BULLET_COUNT} bullets, ${ENTITY_COUNT} colliders)`,
  (iters) => {
    for (let s = 0; s < iters; s++) {
      restoreLive(crowdSnap);
      tickBulletsBuffers(tickArgs(true, excludeSet, activeData));
    }
  },
  { iterations: STEPS_CROWDED }
);

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

if (OUTPUT) {
  writeReport(OUTPUT, {
    feature: 'bullets',
    layer: 'L1',
    seed: SEED,
    bulletCount: BULLET_COUNT,
    entityCount: ENTITY_COUNT,
    cellSize: CELL_SIZE,
    cases: caseSummary,
  });
}
