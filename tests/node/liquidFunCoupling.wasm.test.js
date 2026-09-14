import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
const WASM_PATH = path.join(BOX2D_DIR, 'box2dWasm.wasm');
const JS_PATH = path.join(BOX2D_DIR, 'box2dWasm.js');

const LF_ZOMBIE = 1 << 0;
const CAP = 32;
const CH_X = 0;
const CH_Y = 1;
const CH_VX = 3;
const CH_VY = 4;

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
  assert.ok(names.get_lf_apply_impulse_calls, 'counter exports missing — rebuild box2dWasm');

  const wasmModule = new WebAssembly.Module(wasmBuffer);
  let memory = null;
  const imports = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'memory') {
      memory = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
      imports[imp.module][imp.name] = memory;
    } else if (imp.kind === 'table') {
      imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 1024, element: 'anyfunc' });
    } else if (imp.kind === 'function') {
      if (imp.module === 'a' && imp.name === 'b') {
        imports[imp.module][imp.name] = () => performance.now();
      } else {
        imports[imp.module][imp.name] = () => 0;
      }
    } else if (imp.kind === 'global') {
      imports[imp.module][imp.name] = 0;
    }
  }
  assert.ok(memory, 'wasm memory import missing');
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const fn = (name) => {
    const exp = names[name];
    assert.ok(exp && typeof instance.exports[exp] === 'function', `missing wasm export ${name} (${exp})`);
    return instance.exports[exp];
  };
  fn('set_particle_sub_steps')(1);
  return { instance, memory, fn };
}

function staticFloor(fn, worldId, entityIndex) {
  return fn('create_body_box')(
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
    0, 0, entityIndex,
  );
}

function dynamicBox(fn, worldId, x, y, hx, hy, opts = {}) {
  const gScale = opts.gravityScale ?? 1;
  const density = opts.density ?? 0.4;
  const vx = opts.vx ?? 0;
  const vy = opts.vy ?? 0;
  return fn('create_body_box')(
    worldId,
    1,
    x, y, 0,
    hx, hy,
    0, 0,
    density, 0.4, 0,
    0, 0, gScale,
    vx, vy, 0,
    0, 0,
    1, 0xffffffff,
    0, opts.fixedRotation ?? 1, opts.entityIndex ?? -1,
  );
}

function readBody(memory, fn, slot) {
  const base = fn('get_state_byte_offset')() >> 2;
  const heap = new Float32Array(memory.buffer);
  const off = (ch) => fn('get_state_channel_offset')(ch);
  return {
    x: heap[base + off(CH_X) + slot],
    y: heap[base + off(CH_Y) + slot],
    vx: heap[base + off(CH_VX) + slot],
    vy: heap[base + off(CH_VY) + slot],
  };
}

