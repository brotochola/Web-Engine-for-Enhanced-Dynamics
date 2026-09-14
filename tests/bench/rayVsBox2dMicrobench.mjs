// L1 microbench: WeedJS Ray.cast vs Box2D cast_ray_closest (same geometry).
//
// Idle single-thread Node — no worker contention. Soft hit-agreement rate only
// (grid DDA + collisionLayer vs fixture ray + category/mask — not bit-identical).
//
// Usage:
//   node tests/bench/ray-vs-box2d-microbench.mjs
//   node tests/bench/ray-vs-box2d-microbench.mjs --entities 2000 --rays 100000 --output tests/results/ray-vs-box2d-micro.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ray } from '../../src/core/Ray.js';
import { Grid } from '../../src/core/Grid.js';
import { Transform } from '../../src/components/Transform.js';
import { Collider } from '../../src/components/Collider.js';
import { mulberry32, parseArgs, timeIt, writeReport } from './microbench-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
const WASM_PATH = path.join(BOX2D_DIR, 'box2d_wasm.wasm');
const JS_PATH = path.join(BOX2D_DIR, 'box2d_wasm.js');

const args = parseArgs();
const WORLD_W = 4000;
const WORLD_H = 3000;
const CELL_SIZE = Number(args['cell-size'] ?? 128);
const MAX_PER_CELL = 64;
const ENTITY_COUNT = Number(args.entities ?? 2000);
const RAY_ITERS = Number(args.rays ?? 100000);
const SEED = Number(args.seed ?? 0xc0ffee);
const MARGIN = 64;
const AGREEMENT_CHECKS = 5000;
const OUTPUT = args.output ? String(args.output) : null;

function parseWasmExportMap(jsSource) {
  const map = Object.create(null);
  const re = /Module\["_(\w+)"\]\s*=\s*wasmExports\["([^"]+)"\]/g;
  let m;
  while ((m = re.exec(jsSource))) map[m[1]] = m[2];
  return map;
}

function instantiateBox2dWasm() {
  const wasmBuffer = fs.readFileSync(WASM_PATH);
  const jsSource = fs.readFileSync(JS_PATH, 'utf8');
  const names = parseWasmExportMap(jsSource);
  const wasmModule = new WebAssembly.Module(wasmBuffer);
  const imports = {};
  let memory = null;
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'memory') {
      memory = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
      imports[imp.module][imp.name] = memory;
    } else if (imp.kind === 'table') {
      imports[imp.module][imp.name] = new WebAssembly.Table({
        initial: 1024,
        element: 'anyfunc',
      });
    } else if (imp.kind === 'function') {
      imports[imp.module][imp.name] = () => 0;
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
  return { fn, memory };
}

// --- WeedJS grid world (same layout as ray-microbench) ---
const gridCols = Math.ceil(WORLD_W / CELL_SIZE);
const gridRows = Math.ceil(WORLD_H / CELL_SIZE);
const totalCells = gridCols * gridRows;
const cellByteSize = 4 + MAX_PER_CELL * 2;

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
Grid._gridEntities = new Uint16Array(gridBuffer);

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

const rng = mulberry32(SEED);
for (let i = 0; i < ENTITY_COUNT; i++) {
  Transform.x[i] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
  Transform.y[i] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
  Collider.shapeType[i] = rng() < 0.7 ? 1 : 0;
  Collider.radius[i] = 4 + rng() * 16;
  Collider.width[i] = 8 + rng() * 32;
  Collider.height[i] = 8 + rng() * 32;
  Collider.collisionLayer[i] = (rng() * 8) | 0;
}

