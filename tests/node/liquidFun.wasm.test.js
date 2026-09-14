import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
const WASM_PATH = path.join(BOX2D_DIR, 'box2d_wasm.wasm');
const JS_PATH = path.join(BOX2D_DIR, 'box2d_wasm.js');

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
  assert.ok(names.create_particle_system, 'create_particle_system export map missing');

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
      // box2d_wasm.js wasmImports: a.b = _emscripten_get_now (LTO minified).
      // Stubbed 0 makes LF step timer always report 0 ms.
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

  // Demo uses subSteps=1. Wrapper default is 2; that 4× critical pressure sprays puddles off the floor.
  fn('set_particle_sub_steps')(1);

  return { instance, memory, fn };
}

test('WASM LiquidFun groups create and rest on a static box (Y-down pixels)', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createBodyBox = fn('create_body_box');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const createParticleGroupBox = fn('create_particle_group_box');
  const getParticleCount = fn('get_particle_count');
  const getParticleXByteOffset = fn('get_particle_x_byte_offset');
  const getParticleYByteOffset = fn('get_particle_y_byte_offset');
  const stepWorld = fn('step_world');

  // Weed pixel world: Y+ down, 100 px/m, g = 9.8 * 100
  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');

  // Static floor at y=400, half-height 130 → top at 270. Wide so the puddle cannot walk off the ends.
  const floorSlot = createBodyBox(
    worldId,
    0, // static
    0, 400, 0,
    2000, 130,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 0,
  );
  assert.ok(floorSlot >= 0, `create_body_box failed: ${floorSlot}`);

  const sysOk = createParticleSystem(worldId, 10, 1.0, 500);
  assert.ok(sysOk, 'create_particle_system failed');

  const circle0 = createParticleGroupCircle(0, 80, 40, 0, 0, 0.5, 0, 0, 0, 1, 1);
  assert.ok(circle0 >= 0, `first circle group failed: ${circle0}`);
  const circle1 = createParticleGroupCircle(80, 80, 30, 0, 0, 0.5, 0, 0, 0, 1, 1);
  assert.ok(circle1 >= 0, `second circle group failed: ${circle1}`);
  const boxGrp = createParticleGroupBox(-40, 40, 40, 100, 0, 0, 0.5, 0, 0, 0, 1, 1);
  assert.ok(boxGrp >= 0, `box group failed: ${boxGrp}`);

  const count = getParticleCount();
  assert.ok(count > 8, `expected a blob of particles, got ${count}`);

  const dt = 1 / 60;
  for (let i = 0; i < 180; i++) {
    stepWorld(worldId, dt, 4);
  }

  const heap = new Float32Array(memory.buffer);
  const xBase = getParticleXByteOffset() >> 2;
  const yBase = getParticleYByteOffset() >> 2;
  assert.ok(xBase > 0 && yBase > 0, 'particle x/y SoA buffers missing');
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = heap[xBase + i];
    const y = heap[yBase + i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const floorTop = 270;
  assert.ok(
    maxY < floorTop + 40,
    `particles fell through floor: maxY=${maxY} floorTop=${floorTop}`,
  );
  assert.ok(
    maxY > floorTop - 80,
    `particles never reached the floor (gravity/step dead?): maxY=${maxY} floorTop=${floorTop}`,
  );
  assert.ok(minY > -200, `particles escaped upward unexpectedly: minY=${minY}`);
  // Point particles pancake on the plane; Google 1.1.0 has no disk stack. Check spread in X.
  assert.ok(
    maxX - minX > 80,
    `puddle did not spread: spanX=${maxX - minX} minX=${minX} maxX=${maxX}`,
  );
  assert.equal(getParticleCount(), count);
});

test('WASM water blob does not climb a vertical static wall', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createBodyBox = fn('create_body_box');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const getParticleCount = fn('get_particle_count');
  const getParticleXByteOffset = fn('get_particle_x_byte_offset');
  const getParticleYByteOffset = fn('get_particle_y_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');

  // Floor top at y=270. Wall right face at x=130. Wide floor so the puddle stays on it.
  const floorSlot = createBodyBox(
    worldId,
    0, // static
    0, 400, 0,
    2000, 130,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 0,
  );
  const wallSlot = createBodyBox(
    worldId,
    0,
    0, 200, 0,
    130, 200,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 1,
  );
  assert.ok(floorSlot >= 0, `floor failed: ${floorSlot}`);
  assert.ok(wallSlot >= 0, `wall failed: ${wallSlot}`);

  const sysOk = createParticleSystem(worldId, 10, 1.0, 800);
  assert.ok(sysOk, 'create_particle_system failed');

  const gid = createParticleGroupCircle(155, 200, 50, 0, 0, 0, 0, 0, 0, 1, 1);
  assert.ok(gid >= 0, `circle group failed: ${gid}`);
  const count = getParticleCount();
  assert.ok(count > 8, `expected a blob, got ${count}`);

  const dt = 1 / 60;
  for (let i = 0; i < 180; i++) {
    stepWorld(worldId, dt, 4);
  }

  const heap = new Float32Array(memory.buffer);
  const xBase = getParticleXByteOffset() >> 2;
  const yBase = getParticleYByteOffset() >> 2;
  assert.ok(xBase > 0 && yBase > 0, 'particle x/y SoA buffers missing');
  const wallFace = 130;
  const nearWall = wallFace + 60;
  let puddleMinY = Infinity;
  let puddleMaxY = -Infinity;
  let wallMinY = Infinity;
  let wallMaxY = -Infinity;
  let wallN = 0;
  for (let i = 0; i < count; i++) {
    const x = heap[xBase + i];
    const y = heap[yBase + i];
    if (y < puddleMinY) puddleMinY = y;
    if (y > puddleMaxY) puddleMaxY = y;
    if (x < nearWall) {
      wallN++;
      if (y < wallMinY) wallMinY = y;
      if (y > wallMaxY) wallMaxY = y;
    }
  }

  assert.ok(wallN > 0, 'no particles settled against the wall');
  assert.ok(
    wallMinY > puddleMinY - 50,
    `wall column climbed: wallMinY=${wallMinY} puddleMinY=${puddleMinY}`,
  );
  const wallSpan = wallMaxY - wallMinY;
  const puddleSpan = puddleMaxY - puddleMinY;
  assert.ok(
    wallSpan < puddleSpan + 40,
    `tall 1-wide wall column: wallSpan=${wallSpan} puddleSpan=${puddleSpan} wallN=${wallN}`,
  );
  assert.ok(
    puddleMaxY < 270 + 40,
    `particles fell through floor: maxY=${puddleMaxY}`,
  );

  const wallX0 = -128;
  const wallX1 = 128;
  const wallY0 = 2;
  const wallY1 = 398;
  let insideWall = 0;
  for (let i = 0; i < count; i++) {
    const x = heap[xBase + i];
    const y = heap[yBase + i];
    if (x > wallX0 && x < wallX1 && y > wallY0 && y < wallY1) insideWall++;
  }
  assert.equal(insideWall, 0, `particle centers inside wall box: ${insideWall}`);
});

