/**
 * body_clear_shapes on one static body.
 * leftoverN is the world shape count after one clear (0 means it finished).
 * clearN times only the clear; fill and body recreate are outside the clock.
 * step200 steps a world that still has 200 shapes, so it never calls clear.
 *
 *   node tests/bench/clearShapesMicrobench.mjs --before old.wasm --after src/box2d/box2dWasm.wasm
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCli, parseArgs, timeIt } from './microbenchHelpers.mjs';
import { upperMedian } from './benchMath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');

function parseWasmExportMap(jsSource) {
  const map = Object.create(null);
  const re = /Module\["_(\w+)"\]\s*=\s*wasmExports\["([^"]+)"\]/g;
  let m;
  while ((m = re.exec(jsSource))) map[m[1]] = m[2];
  return map;
}

function instantiate(wasmPath) {
  const wasmBuffer = fs.readFileSync(wasmPath || path.join(BOX2D_DIR, 'box2dWasm.wasm'));
  const jsSource = fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.js'), 'utf8');
  const names = parseWasmExportMap(jsSource);
  const wasmModule = new WebAssembly.Module(wasmBuffer);
  let memory = null;
  const imports = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'memory') {
      memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
      imports[imp.module][imp.name] = memory;
    } else if (imp.kind === 'table') {
      imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 1024, element: 'anyfunc' });
    } else if (imp.kind === 'function') {
      imports[imp.module][imp.name] =
        imp.module === 'a' && imp.name === 'b' ? () => performance.now() : () => 0;
    } else if (imp.kind === 'global') {
      imports[imp.module][imp.name] = 0;
    }
  }
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const fn = (name) => instance.exports[names[name]];
  return { memory, fn };
}

function makeSession(fn, memory) {
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  if (!fn('bind_game_buffers')(8)) throw new Error('bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);
  const createBody = fn('create_body');
  const destroyBody = fn('destroy_body');
  let slot = createBody(worldId, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0);
  const ptr = fn('malloc')(8 * 4);
  const heap = new Float32Array(memory.buffer, ptr, 8);
  const add = fn('body_add_shape_polygon');
  const clear = fn('body_clear_shapes');
  const step = fn('step_world');
  const counterOff = fn('get_counters_byte_offset')();

  function fill(n) {
    for (let i = 0; i < n; i++) {
      const x = i * 1.2;
      heap[0] = x;
      heap[1] = -0.4;
      heap[2] = x + 0.8;
      heap[3] = -0.4;
      heap[4] = x + 0.8;
      heap[5] = 0.4;
      heap[6] = x;
      heap[7] = 0.4;
      add(slot, ptr, 4, 0, 0, 0);
    }
  }

  function shapeCount() {
    step(worldId, 1 / 60, 1);
    return new Int32Array(memory.buffer)[(counterOff >> 2) + 1];
  }

  function resetBody() {
    destroyBody(slot);
    slot = createBody(worldId, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0);
  }

  return {
    worldId,
    get slot() { return slot; },
    fill,
    clear,
    step,
    shapeCount,
    resetBody,
    ptr,
    free: () => fn('free')(ptr),
  };
}

// One clear is 1.5-3.5 us and each sample brackets one call, so the pair of clock
// reads (about 100 ns here) was 3-7 % of every sample, and a larger share of a
// faster arm's: ratios between arms were squeezed toward 1 (review M9). Batching
// clears needs more bodies in the world, which changes the regime (removals cost
// more in a bigger tree), so the pair's cost is measured and subtracted instead.
let clockPairMs = null;
function clockPairCost() {
  if (clockPairMs !== null) return clockPairMs;
  const N = 200000;
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    acc += performance.now() - t0;
  }
  clockPairMs = acc / N;
  return clockPairMs;
}

/** Time only body_clear_shapes. Fill and body recreate stay outside the clock. */
function timeClear(session, n) {
  const pair = clockPairCost();
  let acc = 0;
  let count = 0;
  while (acc - count * pair < 3 && count < 100000) {
    session.fill(n);
    const t0 = performance.now();
    session.clear(session.slot);
    acc += performance.now() - t0;
    count++;
    session.resetBody();
  }
  return (count / (acc - count * pair)) * 1000;
}

