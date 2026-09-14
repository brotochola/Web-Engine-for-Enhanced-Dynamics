// L1: steady-state SolveRigidDamping (ice-ice pair + ice-floor body contacts).
//
// CapturePairs / ComputeDepth miss this pass. LiquidFunStressScene has one ice
// slab, not two overlapping SOLID|RIGID groups. Times get_liquidfun_step_ms
// after warmup.
//
// Usage:
//   node tests/bench/liquidFunRigidDampingMicrobench.mjs
//   node tests/bench/liquidFunRigidDampingMicrobench.mjs --output tests/results/liquidfun-rigiddamping-micro.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, writeReport } from './microbenchHelpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
const WASM_PATH = path.join(BOX2D_DIR, 'box2dWasm.wasm');
const JS_PATH = path.join(BOX2D_DIR, 'box2dWasm.js');

const args = parseArgs();
const RADIUS = Number(args.radius ?? 10);
const REPS = Number(args.reps ?? 7);
const WARMUP_STEPS = Number(args.warmup ?? 40);
const MEASURE_STEPS = Number(args.steps ?? 80);
const OUTPUT = args.output ? String(args.output) : null;

const VISCOUS = 1 << 2;
const LF_SOLID_GROUP = 1 << 0;
const LF_RIGID_GROUP = 1 << 1;

function parseWasmExportMap(jsSource) {
  const map = Object.create(null);
  const re = /Module\["_(\w+)"\]\s*=\s*wasmExports\["([^"]+)"\]/g;
  let m;
  while ((m = re.exec(jsSource))) {
    map[m[1]] = m[2];
  }
  return map;
}

function instantiateBox2dWasm() {
  const wasmBuffer = fs.readFileSync(WASM_PATH);
  const jsSource = fs.readFileSync(JS_PATH, 'utf8');
  const names = parseWasmExportMap(jsSource);
  const wasmModule = new WebAssembly.Module(wasmBuffer);
  const imports = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'memory') {
      imports[imp.module][imp.name] = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
    } else if (imp.kind === 'table') {
      imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 1024, element: 'anyfunc' });
    } else if (imp.kind === 'function') {
      // box2dWasm.js wasmImports: a.b = _emscripten_get_now (LTO minified).
      if (imp.module === 'a' && imp.name === 'b') {
        imports[imp.module][imp.name] = () => performance.now();
      } else {
        imports[imp.module][imp.name] = () => 0;
      }
    } else if (imp.kind === 'global') {
      imports[imp.module][imp.name] = 0;
    }
  }
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const fn = (name) => {
    const exp = names[name];
    if (!exp || typeof instance.exports[exp] !== 'function') {
      throw new Error(`missing wasm export ${name} (${exp}) - rebuild box2d_wasm.js`);
    }
    return instance.exports[exp];
  };
  return fn;
}

function median(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  return s[(s.length / 2) | 0];
}