test('WASM water beside a thick static box stays outside (max pen < radius)', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createBodyBox = fn('create_body_box');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const getParticleCount = fn('get_particle_count');
  const getParticleXByteOffset = fn('get_particle_x_byte_offset');
  const getParticleYByteOffset = fn('get_particle_y_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');

  const radius = 10;
  const floorSlot = createBodyBox(
    worldId,
    0,
    0, 400, 0,
    400, 30,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 0,
  );
  const boxSlot = createBodyBox(
    worldId,
    0,
    200, 280, 0,
    80, 80,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 1,
  );
  assert.ok(floorSlot >= 0, `floor failed: ${floorSlot}`);
  assert.ok(boxSlot >= 0, `box failed: ${boxSlot}`);

  assert.ok(createParticleSystem(worldId, radius, 1.0, 800), 'create_particle_system failed');
  const gid = createParticleGroupCircle(400, 220, 40, 0, 0, 0, 0, 0, 0, 1, 1);
  assert.ok(gid >= 0, `circle group failed: ${gid}`);
  const count = getParticleCount();
  assert.ok(count > 8, `expected a blob, got ${count}`);

  const dt = 1 / 60;
  for (let i = 0; i < 180; i++) {
    stepWorld(worldId, dt, 4);
  }

  const heap = new Float32Array(memory.buffer);
  const xBase = getParticleXByteOffset() >> 2;
  const yBase = getParticleYByteOffset() >> 2;
  assert.ok(xBase > 0 && yBase > 0, 'particle x/y SoA buffers missing');
  const x0 = 120;
  const x1 = 280;
  const y0 = 200;
  const y1 = 360;
  let maxPen = 0;
  for (let i = 0; i < count; i++) {
    const x = heap[xBase + i];
    const y = heap[yBase + i];
    if (x <= x0 || x >= x1 || y <= y0 || y >= y1) continue;
    const pen = Math.min(x - x0, x1 - x, y - y0, y1 - y);
    if (pen > maxPen) maxPen = pen;
  }
  assert.ok(
    maxPen < radius,
    `centers tunneled into thick box: maxPen=${maxPen} radius=${radius}`,
  );
});

test('WASM particle spawned inside a thick static box exits the nearest face', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createBodyBox = fn('create_body_box');
  const createParticleSystem = fn('create_particle_system');
  const createParticleBox = fn('create_particle_box');
  const getParticleCount = fn('get_particle_count');
  const getParticleXByteOffset = fn('get_particle_x_byte_offset');
  const getParticleYByteOffset = fn('get_particle_y_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');

  // Box x=[-130,130], y=[0,800]. Center spawn is 130px from left/right, 400px from top/bottom.
  const boxSlot = createBodyBox(
    worldId,
    0,
    0, 400, 0,
    130, 400,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 1,
  );
  assert.ok(boxSlot >= 0, `box failed: ${boxSlot}`);
  assert.ok(createParticleSystem(worldId, 10, 1.0, 64), 'create_particle_system failed');

  const n = createParticleBox(0, 400, 0, 400, 20, 0);
  assert.equal(n, 1, `expected 1 particle, got ${n}`);
  assert.equal(getParticleCount(), 1);

  const dt = 1 / 60;
  for (let i = 0; i < 90; i++) {
    stepWorld(worldId, dt, 4);
  }

  const heap = new Float32Array(memory.buffer);
  const xBase = getParticleXByteOffset() >> 2;
  const yBase = getParticleYByteOffset() >> 2;
  assert.ok(xBase > 0 && yBase > 0, 'particle x/y SoA buffers missing');
  const x = heap[xBase];
  const y = heap[yBase];
  const inside = x > -128 && x < 128 && y > 2 && y < 798;
  assert.ok(!inside, `still trapped inside box: x=${x} y=${y}`);
  assert.ok(y > 80, `exited through the top instead of nearest face: x=${x} y=${y}`);
  assert.ok(
    x < -100 || x > 100,
    `did not leave through a vertical face: x=${x} y=${y}`,
  );
});

test('WASM 3k water smoke: create and step without losing particles', () => {
  // Stay under LF_CONTACT_PARALLEL_MIN (4096): Node stubs pthreads so the
  // parallel FindContacts path would deadlock waiting for workers that never run.
  const { fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const getParticleCount = fn('get_particle_count');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');
  assert.ok(createParticleSystem(worldId, 4, 1.0, 4000), 'create_particle_system failed');

  const gid = createParticleGroupBox(-180, -180, 180, 180, 0, 0, 0, 0, 0, 0, 1, 1);
  assert.ok(gid >= 0, `box group failed: ${gid}`);
  const count = getParticleCount();
  assert.ok(count >= 2500 && count < 4096, `expected ~3k water under parallel min, got ${count}`);

  const dt = 1 / 60;
  for (let i = 0; i < 10; i++) {
    stepWorld(worldId, dt, 1);
  }
  assert.equal(getParticleCount(), count);
});

test('WASM one water particle settles on a static floor (no 600 px/s bounce)', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createBodyBox = fn('create_body_box');
  const createParticleSystem = fn('create_particle_system');
  const createParticleBox = fn('create_particle_box');
  const getParticleCount = fn('get_particle_count');
  const getParticleXByteOffset = fn('get_particle_x_byte_offset');
  const getParticleYByteOffset = fn('get_particle_y_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');

  const radius = 10;
  const floorSlot = createBodyBox(
    worldId,
    0,
    0, 400, 0,
    400, 130,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 0,
  );
  assert.ok(floorSlot >= 0, `create_body_box failed: ${floorSlot}`);
  assert.ok(createParticleSystem(worldId, radius, 1.0, 64), 'create_particle_system failed');

  const n = createParticleBox(0, 200, 0, 200, 20, 0);
  assert.equal(n, 1, `expected 1 particle, got ${n}`);
  assert.equal(getParticleCount(), 1);

  const dt = 1 / 60;
  for (let i = 0; i < 180; i++) {
    stepWorld(worldId, dt, 4);
  }

  const heap = new Float32Array(memory.buffer);
  const xBase = getParticleXByteOffset() >> 2;
  const yBase = getParticleYByteOffset() >> 2;
  assert.ok(xBase > 0 && yBase > 0, 'particle x/y SoA buffers missing');
  const getParticleVyByteOffset = fn('get_particle_vy_byte_offset');
  const vyBase = getParticleVyByteOffset() >> 2;
  const y = heap[yBase];
  const vy = heap[vyBase];
  const floorTop = 270;
  assert.ok(Number.isFinite(y) && Number.isFinite(vy), `non-finite: y=${y} vy=${vy}`);
  assert.ok(
    Math.abs(vy) < 80,
    `particle still bouncing: |vy|=${vy} (overlap launch is ~600)`,
  );
  assert.ok(
    y > floorTop - 25 && y < floorTop + 12,
    `particle not resting near floor top: y=${y} floorTop=${floorTop} radius=${radius}`,
  );
});

