import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
const wasmBuffer = fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.wasm'));
const jsSource = fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.js'), 'utf8');
const names = Object.create(null);
const re = /Module\["_(\w+)"\]\s*=\s*wasmExports\["([^"]+)"\]/g;
let m;
while ((m = re.exec(jsSource))) names[m[1]] = m[2];

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
    imports[imp.module][imp.name] = imp.module === 'a' && imp.name === 'b' ? () => performance.now() : () => 0;
  } else if (imp.kind === 'global') {
    imports[imp.module][imp.name] = 0;
  }
}
const instance = new WebAssembly.Instance(wasmModule, imports);
const fn = (name) => instance.exports[names[name]];

const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
fn('bind_game_buffers')(64);
fn('world_enable_sleeping')(worldId, 0);

function createBox(x, y, entityIndex) {
  return fn('create_body_box')(
    worldId, 0, x, y, 0, 20, 20, 0, 0, 1, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, entityIndex,
  );
}

const slotA = createBox(0, 0, 11);
const slotB = createBox(10, 0, 22);
console.log({ slotA, slotB, worldId });

const heapI = () => new Int32Array(memory.buffer);
const heapF = () => new Float32Array(memory.buffer);
const slotsOff = fn('get_query_slots_byte_offset')() >> 2;
const hitsOff = fn('get_query_hits_byte_offset')() >> 2;
const stride = fn('get_query_hit_float_stride')();
const cap = fn('get_query_capacity')();
console.log({ slotsOff, hitsOff, stride, cap });

const malloc = fn('malloc');
const ptr = malloc(64 * 4);
const aabbN = fn('overlap_aabb_into')(worldId, -50, -50, 50, 50, 1, 0xffffffff, ptr, 64);
const aabbView = heapI().subarray(ptr >> 2, (ptr >> 2) + 8);
console.log({ aabbN, aabbView: [...aabbView] });

const circleN = fn('overlap_circle')(worldId, 0, 0, 40, 1, 0xffffffff, 0);
console.log({ circleN, querySlots: [...heapI().subarray(slotsOff, slotsOff + 8)] });

const circleN6 = fn('overlap_circle')(worldId, 0, 0, 40, 1, 0xffffffff);
console.log({ circleN6, querySlots6: [...heapI().subarray(slotsOff, slotsOff + 8)] });

const allN = fn('cast_ray_all')(worldId, -80, 0, 160, 0, 1, 0xffffffff);
console.log({ allN, hits: [...heapF().subarray(hitsOff, hitsOff + stride * 4)] });

const closestN = fn('cast_ray_closest')(worldId, -80, 0, 160, 0, 1, 0xffffffff);
console.log({ closestN, closestHits: [...heapF().subarray(hitsOff, hitsOff + 4)] });