test('WASM lf counters: puddle+floor nonzero; empty world contacts 0', () => {
  const { fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const stepWorld = fn('step_world');

  const emptyId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(emptyId);
  assert.ok(bindGameBuffers(CAP));
  assert.ok(createParticleSystem(emptyId, 10, 1.0, 400));
  assert.ok(createParticleGroupBox(-40, -40, 40, 40, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  stepWorld(emptyId, 1 / 60, 1);
  assert.equal(fn('get_lf_body_contact_count')(), 0);
  assert.equal(fn('get_lf_apply_impulse_calls')(), 0);
  assert.ok(fn('get_lf_overlap_aabb_calls')() >= 1, 'empty world still queries AABB');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(CAP));
  assert.ok(staticFloor(fn, worldId, 0) >= 0);
  assert.ok(createParticleSystem(worldId, 10, 1.0, 400));
  assert.ok(createParticleGroupBox(-80, 40, 80, 160, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  for (let i = 0; i < 40; i++) stepWorld(worldId, 1 / 60, 1);
  assert.ok(fn('get_lf_body_contact_count')() > 0, 'settled puddle should touch floor');
  assert.ok(fn('get_lf_apply_impulse_calls')() > 0, 'pressure still calls ApplyLinearImpulse on statics');
  assert.ok(fn('get_lf_body_prop_calls')() > 0, 'GetType at least once per contact');
  assert.equal(fn('get_lf_overlap_aabb_calls')(), 1);
  assert.ok(fn('get_lf_query_shape_count')() >= 1);
});

test('WASM get_lf_worker_count matches create_world workerCount', () => {
  const { fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.equal(fn('get_lf_worker_count')(), 1);
  const world4 = fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 4);
  assert.ok(world4);
  assert.equal(fn('get_lf_worker_count')(), 4);
});

test('WASM static floor vx stays 0 under a puddle', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  const floor = staticFloor(fn, worldId, 0);
  assert.ok(floor >= 0);
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 400));
  assert.ok(fn('create_particle_group_box')(-80, 40, 80, 160, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  for (let i = 0; i < 60; i++) fn('step_world')(worldId, 1 / 60, 1);
  const s = readBody(memory, fn, floor);
  assert.equal(s.vx, 0);
  assert.equal(s.vy, 0);
});

test('WASM water pushes a gravityScale-0 dynamic crate', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  const crate = dynamicBox(fn, worldId, 40, 0, 18, 18, { gravityScale: 0, density: 0.2, entityIndex: 1 });
  assert.ok(crate >= 0);
  const spawn = readBody(memory, fn, crate);
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 800));
  assert.ok(fn('create_particle_group_box')(-120, -50, 20, 50, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  for (let i = 0; i < 45; i++) fn('step_world')(worldId, 1 / 60, 1);
  const after = readBody(memory, fn, crate);
  const moved = Math.hypot(after.x - spawn.x, after.y - spawn.y);
  const sped = Math.hypot(after.vx, after.vy);
  assert.ok(
    moved > 2 || sped > 5,
    `crate should be pushed by water: dx=${after.x - spawn.x} dy=${after.y - spawn.y} vx=${after.vx} vy=${after.vy}`,
  );
});

test('WASM H23: awake mover gets LF vx same frame; position is rigid-step transform', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  const crate = dynamicBox(fn, worldId, 0, 0, 16, 16, {
    gravityScale: 0,
    density: 0.25,
    vx: 90,
    entityIndex: 1,
  });
  assert.ok(crate >= 0);
  const spawn = readBody(memory, fn, crate);
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 800));
  assert.ok(fn('create_particle_group_box')(-40, -40, 40, 40, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  fn('step_world')(worldId, 1 / 60, 1);
  const one = readBody(memory, fn, crate);
  const expectedX = spawn.x + spawn.vx / 60;
  assert.ok(
    Math.abs(one.x - expectedX) < 8,
    `position should follow pre-LF velocity this frame: x=${one.x} expected~${expectedX}`,
  );
  assert.ok(
    Math.abs(one.vx - spawn.vx) > 1,
    `export re-reads velocity after LF: vx=${one.vx} spawn=${spawn.vx}`,
  );
});

test('WASM H23: sleeping crate velocity may appear next rigid step', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  fn('world_enable_sleeping')(worldId, 1);
  const crate = dynamicBox(fn, worldId, 0, 0, 16, 16, { gravityScale: 0, density: 0.25, entityIndex: 1 });
  assert.ok(crate >= 0);
  fn('body_set_awake')(crate, 0);
  fn('step_world')(worldId, 1 / 60, 1);
  const slept = readBody(memory, fn, crate);
  assert.ok(Math.abs(slept.vx) < 1e-3 && Math.abs(slept.vy) < 1e-3, 'asleep crate still');
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 800));
  assert.ok(fn('create_particle_group_box')(-50, -50, 50, 50, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  fn('step_world')(worldId, 1 / 60, 1);
  const frame0 = readBody(memory, fn, crate);
  fn('step_world')(worldId, 1 / 60, 1);
  const frame1 = readBody(memory, fn, crate);
  const sped1 = Math.hypot(frame1.vx, frame1.vy);
  const moved1 = Math.hypot(frame1.x - slept.x, frame1.y - slept.y);
  assert.ok(
    sped1 > 1 || moved1 > 0.5,
    `sleeper should move by the following rigid step: f0 vx=${frame0.vx} f1 vx=${frame1.vx} moved=${moved1}`,
  );
});

test('WASM circle body does not swallow particle centers', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  const radius = 80;
  const slot = fn('create_body_circle')(
    worldId,
    0,
    0, 200, 0,
    radius,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 0,
  );
  assert.ok(slot >= 0);
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 400));
  assert.ok(fn('create_particle_group_box')(-60, 40, 60, 160, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  for (let i = 0; i < 90; i++) fn('step_world')(worldId, 1 / 60, 1);
  const n = fn('get_particle_count')();
  const xs = new Float32Array(memory.buffer, fn('get_particle_x_byte_offset')(), n);
  const ys = new Float32Array(memory.buffer, fn('get_particle_y_byte_offset')(), n);
  let inside = 0;
  for (let i = 0; i < n; i++) {
    if (Math.hypot(xs[i], ys[i] - 200) < radius - 4) inside++;
  }
  assert.equal(inside, 0, `particle centers inside circle: ${inside}`);
});