test('WASM WALL|BARRIER segment keeps water on one side', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createBodyBox = fn('create_body_box');
  const createParticleSystem = fn('create_particle_system');
  const createParticleBox = fn('create_particle_box');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const getParticleCount = fn('get_particle_count');
  const getParticleXByteOffset = fn('get_particle_x_byte_offset');
  const getParticleYByteOffset = fn('get_particle_y_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');

  const floorSlot = createBodyBox(
    worldId,
    0,
    0, 400, 0,
    400, 30,
    0, 0,
    1, 0.6, 0,
    0, 0, 1,
    0, 0, 0,
    0, 0,
    1, 0xffffffff,
    0, 0, 0,
  );
  assert.ok(floorSlot >= 0, `floor failed: ${floorSlot}`);
  assert.ok(createParticleSystem(worldId, 10, 1.0, 400), 'create_particle_system failed');

  const WALL = 1 << 1;
  const BARRIER = 1 << 7;
  const dam = createParticleBox(100, 340, 100, 357, 17, WALL | BARRIER);
  assert.equal(dam, 2, `expected 2 barrier particles, got ${dam}`);

  const gid = createParticleGroupCircle(40, 300, 35, 0, 0, 0, 0, 0, 0, 1, 1);
  assert.ok(gid >= 0, `water circle failed: ${gid}`);
  const count = getParticleCount();
  assert.ok(count > 4, `expected water + dam, got ${count}`);

  const dt = 1 / 60;
  for (let i = 0; i < 180; i++) {
    stepWorld(worldId, dt, 4);
  }

  const heap = new Float32Array(memory.buffer);
  const xBase = getParticleXByteOffset() >> 2;
  const yBase = getParticleYByteOffset() >> 2;
  assert.ok(xBase > 0 && yBase > 0, 'particle x/y SoA buffers missing');
  let far = 0;
  for (let i = 0; i < count; i++) {
    const x = heap[xBase + i];
    if (x > 115) far++;
  }
  assert.ok(far <= 2, `water crossed barrier: far=${far} count=${count}`);
  assert.equal(getParticleCount(), count);
});

test('WASM STATIC_PRESSURE create and step stays finite', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const getParticleCount = fn('get_particle_count');
  const getParticleXByteOffset = fn('get_particle_x_byte_offset');
  const getParticleYByteOffset = fn('get_particle_y_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');
  assert.ok(createParticleSystem(worldId, 10, 1.0, 200), 'create_particle_system failed');

  const STATIC_PRESSURE = 1 << 8;
  const gid = createParticleGroupCircle(0, 80, 40, 0, STATIC_PRESSURE, 0, 0, 0, 0, 1, 1);
  assert.ok(gid >= 0, `circle failed: ${gid}`);
  const count = getParticleCount();
  assert.ok(count > 4, `expected a blob, got ${count}`);

  const dt = 1 / 60;
  for (let i = 0; i < 10; i++) {
    stepWorld(worldId, dt, 1);
  }
  assert.equal(getParticleCount(), count);

  const heap = new Float32Array(memory.buffer);
  const xBase = getParticleXByteOffset() >> 2;
  const yBase = getParticleYByteOffset() >> 2;
  assert.ok(xBase > 0 && yBase > 0, 'particle x/y SoA buffers missing');
  for (let i = 0; i < count; i++) {
    const x = heap[xBase + i];
    const y = heap[yBase + i];
    assert.ok(Number.isFinite(x) && Number.isFinite(y), `NaN at ${i}: ${x},${y}`);
  }
});

test('WASM particle x/y are native SoA (interleaved pos offset deprecated)', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createBodyBox = fn('create_body_box');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const getParticleCount = fn('get_particle_count');
  const getParticlePosByteOffset = fn('get_particle_pos_byte_offset');
  const getParticleXByteOffset = fn('get_particle_x_byte_offset');
  const getParticleYByteOffset = fn('get_particle_y_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');

  const floorSlot = createBodyBox(
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
    0, 0, 0,
  );
  assert.ok(floorSlot >= 0, `create_body_box failed: ${floorSlot}`);

  assert.ok(createParticleSystem(worldId, 10, 1.0, 300), 'create_particle_system failed');
  const gid = createParticleGroupCircle(0, 80, 40, 0, 0, 0.5, 0, 0, 0, 1, 1);
  assert.ok(gid >= 0, `circle group failed: ${gid}`);
  const count = getParticleCount();
  assert.ok(count > 4, `expected a blob, got ${count}`);

  const dt = 1 / 60;
  for (let i = 0; i < 30; i++) {
    stepWorld(worldId, dt, 4);
  }
  assert.equal(getParticleCount(), count);

  const heap = new Float32Array(memory.buffer);
  const xBase = getParticleXByteOffset() >> 2;
  const yBase = getParticleYByteOffset() >> 2;
  assert.ok(xBase > 0 && yBase > 0, 'particle x/y SoA buffers missing');
  assert.equal(getParticlePosByteOffset(), 0, 'interleaved pos buffer retired');
  assert.notEqual(xBase, yBase, 'x/y must be separate SoA buffers');

  for (let i = 0; i < count; i++) {
    assert.ok(Number.isFinite(heap[xBase + i]), `x[${i}] NaN`);
    assert.ok(Number.isFinite(heap[yBase + i]), `y[${i}] NaN`);
  }
});

test('WASM create_particle_system strictContactCheck param reaches C (5th arg)', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const getParticleCount = fn('get_particle_count');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');

  // Explicit strictContactCheck=1 (5th arg). Omitting it (as every other test in
  // this file does) coerces to 0/false via the wasm JS API (ToInt32(undefined)),
  // matching the new liquidFun.strictContactCheck default of false.
  assert.ok(createParticleSystem(worldId, 10, 1.0, 200, 1), 'create_particle_system failed');

  const gid = createParticleGroupCircle(0, 80, 40, 0, 0, 0.5, 0, 0, 0, 1, 1);
  assert.ok(gid >= 0, `circle group failed: ${gid}`);
  const count = getParticleCount();
  assert.ok(count > 4, `expected a blob, got ${count}`);

  const dt = 1 / 60;
  for (let i = 0; i < 30; i++) {
    stepWorld(worldId, dt, 4);
  }
  assert.equal(getParticleCount(), count, 'strictContactCheck must not drop live particles');

  const heap = new Float32Array(memory.buffer);
  const xBase = fn('get_particle_x_byte_offset')() >> 2;
  const yBase = fn('get_particle_y_byte_offset')() >> 2;
  assert.ok(xBase > 0 && yBase > 0, 'particle x/y SoA buffers missing');
  for (let i = 0; i < count; i++) {
    assert.ok(Number.isFinite(heap[xBase + i]) && Number.isFinite(heap[yBase + i]), `NaN at ${i}`);
  }
});

