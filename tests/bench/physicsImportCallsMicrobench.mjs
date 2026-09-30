#!/usr/bin/env node
/**
 * Diagnostic (P1): how many times Box2D's step calls back into JS, per import,
 * on a Predator-sized world. The trace shows ~3k samples of
 * `_emscripten_get_now` (import a.b) in the physics threads; this counts the
 * calls per step_world so the cost can be attributed.
 *
 * Node, single-threaded world (workerCount 1): the pthread task system is not
 * exercised; the counts are per step of the solver itself.
 *
 *   node tests/bench/physicsImportCallsMicrobench.mjs --output tests/results/physics-import-calls.json
 */
import fs from 'node:fs';

import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { JS_PATH, WASM_PATH, parseWasmExportMap } from './wasmLfBenchLib.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';

function instantiateCounting() {
  const wasmBuffer = fs.readFileSync(WASM_PATH);
  const jsSource = fs.readFileSync(JS_PATH, 'utf8');
  const names = parseWasmExportMap(jsSource);
  const wasmModule = new WebAssembly.Module(wasmBuffer);
  const counts = new Map();
  const imports = {};
  let memory = null;
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    const key = `${imp.module}.${imp.name}`;
    if (imp.kind === 'memory') {
      memory = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
      imports[imp.module][imp.name] = memory;
    } else if (imp.kind === 'table') {
      imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 1024, element: 'anyfunc' });
    } else if (imp.kind === 'function') {
      counts.set(key, 0);
      const now = imp.module === 'a' && imp.name === 'b';
      imports[imp.module][imp.name] = (...a) => {
        counts.set(key, counts.get(key) + 1);
        return now ? performance.now() : 0;
      };
    } else if (imp.kind === 'global') {
      imports[imp.module][imp.name] = 0;
    }
  }
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const fn = (name) => {
    const exp = names[name];
    if (!exp || typeof instance.exports[exp] !== 'function') throw new Error(`missing wasm export ${name}`);
    return instance.exports[exp];
  };
  return { fn, counts, memory };
}

async function main() {
  const args = parseArgs();
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const { fn, counts } = instantiateCounting();
  const { x, y, radius, active, colliderActive } = fx.arrays;
  const n = fx.meta.n;
  const worldId = fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!fn('bind_game_buffers')(Math.max(16, n + 64))) throw new Error('bind_game_buffers failed');
  const createBodyCircle = fn('create_body_circle');
  let bodies = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i] || !colliderActive[i]) continue;
    const slot = createBodyCircle(worldId, 2, x[i], y[i], 0, radius[i] || 8, 0, 0, 1, 0.3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, i);
    if (slot >= 0) bodies++;
  }
  const step = fn('step_world');
  const dt = 1 / 60;
  for (let s = 0; s < 30; s++) step(worldId, dt, 1);
  for (const k of counts.keys()) counts.set(k, 0);
  const STEPS = 60;
  for (let s = 0; s < STEPS; s++) step(worldId, dt, 1);
  const perStep = {};
  for (const [k, v] of counts) if (v > 0) perStep[k] = v / STEPS;
  const cases = {
    step: timeIt(`step_world (${bodies} dynamic circles)`, () => step(worldId, dt, 1), { iterations: 5, warmup: 5 }),
  };
  const report = {
    feature: 'physics-import-calls',
    functions: ['step_world (box2dWasm)'],
    n: bodies,
    seed: 0,
    checksum: bodies,
    importCallsPerStep: perStep,
    note: 'import a.b is _emscripten_get_now (LTO-minified glue). Single-threaded world in Node.',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  console.log(JSON.stringify(perStep, null, 2));
}

if (isCli(import.meta.url)) await main();
