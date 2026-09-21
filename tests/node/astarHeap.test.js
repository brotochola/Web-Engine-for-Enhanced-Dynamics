import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Same open-set rule as particleWorker.computePath:
 * a better g updates the cost in place and does not push again.
 * Octile heuristic, 8-neighborhood, costs 10 and 14.
 */
function search(gridW, gridH, blocked, fromCell, toCell, repush) {
  const n = gridW * gridH;
  const gCost = new Uint32Array(n);
  const fCost = new Uint32Array(n);
  const came = new Int32Array(n);
  const inOpen = new Uint8Array(n);
  const closed = new Uint8Array(n);
  const heap = new Int32Array(n);
  gCost.fill(0xffffffff);
  came.fill(-1);
  let heapSize = 0;
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];
  const cost = [10, 14, 10, 14, 10, 14, 10, 14];
  const tx = toCell % gridW;
  const ty = (toCell / gridW) | 0;
  const heuristic = (cell) => {
    const cx = cell % gridW;
    const cy = (cell / gridW) | 0;
    const adx = Math.abs(cx - tx);
    const ady = Math.abs(cy - ty);
    return 10 * Math.max(adx, ady) + 4 * Math.min(adx, ady);
  };
  const push = (cell) => {
    let i = heapSize++;
    heap[i] = cell;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fCost[heap[i]] < fCost[heap[parent]]) {
        const tmp = heap[i];
        heap[i] = heap[parent];
        heap[parent] = tmp;
        i = parent;
      } else break;
    }
  };
  const pop = () => {
    const result = heap[0];
    heapSize--;
    if (heapSize > 0) {
      heap[0] = heap[heapSize];
      let i = 0;
      while (true) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < heapSize && fCost[heap[left]] < fCost[heap[smallest]]) smallest = left;
        if (right < heapSize && fCost[heap[right]] < fCost[heap[smallest]]) smallest = right;
        if (smallest !== i) {
          const tmp = heap[i];
          heap[i] = heap[smallest];
          heap[smallest] = tmp;
          i = smallest;
        } else break;
      }
    }
    return result;
  };
  gCost[fromCell] = 0;
  fCost[fromCell] = heuristic(fromCell);
  came[fromCell] = fromCell;
  push(fromCell);
  inOpen[fromCell] = 1;
  let found = false;
  while (heapSize > 0) {
    const current = pop();
    inOpen[current] = 0;
    if (current === toCell) {
      found = true;
      break;
    }
    if (closed[current]) continue;
    closed[current] = 1;
    const cx = current % gridW;
    const cy = (current / gridW) | 0;
    for (let dir = 0; dir < 8; dir++) {
      const nx = cx + dx[dir];
      const ny = cy + dy[dir];
      if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
      const neighbor = ny * gridW + nx;
      if (blocked[neighbor] || closed[neighbor]) continue;
      const tentative = gCost[current] + cost[dir];
      if (!inOpen[neighbor] || tentative < gCost[neighbor]) {
        came[neighbor] = current;
        gCost[neighbor] = tentative;
        fCost[neighbor] = tentative + heuristic(neighbor);
        if (!inOpen[neighbor]) {
          push(neighbor);
          inOpen[neighbor] = 1;
        } else if (repush) {
          push(neighbor);
        }
      }
    }
  }
  if (!found) return null;
  const path = [];
  let cur = toCell;
  while (cur !== fromCell) {
    path.push(cur);
    cur = came[cur];
  }
  path.push(fromCell);
  path.reverse();
  return { g: gCost[toCell], path };
}

test('stale A* heap can close a worse path on a wall gap', () => {
  // 5x3. Wall on the middle row except a gap on the right.
  // Optimal hugs the gap. A heap that does not repush may take the long way.
  const w = 5;
  const h = 3;
  const blocked = new Uint8Array(w * h);
  blocked[1 * w + 0] = 1;
  blocked[1 * w + 1] = 1;
  blocked[1 * w + 2] = 1;
  const from = 0;
  const to = 2 * w + 4;
  const stale = search(w, h, blocked, from, to, false);
  const fresh = search(w, h, blocked, from, to, true);
  assert.ok(fresh);
  assert.ok(stale);
  assert.ok(fresh.g <= stale.g);
});

test('production open-set rule matches the optimal g on this wall gap', () => {
  const w = 5;
  const h = 3;
  const blocked = new Uint8Array(w * h);
  blocked[1 * w + 0] = 1;
  blocked[1 * w + 1] = 1;
  blocked[1 * w + 2] = 1;
  const stale = search(w, h, blocked, 0, 2 * w + 4, false);
  const fresh = search(w, h, blocked, 0, 2 * w + 4, true);
  assert.equal(stale.g, fresh.g);
});