test('WASM particle lifespan: age-based destruction (SetParticleDestructionByAge-style) sweeps expired particles', () => {
  const { fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const getParticleCount = fn('get_particle_count');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');
  assert.ok(createParticleSystem(worldId, 10, 1.0, 300), 'create_particle_system failed');

  // min === max: every particle in the group gets exactly the same lifetime
  // (no per-particle RNG spread), so the expiry step is deterministic.
  const lifetimeSec = 0.1;
  const gid = createParticleGroupCircle(0, 80, 40, 0, 0, 0.5, lifetimeSec, lifetimeSec, 0, 1, 1);
  assert.ok(gid >= 0, `circle group failed: ${gid}`);
  const count = getParticleCount();
  assert.ok(count > 4, `expected a blob, got ${count}`);

  const dt = 1 / 60;
  // Well past lifetimeSec (0.1s) - SolveLifetime uses the full dt once per
  // step_world call, so ~6 steps cross zero; run extra for a safety margin.
  for (let i = 0; i < 20; i++) {
    stepWorld(worldId, dt, 4);
  }
  assert.equal(getParticleCount(), 0, 'every particle should have aged out and been swept by SolveZombie');
});

test('WASM particle lifespan alpha fades toward 0 only when fadeToAlpha0=1; untracked and fade=0 stay at alpha=1', () => {
  const { memory, fn } = instantiateBox2dWasm();

  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const getParticleCount = fn('get_particle_count');
  const getParticleAlphaByteOffset = fn('get_particle_alpha_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId, 'create_world failed');
  assert.ok(bindGameBuffers(16), 'bind_game_buffers failed');

  const dt = 1 / 60;
  const heap = new Float32Array(memory.buffer);

  // --- Block 1: no lifespan requested (0,0) - alpha must stay 1 forever. ---
  assert.ok(createParticleSystem(worldId, 10, 1.0, 300), 'create_particle_system failed');
  const untrackedGid = createParticleGroupCircle(0, 80, 40, 0, 0, 0.5, 0, 0, 0, 1, 1);
  assert.ok(untrackedGid >= 0, `circle group failed: ${untrackedGid}`);
  const untrackedCount = getParticleCount();
  assert.ok(untrackedCount > 4, `expected a blob, got ${untrackedCount}`);
  for (let i = 0; i < 30; i++) {
    stepWorld(worldId, dt, 4);
  }
  assert.equal(getParticleCount(), untrackedCount, 'untracked particles must not expire');
  {
    const alphaBase = getParticleAlphaByteOffset() >> 2;
    assert.ok(alphaBase > 0, 'alpha byte offset missing');
    for (let i = 0; i < untrackedCount; i++) {
      assert.equal(heap[alphaBase + i], 1, `untracked particle ${i} alpha should stay 1`);
    }
  }

  // --- Block 2: lifespan + fadeToAlpha0=1, sampled at midpoint → alpha ~0.5. ---
  assert.ok(createParticleSystem(worldId, 10, 1.0, 300), 'create_particle_system failed');
  const lifetimeSec = 1.0;
  const trackedGid = createParticleGroupCircle(0, 80, 40, 0, 0, 0.5, lifetimeSec, lifetimeSec, 1, 1, 1);
  assert.ok(trackedGid >= 0, `circle group failed: ${trackedGid}`);
  const trackedCount = getParticleCount();
  assert.ok(trackedCount > 4, `expected a blob, got ${trackedCount}`);

  const halfSteps = Math.round((lifetimeSec * 0.5) / dt);
  for (let i = 0; i < halfSteps; i++) {
    stepWorld(worldId, dt, 4);
  }
  assert.equal(getParticleCount(), trackedCount, 'must not have expired yet at the midpoint');
  {
    const alphaBase = getParticleAlphaByteOffset() >> 2;
    for (let i = 0; i < trackedCount; i++) {
      const a = heap[alphaBase + i];
      assert.ok(a > 0.4 && a < 0.6, `particle ${i} alpha ${a} should be near the 0.5 midpoint`);
    }
  }

  // Run well past full expiry - every tracked particle should now be gone.
  for (let i = 0; i < halfSteps + 20; i++) {
    stepWorld(worldId, dt, 4);
  }
  assert.equal(getParticleCount(), 0, 'every tracked particle should have aged out by now');

  // --- Block 3: lifespan + fadeToAlpha0=0 → alpha stays 1 until destroy. ---
  assert.ok(createParticleSystem(worldId, 10, 1.0, 300), 'create_particle_system failed');
  const opaqueGid = createParticleGroupCircle(0, 80, 40, 0, 0, 0.5, lifetimeSec, lifetimeSec, 0, 1, 1);
  assert.ok(opaqueGid >= 0, `circle group failed: ${opaqueGid}`);
  const opaqueCount = getParticleCount();
  assert.ok(opaqueCount > 4, `expected a blob, got ${opaqueCount}`);
  for (let i = 0; i < halfSteps; i++) {
    stepWorld(worldId, dt, 4);
  }
  assert.equal(getParticleCount(), opaqueCount, 'must not have expired yet at the midpoint');
  {
    const alphaBase = getParticleAlphaByteOffset() >> 2;
    for (let i = 0; i < opaqueCount; i++) {
      assert.equal(heap[alphaBase + i], 1, `fade=0 particle ${i} alpha should stay 1`);
    }
  }
});

// ----------------------------------------------------------------------
// New LiquidFun 1.1 slab / join / solid / rigid / query / apply features
// ----------------------------------------------------------------------

const LF_ZOMBIE = 1 << 0;
const LF_ELASTIC = 1 << 4;
const LF_SOLID_GROUP = 1 << 0;
const LF_RIGID_GROUP = 1 << 1;

test('WASM group slab stays contiguous after mid-group zombie compact', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const getParticleCount = fn('get_particle_count');
  const getFirst = fn('get_particle_group_first_index');
  const getLast = fn('get_particle_group_last_index');
  const getAlive = fn('get_particle_group_alive');
  const getCount = fn('get_particle_group_particle_count');
  const getFlagsOff = fn('get_particle_flags_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));

  // trackGroup=1, groupFlags=0 — bookkeeping group, contiguous box fill
  const gid = createParticleGroupBox(-60, -40, 60, 40, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid >= 0, `group create failed: ${gid}`);
  const n0 = getParticleCount();
  const first0 = getFirst(gid);
  const last0 = getLast(gid);
  assert.equal(last0 - first0, n0);
  assert.equal(getCount(gid), n0);
  assert.ok(n0 >= 9, `need enough particles to kill middle, got ${n0}`);

  const flags = new Uint32Array(memory.buffer, getFlagsOff(), n0);
  const mid = (first0 + last0) >> 1;
  flags[mid] = flags[mid] | LF_ZOMBIE;
  flags[mid + 1] = flags[mid + 1] | LF_ZOMBIE;
  flags[mid + 2] = flags[mid + 2] | LF_ZOMBIE;

  stepWorld(worldId, 1 / 60, 1);

  assert.ok(getAlive(gid), 'group must stay alive');
  const first1 = getFirst(gid);
  const last1 = getLast(gid);
  const n1 = getParticleCount();
  assert.equal(n1, n0 - 3, 'three zombies removed');
  assert.equal(last1 - first1, n1, 'slab length must equal live count');
  assert.equal(getCount(gid), n1);
  assert.equal(first1, 0, 'sole group should pack to start after compact');
});

test('WASM JoinParticleGroups merges two slabs into one contiguous range', () => {
  const { fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const joinGroups = fn('join_particle_groups');
  const getFirst = fn('get_particle_group_first_index');
  const getLast = fn('get_particle_group_last_index');
  const getAlive = fn('get_particle_group_alive');
  const getCount = fn('get_particle_group_particle_count');
  const getParticleCount = fn('get_particle_count');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));

  const a = createParticleGroupBox(-80, -20, -20, 20, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  const b = createParticleGroupBox(20, -20, 80, 20, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(a >= 0 && b >= 0 && a !== b);
  const nA = getCount(a);
  const nB = getCount(b);
  assert.ok(nA > 0 && nB > 0);

  joinGroups(a, b);

  assert.ok(getAlive(a), 'group A keeps the merged slab');
  assert.equal(getAlive(b), 0, 'group B destroyed');
  assert.equal(getCount(a), nA + nB);
  assert.equal(getLast(a) - getFirst(a), nA + nB);
  assert.equal(getParticleCount(), nA + nB);
});

test('WASM rigid group ApplyLinearImpulse moves every member with same delta-v', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const groupImpulse = fn('particle_group_apply_linear_impulse');
  const getFirst = fn('get_particle_group_first_index');
  const getLast = fn('get_particle_group_last_index');
  const getVxOff = fn('get_particle_vx_byte_offset');
  const getVyOff = fn('get_particle_vy_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));

  // groupFlags = RIGID
  const gid = createParticleGroupBox(-40, -40, 40, 40, 0, 0, 0.5, 0, 0, 0, 1, 1, LF_RIGID_GROUP);
  assert.ok(gid >= 0);
  const first = getFirst(gid);
  const last = getLast(gid);
  assert.ok(last - first >= 4);

  groupImpulse(gid, 1000, 0);
  const vx = new Float32Array(memory.buffer, getVxOff());
  const vy = new Float32Array(memory.buffer, getVyOff());
  const vx0 = vx[first];
  for (let i = first; i < last; i++) {
    assert.ok(Math.abs(vx[i] - vx0) < 1e-3, `member ${i} vx should match group impulse`);
    assert.ok(Math.abs(vy[i]) < 1e-3, `member ${i} vy should stay ~0`);
  }

  // One rigid solve step should keep coherent motion (no NaNs)
  stepWorld(worldId, 1 / 60, 1);
  for (let i = first; i < last; i++) {
    assert.ok(Number.isFinite(vx[i]) && Number.isFinite(vy[i]));
  }
});

test('WASM solid+rigid group creates and steps finite; QueryAABB finds members', () => {
  const { fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const queryAabb = fn('particle_query_aabb');
  const getHit = fn('get_particle_query_hit');
  const getFirst = fn('get_particle_group_first_index');
  const getLast = fn('get_particle_group_last_index');
  const getParticleCount = fn('get_particle_count');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));

  const gid = createParticleGroupBox(
    -50,
    0,
    50,
    80,
    0,
    0,
    0.5,
    0,
    0,
    0,
    1,
    1,
    LF_SOLID_GROUP | LF_RIGID_GROUP,
  );
  assert.ok(gid >= 0);
  const n = getParticleCount();
  assert.ok(n > 4);
  assert.equal(fn('get_particle_group_flags')(gid), LF_SOLID_GROUP | LF_RIGID_GROUP);

  for (let i = 0; i < 30; i++) {
    stepWorld(worldId, 1 / 60, 1);
  }
  assert.equal(getParticleCount(), n, 'solid/rigid must not lose particles');

  const hits = queryAabb(-60, -10, 60, 200);
  assert.ok(hits > 0, 'QueryAABB should hit ice slab');
  const first = getFirst(gid);
  const last = getLast(gid);
  let inSlab = 0;
  for (let i = 0; i < hits; i++) {
    const idx = getHit(i);
    if (idx >= first && idx < last) inSlab++;
  }
  assert.ok(inSlab > 0, 'at least one hit must be inside the group slab');
});

test('WASM tracked viscous puddle + ice step stays finite', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const getParticleCount = fn('get_particle_count');
  const getVxOff = fn('get_particle_vx_byte_offset');
  const getVyOff = fn('get_particle_vy_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 2000));

  const puddle = createParticleGroupBox(-200, -80, 200, 80, 0, 1 << 2, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(puddle >= 0);
  stepWorld(worldId, 1 / 60, 1);
  const nPuddle = getParticleCount();

  const ice = createParticleGroupBox(-40, -30, 40, 30, 0, 0, 0.5, 0, 0, 0, 1, 1, LF_SOLID_GROUP | LF_RIGID_GROUP);
  assert.ok(ice >= 0);
  const n = getParticleCount();
  assert.ok(n > nPuddle);
  stepWorld(worldId, 1 / 60, 1);
  assert.equal(getParticleCount(), n);

  const vx = new Float32Array(memory.buffer, getVxOff());
  const vy = new Float32Array(memory.buffer, getVyOff());
  for (let i = 0; i < n; i++) {
    assert.ok(Number.isFinite(vx[i]) && Number.isFinite(vy[i]), `particle ${i} velocity not finite`);
  }
});

test('WASM overlapping solid groups eject (centers move apart)', () => {
  const { fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const getCx = fn('get_particle_group_center_x');
  const getCy = fn('get_particle_group_center_y');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 800));

  const a = createParticleGroupBox(-50, -30, 30, 30, 0, 0, 0.5, 0, 0, 0, 1, 1, LF_SOLID_GROUP | LF_RIGID_GROUP);
  const b = createParticleGroupBox(-10, -30, 70, 30, 0, 0, 0.5, 0, 0, 0, 1, 1, LF_SOLID_GROUP | LF_RIGID_GROUP);
  assert.ok(a >= 0 && b >= 0 && a !== b);

  const dx0 = getCx(b) - getCx(a);
  const dy0 = getCy(b) - getCy(a);
  const d0 = Math.hypot(dx0, dy0);
  assert.ok(d0 > 1, `groups should start offset, d0=${d0}`);

  for (let i = 0; i < 30; i++) {
    stepWorld(worldId, 1 / 60, 1);
  }

  const d1 = Math.hypot(getCx(b) - getCx(a), getCy(b) - getCy(a));
  assert.ok(d1 > d0 + 0.5, `SolveSolid should eject overlapping ice, d0=${d0} d1=${d1}`);
});

test('WASM second ice still ejects after first group depth is stale', () => {
  const { fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const getCx = fn('get_particle_group_center_x');
  const getCy = fn('get_particle_group_center_y');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 800));

  const a = createParticleGroupBox(-50, -30, 30, 30, 0, 0, 0.5, 0, 0, 0, 1, 1, LF_SOLID_GROUP | LF_RIGID_GROUP);
  assert.ok(a >= 0);
  for (let i = 0; i < 5; i++) {
    stepWorld(worldId, 1 / 60, 1);
  }

  const b = createParticleGroupBox(-10, -30, 70, 30, 0, 0, 0.5, 0, 0, 0, 1, 1, LF_SOLID_GROUP | LF_RIGID_GROUP);
  assert.ok(b >= 0);
  const d0 = Math.hypot(getCx(b) - getCx(a), getCy(b) - getCy(a));

  for (let i = 0; i < 30; i++) {
    stepWorld(worldId, 1 / 60, 1);
  }

  const d1 = Math.hypot(getCx(b) - getCx(a), getCy(b) - getCy(a));
  assert.ok(d1 > d0 + 0.5, `stale first-group depth must still eject, d0=${d0} d1=${d1}`);
});

test('WASM particle_apply_force accumulates into velocity after step', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const applyForce = fn('particle_apply_force');
  const getFirst = fn('get_particle_group_first_index');
  const getVxOff = fn('get_particle_vx_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 200));

  const gid = createParticleGroupBox(-20, -20, 20, 20, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid >= 0);
  const i = getFirst(gid);
  applyForce(i, 5000, 0);
  stepWorld(worldId, 1 / 60, 1);
  const vx = new Float32Array(memory.buffer, getVxOff());
  assert.ok(vx[i] > 0.1, `expected +vx after ApplyForce, got ${vx[i]}`);
});

test('WASM SplitParticleGroup peels disconnected Join components', () => {
  const { fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const joinGroups = fn('join_particle_groups');
  const splitGroup = fn('split_particle_group');
  const getAlive = fn('get_particle_group_alive');
  const getSlotCount = fn('get_particle_group_slot_count');
  const getCount = fn('get_particle_group_particle_count');
  const getParticleCount = fn('get_particle_count');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 800));

  // Two spatially separated blobs; Join makes one index-slab group.
  const a = createParticleGroupBox(-200, -20, -120, 20, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  const b = createParticleGroupBox(120, -20, 200, 20, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(a >= 0 && b >= 0);
  const nA = getCount(a);
  const nB = getCount(b);
  joinGroups(a, b);
  assert.equal(getCount(a), nA + nB);
  assert.equal(getAlive(b), 0);

  // Build contacts then split: disconnected components become separate groups.
  stepWorld(worldId, 1 / 60, 1);
  splitGroup(a);
  stepWorld(worldId, 1 / 60, 1); // SolveZombie cleans cloned originals

  let alive = 0;
  let particlesInGroups = 0;
  const slots = getSlotCount();
  for (let g = 0; g < slots; g++) {
    if (getAlive(g)) {
      alive++;
      particlesInGroups += getCount(g);
    }
  }
  assert.ok(alive >= 2, `expected >=2 live groups after Split, got ${alive}`);
  assert.equal(particlesInGroups, getParticleCount(), 'every live particle belongs to a group');
  assert.ok(getAlive(a), 'longest component keeps original group id');
});

test('WASM RayCast hits a particle disc along a segment', () => {
  const { fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const rayCast = fn('particle_ray_cast');
  const getHit = fn('get_particle_query_hit');
  const getFirst = fn('get_particle_group_first_index');
  const getLast = fn('get_particle_group_last_index');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 200));

  const gid = createParticleGroupBox(-30, -30, 30, 30, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid >= 0);
  const first = getFirst(gid);
  const last = getLast(gid);

  // Ray from left of the blob through its center.
  const hits = rayCast(-200, 0, 200, 0);
  assert.ok(hits > 0, 'RayCast should hit the blob');
  let inSlab = 0;
  for (let i = 0; i < hits; i++) {
    const idx = getHit(i);
    if (idx >= first && idx < last) inSlab++;
  }
  assert.ok(inSlab > 0, 'hit index must land in the group slab');

  // Miss far above.
  assert.equal(rayCast(-200, 500, 200, 500), 0, 'ray far from blob should miss');
});

test('WASM get_liquidfun_step_ms > 0 after particle step; 0 with no system', () => {
  const { fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const destroyParticleSystem = fn('destroy_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const stepWorld = fn('step_world');
  const getLfMs = fn('get_liquidfun_step_ms');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));

  stepWorld(worldId, 1 / 60, 1);
  assert.equal(getLfMs(), 0, 'no particle system → 0 ms');

  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));
  assert.ok(
    createParticleGroupBox(-80, -80, 80, 80, 0, 0, 0.5, 0, 0, 0, 1, 1, 0) >= 0,
  );
  stepWorld(worldId, 1 / 60, 1);
  const ms = getLfMs();
  assert.ok(ms > 0, `expected liquidfun step ms > 0, got ${ms}`);

  destroyParticleSystem();
  stepWorld(worldId, 1 / 60, 1);
  assert.equal(getLfMs(), 0, 'after destroy → 0 ms');
});