function timeStep(session) {
  session.fill(200);
  const result = timeIt('step200', (iters) => {
    for (let i = 0; i < iters; i++) session.step(session.worldId, 1 / 60, 4);
  }, { silent: true, iterations: 20 });
  return result.opsPerSec;
}

function leftover(fn, memory, n) {
  const s = makeSession(fn, memory);
  s.fill(n);
  const before = s.shapeCount();
  s.clear(s.slot);
  const after = s.shapeCount();
  s.free();
  return { before, after };
}

function measure(wasmPath) {
  const { memory, fn } = instantiate(wasmPath);
  const counts = [32, 63, 64, 96];
  const leftoverByN = {};
  for (let i = 0; i < counts.length; i++) {
    leftoverByN[counts[i]] = leftover(fn, memory, counts[i]);
  }
  const clearOps = {};
  for (const n of [32, 96]) {
    const s = makeSession(fn, memory);
    clearOps[n] = timeClear(s, n);
    s.free();
  }
  const stepSession = makeSession(fn, memory);
  const stepOps = timeStep(stepSession);
  stepSession.free();
  return { leftoverByN, clearOps, stepOps, clockPairNs: clockPairCost() * 1e6 };
}

function main() {
  const args = parseArgs();
  if (args.before && args.after) {
    const rounds = [];
    for (let r = 0; r < 5; r++) {
      const order = r % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
      const row = { round: r };
      for (let k = 0; k < order.length; k++) {
        const side = order[k];
        const wasm = side === 'before' ? args.before : args.after;
        const m = measure(wasm);
        row[side] = m;
      }
      rounds.push(row);
      console.log(`round ${r} clear96 ${row.before.clearOps[96].toFixed(0)} → ${row.after.clearOps[96].toFixed(0)}  step ${row.before.stepOps.toFixed(0)} → ${row.after.stepOps.toFixed(0)}`);
    }
    const beforeClear32 = rounds.map((r) => r.before.clearOps[32]);
    const afterClear32 = rounds.map((r) => r.after.clearOps[32]);
    const beforeClear96 = rounds.map((r) => r.before.clearOps[96]);
    const afterClear96 = rounds.map((r) => r.after.clearOps[96]);
    const beforeStep = rounds.map((r) => r.before.stepOps);
    const afterStep = rounds.map((r) => r.after.stepOps);
    const won = (b, a, higherBetter) => {
      let w = 0;
      for (let i = 0; i < b.length; i++) {
        if (higherBetter ? a[i] > b[i] : a[i] < b[i]) w++;
      }
      return w;
    };
    const out = {
      leftoverBefore: rounds[0].before.leftoverByN,
      leftoverAfter: rounds[0].after.leftoverByN,
      clear32: { before: upperMedian(beforeClear32), after: upperMedian(afterClear32), roundsWonByAfter: won(beforeClear32, afterClear32, true) },
      clear96: { before: upperMedian(beforeClear96), after: upperMedian(afterClear96), roundsWonByAfter: won(beforeClear96, afterClear96, true) },
      step200: { before: upperMedian(beforeStep), after: upperMedian(afterStep), roundsWonByAfter: won(beforeStep, afterStep, true) },
      rounds,
    };
    const text = JSON.stringify(out, null, 2);
    if (args.output) {
      fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
      fs.writeFileSync(args.output, text);
    }
    console.log(text);
    return;
  }

  const out = measure(args.wasm);
  const text = JSON.stringify(out, null, 2);
  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, text);
  }
  console.log(text);
}

if (isCli(import.meta.url)) main();
