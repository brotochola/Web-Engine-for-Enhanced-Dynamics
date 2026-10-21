import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findWgslUseBeforeDeclare, prependComputePrelude } from '../../src/render/webgpu/wgslPrelude.js';

// The burning-boxes demo: its fire shaders and scene wiring.
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SHADER_DIR = join(root, 'demos/burningBoxesScene/shaders');

test('fireLook: sample then discard outside 0-1; fluid uses scene uCellSize', () => {
  const look = readFileSync(join(SHADER_DIR, 'fireLook.wgsl'), 'utf8');
  const sampleAt = look.indexOf('textureSample(uTexture, uSampler');
  const discardAt = look.indexOf('uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0');
  assert.ok(sampleAt >= 0);
  assert.ok(discardAt > sampleAt);
  assert.match(look, /uCellSize/);
  const fluid = readFileSync(join(SHADER_DIR, 'fireFluid.wgsl'), 'utf8');
  assert.match(fluid, /max\(frame\.uCellSize/);
  assert.equal(/canvasW \/ max\(frame\.texW/.test(fluid), false);
});

test('world-fixed lattice: no camera-relative origin/shift, cell_active gates the fluid+stamp sim', () => {
  const fluid = readFileSync(join(SHADER_DIR, 'fireFluid.wgsl'), 'utf8');
  const stamp = readFileSync(join(SHADER_DIR, 'fireStamp.wgsl'), 'utf8');
  const look = readFileSync(join(SHADER_DIR, 'fireLook.wgsl'), 'utf8');
  const particles = readFileSync(join(SHADER_DIR, 'fireParticles.wgsl'), 'utf8');
  for (const src of [fluid, stamp, look, particles]) {
    assert.equal(/lattice_origin|lattice_shift/.test(src), false);
  }
  assert.match(particles, /fn cell_active\(id: vec2<i32>\)/);
  assert.equal(/fn shift_swirls/.test(fluid), false);
  assert.match(fluid, /fn cell_active\(id: vec2<i32>\)/);
  assert.match(stamp, /fn cell_active\(id: vec2<i32>\)/);
  // Every fluid pass that swaps a texture must gate on cell_active, since
  // inactive cells must stay zeroed (empty), not stale/undefined.
  for (const entry of ['cool_rise', 'apply_swirls', 'apply_stamp', 'apply_body_vel', 'push_from_solid', 'diffuse_temperature', 'jacobi_pressure', 'project_velocity', 'advect_velocity', 'advect_temperature']) {
    const fnStart = fluid.indexOf(`fn ${entry}(`);
    assert.ok(fnStart >= 0, `${entry} should exist`);
    const nextFn = fluid.indexOf('\n@compute', fnStart + 1);
    const body = fluid.slice(fnStart, nextFn === -1 ? undefined : nextFn);
    assert.match(body, /cell_active\(id\)/, `${entry} should gate on cell_active`);
  }
});

test('fire stamp: burning crust is live fluid; inert solids push; ember overlays in look', () => {
  const stamp = readFileSync(join(SHADER_DIR, 'fireStamp.wgsl'), 'utf8');
  const fluid = readFileSync(join(SHADER_DIR, 'fireFluid.wgsl'), 'utf8');
  const pack = readFileSync(join(SHADER_DIR, 'firePack.wgsl'), 'utf8');
  const look = readFileSync(join(SHADER_DIR, 'fireLook.wgsl'), 'utf8');
  assert.match(stamp, /!isBurning \|\| d <= -inner/);
  assert.match(stamp, /uStampInner/);
  assert.match(stamp, /uStampOuter/);
  assert.match(stamp, /burnSolid/);
  assert.match(stamp, /uEmberPad/);
  assert.match(stamp, /isBlow/);
  assert.match(stamp, /isJet/);
  assert.match(stamp, /fuelWrite/);
  assert.match(fluid, /fuel\.a > 0\.5/);
  assert.match(fluid, /uLfDrive/);
  assert.match(fluid, /fn inert_solid/);
  assert.match(fluid, /fn push_from_solid/);
  assert.match(stamp, /s\.velX/);
  assert.match(stamp, /velKind = 2\.0/);
  const applyStart = fluid.indexOf('fn apply_body_vel(');
  const applyNext = fluid.indexOf('\n@compute', applyStart + 1);
  const applyBody = fluid.slice(applyStart, applyNext === -1 ? undefined : applyNext);
  assert.match(fluid, /fn pin_face_u/);
  assert.match(fluid, /fn pin_face_v/);
  assert.match(fluid, /fn inert_wall_mid/);
  assert.match(fluid, /fn inert_corner_air/);
  assert.match(applyBody, /pin_face_u/);
  assert.match(applyBody, /pin_face_v/);
  assert.match(applyBody, /inert_corner_air/);
  assert.equal(/velR/.test(applyBody), false);
  assert.equal(/velU/.test(applyBody), false);

  const inertSolid = (open, burnA, hasBody) => open < 0.5 && burnA < 0.5 && hasBody < 0.5;
  assert.equal(inertSolid(0, 0, 0), true);
  assert.equal(inertSolid(0, 1, 0), false);
  assert.equal(inertSolid(1, 0, 0), false);
  assert.equal(inertSolid(0, 0, 1), false, 'flying crate is not an inert floor');
  assert.match(pack, /let ember = clamp\(mark\.b/);
  assert.match(look, /let ember = heat\.a/);
  assert.match(look, /eRgb \* eA \+ premul/);

  const inertWallMid = (at, tx, ty, ax, ay) => at(tx, ty) && at(tx + ax, ty + ay) && at(tx - ax, ty - ay);
  const pushAt = (solid, x, y) => {
    const at = (dx, dy) => !!solid(x + dx, y + dy);
    let nx = 0;
    let ny = 0;
    if (inertWallMid(at, -1, 0, 0, 1)) nx += 1;
    if (inertWallMid(at, 1, 0, 0, 1)) nx -= 1;
    if (inertWallMid(at, 0, -1, 1, 0)) ny += 1;
    if (inertWallMid(at, 0, 1, 1, 0)) ny -= 1;
    const len = Math.hypot(nx, ny);
    if (len <= 1e-4) return { nx: 0, ny: 0 };
    return { nx: nx / len, ny: ny / len };
  };
  const box = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const midTop = pushAt(box(2, 2, 5, 5), 3, 1);
  assert.ok(Math.abs(midTop.nx) < 1e-9 && Math.abs(midTop.ny + 1) < 1e-9);
  const midLeft = pushAt(box(2, 2, 5, 5), 1, 3);
  assert.ok(Math.abs(midLeft.nx + 1) < 1e-9 && Math.abs(midLeft.ny) < 1e-9);
  const corner = pushAt(box(2, 2, 5, 5), 2, 1);
  assert.equal(corner.nx, 0);
  assert.equal(corner.ny, 0);
  const inertCornerAir = (solid, x, y) => {
    const at = (dx, dy) => !!solid(x + dx, y + dy);
    const mid = (tx, ty, ax, ay) => at(tx, ty) && at(tx + ax, ty + ay) && at(tx - ax, ty - ay);
    if (at(-1, 0) || at(1, 0) || at(0, -1) || at(0, 1)) {
      return !mid(-1, 0, 0, 1) && !mid(1, 0, 0, 1) && !mid(0, -1, 1, 0) && !mid(0, 1, 1, 0);
    }
    return [at(-1, -1), at(1, -1), at(-1, 1), at(1, 1)].filter(Boolean).length === 1;
  };
  const plat = box(2, 2, 5, 5);
  assert.equal(inertCornerAir(plat, 3, 1), false, 'mid-top is not a corner');
  assert.equal(inertCornerAir(plat, 2, 1), true, 'top-left edge end');
  assert.equal(inertCornerAir(plat, 1, 1), true, 'diagonal outside vertex');
  assert.equal(inertCornerAir(plat, 0, 0), false, 'open field');
  const burnNeighbor = pushAt(() => false, 0, 0);
  assert.equal(burnNeighbor.nx, 0);
  assert.equal(burnNeighbor.ny, 0);

  const overA = (dstA, srcA) => srcA + dstA * (1 - srcA);
  assert.ok(overA(0.5, 0.8) > 0.5);

  const closed = (d, skin, burning, inner) => {
    if (d > skin) return false;
    if (!burning) return true;
    return d <= -inner;
  };
  assert.equal(closed(0, 0, true, 0), true);
  assert.equal(closed(-10, 0, true, 64), false);
  assert.equal(closed(-10, 0, false, 64), true);

  // MAC left face of an air cell is the right wall of a solid on the left.
  // Closed neighbor pins the face: body vel if moving, 0 if static.
  const sharedFaceU = (closedSelf, bodySelf, closedLeft, bodyLeft, vx, airU) => {
    if (closedSelf && bodySelf) return vx;
    if (closedSelf && !bodySelf) return 0;
    if (!closedSelf && closedLeft) return bodyLeft ? vx : 0;
    return airU;
  };
  assert.equal(sharedFaceU(false, false, true, true, 400, 0), 400);
  assert.equal(sharedFaceU(true, true, false, false, 400, 0), 400);
  assert.equal(sharedFaceU(false, false, false, false, 400, 0), 0);
  assert.equal(sharedFaceU(false, false, true, false, 400, 50), 0);
});

test('layerN: kindling negative scroll + +uTime*scroll moves uv.y toward screen up', () => {
  // Matches fireLook layerN. Y-down lattice: smaller uv.y is screen up.
  const offsetY = (time, scroll) => time * scroll;
  assert.ok(offsetY(1, -0.35) < 0);
  assert.ok(offsetY(1, 0.35) > 0);
});

test('fireParticles occupancy on fuel.a; apply_stamp ignites on fuel.r', () => {
  const particles = readFileSync(join(SHADER_DIR, 'fireParticles.wgsl'), 'utf8');
  const fluid = readFileSync(join(SHADER_DIR, 'fireFluid.wgsl'), 'utf8');
  const pack = readFileSync(join(SHADER_DIR, 'firePack.wgsl'), 'utf8');
  assert.equal(/if \(heat <= 0\.0\) \{ return; \}/.test(particles), false);
  assert.match(particles, /let occ = select\(0\.0, 1\.0, d2 <= rSolid \* rSolid\)/);
  assert.match(particles, /textureStore\(fuelWrite, id, vec4<f32>\(heat, p\.vx, p\.vy, occ\)\)/);
  const openFn = fluid.slice(fluid.indexOf('fn open_cell('), fluid.indexOf('fn inert_solid('));
  assert.match(openFn, /textureLoad\(fuelTex/);
  assert.match(openFn, /\.a > 0\.5/);
  const stampFn = fluid.slice(fluid.indexOf('fn apply_stamp('), fluid.indexOf('fn apply_body_vel('));
  assert.match(stampFn, /fuel\.a > 0\.5/);
  assert.match(stampFn, /fuel\.r > 0\.0/);
  const advectT = fluid.slice(fluid.indexOf('fn advect_temperature('), fluid.indexOf('fn cool_rise('));
  assert.match(advectT, /load_t\(id\)/);
  assert.equal(/fuelTex/.test(pack), false);
  assert.match(pack, /if \(mark\.r < 0\.5\)/);
});

test('burningBoxesScene: landscape bg + particle fuel pass', () => {
  const scene = readFileSync(
    join(SHADER_DIR, '../burningBoxesScene.js'),
    'utf8'
  );
  assert.match(scene, /kind: LAYER_KIND.COVER/);
  assert.match(scene, /texture: 'landscape'/);
  assert.match(scene, /zoomParallax: 0\.35/);
  assert.match(scene, /background_lanscape\.jpg/);
  assert.match(scene, /dispatchFrom: 'particles'/);
  assert.match(scene, /maxParticles: FIRE_LF_MAX/);
  assert.match(scene, /densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN/);
  assert.match(scene, /layers: burning \? \['fire'\] : \['oil', 'fire'\]/);
  assert.match(scene, /layers: \['oil', 'fire'\]/);
  assert.match(scene, /Keyboard\.q \|\| Keyboard\.e/);
  assert.match(scene, /OIL_DRIP_MS/);
});

test('burningBox click/F ignites crates in range', () => {
  const box = readFileSync(
    join(SHADER_DIR, '../gameObjects/burningBox.js'),
    'utf8'
  );
  assert.match(box, /dx \* dx \+ dy \* dy < IGNITE_RANGE_SQ/);
  assert.match(box, /this\.ignite\(\)/);
});

test('burningBoxes compute shaders stay clean after engine prelude', () => {
  const shaderDir = join(root, 'demos/burningBoxesScene/shaders');
  const names = readdirSync(shaderDir).filter((n) => n.endsWith('.wgsl') && n !== 'fireLook.wgsl');
  assert.ok(names.includes('fireParticles.wgsl'));
  for (const name of names) {
    const raw = readFileSync(join(shaderDir, name), 'utf8');
    if (!raw.includes('@compute')) continue;
    const issues = findWgslUseBeforeDeclare(prependComputePrelude(raw, null, null));
    assert.deepEqual(issues, [], `${name} after prelude: ${JSON.stringify(issues)}`);
  }
});