test('WASM clear-without-recreate: destroy groups + zombie rest → count 0; system reusable', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const createParticleBox = fn('create_particle_box');
  const destroyParticleGroup = fn('destroy_particle_group');
  const getParticleCount = fn('get_particle_count');
  const getParticleGroupSlotCount = fn('get_particle_group_slot_count');
  const getParticleGroupAlive = fn('get_particle_group_alive');
  const getFlagsOff = fn('get_particle_flags_byte_offset');
  const getXOff = fn('get_particle_x_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 2000));

  // Grouped blob + ungrouped fill (clear must wipe both).
  const gid = createParticleGroupBox(-40, -40, 40, 40, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid >= 0);
  const ungrouped = createParticleBox(80, 80, 120, 120, 0, 0);
  assert.ok(ungrouped > 0, `ungrouped fill failed: ${ungrouped}`);
  const n0 = getParticleCount();
  assert.ok(n0 > 10, `expected particles, got ${n0}`);
  const xOff0 = getXOff();

  const slots = getParticleGroupSlotCount() | 0;
  for (let g = 0; g < slots; g++) {
    if (getParticleGroupAlive(g) | 0) destroyParticleGroup(g);
  }
  let left = getParticleCount() | 0;
  if (left > 0) {
    const flags = new Uint32Array(memory.buffer, getFlagsOff(), left);
    for (let i = 0; i < left; i++) flags[i] = flags[i] | LF_ZOMBIE;
  }
  stepWorld(worldId, 1 / 60, 1);
  assert.equal(getParticleCount(), 0, 'clear path must empty live count');
  assert.equal(getXOff(), xOff0, 'system kept — x buffer offset unchanged');

  const gid2 = createParticleGroupBox(-20, -20, 20, 20, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid2 >= 0);
  const n1 = getParticleCount();
  assert.ok(n1 > 0, 're-emit after clear must work on same system');
  assert.ok(n1 < n0, 're-emit smaller than pre-clear puddle');
});

