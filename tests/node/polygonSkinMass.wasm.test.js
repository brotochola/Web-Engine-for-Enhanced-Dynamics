/**
 * B20. The physics host sets density = RigidBody.mass / area. With a polygon
 * skin (Collider.radius on a polygon) Box2D weighs more than the hull, so the
 * host's area must be the one Box2D uses. Measured here in the shipped WASM:
 * same density, known impulse, mass = impulse / velocity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
const post = fs.readFileSync(path.join(BOX2D_DIR, 'weedjsPost.js'), 'utf8');

function loadPolygonMassArea() {
  const start = post.indexOf('// polygon-mass-area-start');
  const end = post.indexOf('// polygon-mass-area-end');
  assert.ok(start >= 0 && end > start, 'polygon mass area block missing in weedjsPost.js');
  return new Function(`${post.slice(start, end)}\nreturn polygonMassArea;`)();
}

function instantiateBox2dWasm() {
  const wasmBuffer = fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.wasm'));
  const jsSource = fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.js'), 'utf8');
  const names = Object.create(null);
  for (const m of jsSource.matchAll(/Module\["_(\w+)"\]\s*=\s*wasmExports\["([^"]+)"\]/g)) names[m[1]] = m[2];
  const wasmModule = new WebAssembly.Module(wasmBuffer);
  let memory = null;
  const imports = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'memory') {
      memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
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
  return { memory, fn: (n) => instance.exports[names[n]] };
}

const POLYS = {
  square: [-5, -5, 5, -5, 5, 5, -5, 5],
  triangle: [0, 0, 30, 0, 0, 20],
  triangleCW: [0, 0, 0, 20, 30, 0],
  hexagon: Array.from({ length: 12 }, (_, k) => {
    const a = (Math.floor(k / 2) * Math.PI) / 3;
    return k % 2 === 0 ? 15 * Math.cos(a) : 15 * Math.sin(a);
  }),
  collinear: [0, 0, 10, 0, 20, 0, 20, 20, 0, 20],
  sliver: [0, 0, 40, 0, 40, 3, 0, 3],
};
const SKINS = [0, 0.5, 1, 2.5, 6];

test('the host weighs a skinned polygon by the area Box2D uses', () => {
  const polygonMassArea = loadPolygonMassArea();
  const { memory, fn } = instantiateBox2dWasm();
  const worldId = fn('create_world')(0, 0, 1, 30, 10, 3, 1e6, 1);
  assert.ok(fn('bind_game_buffers')(128));
  const ptr = fn('malloc')(16 * 4);
  const heap = new Float32Array(memory.buffer, ptr, 16);

  const cases = [];
  let x = 0;
  for (const [name, verts] of Object.entries(POLYS)) {
    for (const r of SKINS) {
      x += 2000;
      const slot = fn('create_body')(worldId, 1, x, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1);
      heap.fill(0);
      heap.set(verts);
      fn('body_add_shape_polygon')(slot, ptr, verts.length / 2, 0, 0, r);
      fn('body_set_density')(slot, 1);
      fn('body_apply_linear_impulse_center')(slot, 1000, 0, 1);
      cases.push({ name, r, slot, verts });
    }
  }
  fn('step_world')(worldId, 1 / 60, 1);
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  const f32 = new Float32Array(memory.buffer);

  for (const c of cases) {
    const vx = f32[(stateByte >> 2) + 3 * cap + c.slot];
    const measured = 1000 / vx;
    const xs = new Float32Array(8);
    const ys = new Float32Array(8);
    for (let k = 0; k < c.verts.length / 2; k++) {
      xs[k] = c.verts[k * 2];
      ys[k] = c.verts[k * 2 + 1];
    }
    const host = polygonMassArea(xs, ys, 0, c.verts.length / 2, c.r);
    assert.ok(
      Math.abs(host - measured) <= measured * 2e-3,
      `${c.name} r=${c.r}: host area ${host.toFixed(3)} vs Box2D mass ${measured.toFixed(3)}`,
    );
  }
  fn('free')(ptr);
});

test('density uses the skin-aware area for single and compound polygons', () => {
  const body = post.slice(post.indexOf('function densityForEntity'), post.indexOf('function createBodyForEntity'));
  assert.match(body, /const skin = polygonSkin\(i\);/);
  assert.match(body, /fixtureAreaSum\(i, skin\)/);
  assert.match(body, /polygonMassArea\([\s\S]*skin,\s*\)/);
  const sum = post.slice(post.indexOf('function fixtureAreaSum'), post.indexOf('function ensurePolygonVertexScratch'));
  assert.match(sum, /polygonMassArea\(F\.vertexX, F\.vertexY, cur \* MAX_POLY_VERTS, count, skin\)/);
});
