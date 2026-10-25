// The flowfield search in JavaScript: ParticleWorker.computeFlowfield as it ran until navFlowfield.wasm (E-76 W14)
// became the only search, with its bucket queue and the scratch it searched in (NavScratch's flowfield arrays).
// Kept as the parity reference the kernel is tested against (WASM_HYPOTHESES L12); the engine does not use it.

import { NavGrid, DIRECTION, DIR_TO_VEC } from '../../src/core/navGrid.js';

const NAV_DX = Object.freeze([0, 1, 1, 1, 0, -1, -1, -1]);
const NAV_DY = Object.freeze([-1, -1, 0, 1, 1, 1, 0, -1]);
const NAV_COST = Object.freeze([10, 14, 10, 14, 10, 14, 10, 14]);
const NAV_OPPOSITE_DIR = Object.freeze([
  DIRECTION.S, DIRECTION.SW, DIRECTION.W, DIRECTION.NW,
  DIRECTION.N, DIRECTION.NE, DIRECTION.E, DIRECTION.SE,
]);
const NAV_DIR_MAP = Object.freeze([
  DIRECTION.N, DIRECTION.NE, DIRECTION.E, DIRECTION.SE,
  DIRECTION.S, DIRECTION.SW, DIRECTION.W, DIRECTION.NW,
]);

/** The scratch the JS search used: NavScratch as it was, flowfield arrays and all. */
export class FlowScratch {
  constructor(totalCells, maxPathLength, gridWidth, gridHeight) {
    this.visited = new Uint8Array(totalCells);
    this.stamp = new Uint32Array(totalCells);
    this.currentStamp = 0;

    this.distance = new Uint16Array(totalCells);
    this.direction = new Uint8Array(totalCells);
    this.smoothedVectors = new Int8Array(totalCells * 2);

    this.maxDistance = Math.min(65535, (gridWidth + gridHeight) * 14);
    this.bucketHead = new Int32Array(this.maxDistance + 1);
    this.bucketTail = new Int32Array(this.maxDistance + 1);
    this.bucketNodeNext = new Int32Array(totalCells);
    this.bucketNodePrev = new Int32Array(totalCells);
    this.bucketNodeDist = new Int32Array(totalCells);
    this.bucketNodeCell = new Uint32Array(totalCells);
    for (let i = 0; i <= this.maxDistance; i++) {
      this.bucketHead[i] = -1;
      this.bucketTail[i] = -1;
    }
    for (let i = 0; i < totalCells; i++) {
      this.bucketNodeNext[i] = -1;
      this.bucketNodePrev[i] = -1;
      this.bucketNodeDist[i] = -1;
      this.bucketNodeCell[i] = i;
    }
    this.bucketHeadDistance = 0;
    this.bucketCount = 0;

    this.heapCell = new Uint32Array(totalCells);
    this.heapFCost = new Uint32Array(totalCells);
    this.heapGCost = new Uint32Array(totalCells);
    this.heapSize = 0;
    this.cameFrom = new Uint32Array(totalCells);
    this.inOpenSet = new Uint8Array(totalCells);
    this.pathResult = new Uint32Array(maxPathLength);
  }

  reset() {
    this.currentStamp++;
    if (this.currentStamp === 0) {
      this.stamp.fill(0);
      this.currentStamp = 1;
    }

    this.bucketHeadDistance = 0;
    this.bucketCount = 0;
    this.bucketHead.fill(-1);
    this.bucketTail.fill(-1);
    this.bucketNodeNext.fill(-1);
    this.bucketNodePrev.fill(-1);
    this.bucketNodeDist.fill(-1);

    this.heapSize = 0;
  }

  isVisited(cell) {
    return this.stamp[cell] === this.currentStamp;
  }

  markVisited(cell) {
    this.stamp[cell] = this.currentStamp;
  }
}

function bucketInsertCell(scratch, cell, bucket) {
  const clampedBucket = bucket > scratch.maxDistance ? scratch.maxDistance : bucket;
  const oldBucket = scratch.bucketNodeDist[cell];
  if (oldBucket >= 0) {
    if (oldBucket === clampedBucket) return;
    buckets.unlink(scratch, cell, oldBucket);
  }

  const head = scratch.bucketHead[clampedBucket];
  scratch.bucketNodePrev[cell] = -1;
  scratch.bucketNodeNext[cell] = head;
  if (head >= 0) {
    scratch.bucketNodePrev[head] = cell;
  } else {
    scratch.bucketTail[clampedBucket] = cell;
  }
  scratch.bucketHead[clampedBucket] = cell;
  scratch.bucketNodeDist[cell] = clampedBucket;
  scratch.bucketCount++;
}

function bucketUnlinkCell(scratch, cell, bucket) {
  const prev = scratch.bucketNodePrev[cell];
  const next = scratch.bucketNodeNext[cell];
  if (prev >= 0) {
    scratch.bucketNodeNext[prev] = next;
  } else {
    scratch.bucketHead[bucket] = next;
  }
  if (next >= 0) {
    scratch.bucketNodePrev[next] = prev;
  } else {
    scratch.bucketTail[bucket] = prev;
  }
  scratch.bucketNodePrev[cell] = -1;
  scratch.bucketNodeNext[cell] = -1;
  scratch.bucketNodeDist[cell] = -1;
  scratch.bucketCount--;
}