test('WASM clear wipe parks HEAP x/y far; create writes SoA pose before step', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const destroyParticleGroup = fn('destroy_particle_group');
  const getParticleCount = fn('get_particle_count');
  const getParticleGroupSlotCount = fn('get_particle_group_slot_count');
  const getParticleGroupAlive = fn('get_particle_group_alive');
  const getFlagsOff = fn('get_particle_flags_byte_offset');
  const getXOff = fn('get_particle_x_byte_offset');
  const getYOff = fn('get_particle_y_byte_offset');
  const stepWorld = fn('step_world');
  const LF_CLEARED_XY = -1e8;

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 2000));

  const gid = createParticleGroupBox(400, 500, 460, 560, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid >= 0);
  stepWorld(worldId, 1 / 60, 1);
  const n0 = getParticleCount();
  assert.ok(n0 > 4);
  const heap = new Float32Array(memory.buffer);
  const xBase = getXOff() >> 2;
  const yBase = getYOff() >> 2;
  const oldX0 = heap[xBase];
  assert.ok(Math.abs(oldX0 - LF_CLEARED_XY) > 1e3, 'pre-clear x should be near puddle, not far sentinel');

  // Simulate weedjs clear HEAP wipe (high-water = n0) then zombie compact.
  for (let i = 0; i < n0; i++) {
    heap[xBase + i] = LF_CLEARED_XY;
    heap[yBase + i] = LF_CLEARED_XY;
  }
  assert.equal(heap[xBase], LF_CLEARED_XY);
  assert.equal(heap[yBase], LF_CLEARED_XY);

  const slots = getParticleGroupSlotCount() | 0;
  for (let g = 0; g < slots; g++) {
    if (getParticleGroupAlive(g) | 0) destroyParticleGroup(g);
  }
  const left = getParticleCount() | 0;
  if (left > 0) {
    const flags = new Uint32Array(memory.buffer, getFlagsOff(), left);
    for (let i = 0; i < left; i++) flags[i] = flags[i] | LF_ZOMBIE;
  }
  stepWorld(worldId, 1 / 60, 1);
  assert.equal(getParticleCount(), 0);

  // Re-emit without stepping — CreateParticle writes native SoA immediately (no seed copy).
  const gid2 = createParticleGroupBox(-30, -30, 30, 30, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid2 >= 0);
  const n1 = getParticleCount();
  assert.ok(n1 > 0);
  for (let i = 0; i < n1; i++) {
    assert.ok(Number.isFinite(heap[xBase + i]), `x[${i}]`);
    assert.ok(Number.isFinite(heap[yBase + i]), `y[${i}]`);
    assert.notEqual(heap[xBase + i], LF_CLEARED_XY, `x[${i}] must not stay cleared sentinel`);
  }
  assert.ok(Math.abs(heap[xBase] - oldX0) > 50 || Math.abs(heap[yBase]) < 80, 'new pose away from old puddle');
});