test('WASM cull then step_world compact-zombies (count drops)', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 400));
  assert.ok(fn('create_particle_group_box')(-40, -40, 40, 40, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  const n0 = fn('get_particle_count')();
  assert.ok(n0 > 8);
  const xs = new Float32Array(memory.buffer, fn('get_particle_x_byte_offset')(), n0);
  xs[0] = -20000;
  xs[1] = 20000;
  fn('cull_particles_outside_bounds')(-10000, -10000, 10000, 10000);
  const flags = new Uint32Array(memory.buffer, fn('get_particle_flags_byte_offset')(), n0);
  assert.equal(flags[0] & LF_ZOMBIE, LF_ZOMBIE);
  fn('step_world')(worldId, 1 / 60, 1);
  const n1 = fn('get_particle_count')();
  assert.equal(n1, n0 - 2);
});

test('WASM subSteps=4 puddle still rests on the floor', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  assert.ok(staticFloor(fn, worldId, 0) >= 0);
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 400));
  fn('set_particle_sub_steps')(4);
  assert.ok(fn('create_particle_group_box')(-60, 40, 60, 140, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  for (let i = 0; i < 90; i++) fn('step_world')(worldId, 1 / 60, 1);
  const n = fn('get_particle_count')();
  const ys = new Float32Array(memory.buffer, fn('get_particle_y_byte_offset')(), n);
  let maxY = -Infinity;
  let minY = Infinity;
  for (let i = 0; i < n; i++) {
    if (ys[i] > maxY) maxY = ys[i];
    if (ys[i] < minY) minY = ys[i];
  }
  const floorTop = 270;
  assert.ok(maxY < floorTop + 50, `fell through: maxY=${maxY}`);
  assert.ok(maxY > floorTop - 90, `never reached floor: maxY=${maxY}`);
  assert.ok(minY > -400, `sprayed upward: minY=${minY}`);
  assert.equal(fn('get_lf_overlap_aabb_calls')(), 1, 'H26 default: one OverlapAABB per frame');
});

test('WASM H26 off: subSteps=4 still does 4 OverlapAABB calls', () => {
  const { fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  assert.ok(staticFloor(fn, worldId, 0) >= 0);
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 400));
  fn('set_particle_sub_steps')(4);
  fn('set_lf_reuse_query_across_substeps')(0);
  assert.ok(fn('create_particle_group_box')(-60, 40, 60, 140, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  fn('step_world')(worldId, 1 / 60, 1);
  assert.equal(fn('get_lf_overlap_aabb_calls')(), 4);
});

test('WASM H26 flag: reuse query across sub-steps drops OverlapAABB to 1', () => {
  const { fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  assert.ok(staticFloor(fn, worldId, 0) >= 0);
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 400));
  fn('set_particle_sub_steps')(4);
  fn('set_lf_reuse_query_across_substeps')(1);
  assert.ok(fn('create_particle_group_box')(-80, 40, 80, 250, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  for (let i = 0; i < 30; i++) fn('step_world')(worldId, 1 / 60, 1);
  assert.equal(fn('get_lf_overlap_aabb_calls')(), 1);
  assert.ok(fn('get_lf_query_shape_count')() >= 1, 'settled cloud AABB should hit the floor');
  assert.ok(fn('get_lf_body_contact_count')() > 0);
});

test('WASM skip-impulse flag still counts calls but crate is not pushed', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(CAP));
  const crate = dynamicBox(fn, worldId, 40, 0, 18, 18, { gravityScale: 0, density: 0.2, entityIndex: 1 });
  const spawn = readBody(memory, fn, crate);
  assert.ok(fn('create_particle_system')(worldId, 10, 1.0, 800));
  fn('set_lf_skip_body_impulse')(1);
  assert.ok(fn('create_particle_group_box')(-120, -50, 20, 50, 0, 0, 0.5, 0, 0, 0, 1, 1) >= 0);
  for (let i = 0; i < 45; i++) fn('step_world')(worldId, 1 / 60, 1);
  assert.ok(fn('get_lf_apply_impulse_calls')() > 0);
  const after = readBody(memory, fn, crate);
  const moved = Math.hypot(after.x - spawn.x, after.y - spawn.y);
  assert.ok(moved < 2, `skip impulse should leave crate put: moved=${moved}`);
});
