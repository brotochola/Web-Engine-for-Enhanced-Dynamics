// Microbenchmark + correctness check for Ray.js (cast / linecast).
//
// Sets up Grid/Transform/Collider statics in-process (no workers), populates
// the spatial grid exactly like spatial_worker does (entity inserted into every
// cell its AABB overlaps), then:
//   1. Verifies Ray.cast/linecast against a brute-force all-entities reference.
//   2. Times cast() and linecast() over seeded-random rays.
//
// Usage: node tests/bench/ray-microbench.mjs

import { Ray } from '../../src/core/Ray.js';
import { Grid } from '../../src/core/Grid.js';
import { Transform } from '../../src/components/Transform.js';
import { Collider } from '../../src/components/Collider.js';
import { rayCircleIntersect, rayBoxIntersect } from '../../src/core/utils.js';

// ---------------------------------------------------------------------------
// Deterministic RNG so before/after runs see identical scenarios
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// World + grid setup
// ---------------------------------------------------------------------------
const WORLD_W = 4000;
const WORLD_H = 3000;
const CELL_SIZE = 128;
const MAX_PER_CELL = 64;
const ENTITY_COUNT = 2000;
const MARGIN = 64; // keep colliders fully inside the grid

const gridCols = Math.ceil(WORLD_W / CELL_SIZE);
const gridRows = Math.ceil(WORLD_H / CELL_SIZE);
const totalCells = gridCols * gridRows;
const cellByteSize = 4 + MAX_PER_CELL * 4;

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
Grid._gridEntities = new Uint32Array(gridBuffer);

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

const rng = mulberry32(0xC0FFEE);

for (let i = 0; i < ENTITY_COUNT; i++) {
  Transform.x[i] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
  Transform.y[i] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
  Collider.shapeType[i] = rng() < 0.7 ? 0 : 1; // 70% circles, 30% boxes
  Collider.radius[i] = 4 + rng() * 16;
  Collider.width[i] = 8 + rng() * 32;
  Collider.height[i] = 8 + rng() * 32;
  Collider.collisionLayer[i] = (rng() * 8) | 0;
}

// Insert entities into ALL cells their AABB overlaps (mirrors spatial_worker)
for (let i = 0; i < ENTITY_COUNT; i++) {
  const px = Transform.x[i];
  const py = Transform.y[i];
  let halfW, halfH;
  if (Collider.shapeType[i] === 0) {
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

// ---------------------------------------------------------------------------
// Brute-force reference (checks every entity, no grid)
// ---------------------------------------------------------------------------
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
    if (Collider.shapeType[i] === 0) {
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

// ---------------------------------------------------------------------------
// Correctness: grid-based linecast must match brute force
// ---------------------------------------------------------------------------
const CHECKS = 20000;
const checkRng = mulberry32(0xBEEF);
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

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------
function bench(label, fn, iterations, reps = 5) {
  // Warmup
  fn(2000);
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    fn(iterations);
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  const median = times[(times.length / 2) | 0];
  const opsPerSec = (iterations / median) * 1000;
  console.log(
    `${label}: median ${median.toFixed(1)} ms for ${iterations} ops -> ${Math.round(opsPerSec).toLocaleString()} ops/s`
  );
  return opsPerSec;
}

let sink = 0; // prevent dead-code elimination

// Workload 1: entity-to-entity LOS (typical AI usage, mostly short rays)
const losRng = mulberry32(0x1234);
const losPairs = new Uint32Array(8192 * 2);
for (let i = 0; i < losPairs.length; i++) losPairs[i] = (losRng() * ENTITY_COUNT) | 0;
bench('linecastBetweenEntities (LOS pairs)', (iters) => {
  for (let i = 0; i < iters; i++) {
    const k = (i % 8192) * 2;
    const r = Ray.linecastBetweenEntities(losPairs[k], losPairs[k + 1]);
    if (r.blocked) sink++;
  }
}, 200000);

// Workload 2: long random rays across the world (worst case for no-early-out)
const longRng = mulberry32(0x5678);
const longRays = new Float32Array(4096 * 4);
for (let i = 0; i < longRays.length; i += 4) {
  longRays[i] = MARGIN + longRng() * (WORLD_W - 2 * MARGIN);
  longRays[i + 1] = MARGIN + longRng() * (WORLD_H - 2 * MARGIN);
  longRays[i + 2] = MARGIN + longRng() * (WORLD_W - 2 * MARGIN);
  longRays[i + 3] = MARGIN + longRng() * (WORLD_H - 2 * MARGIN);
}
bench('cast (long random rays)', (iters) => {
  for (let i = 0; i < iters; i++) {
    const k = (i % 4096) * 4;
    sink += Ray.cast(longRays[k], longRays[k + 1], longRays[k + 2], longRays[k + 3]);
  }
}, 200000);

// Workload 3: linecast with finite maxDist behavior via short rays
bench('castWithInfo (short rays, 300u)', (iters) => {
  for (let i = 0; i < iters; i++) {
    const k = (i % 4096) * 4;
    const x = longRays[k];
    const y = longRays[k + 1];
    const r = Ray.castWithInfo(x, y, x + 250, y + 120, 300);
    if (r.hit) sink++;
  }
}, 200000);

console.log(`(sink=${sink})`);