test('WASM particle query hits are a contiguous HEAP32 block', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const queryAabb = fn('particle_query_aabb');
  const getHit = fn('get_particle_query_hit');
  const getHitsOff = fn('get_particle_query_hits_byte_offset');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));
  const gid = createParticleGroupBox(-40, -40, 40, 40, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid >= 0);

  const n = queryAabb(-50, -50, 50, 50);
  assert.ok(n > 0);
  const hitsOff = getHitsOff();
  assert.ok(hitsOff > 0);
  const hits = new Int32Array(memory.buffer, hitsOff, n);
  for (let i = 0; i < n; i++) {
    assert.equal(hits[i], getHit(i));
  }
});

test('WASM sync_active_particle_groups matches per-slot getters', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const syncGroups = fn('sync_active_particle_groups');
  const getOff = fn('get_sync_particle_groups_byte_offset');
  const getMax = fn('get_sync_particle_groups_max');
  const getAlive = fn('get_particle_group_alive');
  const getCount = fn('get_particle_group_particle_count');
  const getFirst = fn('get_particle_group_first_index');
  const getLast = fn('get_particle_group_last_index');
  const getVisc = fn('get_particle_group_viscous_scale');
  const getCx = fn('get_particle_group_center_x');
  const getCy = fn('get_particle_group_center_y');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));
  const a = createParticleGroupBox(-80, -20, -20, 20, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  const b = createParticleGroupBox(20, -20, 80, 20, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(a >= 0 && b >= 0);

  const stride = getMax();
  assert.equal(stride, 256);
  const n = syncGroups(stride);
  assert.equal(n, 2);
  const base = getOff() >> 2;
  const heap32 = new Int32Array(memory.buffer);
  const heapF32 = new Float32Array(memory.buffer);
  const ids = [heap32[base], heap32[base + 1]];
  assert.ok(ids.includes(a) && ids.includes(b));
  for (let w = 0; w < n; w++) {
    const gid = heap32[base + w];
    assert.equal(getAlive(gid), 1);
    assert.equal(heap32[base + stride + w], getCount(gid));
    assert.equal(heap32[base + stride * 2 + w], getFirst(gid));
    assert.equal(heap32[base + stride * 3 + w], getLast(gid));
    assert.ok(Math.abs(heapF32[base + stride * 4 + w] - getVisc(gid)) < 1e-6);
    assert.ok(Math.abs(heapF32[base + stride * 5 + w] - getCx(gid)) < 1e-4);
    assert.ok(Math.abs(heapF32[base + stride * 6 + w] - getCy(gid)) < 1e-4);
  }
});

test('WASM cull_particles_outside_bounds marks OOB centers zombie', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const getParticleCount = fn('get_particle_count');
  const getXOff = fn('get_particle_x_byte_offset');
  const getFlagsOff = fn('get_particle_flags_byte_offset');
  const cull = fn('cull_particles_outside_bounds');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));
  const gid = createParticleGroupBox(-30, -30, 30, 30, 0, 0, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid >= 0);
  const n = getParticleCount();
  assert.ok(n > 4);
  const xs = new Float32Array(memory.buffer, getXOff(), n);
  const flags = new Uint32Array(memory.buffer, getFlagsOff(), n);
  xs[0] = -20000;
  xs[1] = 20000;
  cull(-10000, -10000, 10000, 10000);
  assert.equal(flags[0] & LF_ZOMBIE, LF_ZOMBIE);
  assert.equal(flags[1] & LF_ZOMBIE, LF_ZOMBIE);
  let stillInside = 0;
  for (let i = 2; i < n; i++) {
    if ((flags[i] & LF_ZOMBIE) === 0) stillInside++;
  }
  assert.ok(stillInside > 0, 'in-bounds particles stay alive');
});

