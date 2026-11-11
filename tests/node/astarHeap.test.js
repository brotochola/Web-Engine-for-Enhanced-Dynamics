import test from 'node:test';
import assert from 'node:assert/strict';

import { NavScratch, searchAstar, NAV_DX, NAV_DY, NAV_COST } from '../../src/core/navAstar.js';
import { mulberry32 } from '../bench/benchMath.js';

// N-137. The particle worker's A* (navAstar.js since) lowered a waiting cell's f in place without moving it in the
// heap, so the heap's order broke and a path could come out longer than the shortest. The open set now keeps each
// cell's heap position and sifts it up when its cost falls. These run the shipped search against an exact Dijkstra.

function dijkstra(w, h, walk, from, to) {
  const n = w * h;
  const d = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  d[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i;
    if (u < 0) return Infinity;
    if (u === to) return d[u];
    done[u] = 1;
    const x = u % w;
    const y = (u / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + NAV_DX[k];
      const ny = y + NAV_DY[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const v = ny * w + nx;
      if (walk[v] && d[u] + NAV_COST[k] < d[v]) d[v] = d[u] + NAV_COST[k];
    }
  }
}

/** The cost of a path the search wrote, or NaN when a step is not a move between walkable neighbours. */
function pathCost(w, walk, path, n) {
  let c = 0;
  for (let i = 1; i < n; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dx = Math.abs((a % w) - (b % w));
    const dy = Math.abs(((a / w) | 0) - ((b / w) | 0));
    if (!walk[b] || dx > 1 || dy > 1 || dx + dy === 0) return NaN;
    c += dx + dy === 2 ? 14 : 10;
  }
  return c;
}

function grid(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const walk = new Uint8Array(w * h);
  let from = -1;
  let to = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x];
      const c = y * w + x;
      walk[c] = ch === '#' ? 0 : 1;
      if (ch === 'S') from = c;
      if (ch === 'T') to = c;
    }
  }
  return { w, h, walk, from, to };
}

function search({ w, h, walk, from, to }) {
  const s = new NavScratch(w * h, 256, w, h);
  const n = searchAstar(s, walk, w, h, from, to);
  return { n, path: s.pathResult, cost: pathCost(w, walk, s.pathResult, n) };
}

test('A* finds the shortest path on a wall gap', () => {
  const g = grid(['S....', '###..', '....T']);
  const r = search(g);
  assert.equal(r.path[0], g.from);
  assert.equal(r.path[r.n - 1], g.to);
  assert.equal(r.cost, dijkstra(g.w, g.h, g.walk, g.from, g.to));
});

test('a grid where the old open-set rule came out 62 long: the search takes the shortest, 54', () => {
  // Found by comparing the old rule with Dijkstra on random grids (5 of 9093 reachable pairs were longer).
  const g = grid(['...#..', '....#T', 'S....#', '....#.']);
  assert.equal(dijkstra(g.w, g.h, g.walk, g.from, g.to), 54);
  const r = search(g);
  assert.equal(r.path[0], g.from);
  assert.equal(r.path[r.n - 1], g.to);
  assert.equal(r.cost, 54);
});

test('A* paths cost what an exact Dijkstra says, on 20 000 random small grids', () => {
  const rnd = mulberry32(138);
  let checked = 0;
  for (let trial = 0; trial < 20000; trial++) {
    const w = 4 + Math.floor(rnd() * 5);
    const h = 3 + Math.floor(rnd() * 4);
    const walk = new Uint8Array(w * h);
    for (let i = 0; i < walk.length; i++) walk[i] = rnd() < 0.7 ? 1 : 0;
    const from = Math.floor(rnd() * walk.length);
    const to = Math.floor(rnd() * walk.length);
    if (from === to || !walk[from] || !walk[to]) continue;
    const best = dijkstra(w, h, walk, from, to);
    const r = search({ w, h, walk, from, to });
    if (best === Infinity) {
      assert.equal(r.n, 0, 'no path where none exists');
      continue;
    }
    checked++;
    assert.equal(r.path[0], from);
    assert.equal(r.path[r.n - 1], to);
    assert.equal(r.cost, best, `grid ${w}x${h} ${Array.from(walk).join('')} from ${from} to ${to}`);
  }
  assert.ok(checked > 5000, `${checked} reachable pairs checked`);
});

test('a scratch is reused between searches', () => {
  const a = grid(['S#..', '.#.T', '....']);
  const s = new NavScratch(a.w * a.h, 64, a.w, a.h);
  const first = searchAstar(s, a.walk, a.w, a.h, a.from, a.to);
  const firstPath = Array.from(s.pathResult.subarray(0, first));
  searchAstar(s, a.walk, a.w, a.h, a.to, a.from);
  const again = searchAstar(s, a.walk, a.w, a.h, a.from, a.to);
  assert.deepEqual(Array.from(s.pathResult.subarray(0, again)), firstPath);
  assert.equal(pathCost(a.w, a.walk, s.pathResult, again), dijkstra(a.w, a.h, a.walk, a.from, a.to));
});