function measureSteps(fn, setup) {
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const createBodyBox = fn('create_body_box');
  const destroyParticleSystem = fn('destroy_particle_system');
  const getParticleCount = fn('get_particle_count');
  const setSubSteps = fn('set_particle_sub_steps');
  const stepWorld = fn('step_world');
  const getLfMs = fn('get_liquidfun_step_ms');

  const gravity = setup.gravity || 0;
  const worldId = createWorld(0, gravity, 100, 30, 0.7, 3, 4000, 1);
  if (!worldId) throw new Error('create_world failed');
  if (!bindGameBuffers(16)) throw new Error('bind_game_buffers failed');
  const sysOk = createParticleSystem(worldId, RADIUS, 1.0, setup.cap, 0);
  if (!sysOk) throw new Error('create_particle_system failed');
  setSubSteps(1);

  if (setup.floor) {
    const floorSlot = createBodyBox(
      worldId,
      0,
      0, 400, 0,
      2000, 130,
      0, 0,
      1, 0.6, 0,
      0, 0, 1,
      0, 0, 0,
      0, 0,
      1, 0xffffffff,
      0, 0, 0,
    );
    if (floorSlot < 0) throw new Error(`create_body_box failed: ${floorSlot}`);
  }

  for (const g of setup.groups) {
    const gid = createParticleGroupBox(
      g.x0, g.y0, g.x1, g.y1,
      0,
      g.flags || 0,
      0.5, 0, 0, 0, 1, 1,
      g.groupFlags || 0,
    );
    if (gid < 0) throw new Error(`group create failed: ${gid}`);
  }

  const count = getParticleCount();
  const dt = 1 / 60;
  for (let i = 0; i < WARMUP_STEPS; i++) stepWorld(worldId, dt, 1);

  const samples = [];
  const t0 = performance.now();
  for (let i = 0; i < MEASURE_STEPS; i++) {
    stepWorld(worldId, dt, 1);
    samples.push(getLfMs());
  }
  const wallMs = performance.now() - t0;
  destroyParticleSystem();
  return {
    count,
    lfMedianMs: median(samples),
    lfMinMs: Math.min(...samples),
    lfMaxMs: Math.max(...samples),
    wallPerStepMs: wallMs / MEASURE_STEPS,
    samples,
  };
}

const ICE = LF_SOLID_GROUP | LF_RIGID_GROUP;

const SCENES = [
  {
    id: 'water-overlap',
    note: 'control: overlapping viscous (no SOLID) — pair damping skipped',
    gravity: 0,
    cap: 8000,
    groups: [
      { x0: -700, y0: -120, x1: 80, y1: 120, flags: VISCOUS, groupFlags: 0 },
      { x0: -80, y0: -120, x1: 700, y1: 120, flags: VISCOUS, groupFlags: 0 },
    ],
  },
  {
    id: 'ice-ice',
    note: 'overlapping SOLID|RIGID — pair-COM SolveRigidDamping hot path',
    gravity: 0,
    cap: 8000,
    groups: [
      { x0: -700, y0: -120, x1: 80, y1: 120, flags: 0, groupFlags: ICE },
      { x0: -80, y0: -120, x1: 700, y1: 120, flags: 0, groupFlags: ICE },
    ],
  },
  {
    id: 'ice-floor',
    note: 'SOLID|RIGID on static floor — body-contact SolveRigidDamping',
    gravity: 980,
    floor: true,
    cap: 4000,
    groups: [
      { x0: -600, y0: 40, x1: 600, y1: 200, flags: 0, groupFlags: ICE },
    ],
  },
];

const fn = instantiateBox2dWasm();
const report = {
  bench: 'liquidfun-rigiddamping-microbench',
  radius: RADIUS,
  reps: REPS,
  warmupSteps: WARMUP_STEPS,
  measureSteps: MEASURE_STEPS,
  wasmBytes: fs.statSync(WASM_PATH).size,
  scenes: {},
};

for (const scene of SCENES) {
  const medians = [];
  const walls = [];
  let last = null;
  for (let r = 0; r < REPS; r++) {
    const row = measureSteps(fn, scene);
    medians.push(row.lfMedianMs);
    walls.push(row.wallPerStepMs);
    last = row;
  }
  const lfMedian = median(medians);
  const wallMedian = median(walls);
  report.scenes[scene.id] = {
    note: scene.note,
    particleCount: last.count,
    lfMedianMs: lfMedian,
    lfMinMs: Math.min(...medians),
    lfMaxMs: Math.max(...medians),
    wallPerStepMedianMs: wallMedian,
    worldMediansMs: medians,
  };
  console.log(
    `${scene.id} (n=${last.count}): lf step median ${lfMedian.toFixed(4)} ms ` +
      `(min ${Math.min(...medians).toFixed(4)}, max ${Math.max(...medians).toFixed(4)}, worlds=${REPS}) ` +
      `wall ${wallMedian.toFixed(4)} ms/step`,
  );
}

if (OUTPUT) writeReport(OUTPUT, report);
