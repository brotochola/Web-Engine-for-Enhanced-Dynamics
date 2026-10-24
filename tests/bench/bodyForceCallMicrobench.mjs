#!/usr/bin/env node
/**
 * Premise for E-76 W28: what one `body_apply_force_center` call per body costs, the call the physics host's
 * `applyForcesAndTorque` makes for every body with an acceleration, against the same loop without the call. A
 * batched C export would still do Box2D's work per body (the body lookup and the force add); what it saves is at
 * most the difference, the JS → WASM boundary included.
 *
 * Node, the shipped box2dWasm.wasm, single-threaded, the Predator fixture's bodies as dynamic circles.
 *
 *   node tests/bench/bodyForceCallMicrobench.mjs [--output path]
 */
import fs from 'node:fs';

import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { JS_PATH, WASM_PATH, parseWasmExportMap } from './wasmLfBenchLib.mjs';
import { loadPredatorFixture } from './predatorFixture.mjs';

function instantiate() {
  const names = parseWasmExportMap(fs.readFileSync(JS_PATH, 'utf8'));
  const mod = new WebAssembly.Module(fs.readFileSync(WASM_PATH));
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'memory') imports[imp.module][imp.name] = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    else if (imp.kind === 'table') imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 1024, element: 'anyfunc' });
    else if (imp.kind === 'function') imports[imp.module][imp.name] = imp.module === 'a' && imp.name === 'b' ? () => performance.now() : () => 0;
    else if (imp.kind === 'global') imports[imp.module][imp.name] = 0;
  }
  const instance = new WebAssembly.Instance(mod, imports);
  return (name) => {
    const exp = names[name];
    if (!exp || typeof instance.exports[exp] !== 'function') throw new Error(`missing wasm export ${name}`);
    return instance.exports[exp];
  };
}

/** The bodies' slots and their accelerations, as the host's dense list and RigidBody columns hold them. */
function world(fn) {
  const fx = loadPredatorFixture();
  if (!fx) throw new Error('missing tests/fixtures/predator-frame.bin (run capturePredatorFixture.mjs)');
  const { x, y, radius, active, colliderActive } = fx.arrays;
  const n = fx.meta.n;
  const worldId = fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!fn('bind_game_buffers')(Math.max(16, n + 64))) throw new Error('bind_game_buffers failed');
  const createBodyCircle = fn('create_body_circle');
  const list = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!active[i] || !colliderActive[i]) continue;
    const slot = createBodyCircle(worldId, 2, x[i], y[i], 0, radius[i] || 8, 0, 0, 1, 0.3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, i);
    if (slot >= 0) list[count++] = i;
  }
  const ax = new Float32Array(n);
  const ay = new Float32Array(n);
  const mass = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const i = list[k];
    ax[i] = ((i * 37) % 11) - 5 || 1;
    ay[i] = ((i * 53) % 13) - 6 || 1;
    mass[i] = 1 + (i % 4);
  }
  return { worldId, list, count, ax, ay, mass };
}

async function main() {
  const args = parseArgs();
  const fn = instantiate();
  const w = world(fn);
  const apply = fn('body_apply_force_center');
  const { list, count, ax, ay, mass } = w;

  // applyForcesAndTorque's linear part: per body with an acceleration, a force of a × mass.
  function withCall() {
    let calls = 0;
    for (let k = 0; k < count; k++) {
      const i = list[k];
      const m = mass[i] > 0 ? mass[i] : 1;
      const x = ax[i];
      const y = ay[i];
      if (x !== 0 || y !== 0) {
        apply(i, x * m, y * m, 1);
        calls++;
      }
    }
    return calls;
  }
  // The same loads and tests, the force summed instead of sent.
  let sink = 0;
  function withoutCall() {
    let calls = 0;
    let s = 0;
    for (let k = 0; k < count; k++) {
      const i = list[k];
      const m = mass[i] > 0 ? mass[i] : 1;
      const x = ax[i];
      const y = ay[i];
      if (x !== 0 || y !== 0) {
        s += x * m + y * m;
        calls++;
      }
    }
    sink += s;
    return calls;
  }
  warmNormalCompile(withCall, 40);
  warmNormalCompile(withoutCall, 40);
  const cases = {};
  const rounds = Number(args.rounds || 5);
  const calls = withCall();
  for (let r = 0; r < rounds; r++) {
    cases[`call r${r}`] = timeIt(`${calls} body_apply_force_center calls`, withCall, { iterations: 200, warmup: 20 });
    cases[`floor r${r}`] = timeIt(`the same loop without the call`, withoutCall, { iterations: 200, warmup: 20 });
  }
  const med = (key) => {
    const v = Object.entries(cases).filter(([k]) => k.startsWith(key)).map(([, c]) => 1e9 / c.opsPerSec).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const callNs = med('call') / calls;
  const floorNs = med('floor') / calls;
  console.log(`bodies ${count}, calls ${calls}: ${callNs.toFixed(1)} ns a body with the call, ${floorNs.toFixed(1)} ns without (sink ${sink > 0})`);
  const report = {
    feature: 'body-force-call',
    functions: ['body_apply_force_center (box2dWasm)'],
    n: count,
    seed: 0,
    checksum: calls,
    nsPerBodyWithCall: callNs,
    nsPerBodyWithoutCall: floorNs,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
}

if (isCli(import.meta.url)) await main();
