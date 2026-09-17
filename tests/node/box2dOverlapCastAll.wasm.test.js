/**
 * overlap_circle / cast_ray_all fill WASM query slots / hits (not count-only).
 * Query-hit stride is 8; first 4 floats match closest-hit layout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
const WASM_PATH = path.join(BOX2D_DIR, 'box2dWasm.wasm');
const JS_PATH = path.join(BOX2D_DIR, 'box2dWasm.js');

const BODY_STATIC = 0;

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
  assert.ok(names.overlap_circle, 'overlap_circle export missing');
  assert.ok(names.cast_ray_all, 'cast_ray_all export missing');
  assert.ok(names.get_query_slots_byte_offset, 'query slots offset missing');
  assert.ok(names.get_query_hits_byte_offset, 'query hits offset missing');

  const wasmModule = new WebAssembly.Module(wasmBuffer);
  let memory = null;
  const imports = {};
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
    assert.ok(
      exp && typeof instance.exports[exp] === 'function',
      `missing wasm export ${name} (${exp})`,
    );
    return instance.exports[exp];
  };

  return { memory, fn };
}

function createBox(fn, worldId, x, y, entityIndex) {
  const slot = fn('create_body_box')(
    worldId,
    BODY_STATIC,
    x,
    y,
    0,
    20,
    20,
    0,
    0,
    1,
    0.3,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    0xffffffff,
    0,
    0,
    entityIndex,
  );
  assert.ok(slot >= 0, `create_body_box failed: ${slot}`);
  return slot;
}

test('overlap_circle writes entity ids into query slots', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);

  createBox(fn, worldId, 0, 0, 11);
  createBox(fn, worldId, 10, 0, 22);

  const n = fn('overlap_circle')(worldId, 0, 0, 40, 1, 0xffffffff);
  assert.equal(n, 2);

  const slotsOff = fn('get_query_slots_byte_offset')() >> 2;
  const slots = new Int32Array(memory.buffer).subarray(slotsOff, slotsOff + n);
  const ids = new Set(slots);
  assert.ok(ids.has(11), `query slots missing 11: ${[...slots]}`);
  assert.ok(ids.has(22), `query slots missing 22: ${[...slots]}`);
});

test('cast_ray_all writes stride-8 hits; first 4 floats are entity/fraction/xy', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);

  createBox(fn, worldId, 0, 0, 11);
  createBox(fn, worldId, 10, 0, 22);

  const stride = fn('get_query_hit_float_stride')();
  assert.equal(stride, 8);

  const n = fn('cast_ray_all')(worldId, -80, 0, 160, 0, 1, 0xffffffff);
  assert.equal(n, 2);

  const hitsOff = fn('get_query_hits_byte_offset')() >> 2;
  const hits = new Float32Array(memory.buffer).subarray(hitsOff, hitsOff + n * stride);
  const entities = [hits[0] | 0, hits[stride] | 0];
  assert.ok(entities.includes(11), `hits missing 11: ${entities}`);
  assert.ok(entities.includes(22), `hits missing 22: ${entities}`);
  assert.ok(hits[1] > 0 && hits[1] < 1, `fraction0 out of range: ${hits[1]}`);
  assert.ok(hits[stride + 1] > 0 && hits[stride + 1] < 1, `fraction1 out of range: ${hits[stride + 1]}`);
});