for (let i = 0; i < ENTITY_COUNT; i++) {
  const px = Transform.x[i];
  const py = Transform.y[i];
  let halfW;
  let halfH;
  if (Collider.shapeType[i] === 1) {
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

// --- Box2D world mirroring Collider geometry (static bodies, entity index userData) ---
const { fn, memory } = instantiateBox2dWasm();
const createWorld = fn('create_world');
const bindGameBuffers = fn('bind_game_buffers');
const createBodyBox = fn('create_body_box');
const createBodyCircle = fn('create_body_circle');
const castRayClosest = fn('cast_ray_closest');
const getQueryHitsByteOffset = fn('get_query_hits_byte_offset');
const getQueryHitFloatStride = fn('get_query_hit_float_stride');

const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
if (!worldId) throw new Error('create_world failed');
if (!bindGameBuffers(Math.max(16, ENTITY_COUNT + 64))) {
  throw new Error('bind_game_buffers failed');
}

for (let i = 0; i < ENTITY_COUNT; i++) {
  const x = Transform.x[i];
  const y = Transform.y[i];
  // Wide category/mask so all bodies are hittable (fair kernel compare; layer masks differ).
  const cat = 1;
  const mask = 0xffffffff;
  let slot;
  if (Collider.shapeType[i] === 1) {
    slot = createBodyCircle(
      worldId,
      0,
      x,
      y,
      0,
      Collider.radius[i],
      0,
      0,
      1,
      0.3,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      cat,
      mask,
      0,
      0,
      i,
    );
  } else {
    slot = createBodyBox(
      worldId,
      0,
      x,
      y,
      0,
      Collider.width[i] * 0.5,
      Collider.height[i] * 0.5,
      0,
      0,
      1,
      0.3,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      cat,
      mask,
      0,
      0,
      i,
    );
  }
  if (slot < 0) throw new Error(`create body failed for entity ${i}: ${slot}`);
}

const hitStride = getQueryHitFloatStride();
const hitsOffset = getQueryHitsByteOffset();
const queryHits = new Float32Array(memory.buffer, hitsOffset, hitStride);

const rayRng = mulberry32((SEED ^ 0x5678) >>> 0);
const longRays = new Float32Array(4096 * 4);
for (let i = 0; i < longRays.length; i += 4) {
  longRays[i] = MARGIN + rayRng() * (WORLD_W - 2 * MARGIN);
  longRays[i + 1] = MARGIN + rayRng() * (WORLD_H - 2 * MARGIN);
  longRays[i + 2] = MARGIN + rayRng() * (WORLD_W - 2 * MARGIN);
  longRays[i + 3] = MARGIN + rayRng() * (WORLD_H - 2 * MARGIN);
}

function box2dClosestEntity(ox, oy, dx, dy) {
  const n = castRayClosest(worldId, ox, oy, dx, dy, 1, 0xffffffff);
  if (!(n > 0)) return -1;
  return queryHits[0] | 0;
}

// Soft agreement: both hit or both miss (entity id may differ — filters/math differ).
const agreeRng = mulberry32((SEED ^ 0xabcd) >>> 0);
let agree = 0;
let disagree = 0;
for (let n = 0; n < AGREEMENT_CHECKS; n++) {
  const k = ((agreeRng() * 4096) | 0) * 4;
  const ox = longRays[k];
  const oy = longRays[k + 1];
  const ex = longRays[k + 2];
  const ey = longRays[k + 3];
  const dx = ex - ox;
  const dy = ey - oy;
  const weedHit = Ray.cast(ox, oy, ex, ey) !== -1;
  const boxHit = box2dClosestEntity(ox, oy, dx, dy) !== -1;
  if (weedHit === boxHit) agree++;
  else disagree++;
}
const agreementRate = agree / (agree + disagree);
console.log(
  `HIT AGREEMENT (hit/miss only): ${(agreementRate * 100).toFixed(1)}% ` +
    `(${agree}/${agree + disagree}) — soft gate, not bit-identical`,
);
console.log(
  `config: entities=${ENTITY_COUNT} cellSize=${CELL_SIZE} rays=${RAY_ITERS} seed=${SEED}`,
);

let sink = 0;
const cases = {};

cases.weedjs_cast = timeIt(
  'WeedJS Ray.cast (long random rays)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 4096) * 4;
      sink += Ray.cast(longRays[k], longRays[k + 1], longRays[k + 2], longRays[k + 3]);
    }
  },
  { iterations: RAY_ITERS },
);

cases.box2d_castRayClosest = timeIt(
  'Box2D cast_ray_closest (same segments)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 4096) * 4;
      const ox = longRays[k];
      const oy = longRays[k + 1];
      sink += box2dClosestEntity(
        ox,
        oy,
        longRays[k + 2] - ox,
        longRays[k + 3] - oy,
      );
    }
  },
  { iterations: RAY_ITERS },
);

cases.weedjs_castWithInfo = timeIt(
  'WeedJS Ray.castWithInfo (short 300u)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 4096) * 4;
      const x = longRays[k];
      const y = longRays[k + 1];
      const r = Ray.castWithInfo(x, y, x + 250, y + 120, 300);
      if (r.hit) sink++;
    }
  },
  { iterations: RAY_ITERS },
);

cases.box2d_castRayClosest_short = timeIt(
  'Box2D cast_ray_closest (short 300u)',
  (iters) => {
    for (let i = 0; i < iters; i++) {
      const k = (i % 4096) * 4;
      const x = longRays[k];
      const y = longRays[k + 1];
      // 250,120 has length ~277; clamp displacement to 300u along that dir.
      const len = Math.hypot(250, 120);
      const scale = 300 / len;
      sink += box2dClosestEntity(x, y, 250 * scale, 120 * scale);
    }
  },
  { iterations: RAY_ITERS },
);

console.log(`(sink=${sink})`);
const weedOps = cases.weedjs_cast.opsPerSec;
const boxOps = cases.box2d_castRayClosest.opsPerSec;
console.log(
  `L1 VERDICT (idle kernel): WeedJS ${Math.round(weedOps).toLocaleString()} ops/s vs ` +
    `Box2D ${Math.round(boxOps).toLocaleString()} ops/s ` +
    `(ratio Weed/Box2D=${(weedOps / boxOps).toFixed(2)})`,
);

if (OUTPUT) {
  const caseSummary = {};
  for (const [key, result] of Object.entries(cases)) {
    caseSummary[key] = {
      ms: result.ms,
      opsPerSec: result.opsPerSec,
      iterations: result.iterations,
    };
  }
  writeReport(OUTPUT, {
    feature: 'ray-vs-box2d',
    layer: 'L1',
    seed: SEED,
    entityCount: ENTITY_COUNT,
    cellSize: CELL_SIZE,
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    hitAgreementRate: agreementRate,
    agreementChecks: AGREEMENT_CHECKS,
    cases: caseSummary,
    ratioWeedOverBox2d: weedOps / boxOps,
  });
}