test('WASM elastic restOffset rebuilds around survivor COM after partial zombie', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupBox = fn('create_particle_group_box');
  const getParticleCount = fn('get_particle_count');
  const getFirst = fn('get_particle_group_first_index');
  const getLast = fn('get_particle_group_last_index');
  const getAlive = fn('get_particle_group_alive');
  const getYOff = fn('get_particle_y_byte_offset');
  const getFlagsOff = fn('get_particle_flags_byte_offset');
  const getRestOff = fn('get_particle_rest_offset_byte_offset');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));
  const gid = createParticleGroupBox(-40, -40, 40, 40, 0, LF_ELASTIC, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid >= 0);

  const n0 = getParticleCount();
  const first0 = getFirst(gid);
  const last0 = getLast(gid);
  assert.ok(last0 - first0 >= 8, `need a slab to split, got ${last0 - first0}`);

  const ys = new Float32Array(memory.buffer, getYOff(), n0);
  const flags = new Uint32Array(memory.buffer, getFlagsOff(), n0);
  let killed = 0;
  for (let i = first0; i < last0; i++) {
    if (ys[i] > 0) {
      flags[i] = flags[i] | LF_ZOMBIE;
      killed++;
    }
  }
  assert.ok(killed > 0 && killed < n0, `need a partial kill, killed ${killed}/${n0}`);

  stepWorld(worldId, 1 / 60, 1);

  assert.ok(getAlive(gid), 'group stays alive');
  const n1 = getParticleCount();
  assert.equal(n1, n0 - killed);
  const first1 = getFirst(gid);
  const last1 = getLast(gid);
  assert.equal(last1 - first1, n1);

  const rest = new Float32Array(memory.buffer, getRestOff());
  let sumX = 0;
  let sumY = 0;
  for (let i = first1; i < last1; i++) {
    sumX += rest[i * 2];
    sumY += rest[i * 2 + 1];
  }
  const inv = 1 / n1;
  assert.ok(Math.abs(sumX * inv) < 1e-4, `mean rest.x should be 0 after rebuild, got ${sumX * inv}`);
  assert.ok(Math.abs(sumY * inv) < 1e-4, `mean rest.y should be 0 after rebuild, got ${sumY * inv}`);
});

test('WASM elastic group falls through cull plane to count 0 without COM rebound', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const createParticleGroupCircle = fn('create_particle_group_circle');
  const getParticleCount = fn('get_particle_count');
  const getFirst = fn('get_particle_group_first_index');
  const getLast = fn('get_particle_group_last_index');
  const getYOff = fn('get_particle_y_byte_offset');
  const getVyOff = fn('get_particle_vy_byte_offset');
  const cull = fn('cull_particles_outside_bounds');
  const stepWorld = fn('step_world');

  const worldId = createWorld(0, 980, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 500));

  const gid = createParticleGroupCircle(0, 0, 40, 0, LF_ELASTIC, 0.5, 0, 0, 0, 1, 1, 0);
  assert.ok(gid >= 0);
  const n0 = getParticleCount();
  assert.ok(n0 > 4);

  const yMax = 80;
  const dt = 1 / 60;
  let prevCount = n0;
  let maxComYSameCount = -Infinity;
  let reachedZero = false;
  for (let s = 0; s < 240; s++) {
    cull(-1000, -1000, 1000, yMax);
    stepWorld(worldId, dt, 1);
    const n = getParticleCount();
    if (n <= 0) {
      reachedZero = true;
      break;
    }
    const first = getFirst(gid);
    const last = getLast(gid);
    const ys = new Float32Array(memory.buffer, getYOff());
    const vys = new Float32Array(memory.buffer, getVyOff());
    let comY = 0;
    let meanVy = 0;
    for (let i = first; i < last; i++) {
      comY += ys[i];
      meanVy += vys[i];
    }
    const inv = 1 / (last - first);
    comY *= inv;
    meanVy *= inv;
    if (n === prevCount) {
      assert.ok(
        comY + 1e-2 >= maxComYSameCount,
        `COM y rebound at step ${s}: ${comY} < ${maxComYSameCount}`,
      );
      maxComYSameCount = Math.max(maxComYSameCount, comY);
    } else {
      maxComYSameCount = comY;
    }
    assert.ok(meanVy > -200, `elastic fight launched blob up, mean vy=${meanVy} at step ${s}`);
    prevCount = n;
  }
  assert.ok(reachedZero, `elastic blob must leave through yMax, leftover ${getParticleCount()}/${n0}`);
});

test('WASM restore_particles SoA roundtrip matches x/y/vx/vy', () => {
  const { memory, fn } = instantiateBox2dWasm();
  const createWorld = fn('create_world');
  const bindGameBuffers = fn('bind_game_buffers');
  const createParticleSystem = fn('create_particle_system');
  const restoreParticles = fn('restore_particles');
  const getParticleCount = fn('get_particle_count');
  const getXOff = fn('get_particle_x_byte_offset');
  const getYOff = fn('get_particle_y_byte_offset');
  const getVxOff = fn('get_particle_vx_byte_offset');
  const getVyOff = fn('get_particle_vy_byte_offset');
  const malloc = fn('malloc');
  const free = fn('free');

  const worldId = createWorld(0, 0, 100, 30, 0.7, 3, 4000, 1);
  assert.ok(worldId);
  assert.ok(bindGameBuffers(16));
  assert.ok(createParticleSystem(worldId, 10, 1.0, 200));

  const n = 3;
  const x = new Float32Array([10, 20, 30]);
  const y = new Float32Array([11, 21, 31]);
  const vx = new Float32Array([1, 2, 3]);
  const vy = new Float32Array([4, 5, 6]);
  const flags = new Uint32Array([0, 0, 0]);
  const xPtr = malloc(n * 4);
  const yPtr = malloc(n * 4);
  const vxPtr = malloc(n * 4);
  const vyPtr = malloc(n * 4);
  const fPtr = malloc(n * 4);
  new Float32Array(memory.buffer, xPtr, n).set(x);
  new Float32Array(memory.buffer, yPtr, n).set(y);
  new Float32Array(memory.buffer, vxPtr, n).set(vx);
  new Float32Array(memory.buffer, vyPtr, n).set(vy);
  new Uint32Array(memory.buffer, fPtr, n).set(flags);
  const r = restoreParticles(n, xPtr, yPtr, vxPtr, vyPtr, fPtr);
  free(xPtr);
  free(yPtr);
  free(vxPtr);
  free(vyPtr);
  free(fPtr);
  assert.equal(r, n);
  assert.equal(getParticleCount(), n);
  const xs = new Float32Array(memory.buffer, getXOff(), n);
  const ys = new Float32Array(memory.buffer, getYOff(), n);
  const vxs = new Float32Array(memory.buffer, getVxOff(), n);
  const vys = new Float32Array(memory.buffer, getVyOff(), n);
  assert.deepEqual([...xs], [...x]);
  assert.deepEqual([...ys], [...y]);
  assert.deepEqual([...vxs], [...vx]);
  assert.deepEqual([...vys], [...vy]);
});


