/**
 * world_explode — two dynamic boxes must move apart after one step.
 * Not a speed claim.
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

const BODY_DYNAMIC = 1;
const CH_X = 0;
const CH_VX = 3;

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
  assert.ok(names.world_explode, 'world_explode export missing');
  assert.ok(names.create_body_box, 'create_body_box export missing');

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

  return { instance, memory, fn };
}

function makeWorld(fn, memory) {
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(fn('bind_game_buffers')(64), 'bind_game_buffers failed');
  fn('world_enable_sleeping')(worldId, 0);

  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const heapF = () => new Float32Array(memory.buffer);
  const bodyX = (slot) => heapF()[(stateByte >> 2) + CH_X * cap + slot];
  const bodyVx = (slot) => heapF()[(stateByte >> 2) + CH_VX * cap + slot];
  return { worldId, bodyX, bodyVx };
}

function createBox(fn, worldId, opts) {
  const o = {
    type: BODY_DYNAMIC,
    x: 0,
    y: 0,
    angle: 0,
    hx: 0.5,
    hy: 0.5,
    offsetX: 0,
    offsetY: 0,
    density: 1,
    friction: 0,
    restitution: 0,
    linearDamp: 0,
    angularDamp: 0,
    gravityScale: 0,
    vx: 0,
    vy: 0,
    angularVel: 0,
    isSensor: 0,
    enableHitEvents: 0,
    categoryBits: 1,
    maskBits: 0xffffffff,
    groupIndex: 0,
    fixedRotation: 0,
    entityIndex: -1,
    ...opts,
  };
  const slot = fn('create_body_box')(
    worldId,
    o.type,
    o.x,
    o.y,
    o.angle,
    o.hx,
    o.hy,
    o.offsetX,
    o.offsetY,
    o.density,
    o.friction,
    o.restitution,
    o.linearDamp,
    o.angularDamp,
    o.gravityScale,
    o.vx,
    o.vy,
    o.angularVel,
    o.isSensor,
    o.enableHitEvents,
    o.categoryBits,
    o.maskBits,
    o.groupIndex,
    o.fixedRotation,
    o.entityIndex,
  );
  assert.ok(slot >= 0, `create_body_box failed: ${slot}`);
  return slot;
}

test('world_explode pushes two dynamic boxes apart', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, bodyX, bodyVx } = makeWorld(fn, memory);

  const left = createBox(fn, worldId, { x: -4, y: 0, entityIndex: 0 });
  const right = createBox(fn, worldId, { x: 4, y: 0, entityIndex: 1 });
  const xL0 = bodyX(left);
  const xR0 = bodyX(right);

  // Same arg list as PhysicsWorld.explode: world, x, y, radius, falloff, impulse, mask, flags.
  fn('world_explode')(worldId, 0, 0, 20, 10, 12, 0xffffffff, 0);
  fn('step_world')(worldId, 1 / 60, 4);

  const xL1 = bodyX(left);
  const xR1 = bodyX(right);
  assert.ok(
    bodyVx(left) < -0.1 || xL1 < xL0 - 0.01,
    `left should be pushed −x (vx=${bodyVx(left)} x0=${xL0} x1=${xL1})`,
  );
  assert.ok(
    bodyVx(right) > 0.1 || xR1 > xR0 + 0.01,
    `right should be pushed +x (vx=${bodyVx(right)} x0=${xR0} x1=${xR1})`,
  );
});
