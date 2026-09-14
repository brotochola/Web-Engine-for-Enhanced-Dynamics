/**
 * RigidBody / Collider composition — Box2D WASM correctness.
 *
 * - Shapeless dynamic body moves, generates zero contacts against a wall.
 * - Static body + shape (Collider-only stand-in) blocks a dynamic box; wall x unchanged.
 * - body_add_shape_* after create_body starts contacts; body_clear_shapes stops them.
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
const BODY_DYNAMIC = 1;
const CONTACT_BEGIN_HEADER = 2;

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
  assert.ok(names.create_world, 'create_world export map missing — rebuild box2d_wasm.js');
  assert.ok(names.create_body, 'create_body export missing — rebuild after shapeless body patch');
  assert.ok(names.body_add_shape_box, 'body_add_shape_box export missing');
  assert.ok(names.body_clear_shapes, 'body_clear_shapes export missing');

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
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const worldEnableSleeping = fn('world_enable_sleeping');
  // Zero gravity — velocity tests stay deterministic.
  const worldId = createWorld(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(64), 'bind_game_buffers failed');
  worldEnableSleeping(worldId, 0);

  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const headerByte = fn('get_event_header_byte_offset')();
  const heapF = () => new Float32Array(memory.buffer);
  const heapI = () => new Int32Array(memory.buffer);

  const bodyX = (slot) => heapF()[(stateByte >> 2) + 0 * cap + slot];
  const bodyY = (slot) => heapF()[(stateByte >> 2) + 1 * cap + slot];
  const contactBeginCount = () => heapI()[(headerByte >> 2) + CONTACT_BEGIN_HEADER];

  return { worldId, bodyX, bodyY, contactBeginCount, cap };
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
    friction: 0.3,
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

function createShapeless(fn, worldId, opts) {
  const o = {
    type: BODY_DYNAMIC,
    x: 0,
    y: 0,
    angle: 0,
    linearDamp: 0,
    angularDamp: 0,
    gravityScale: 0,
    vx: 0,
    vy: 0,
    angularVel: 0,
    fixedRotation: 0,
    entityIndex: -1,
    ...opts,
  };
  const slot = fn('create_body')(
    worldId,
    o.type,
    o.x,
    o.y,
    o.angle,
    o.linearDamp,
    o.angularDamp,
    o.gravityScale,
    o.vx,
    o.vy,
    o.angularVel,
    o.fixedRotation,
    o.entityIndex,
  );
  assert.ok(slot >= 0, `create_body failed: ${slot}`);
  return slot;
}

test('exports: create_body / body_add_shape_* / body_clear_shapes present', () => {
  const { fn } = instantiateBox2dWasm();
  assert.equal(typeof fn('create_body'), 'function');
  assert.equal(typeof fn('body_add_shape_box'), 'function');
  assert.equal(typeof fn('body_add_shape_circle'), 'function');
  assert.equal(typeof fn('body_clear_shapes'), 'function');
});

test('RB-only shapeless body moves and generates zero contacts vs wall', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, bodyX, contactBeginCount } = makeWorld(fn, memory);
  const stepWorld = fn('step_world');

  // Tall static wall at x=50.
  createBox(fn, worldId, {
    type: BODY_STATIC,
    x: 50,
    y: 0,
    hx: 1,
    hy: 20,
    entityIndex: 0,
  });

  const ghost = createShapeless(fn, worldId, {
    x: 0,
    y: 0,
    vx: 100,
    entityIndex: 1,
  });

  const x0 = bodyX(ghost);
  let contacts = 0;
  for (let i = 0; i < 60; i++) {
    stepWorld(worldId, 1 / 60, 4);
    contacts += contactBeginCount();
  }
  const x1 = bodyX(ghost);

  assert.ok(x1 > x0 + 50, `shapeless body should travel far (x0=${x0} x1=${x1})`);
  assert.ok(x1 > 50, `shapeless body should pass through wall (x1=${x1})`);
  assert.equal(contacts, 0, `expected zero contact begins, got ${contacts}`);
});

test('Col-only static wall blocks dynamic box and does not move', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, bodyX, contactBeginCount } = makeWorld(fn, memory);
  const stepWorld = fn('step_world');

  // Collider-only stand-in: static body + shape.
  const wall = createBox(fn, worldId, {
    type: BODY_STATIC,
    x: 10,
    y: 0,
    hx: 1,
    hy: 5,
    entityIndex: 0,
  });
  const ball = createBox(fn, worldId, {
    type: BODY_DYNAMIC,
    x: 0,
    y: 0,
    hx: 0.5,
    hy: 0.5,
    vx: 40,
    restitution: 0,
    entityIndex: 1,
  });

  const wallX0 = bodyX(wall);
  let contacts = 0;
  for (let i = 0; i < 90; i++) {
    stepWorld(worldId, 1 / 60, 4);
    contacts += contactBeginCount();
  }

  assert.ok(contacts > 0, 'dynamic box should contact the static wall');
  assert.ok(Math.abs(bodyX(wall) - wallX0) < 1e-3, 'static wall must not move');
  assert.ok(bodyX(ball) < 10, `ball should not pass through wall (x=${bodyX(ball)})`);
});

test('attach shape to shapeless body starts contacts; clearShapes stops them', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const { worldId, bodyX, contactBeginCount } = makeWorld(fn, memory);
  const stepWorld = fn('step_world');
  const addShape = fn('body_add_shape_box');
  const clearShapes = fn('body_clear_shapes');
  const setVel = fn('body_set_linear_velocity');

  createBox(fn, worldId, {
    type: BODY_STATIC,
    x: 8,
    y: 0,
    hx: 1,
    hy: 5,
    entityIndex: 0,
  });

  const ghost = createShapeless(fn, worldId, {
    x: 0,
    y: 0,
    vx: 50,
    entityIndex: 1,
  });

  // Phase 1: shapeless — fly through.
  let contacts = 0;
  for (let i = 0; i < 30; i++) {
    stepWorld(worldId, 1 / 60, 4);
    contacts += contactBeginCount();
  }
  assert.equal(contacts, 0, 'pre-attach contacts must be zero');
  assert.ok(bodyX(ghost) > 8, `should pass wall before attach (x=${bodyX(ghost)})`);

  // Reset left of wall and attach a box shape.
  fn('body_set_transform')(ghost, 0, 0, 1, 0);
  setVel(ghost, 50, 0);
  addShape(ghost, 0.5, 0.5, 0, 0);

  contacts = 0;
  for (let i = 0; i < 90; i++) {
    stepWorld(worldId, 1 / 60, 4);
    contacts += contactBeginCount();
  }
  assert.ok(contacts > 0, 'after add_shape should contact wall');
  assert.ok(bodyX(ghost) < 8.5, `should not fully pass wall after attach (x=${bodyX(ghost)})`);

  // Detach shapes, push again — should pass through.
  clearShapes(ghost);
  fn('body_set_transform')(ghost, 0, 0, 1, 0);
  setVel(ghost, 50, 0);
  contacts = 0;
  for (let i = 0; i < 30; i++) {
    stepWorld(worldId, 1 / 60, 4);
    contacts += contactBeginCount();
  }
  assert.equal(contacts, 0, 'after clear_shapes contacts must be zero');
  assert.ok(bodyX(ghost) > 8, `should pass wall after clear (x=${bodyX(ghost)})`);
});
