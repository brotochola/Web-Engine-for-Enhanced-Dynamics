/**
 * N-253 and N-310: Box2D's tables are sized for the scene at bind_game_buffers (box2d/src/wasm_wrapper.c in the
 * sibling repo), not fixed at 65 535 bodies and 4 096 joints. A body slot is an entity index (the pose, sleeping and
 * moved buffers are indexed by entity), so a scene binds a slot per entity, up to the engine's ceiling at 32-bit ids
 * (1 048 575); a scene past 65 535 entities lists its bodies for the acceleration batch in 32 bits
 * (bodies_apply_accelerations_u32), and a 16-bit scene keeps its 2-byte list. The joint table holds the scene's
 * physics.maxJoints. These run the shipped module and the shipped JS (physicsHostImpl.js, weedjsPost.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';

const BODY_DYNAMIC = 1;
const CH_X = 0;
const CH_VX = 3;
const CH_VY = 4;
const ENTITY_CEILING = 1048575;

function makeWorld(fn) {
  const worldId = fn('create_world')(0, 0, 1, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  return worldId;
}

function box(fn, worldId, entity, x) {
  return fn('create_body_box')(
    worldId, BODY_DYNAMIC, x, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0, entity,
  );
}

function stateChannel(fn, memory, channel, entity) {
  const f = new Float32Array(memory.buffer);
  return f[(fn('get_state_byte_offset')() >> 2) + channel * fn('get_body_capacity')() + entity];
}

test('Box2D binds a body slot per entity up to 1 048 575, and bodies past 65 535 move and export their pose', () => {
  // The tables take 78 bytes a slot (82 MB here): 192 MB of memory.
  const { memory, fn } = instantiateBox2dWasm(['get_max_body_slots', 'bind_game_buffers'], { pages: 3072 });
  assert.equal(fn('get_max_body_slots')(), ENTITY_CEILING);
  const worldId = makeWorld(fn);
  assert.equal(fn('bind_game_buffers')(ENTITY_CEILING + 1, 0), 0, 'one slot past the ceiling is refused');
  assert.equal(fn('bind_game_buffers')(ENTITY_CEILING, 0), 1);
  assert.equal(fn('get_body_capacity')(), ENTITY_CEILING);
  const entities = [0, 65535, 65536, 524288, ENTITY_CEILING - 1];
  entities.forEach((entity, k) => {
    assert.equal(box(fn, worldId, entity, k * 10), entity, `the body of entity ${entity} takes its slot`);
    fn('body_set_linear_velocity')(entity, 60, 0);
  });
  fn('step_world')(worldId, 1 / 60, 4);
  entities.forEach((entity, k) => {
    const x = stateChannel(fn, memory, CH_X, entity);
    assert.ok(Math.abs(x - (k * 10 + 1)) < 1e-3, `entity ${entity} moved 1 px: x ${x}`);
  });
});

test('a scene binds only its own count: the body tables follow the slots asked for', () => {
  const { fn } = instantiateBox2dWasm(['weedjs_heap_bytes_used']);
  const worldId = makeWorld(fn);
  assert.equal(fn('bind_game_buffers')(1000, 0), 1);
  const small = fn('weedjs_heap_bytes_used')() >>> 0;
  assert.equal(fn('bind_game_buffers')(101000, 0), 1);
  const large = fn('weedjs_heap_bytes_used')() >>> 0;
  // 100 000 more slots, 78 bytes each: the pose (32), meta (16), moved (4 + 1), sleeping (1), slot (20), free stack (4).
  const perSlot = (large - small) / 100000;
  assert.ok(perSlot > 77 && perSlot < 80, `${perSlot.toFixed(2)} bytes a slot`);
  assert.ok(worldId);
});

/** A world of `capacity` slots with dynamic boxes at `entities`, the RigidBody columns and the list in its memory. */
function accelerationRun(exportName, ListType, capacity, entities) {
  const { memory, fn } = instantiateBox2dWasm([exportName, 'malloc']);
  const worldId = makeWorld(fn);
  assert.equal(fn('bind_game_buffers')(capacity, 0), 1);
  fn('world_enable_sleeping')(worldId, 0);
  entities.forEach((entity, k) => assert.equal(box(fn, worldId, entity, k * 4), entity));
  const malloc = fn('malloc');
  const column = (Type) => {
    const view = new Type(memory.buffer, malloc(capacity * Type.BYTES_PER_ELEMENT), capacity);
    view.fill(0);
    return view;
  };
  const ax = column(Float32Array);
  const ay = column(Float32Array);
  const angularAccel = column(Float32Array);
  const mass = column(Float32Array);
  const inertia = column(Float32Array);
  const isStatic = column(Uint8Array);
  const fixedRotation = column(Uint8Array);
  const list = new ListType(memory.buffer, malloc(entities.length * ListType.BYTES_PER_ELEMENT), entities.length);
  entities.forEach((entity, k) => {
    list[k] = entity;
    ax[entity] = 3 + k;
    ay[entity] = -1.25;
    // The box's own mass (density 1, 1 x 1): the force, ax times this, moves it at ax.
    mass[entity] = 1;
  });
  fn(exportName)(
    list.byteOffset, entities.length, ax.byteOffset, ay.byteOffset, angularAccel.byteOffset, mass.byteOffset,
    inertia.byteOffset, isStatic.byteOffset, fixedRotation.byteOffset,
  );
  fn('step_world')(worldId, 1 / 60, 4);
  return entities.map((entity) => [stateChannel(fn, memory, CH_VX, entity), stateChannel(fn, memory, CH_VY, entity)]);
}