function bucketPopCell(scratch, bucket) {
  const cell = scratch.bucketHead[bucket];
  if (cell < 0) return -1;
  buckets.unlink(scratch, cell, bucket);
  return scratch.bucketNodeCell[cell];
}

/** The bucket queue, through an object so a test can wrap a step (the reach test counts insert's two paths). */
export const buckets = { insert: bucketInsertCell, unlink: bucketUnlinkCell, pop: bucketPopCell };

/** One flowfield for `targetCell` into its slot, on `worker`'s nav grid, searching in `scratch` (a FlowScratch). */
export function computeFlowfieldReference(worker, targetCell, scratch) {
  const willUseEmptySlot = worker._hasEmptyFlowfieldSlot();

  scratch.reset();

  const walkability = NavGrid.getWalkabilityArray();
  const gridWidth = worker.gridWidth;
  const gridHeight = worker.gridHeight;
  const totalCells = worker.totalCells;

  scratch.distance.fill(65535);
  scratch.direction.fill(DIRECTION.NONE);

  scratch.distance[targetCell] = 0;
  buckets.insert(scratch, targetCell, 0);

  while (scratch.bucketCount > 0) {
    while (scratch.bucketHeadDistance <= scratch.maxDistance && scratch.bucketHead[scratch.bucketHeadDistance] < 0) {
      scratch.bucketHeadDistance++;
    }
    if (scratch.bucketHeadDistance > scratch.maxDistance) break;

    const cell = buckets.pop(scratch, scratch.bucketHeadDistance);
    if (cell < 0) continue;

    if (scratch.isVisited(cell)) continue;
    scratch.markVisited(cell);

    const cellDist = scratch.distance[cell];
    const cellX = cell % gridWidth;
    const cellY = Math.floor(cell / gridWidth);

    for (let dir = 0; dir < 8; dir++) {
      const nx = cellX + NAV_DX[dir];
      const ny = cellY + NAV_DY[dir];

      if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridHeight) continue;

      const neighbor = ny * gridWidth + nx;

      if (walkability[neighbor] === 0) continue;
      if (scratch.isVisited(neighbor)) continue;

      const newDist = cellDist + NAV_COST[dir];
      if (newDist < scratch.distance[neighbor]) {
        scratch.distance[neighbor] = newDist;
        scratch.direction[neighbor] = NAV_OPPOSITE_DIR[dir];

        const bucket = Math.min(newDist, scratch.maxDistance);
        buckets.insert(scratch, neighbor, bucket);
      }
    }
  }

  for (let cell = 0; cell < totalCells; cell++) {
    if (walkability[cell] !== 0) continue;

    const cellX = cell % gridWidth;
    const cellY = Math.floor(cell / gridWidth);

    let bestDir = DIRECTION.NONE;
    let bestDist = 65535;

    for (let dir = 0; dir < 8; dir++) {
      const nx = cellX + NAV_DX[dir];
      const ny = cellY + NAV_DY[dir];

      if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridHeight) continue;

      const neighbor = ny * gridWidth + nx;

      if (walkability[neighbor] === 0) continue;

      if (scratch.distance[neighbor] < bestDist) {
        bestDist = scratch.distance[neighbor];
        bestDir = NAV_DIR_MAP[dir];
      }
    }

    scratch.direction[cell] = bestDir;
  }

  // Third pass: Smoothing
  if (!scratch.smoothedVectors) {
    scratch.smoothedVectors = new Int8Array(worker.totalCells * 2);
  }

  const smoothed = scratch.smoothedVectors;

  for (let y = 0; y < worker.gridHeight; y++) {
    for (let x = 0; x < gridWidth; x++) {
      const cell = y * gridWidth + x;
      const outIdx = cell * 2;
      const dir = scratch.direction[cell];

      if (dir === DIRECTION.NONE) {
        smoothed[outIdx] = 0;
        smoothed[outIdx + 1] = 0;
        continue;
      }

      if (walkability[cell] === 0) {
        const vec = DIR_TO_VEC[dir];
        smoothed[outIdx] = Math.round(vec[0] * 127);
        smoothed[outIdx + 1] = Math.round(vec[1] * 127);
        continue;
      }

      let sumX = 0;
      let sumY = 0;
      let count = 0;

      for (let ny = y - 1; ny <= y + 1; ny++) {
        for (let nx = x - 1; nx <= x + 1; nx++) {
          if (nx >= 0 && nx < gridWidth && ny >= 0 && ny < worker.gridHeight) {
            const neighbor = ny * gridWidth + nx;
            const neighborDir = scratch.direction[neighbor];
            if (neighborDir !== DIRECTION.NONE) {
              const vec = DIR_TO_VEC[neighborDir];
              sumX += vec[0];
              sumY += vec[1];
              count++;
            }
          }
        }
      }

      if (count > 0) {
        const avgX = sumX / count;
        const avgY = sumY / count;
        smoothed[outIdx] = Math.round(avgX * 127);
        smoothed[outIdx + 1] = Math.round(avgY * 127);
      } else {
        smoothed[outIdx] = 0;
        smoothed[outIdx + 1] = 0;
      }
    }
  }

  const slot = NavGrid.allocateFlowfieldSlot(targetCell);
  NavGrid.writeFlowfieldData(slot, smoothed);

  if (willUseEmptySlot) {
    worker.cachedFlowfieldsCount++;
  }
}
