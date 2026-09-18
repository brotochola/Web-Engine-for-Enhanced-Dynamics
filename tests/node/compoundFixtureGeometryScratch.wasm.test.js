/**
 * Crash/leak check: one WASM vertex scratch, clear+add many polygons.
 * Timing here is not the keep metric (that is compoundGeometryDirtyScene).
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
const MAX_VERTS = 8;

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
      imports[imp.module][imp.name] =
        imp.module === 'a' && imp.name === 'b' ? () => performance.now() : () => 0;
    } else if (imp.kind === 'global') {
      imports[imp.module][imp.name] = 0;
    }
  }
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const fn = (name) => instance.exports[names[name]];
  return { instance, memory, fn };
}

test('one heap scratch survives many clear+add polygon loops', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(fn('bind_game_buffers')(64));
  const slot = fn('create_body')(worldId, BODY_STATIC, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0);
  assert.ok(slot >= 0);

  const ptr = fn('malloc')(MAX_VERTS * 2 * 4);
  assert.ok(ptr);
  const heap = new Float32Array(memory.buffer, ptr, MAX_VERTS * 2);
  const tris = [
    [0, 0, 10, 0, 0, 10],
    [10, 0, 20, 0, 20, 10],
    [0, 10, 10, 10, 0, 20],
  ];

  for (let loop = 0; loop < 400; loop++) {
    fn('body_clear_shapes')(slot);
    for (let t = 0; t < tris.length; t++) {
      heap.set(tris[t]);
      fn('body_add_shape_polygon')(slot, ptr, 3, 0, 0);
    }
  }

  fn('step_world')(worldId, 1 / 60, 1);
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const x = new Float32Array(memory.buffer)[(stateByte >> 2) + slot];
  assert.ok(Number.isFinite(x), 'body slot still readable after clear+add storm');
  fn('free')(ptr);
});
