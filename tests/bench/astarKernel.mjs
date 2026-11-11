// E-207 kernel: the A* search on astarStressScene's maze, navAstar.js's searchAstar against navFlowfield.wasm's
// astar_path, both on a navigation memory as a scene makes it (createNavigationMemory + bindNavFlowfield). The same
// fixed list of walkable (from, to) pairs for both; the checksum is the sum of the path lengths and of every path
// cell times its place, so the two must agree. Browser-safe (no node: imports): Chrome decides,
//   node tests/bench/chromeKernel.mjs --module /tests/bench/astarKernel.mjs [--args '{"pairs":2000}']
// and Node screens:
//   node tests/bench/astarKernel.mjs [--pairs 2000] [--reps 7] [--output path]
// Each side is warmed through short calls first (normal compile, not OSR), then timed over the whole list.
import { NavGrid } from '../../src/core/navGrid.js';
import { NavScratch, searchAstar } from '../../src/core/navAstar.js';
import { createNavigationMemory } from '../../src/util/navigationMemory.js';
import { bindNavFlowfield } from '../../src/workers/navFlowfieldClient.js';
import { buildMaze, COLS, ROWS } from './stressScenes/astarStress/astarMaze.js';

const MAX_PATH_LENGTH = 512;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function checksum(path, n) {
  let c = n;
  for (let i = 0; i < n; i++) c = (c + path[i] * (i + 1)) % 2147483647;
  return c;
}

export async function run({ pairs = 2000, reps = 7, seed = 207 } = {}) {
  const navigation = { enabled: true, cellSize: 32, maxFlowfields: 1, maxPaths: 4, maxPathLength: MAX_PATH_LENGTH };
  const cells = COLS * ROWS;
  const nm = createNavigationMemory(NavGrid.calculateSABSize(navigation, COLS, ROWS), cells);
  NavGrid.writeHeader(nm.buffer, navigation, COLS, ROWS);
  const walk = new Uint8Array(nm.buffer, NavGrid._HEADER_SIZE, cells);
  walk.set(buildMaze(207).walkable);
  const k = await bindNavFlowfield(nm.memory, nm.layout, {
    walkability: walk,
    gridWidth: COLS,
    gridHeight: ROWS,
    maxDistance: Math.min(65535, (COLS + ROWS) * 14),
    maxPathLength: MAX_PATH_LENGTH,
  });
  const scratch = new NavScratch(cells, MAX_PATH_LENGTH, COLS, ROWS);

  const r = lcg(seed);
  const from = new Uint32Array(pairs);
  const to = new Uint32Array(pairs);
  for (let i = 0; i < pairs; ) {
    const a = Math.floor(r() * cells);
    const b = Math.floor(r() * cells);
    if (a === b || !walk[a] || !walk[b]) continue;
    from[i] = a;
    to[i] = b;
    i++;
  }

  const js = (i) => {
    const n = searchAstar(scratch, walk, COLS, ROWS, from[i], to[i]);
    return checksum(scratch.pathResult, n);
  };
  const wasm = (i) => {
    const n = k.astar(k.tableByte, from[i], to[i]);
    return checksum(k.path, n);
  };
  const pass = (fn) => {
    let c = 0;
    for (let i = 0; i < pairs; i++) c = (c + fn(i)) % 2147483647;
    return c;
  };
  // Short calls first: both compile as a scene's calls do (a whole pass would tier up inside one loop).
  for (let w = 0; w < 3000; w++) {
    js(w % 64);
    wasm(w % 64);
  }
  const sums = { js: pass(js), wasm: pass(wasm) };
  if (sums.js !== sums.wasm) throw new Error(`the paths differ: checksum js ${sums.js}, wasm ${sums.wasm}`);
  const times = { js: [], wasm: [] };
  for (let rep = 0; rep < reps; rep++) {
    for (const side of rep % 2 === 0 ? ['js', 'wasm'] : ['wasm', 'js']) {
      const fn = side === 'js' ? js : wasm;
      const t0 = performance.now();
      const c = pass(fn);
      times[side].push(performance.now() - t0);
      if (c !== sums[side]) throw new Error(`${side}: checksum moved`);
    }
  }
  const jsMs = median(times.js);
  const wasmMs = median(times.wasm);
  return {
    kernel: 'astar',
    grid: `${COLS}x${ROWS} astarStressScene maze`,
    pairs,
    reps,
    checksum: sums.js,
    js: { msPerPass: jsMs, usPerPath: (jsMs * 1000) / pairs, runs: times.js },
    wasm: { msPerPass: wasmMs, usPerPath: (wasmMs * 1000) / pairs, runs: times.wasm },
    speedup: jsMs / wasmMs,
  };
}

if (typeof process !== 'undefined' && process.versions?.node) {
  const { isCli, parseArgs, writeReport } = await import('./microbenchHelpers.mjs');
  if (isCli(import.meta.url)) {
    const args = parseArgs();
    const res = await run({ pairs: args.pairs ?? 2000, reps: args.reps ?? 7 });
    console.log(`${res.grid}, ${res.pairs} pairs, ${res.reps} reps, checksum ${res.checksum}`);
    console.log(`  js:   ${res.js.usPerPath.toFixed(1)} us a path`);
    console.log(`  wasm: ${res.wasm.usPerPath.toFixed(1)} us a path  (${res.speedup.toFixed(2)}x)`);
    if (args.output) writeReport(args.output, res);
  }
}