test('bodies_apply_accelerations_u32 gives the bodies of a 32-bit list what the 16-bit list gives, bit for bit', () => {
  const entities = [5, 1234, 65534];
  const u16 = accelerationRun('bodies_apply_accelerations', Uint16Array, 70000, entities);
  const u32 = accelerationRun('bodies_apply_accelerations_u32', Uint32Array, 70000, entities);
  assert.deepEqual(u32, u16);
  for (const [vx] of u16) assert.ok(vx > 0, 'the force was applied');
});

test('bodies_apply_accelerations_u32 reaches entities past 65 535', () => {
  const entities = [3, 65536, 69999];
  const velocities = accelerationRun('bodies_apply_accelerations_u32', Uint32Array, 70000, entities);
  entities.forEach((entity, k) => {
    const [vx, vy] = velocities[k];
    // ax (3 + k) for one step of 1/60 s.
    assert.ok(Math.abs(vx - (3 + k) / 60) < 1e-5, `entity ${entity}: vx ${vx}`);
    assert.ok(Math.abs(vy - -1.25 / 60) < 1e-5, `entity ${entity}: vy ${vy}`);
  });
});

test('the joint table holds the scene\'s maxJoints, past the old fixed 4 096 (N-310)', () => {
  const { fn } = instantiateBox2dWasm(['get_joint_capacity', 'create_revolute_joint', 'get_joint_region_bytes']);
  const worldId = makeWorld(fn);
  const JOINTS = 5000;
  const BODIES = 64;
  assert.equal(fn('bind_game_buffers')(BODIES, JOINTS), 1);
  assert.equal(fn('get_joint_capacity')(), JOINTS);
  assert.equal(fn('get_joint_region_bytes')(), JOINTS * 8 * 4);
  for (let i = 0; i < BODIES; i++) assert.equal(box(fn, worldId, i, i * 2), i);
  const revolute = (a, b) => fn('create_revolute_joint')(worldId, a, b, a * 2 + 1, 0, 0, 0, 0, 0, 0, 0);
  const handles = new Set();
  for (let j = 0; j < JOINTS; j++) {
    const a = j % (BODIES - 1);
    const handle = revolute(a, a + 1);
    assert.ok(handle >= 0, `joint ${j}: handle ${handle}`);
    handles.add(handle);
  }
  assert.equal(handles.size, JOINTS);
  assert.equal(revolute(0, 1), -2, 'the table is full at maxJoints');
  // The step exports every joint into the table's buffer.
  fn('step_world')(worldId, 1 / 60, 4);
  fn('destroy_joint')(4999);
  assert.equal(revolute(0, 1), 4999, 'a destroyed joint\'s handle is taken again');
});

test('a scene without joints binds a table of 0, and the wrapper refuses more joints than it takes', () => {
  const { fn } = instantiateBox2dWasm(['get_joint_capacity', 'create_revolute_joint']);
  const worldId = makeWorld(fn);
  assert.equal(fn('bind_game_buffers')(8, ENTITY_CEILING + 1), 0, 'past the most joints the wrapper takes');
  assert.equal(fn('bind_game_buffers')(8, -1), 0, 'a negative count');
  assert.equal(fn('bind_game_buffers')(8, 0), 1);
  assert.equal(fn('get_joint_capacity')(), 0);
  for (let i = 0; i < 2; i++) assert.equal(box(fn, worldId, i, i * 2), i);
  assert.equal(fn('create_revolute_joint')(worldId, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0), -2, 'no joint fits a table of 0');
  fn('step_world')(worldId, 1 / 60, 4);
});

test('a body created at its entity takes that slot, and a body without one never gets an active slot', () => {
  const { fn } = instantiateBox2dWasm();
  const worldId = makeWorld(fn);
  assert.equal(fn('bind_game_buffers')(8, 0), 1);
  for (let i = 0; i < 4; i++) assert.equal(box(fn, worldId, i, i * 2), i);
  fn('destroy_body')(1);
  fn('destroy_body')(2);
  // Entity 2 gets a body again while its slot is still in the free stack.
  assert.equal(box(fn, worldId, 2, 4), 2);
  assert.equal(box(fn, worldId, 2, 4), -1, 'an active slot is not claimed twice');
  // Without an entity: the free stack's 2 is active again and skipped, 1 is free, then the next unused slot.
  assert.equal(box(fn, worldId, -1, 20), 1);
  assert.equal(box(fn, worldId, -1, 22), 4);
  fn('destroy_body')(2);
  fn('destroy_body')(2);
  assert.equal(box(fn, worldId, -1, 24), 2, 'a slot freed again after it was skipped');
  assert.equal(box(fn, worldId, -1, 26), 5, 'and only once');
});

