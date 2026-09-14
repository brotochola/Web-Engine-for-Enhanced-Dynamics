// Microbenchmark + correctness check for Ray.js (L1 isolated).
//
// Sets up Grid/Transform/Collider statics in-process (no workers), populates
// the spatial grid exactly like spatial_worker does (entity inserted into every
// cell its AABB overlaps), then:
//   1. Verifies Ray.linecastBetweenEntities against a brute-force reference.
//   2. Times cast / linecast / castAll / hasLineOfSight / mask variants.
//
// Usage:
//   node tests/bench/ray-microbench.mjs
//   node tests/bench/ray-microbench.mjs --entities 2000 --rays 200000 --cell-size 128 --seed 12648430 --output tests/results/ray-micro.json

import { Ray } from '../../src/core/Ray.js';
import { Grid } from '../../src/core/Grid.js';
import { Transform } from '../../src/components/Transform.js';
import { Collider } from '../../src/components/Collider.js';
import { rayCircleIntersect, rayBoxIntersect } from '../../src/core/utils.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

const args = parseArgs();
const WORLD_W = 4000;
const WORLD_H = 3000;
const CELL_SIZE = Number(args['cell-size'] ?? 128);
const MAX_PER_CELL = 64;
const ENTITY_COUNT = Number(args.entities ?? 2000);
const RAY_ITERS = Number(args.rays ?? 200000);
const SEED = Number(args.seed ?? 0xc0ffee);
const MARGIN = 64;
const CHECKS = 20000;
const OUTPUT = args.output ? String(args.output) : null;

const gridCols = Math.ceil(WORLD_W / CELL_SIZE);
const gridRows = Math.ceil(WORLD_H / CELL_SIZE);
const totalCells = gridCols * gridRows;
const cellByteSize = 4 + MAX_PER_CELL * 2;

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

Transform.active = new Uint8Array(ENTITY_COUNT).fill(1);
Transform.x = new Float32Array(ENTITY_COUNT);
Transform.y = new Float32Array(ENTITY_COUNT);

Collider.active = new Uint8Array(ENTITY_COUNT).fill(1);
Collider.shapeType = new Uint8Array(ENTITY_COUNT);
Collider.offsetX = new Float32Array(ENTITY_COUNT);
Collider.offsetY = new Float32Array(ENTITY_COUNT);
Collider.radius = new Float32Array(ENTITY_COUNT);
Collider.width = new Float32Array(ENTITY_COUNT);
Collider.height = new Float32Array(ENTITY_COUNT);
Collider.collisionLayer = new Uint8Array(ENTITY_COUNT);

const rng = mulberry32(SEED);

for (let i = 0; i < ENTITY_COUNT; i++) {
  Transform.x[i] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
  Transform.y[i] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
  Collider.shapeType[i] = rng() < 0.7 ? 1 : 0;
  Collider.radius[i] = 4 + rng() * 16;
  Collider.width[i] = 8 + rng() * 32;
  Collider.height[i] = 8 + rng() * 32;
  Collider.collisionLayer[i] = (rng() * 8) | 0;
}

for (let i = 0; i < ENTITY_COUNT; i++) {
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

function bruteForceClosest(x1, y1, x2, y2, maxDist, mask, excludeA = -1, excludeB = -1) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { entityIndex: -1, distance: maxDist };
  const dirX = dx / len;
  const dirY = dy / len;

  let closestIndex = -1;
  let closestDist = maxDist;
  for (let i = 0; i < ENTITY_COUNT; i++) {
    if (i === excludeA || i === excludeB) continue;
    if (!((1 << (Collider.collisionLayer[i] & 31)) & mask)) continue;
    const ex = Transform.x[i] + Collider.offsetX[i];
    const ey = Transform.y[i] + Collider.offsetY[i];
    let d = -1;
    if (Collider.shapeType[i] === 1) {
      d = rayCircleIntersect(x1, y1, dirX, dirY, ex, ey, Collider.radius[i], len);
    } else {
      d = rayBoxIntersect(x1, y1, dirX, dirY, ex, ey, Collider.width[i], Collider.height[i], len);
    }
    if (d >= 0 && d < closestDist) {
      closestDist = d;
      closestIndex = i;
    }
  }
  return { entityIndex: closestIndex, distance: closestDist };
}

const checkRng = mulberry32((SEED ^ 0xbeef) >>> 0);
let mismatches = 0;

