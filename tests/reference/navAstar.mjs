/**
 * The A* search in JavaScript: navAstar.js (src/core) as it ran from N-137 until navFlowfield.wasm's astar_path
 * (E-207) became the only search, with the scratch it searched in. Kept as the parity reference the kernel is tested
 * against (navAstarWasm.test.js, astarKernel.mjs); the engine does not use it.
 *
 * The A* search behind NavGrid paths (the particle worker's computePath): 8 directions, costs 10 and 14, the octile
 * heuristic, on the walkability grid. The flowfield searches in navFlowfield.wasm.
 *
 * N-137: the open set is a binary heap with a position per cell, so a cell whose cost falls while it waits moves up
 * in the heap (decrease-key). It used to lower the cost in place, the heap's order broke, and a path could be longer
 * than the shortest.
 */
export const NAV_DX = Object.freeze([0, 1, 1, 1, 0, -1, -1, -1]);
export const NAV_DY = Object.freeze([-1, -1, 0, 1, 1, 1, 0, -1]);
export const NAV_COST = Object.freeze([10, 14, 10, 14, 10, 14, 10, 14]);

/** Reusable buffers for the A* search. */
export class NavScratch {
  constructor(totalCells, maxPathLength, gridWidth, gridHeight) {
    this.stamp = new Uint32Array(totalCells);
    this.currentStamp = 0;

    // The flowfield's distance cap, which navFlowfield.wasm takes (bindNavFlowfield).
    this.maxDistance = Math.min(65535, (gridWidth + gridHeight) * 14);

    this.heapCell = new Uint32Array(totalCells);
    /** Where a cell sits in heapCell while it is in the open set. */
    this.heapPos = new Uint32Array(totalCells);
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
    this.heapSize = 0;
  }

  isVisited(cell) {
    return this.stamp[cell] === this.currentStamp;
  }

  markVisited(cell) {
    this.stamp[cell] = this.currentStamp;
  }
}

/** Move the entry at i up while its f is below its parent's. */
function siftUp(s, i) {
  const heap = s.heapCell;
  const pos = s.heapPos;
  const f = s.heapFCost;
  const cell = heap[i];
  const key = f[cell];
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const up = heap[parent];
    if (key >= f[up]) break;
    heap[i] = up;
    pos[up] = i;
    i = parent;
  }
  heap[i] = cell;
  pos[cell] = i;
}

function heapPush(s, cell) {
  const i = s.heapSize++;
  s.heapCell[i] = cell;
  s.heapPos[cell] = i;
  siftUp(s, i);
}

function heapPop(s) {
  const heap = s.heapCell;
  const pos = s.heapPos;
  const f = s.heapFCost;
  const result = heap[0];
  const size = --s.heapSize;
  if (size > 0) {
    const cell = heap[size];
    const key = f[cell];
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= size) break;
      const right = left + 1;
      let child = left;
      if (right < size && f[heap[right]] < f[heap[left]]) child = right;
      if (f[heap[child]] >= key) break;
      heap[i] = heap[child];
      pos[heap[i]] = i;
      i = child;
    }
    heap[i] = cell;
    pos[cell] = i;
  }
  return result;
}

function octile(cell, gridWidth, targetX, targetY) {
  const cx = cell % gridWidth;
  const cy = (cell / gridWidth) | 0;
  const dx = cx > targetX ? cx - targetX : targetX - cx;
  const dy = cy > targetY ? cy - targetY : targetY - cy;
  return dx > dy ? 10 * dx + 4 * dy : 10 * dy + 4 * dx;
}

/**
 * A path from fromCell to toCell into scratch.pathResult, origin first, at most its length (a longer path keeps
 * its last cells). Returns the number of cells written, 0 when toCell cannot be reached.
 */
export function searchAstar(scratch, walkability, gridWidth, gridHeight, fromCell, toCell) {
  const s = scratch;
  s.reset();
  s.inOpenSet.fill(0);
  const targetX = toCell % gridWidth;
  const targetY = (toCell / gridWidth) | 0;
  const g = s.heapGCost;
  const f = s.heapFCost;
  const cameFrom = s.cameFrom;
  const inOpen = s.inOpenSet;

  g[fromCell] = 0;
  f[fromCell] = octile(fromCell, gridWidth, targetX, targetY);
  cameFrom[fromCell] = fromCell;
  heapPush(s, fromCell);
  inOpen[fromCell] = 1;

  let found = false;
  while (s.heapSize > 0) {
    const current = heapPop(s);
    inOpen[current] = 0;
    if (current === toCell) {
      found = true;
      break;
    }
    if (s.isVisited(current)) continue;
    s.markVisited(current);

    const currentG = g[current];
    const currentX = current % gridWidth;
    const currentY = (current / gridWidth) | 0;
    for (let dir = 0; dir < 8; dir++) {
      const nx = currentX + NAV_DX[dir];
      const ny = currentY + NAV_DY[dir];
      if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridHeight) continue;
      const neighbor = ny * gridWidth + nx;
      if (walkability[neighbor] === 0) continue;
      if (s.isVisited(neighbor)) continue;
      const tentativeG = currentG + NAV_COST[dir];
      if (inOpen[neighbor] === 0) {
        cameFrom[neighbor] = current;
        g[neighbor] = tentativeG;
        f[neighbor] = tentativeG + octile(neighbor, gridWidth, targetX, targetY);
        heapPush(s, neighbor);
        inOpen[neighbor] = 1;
      } else if (tentativeG < g[neighbor]) {
        // A shorter way to a cell already waiting: its f falls, so it moves up.
        cameFrom[neighbor] = current;
        f[neighbor] -= g[neighbor] - tentativeG;
        g[neighbor] = tentativeG;
        siftUp(s, s.heapPos[neighbor]);
      }
    }
  }

  let pathLength = 0;
  if (found) {
    const out = s.pathResult;
    let current = toCell;
    while (current !== fromCell && pathLength < out.length) {
      out[pathLength++] = current;
      current = cameFrom[current];
    }
    // Only append the origin when there is room: a write past the end is a silent no-op, and the length would read
    // one cell beyond the array (B-07).
    if (pathLength < out.length) out[pathLength++] = fromCell;
    for (let i = 0; i < pathLength >> 1; i++) {
      const tmp = out[i];
      out[i] = out[pathLength - 1 - i];
      out[pathLength - 1 - i] = tmp;
    }
  }
  return pathLength;
}
