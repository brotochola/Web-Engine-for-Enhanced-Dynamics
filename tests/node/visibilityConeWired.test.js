// DX-SPOT B4: under raycast a cone light gathers only what can shadow its wedge (visibilityGather.wasm's cone
// exports drop the occluders wholly outside it). OL-15: its row holds the whole turn's polygon of what it gathered,
// and the light pass cuts the cone itself (the fan pass's polygon was cut to the wedge here, so Pixi filled the cone
// alone). On a real worker (tests/helpers/visibilityWired.mjs bootPreRenderGather), against the same worker with the
// JS gather (which culls nothing): inside its wedge a cone lamp's row lights the points the full gather's row lights
// (wallRowLight, the shaders' lookup), the cull drops walls, and the point lights publish the same rows, bit for bit.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Transform } from '../../src/components/transform.js';
import { wallRowLight } from '../../src/render/visibility/lampWallRow.js';
import { mulberry32 } from '../bench/benchMath.js';
import { bootPreRenderGather, makeScene, rowBits, rowWalls, runFrame, writeFrame } from '../helpers/visibilityWired.mjs';

const TIMES = [0, 0.6, 1.7, 3.1];

/** The cone on the floor, as pre-render computes it: its direction (unit), and the cosine and sine of its half aperture. */
function wedge(i, g) {
  const dc = LightEmitter.dirC[i];
  const ds = LightEmitter.dirS[i];
  const rc = Transform.rotC[i];
  const rs = Transform.rotS[i];
  const wx = rc * dc - rs * ds;
  const wy = (rs * dc + rc * ds) / g;
  const len = Math.sqrt(wx * wx + wy * wy);
  const fx = wx / len;
  const fy = wy / len;
  const c = LightEmitter.coneCos[i];
  const s = Math.sqrt(1 - c * c);
  return { fx, fy, c, s };
}

/**
 * The JS gather's frames, then the kernel's, each kernel frame's rows handed to `check` with the JS gather's rows at
 * that time while the component arrays hold it (the two workers share them: the second boot binds them to its memory).
 */
async function run(seed, g, check) {
  const scene = makeScene(seed, { cones: 0.5 });
  const jsBoot = await bootPreRenderGather(scene, { groundScaleY: g });
  jsBoot.pre._visGather = null;
  const jsFrames = [];
  for (const t of TIMES) {
    writeFrame(jsBoot, t, { scene });
    jsFrames.push(runFrame(jsBoot));
  }
  const kBoot = await bootPreRenderGather(scene, { groundScaleY: g });
  assert.ok(kBoot.pre._visGather, 'the gather kernel is bound');
  TIMES.forEach((t, f) => {
    writeFrame(kBoot, t, { scene });
    check(scene, jsFrames[f], runFrame(kBoot));
  });
}

const isCone = (lamp) => LightEmitter.coneCos[lamp] > -1;

for (const g of [1, 0.6]) {
  test(`DX-SPOT: a cone lamp's row of the walls in its wedge lights the cone as the full gather's does (groundScaleY ${g})`, async (t) => {
    const rng = mulberry32(0xc0de);
    const sum = { points: 0, cones: 0, noRow: 0, samples: 0, lit: 0, mismatches: 0, wallsJs: 0, wallsK: 0 };
    await run(0x5b04, g, (scene, js, k) => {
      const jsRow = new Map(js.lamps.map((lamp, r) => [lamp, r]));
      const kRow = new Map(k.lamps.map((lamp, r) => [lamp, r]));
      // The point lights: the rows they published before cones existed, bit for bit.
      const points = js.lamps.filter((lamp) => !isCone(lamp));
      assert.deepEqual(k.lamps.filter((lamp) => !isCone(lamp)), points, 'the point lights with a row');
      for (const lamp of points) {
        assert.deepEqual(rowBits(k, kRow.get(lamp)), rowBits(js, jsRow.get(lamp)), `point light ${lamp}: its row`);
        sum.points++;
      }
      for (let i = 0; i < scene.lights; i++) {
        if (!isCone(i)) continue;
        // The cull only drops walls: a lamp with a row has one under the full gather too. A cone lamp with nothing
        // in reach (or that casts no shadow) has none either way.
        assert.ok(!kRow.has(i) || jsRow.has(i), `cone light ${i}: a row with the cull, none without`);
        if (!jsRow.has(i)) continue;
        sum.cones++;
        const full = jsRow.get(i) * js.rowFloats;
        // Every wall in its reach lies outside the wedge: no row, nothing stops it.
        const cut = kRow.has(i) ? kRow.get(i) * k.rowFloats : -1;
        if (cut < 0) sum.noRow++;
        else {
          assert.ok(k.f32[cut + 2] === js.f32[full + 2] && k.f32[cut + 3] === js.f32[full + 3], `cone light ${i}: both rows at its lamp`);
          sum.wallsK += rowWalls(k, kRow.get(i)).size;
        }
        sum.wallsJs += rowWalls(js, jsRow.get(i)).size;
        // Points of the cone on the floor, inside its radius (a row is in the floor's terms: y over the floor's
        // scale): lit by the culled row exactly where the full gather's row lights them, and as much.
        const R = LightEmitter.radius[i];
        const w = wedge(i, g);
        const lx = js.f32[full + 2];
        const ly = js.f32[full + 3];
        for (let q = 0; q < 200; q++) {
          const phi = (rng() * 2 - 1) * Math.acos(w.c) * 0.999;
          const r = Math.sqrt(rng()) * R * 0.94;
          const px = lx + (w.fx * Math.cos(phi) - w.fy * Math.sin(phi)) * r;
          const py = ly + (w.fx * Math.sin(phi) + w.fy * Math.cos(phi)) * r;
          const whole = wallRowLight(js.f32, full, px, py, 0);
          const culled = cut < 0 ? 1 : wallRowLight(k.f32, cut, px, py, 0);
          sum.samples++;
          if (culled === 1) sum.lit++;
          if (Math.abs(whole - culled) > 1e-3) sum.mismatches++;
        }
      }
    });
    t.diagnostic(JSON.stringify(sum));
    assert.ok(sum.points >= 40, `${sum.points} point lights' rows compared`);
    assert.ok(sum.cones >= 40, `${sum.cones} cone lights compared`);
    assert.ok(sum.lit > sum.samples * 0.3 && sum.lit < sum.samples, `lit and shadowed samples both (${sum.lit} of ${sum.samples})`);
    // A few differ, each at the edge of a shadow. Where a wall straddles the wedge's side, the sweep's chord through
    // it ends on another event outside the wedge. And where a compound solid in the lamp's reach lies outside its
    // wedge, the full gather's row is the polar merge (a vertex a bin) and the culled one the sweep's own polygon:
    // a shadow's side is up to a bin apart.
    assert.ok(sum.mismatches <= sum.samples * 0.002, `${sum.mismatches} of ${sum.samples} samples differ`);
    // The cull: the walls outside a wedge are not swept, so the cone lamps' rows name fewer walls.
    assert.ok(sum.wallsK < sum.wallsJs * 0.8, `the cone lamps' rows name ${sum.wallsK} walls with the cull, ${sum.wallsJs} without`);
  });
}