for (let n = 0; n < CHECKS; n++) {
  const a = (checkRng() * ENTITY_COUNT) | 0;
  const b = (checkRng() * ENTITY_COUNT) | 0;
  if (a === b) continue;
  const mask = n % 3 === 0 ? 0xff : 0xffffffff;

  const got = Ray.linecastBetweenEntities(a, b, mask);
  const x1 = Transform.x[a];
  const y1 = Transform.y[a];
  const x2 = Transform.x[b];
  const y2 = Transform.y[b];
  const want = bruteForceClosest(x1, y1, x2, y2, Math.hypot(x2 - x1, y2 - y1), mask, a, b);

  const wantBlocked = want.entityIndex !== -1;
  const distMatches = !wantBlocked || Math.abs(got.distance - want.distance) < 1e-3;
  if (got.blocked !== wantBlocked || !distMatches) {
    mismatches++;
    if (mismatches <= 5) {
      console.error(
        `MISMATCH ray ${a}->${b} mask=${mask.toString(16)}: ` +
          `got blocked=${got.blocked} e=${got.entityIndex} d=${got.distance.toFixed(3)} | ` +
          `want e=${want.entityIndex} d=${want.distance.toFixed(3)}`
      );
    }
  }
}

if (mismatches > 0) {
  console.error(`CORRECTNESS: FAILED (${mismatches}/${CHECKS} mismatches)`);
  process.exit(1);
}
console.log(`CORRECTNESS: OK (${CHECKS} linecasts match brute force)`);
console.log(`config: entities=${ENTITY_COUNT} cellSize=${CELL_SIZE} rays=${RAY_ITERS} seed=${SEED}`);

let sink = 0;

const losRng = mulberry32((SEED ^ 0x1234) >>> 0);
const losPairs = new Uint32Array(8192 * 2);
for (let i = 0; i < losPairs.length; i++) losPairs[i] = (losRng() * ENTITY_COUNT) | 0;

const longRng = mulberry32((SEED ^ 0x5678) >>> 0);
const longRays = new Float32Array(4096 * 4);
for (let i = 0; i < longRays.length; i += 4) {
  longRays[i] = MARGIN + longRng() * (WORLD_W - 2 * MARGIN);
  longRays[i + 1] = MARGIN + longRng() * (WORLD_H - 2 * MARGIN);
  longRays[i + 2] = MARGIN + longRng() * (WORLD_W - 2 * MARGIN);
  longRays[i + 3] = MARGIN + longRng() * (WORLD_H - 2 * MARGIN);
}

const cases = {};

cases.linecastBetweenEntities = timeIt(
  'linecastBetweenEntities (LOS pairs)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 8192) * 2;
      const r = Ray.linecastBetweenEntities(losPairs[k], losPairs[k + 1]);
      if (r.blocked) sink++;
    }
  },
  { iterations: RAY_ITERS }
);

cases.cast = timeIt(
  'cast (long random rays)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 4096) * 4;
      sink += Ray.cast(longRays[k], longRays[k + 1], longRays[k + 2], longRays[k + 3]);
    }
  },
  { iterations: RAY_ITERS }
);

cases.castWithInfo = timeIt(
  'castWithInfo (short rays, 300u)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 4096) * 4;
      const x = longRays[k];
      const y = longRays[k + 1];
      const r = Ray.castWithInfo(x, y, x + 250, y + 120, 300);
      if (r.hit) sink++;
    }
  },
  { iterations: RAY_ITERS }
);

cases.castAll = timeIt(
  'castAll (maxHits=5)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 4096) * 4;
      const hits = Ray.castAll(longRays[k], longRays[k + 1], longRays[k + 2], longRays[k + 3], Infinity, 5);
      sink += hits.length;
    }
  },
  { iterations: Math.max(1000, (RAY_ITERS / 4) | 0) }
);

cases.hasLineOfSight = timeIt(
  'hasLineOfSight (LOS pairs)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 8192) * 2;
      if (Ray.hasLineOfSight(losPairs[k], losPairs[k + 1])) sink++;
    }
  },
  { iterations: RAY_ITERS }
);

const narrowMask = 0x03; // layers 0+1 only
cases.castMasked = timeIt(
  'cast (mask=0x03, sparse layers)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 4096) * 4;
      sink += Ray.cast(longRays[k], longRays[k + 1], longRays[k + 2], longRays[k + 3], Infinity, narrowMask);
    }
  },
  { iterations: RAY_ITERS }
);

console.log(`(sink=${sink})`);

if (OUTPUT) {
  const caseSummary = {};
  for (const [key, result] of Object.entries(cases)) {
    caseSummary[key] = {
      ms: result.ms,
      opsPerSec: result.opsPerSec,
      iterations: result.iterations,
    };
  }
  writeReport(OUTPUT, {
    feature: 'ray',
    layer: 'L1',
    seed: SEED,
    entityCount: ENTITY_COUNT,
    cellSize: CELL_SIZE,
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    correctnessChecks: CHECKS,
    cases: caseSummary,
  });
}
