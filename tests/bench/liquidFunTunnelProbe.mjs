#!/usr/bin/env node
/**
 * N-18 probe: does LiquidFun water get inside the planet's static terrain?
 *
 * The planet demo's WorldGrid disk is meshed by the same calls the terrain
 * manager makes (chunksOverlapping -> extractIslands -> buildContourFixtures),
 * one static body per island like TerrainIsland, in the shipped Box2D WASM.
 * A slab of water is poured over the north pole and pulled to the core every
 * step like PlanetPull (force = dir * G * 4r^2). The probe counts particles
 * that end up well inside solid terrain (all four grid nodes around them
 * solid), for a polygon skin of 0 and 1 px.
 *
 * Result on 2026-10-21 (2948 particles, 1200 steps, 310 islands, 2618 fixtures):
 *
 *   drop above the pole   skin 0   skin 1
 *   0 px                     0        0
 *   250 px                   0        0
 *   500 px                   0        3   (at most 15 px deep)
 *   1000 px                  0        8   (42 px)
 *   1500 px                  0       13   (42 px)
 *
 * The planet meshes with skin 0: no water gets in. The 2026-10-20 table (up to
 * 142 particles, down to the core) came from this probe binding 64 body slots
 * for 310 islands: create_body returned -1 for 246 of them, and their shapes
 * were never made (N-18, closed).
 *
 *   node --expose-gc tests/bench/liquidFunTunnelProbe.mjs
 *   DROP=1000 STEPS=1200 node --expose-gc tests/bench/liquidFunTunnelProbe.mjs
 */
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';
import { WorldGrid, TUNE, ISO } from '../../demos/destructibleTerrainScene/worldGrid.js';
import { N, CELL, RADIUS, CX, CY, G, PARTICLE_R, PARTICLE_MASS } from '../../demos/planetPhysicsScene/planetGravity.js';

const STEPS = Number(process.env.STEPS || 1200);
const DROP = Number(process.env.DROP || 0);
const SKINS = (process.env.SKINS || '0,1').split(',').map(Number);

WorldGrid.attach(N, N, CELL);
WorldGrid.anchorX = N >> 1;
WorldGrid.anchorY = N >> 1;
WorldGrid.bedrock = 4;
WorldGrid.seedDisk(N >> 1, N >> 1, RADIUS);
const poleY = (N >> 1) - RADIUS;
const shards = WorldGrid.chunksOverlapping({ minX: 0, minY: 0, maxX: N - 1, maxY: N - 1 });
const islands = [];
for (const shard of shards) {
  for (const island of WorldGrid.extractIslands(shard, { clip: true })) {
    const built = WorldGrid.buildContourFixtures(island, WorldGrid.tuneGet(TUNE.SIMPLIFY_TOL));
    if (built.polys && built.polys.length) islands.push(built.polys.map((p) => p.map((v) => ({ x: v.x, y: v.y }))));
  }
}

function solidAt(x, y) {
  const gx = Math.floor(x / CELL);
  const gy = Math.floor(y / CELL);
  for (let oy = 0; oy < 2; oy++) {
    for (let ox = 0; ox < 2; ox++) {
      if (!(WorldGrid.amount[(gy + oy) * N + (gx + ox)] >= ISO)) return false;
    }
  }
  return true;
}

function run(skin) {
  const { memory, fn } = instantiateBox2dWasm(['create_particle_box', 'particle_apply_force']);
  // Engine units: 100 px per meter; world gravity off, the pull is per particle.
  const worldId = fn('create_world')(0, 0, 100, 30, 0.7, 1000, 50000, 1);
  // One body per island: with 64 slots (the old value) create_body returned -1
  // for 246 of 310 islands, and water fell through rock that had no shapes.
  fn('bind_game_buffers')(islands.length + 8);
  fn('set_particle_sub_steps')(2);
  const ptr = fn('malloc')(64);
  const heap = new Float32Array(memory.buffer, ptr, 16);
  let fixtures = 0;
  for (const polys of islands) {
    const slot = fn('create_body')(worldId, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1);
    if (slot < 0) throw new Error('create_body: no slot left for an island');
    for (const p of polys) {
      for (let v = 0; v < p.length; v++) {
        heap[2 * v] = p[v].x;
        heap[2 * v + 1] = p[v].y;
      }
      fn('body_add_shape_polygon')(slot, ptr, p.length, 0, 0, skin);
      fixtures++;
    }
  }
  if (!fn('create_particle_system')(worldId, PARTICLE_R, 1.0, 4000, 0)) throw new Error('no particle system');
  const sy = poleY * CELL;
  fn('create_particle_box')(CX - 300, sy - 420 - DROP, CX + 300, sy - 30 - DROP, 0, 0);
  const xs = fn('get_particle_x_byte_offset')() >> 2;
  const ys = fn('get_particle_y_byte_offset')() >> 2;
  const apply = fn('particle_apply_force');
  for (let s = 0; s < STEPS; s++) {
    const n = fn('get_particle_count')();
    const h = new Float32Array(memory.buffer);
    for (let i = 0; i < n; i++) {
      const dx = CX - h[xs + i];
      const dy = CY - h[ys + i];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      apply(i, (dx / len) * G * PARTICLE_MASS, (dy / len) * G * PARTICLE_MASS);
    }
    fn('step_world')(worldId, 1 / 60, 4);
  }
  const n = fn('get_particle_count')();
  const h = new Float32Array(memory.buffer);
  let inside = 0;
  let deepest = 0;
  for (let i = 0; i < n; i++) {
    const x = h[xs + i];
    const y = h[ys + i];
    if (solidAt(x, y)) inside++;
    const dx = x - CX;
    const dy = y - CY;
    const depth = RADIUS * CELL - Math.sqrt(dx * dx + dy * dy);
    if (depth > deepest) deepest = depth;
  }
  return { skin, drop: DROP, islands: islands.length, fixtures, particles: n, inside, deepestPx: +deepest.toFixed(1) };
}

for (const skin of SKINS) console.log(JSON.stringify(run(skin)));
