import test from 'node:test';
import assert from 'node:assert/strict';
import { instantiateBox2dWasm as instantiateShared } from '../helpers/box2dWasmInstance.mjs';

// N-142: LiquidFun moves particles to other indices (a compaction when particles die, a join's rotation) and its own
// buffers follow them, but the engine keeps a particle's tint, texture, scale and base alpha by index, painted once at
// creation: a particle that slid down took the statics of the one that was there. Each particle now carries its
// origin index (where it was at the last reset_particle_origins) through every reorder, with a flag that one happened,
// and the physics host moves the render statics by it (weedjsPost.js followLiquidFunReorder).

function world() {
  const w = instantiateShared(['create_world', 'create_particle_system']);
  w.fn('set_particle_sub_steps')(1);
  const worldId = w.fn('create_world')(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(w.fn('bind_game_buffers')(16), 'bind_game_buffers failed');
  assert.ok(w.fn('create_particle_system')(worldId, 10, 1.0, 4000), 'create_particle_system failed');
  return { ...w, worldId };
}

// create_particle_group_box(x0, y0, x1, y1, spacing, flags, strength, lifetimeMin, lifetimeMax, fade, viscousScale,
// trackGroup, groupFlags, vx, vy, omega, userData, color)
function box(w, x0, color, lifetime = 0) {
  return w.fn('create_particle_group_box')(x0, 0, x0 + 60, 60, 0, 0, 0.5, lifetime, lifetime, 0, 1, 1, 0, 0, 0, 0, 0, color);
}

function views(w) {
  const n = w.fn('get_particle_count')();
  const origin = new Int32Array(w.memory.buffer, w.fn('get_particle_origin_byte_offset')(), n);
  const color = new Uint32Array(w.memory.buffer, w.fn('get_particle_color_byte_offset')(), n);
  const x = new Float32Array(w.memory.buffer, w.fn('get_particle_x_byte_offset')(), n);
  const y = new Float32Array(w.memory.buffer, w.fn('get_particle_y_byte_offset')(), n);
  return { n, origin, color, x, y };
}

test('a compaction moves each survivor\'s origin with it, and says a reorder happened', () => {
  const w = world();
  assert.ok(box(w, 0, 0xffff0000, 0.1) >= 0, 'the red group (dies after 0.1 s)');
  const red = w.fn('get_particle_count')();
  assert.ok(box(w, 400, 0xff00ff00) >= 0, 'the green group');
  let v = views(w);
  const green = v.n - red;
  assert.ok(red > 10 && green > 10, `${red} red, ${green} green`);
  for (let i = 0; i < v.n; i++) assert.equal(v.origin[i], i, 'a new particle\'s origin is its own index');
  assert.equal(w.fn('particle_reordered')(), 0, 'creation is no reorder');
  for (let s = 0; s < 30; s++) w.fn('step_world')(w.worldId, 1 / 60, 4);
  v = views(w);
  assert.equal(v.n, green, 'the red group died');
  assert.equal(w.fn('particle_reordered')(), 1);
  for (let i = 0; i < v.n; i++) {
    assert.equal(v.origin[i], red + i, `particle ${i} came from ${red + i}`);
    assert.equal(v.color[i], 0xff00ff00, 'and is green');
  }
  w.fn('reset_particle_origins')();
  v = views(w);
  assert.equal(w.fn('particle_reordered')(), 0);
  for (let i = 0; i < v.n; i++) assert.equal(v.origin[i], i, 'the reset makes every origin its own index');
});

test('a join rotates the origins with the particles', () => {
  const w = world();
  const a = box(w, 0, 0xffff0000);
  const b = box(w, 400, 0xff00ff00);
  const between = box(w, 800, 0xff0000ff);
  assert.ok(a >= 0 && b >= 0 && between >= 0);
  let v = views(w);
  const before = Array.from({ length: v.n }, (_, i) => [v.x[i], v.y[i], v.color[i]]);
  // Joining the first and the third rotates the second out from between them.
  w.fn('join_particle_groups')(a, between);
  v = views(w);
  assert.equal(w.fn('particle_reordered')(), 1, 'a join is a reorder');
  let moved = 0;
  for (let i = 0; i < v.n; i++) {
    const o = v.origin[i];
    if (o !== i) moved++;
    assert.deepEqual([v.x[i], v.y[i], v.color[i]], before[o], `particle ${i} is the one that was at ${o}`);
  }
  assert.ok(moved > 10, `${moved} particles moved`);
});