// physicsHostImpl.js's own check, run as shipped.
const host = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
const capStart = host.indexOf('// physics-capacity-start');
const capEnd = host.indexOf('// physics-capacity-end');
assert.ok(capStart > 0 && capEnd > capStart, 'the physics-capacity block is missing in physicsHostImpl.js');
const physicsCapacityError = new Function(`${host.slice(capStart, capEnd)}\nreturn physicsCapacityError;`)();

test('the physics host boots any entity count Box2D holds, and names the counts when it does not', () => {
  assert.equal(physicsCapacityError(130000, ENTITY_CEILING, 0), '');
  assert.equal(physicsCapacityError(ENTITY_CEILING, ENTITY_CEILING, 4096), '');
  assert.equal(physicsCapacityError(1000, ENTITY_CEILING, 65535), '');
  const tooMany = physicsCapacityError(ENTITY_CEILING + 1, ENTITY_CEILING, 0);
  assert.match(tooMany, /the scene has 1048576 entities, and Box2D holds 1048575 at most/);
  const tooManyJoints = physicsCapacityError(1000, ENTITY_CEILING, 65536);
  assert.match(tooManyJoints, /physics\.maxJoints is 65536, and 65535 is the most/);
  assert.doesNotMatch(host, /MAX_BODIES_HINT/);
});

// weedjsPost.js's dense list (the acceleration list), run as shipped against the module.
const post = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');
const listStart = post.indexOf('  function aliasesHeap(');
const listEnd = post.indexOf('// dense-list-end');
assert.ok(listStart > 0 && listEnd > listStart, 'the dense-list block is missing in weedjsPost.js');
const loadDenseList = new Function('env', `
  const { Module, views } = env;
  let applyAccelerationsFn = null;
  let denseListPtr = 0;
  const accelBytes = new Int32Array(8);
  ${post.slice(listStart, listEnd)}
  return { allocDenseList, current: () => ({ applyAccelerationsFn, accelBytes, denseListPtr }) };
`);

test('the dense list is 16-bit up to 65 535 entities and 32-bit past it, each with its batch export', () => {
  const capacity = 70000;
  const { memory, fn } = instantiateBox2dWasm(['bodies_apply_accelerations_u32', 'malloc', 'free']);
  const worldId = makeWorld(fn);
  assert.equal(fn('bind_game_buffers')(capacity, 0), 1);
  fn('world_enable_sleeping')(worldId, 0);
  const malloc = fn('malloc');
  const column = (Type) => {
    const view = new Type(memory.buffer, malloc(capacity * Type.BYTES_PER_ELEMENT), capacity);
    view.fill(0);
    return view;
  };
  const views = {
    ax: column(Float32Array),
    ay: column(Float32Array),
    angularAccel: column(Float32Array),
    mass: column(Float32Array),
    inertia: column(Float32Array),
    rbStatic: column(Uint8Array),
    fixedRotation: column(Uint8Array),
  };
  const Module = {
    HEAPF32: new Float32Array(memory.buffer),
    _malloc: malloc,
    _free: fn('free'),
    _bodies_apply_accelerations: fn('bodies_apply_accelerations'),
    _bodies_apply_accelerations_u32: fn('bodies_apply_accelerations_u32'),
  };
  const { allocDenseList, current } = loadDenseList({ Module, views });

  const narrow = allocDenseList(65535);
  assert.ok(narrow instanceof Uint16Array, '65 535 entities: a 2-byte list');
  assert.equal(narrow.buffer, memory.buffer, 'in Box2D\'s memory');
  assert.equal(current().applyAccelerationsFn, Module._bodies_apply_accelerations);

  const wide = allocDenseList(capacity);
  assert.ok(wide instanceof Uint32Array, '70 000 entities: a 4-byte list');
  assert.equal(wide.length, capacity);
  assert.equal(wide.buffer, memory.buffer);
  assert.equal(current().applyAccelerationsFn, Module._bodies_apply_accelerations_u32);

  const entity = capacity - 1;
  assert.equal(box(fn, worldId, entity, 0), entity);
  wide[0] = entity;
  views.ax[entity] = 6;
  views.mass[entity] = 1;
  const b = current().accelBytes;
  current().applyAccelerationsFn(b[0], 1, b[1], b[2], b[3], b[4], b[5], b[6], b[7]);
  fn('step_world')(worldId, 1 / 60, 4);
  const vx = stateChannel(fn, memory, CH_VX, entity);
  assert.ok(Math.abs(vx - 6 / 60) < 1e-5, `entity ${entity}: vx ${vx}`);
});
