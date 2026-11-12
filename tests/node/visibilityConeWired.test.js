// DX-SPOT B4: under raycast a cone light gathers only what can shadow its wedge (visibilityGather.wasm's cone
// exports drop the occluders wholly outside it) and publishes its polygon cut to the wedge, so Pixi fills the cone
// alone. On a real worker (tests/helpers/visibilityWired.mjs bootPreRenderGather), against the same worker with the
// JS gather (which culls nothing): the cut polygons light the same points of every cone, their vertices stay in the
// wedge, the cull drops occluders, and the point lights publish what they did, bit for bit.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Transform } from '../../src/components/transform.js';
import { mulberry32 } from '../bench/benchMath.js';
import { bootPreRenderGather, makeScene, runFrame, writeFrame } from '../helpers/visibilityWired.mjs';

const TIMES = [0, 0.6, 1.7, 3.1];

/** The cone's wedge in world space, as pre-render computes it: floor direction, ∓ the half aperture, y times g. */
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

/** Whether (px, py) is in the triangle fan from the polygon's light over its vertices (closing back to the first). */
function inFan(lx, ly, xs, ys, px, py) {
  const n = xs.length;
  for (let k = 0; k < n; k++) {
    const k1 = k + 1 === n ? 0 : k + 1;
    const ax = xs[k] - lx;
    const ay = ys[k] - ly;
    const bx = xs[k1] - lx;
    const by = ys[k1] - ly;
    const qx = px - lx;
    const qy = py - ly;
    const area = ax * by - ay * bx;
    if (area === 0) continue;
    const s1 = (ax * qy - ay * qx) / area;
    const s2 = (qx * by - qy * bx) / area;
    if (s1 >= 0 && s2 >= 0 && s1 + s2 <= 1) return true;
  }
  return false;
}

/**
 * The JS gather's frames, then the kernel's, each kernel frame handed to `check` with the JS frame at that time while
 * the component arrays hold it (the two workers share them: the second boot binds them to its memory).
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
    check(jsFrames[f], runFrame(kBoot));
  });
}

for (const g of [1, 0.6]) {
  test(`DX-SPOT: a cone light's cut polygon lights the cone as the full gather does, its vertices in the wedge (groundScaleY ${g})`, async () => {
    const rng = mulberry32(0xc0de);
    let cones = 0;
    let samples = 0;
    let mismatches = 0;
    let lit = 0;
    let selfLitJs = 0;
    let selfLitK = 0;
    await run(0x5b04, g, (js, k) => {
      assert.equal(k.lights.length, js.lights.length);
      for (let l = 0; l < js.lights.length; l++) {
        const a = js.lights[l];
        const b = k.lights[l];
        assert.equal(b.idx, a.idx);
        const i = a.idx;
        if (!(LightEmitter.coneCos[i] > -1)) {
          // A point light: what it published before cones existed, bit for bit.
          assert.deepEqual(Array.from(b.x), Array.from(a.x), `point light ${i}: x`);
          assert.deepEqual(Array.from(b.y), Array.from(a.y), `point light ${i}: y`);
          continue;
        }
        cones++;
        const R = LightEmitter.radius[i];
        const w = wedge(i, g);
        // The fan starts at the light, and every vertex lies in the wedge (a hair of float32 rounding aside).
        assert.ok(b.x[0] === b.lx && b.y[0] === b.ly, `cone light ${i}: the fan starts at the light`);
        const e1x = w.fx * w.c + w.fy * w.s;
        const e1y = (w.fy * w.c - w.fx * w.s) * g;
        const e2x = w.fx * w.c - w.fy * w.s;
        const e2y = (w.fy * w.c + w.fx * w.s) * g;
        const wide = w.c < 0;
        for (let v = 1; v < b.n; v++) {
          const dx = b.x[v] - b.lx;
          const dy = b.y[v] - b.ly;
          const tol = 1e-3 * Math.sqrt(dx * dx + dy * dy) + 1e-3;
          const inA = (e1x * dy - e1y * dx) / Math.sqrt(e1x * e1x + e1y * e1y) >= -tol;
          const inB = (dx * e2y - dy * e2x) / Math.sqrt(e2x * e2x + e2y * e2y) >= -tol;
          assert.ok(wide ? inA || inB : inA && inB, `cone light ${i} vertex ${v} outside its wedge`);
        }
        // Points of the cone on the floor, inside its radius: lit by the cut polygon exactly where the full gather's
        // cut polygon lights them.
        for (let q = 0; q < 200; q++) {
          const phi = (rng() * 2 - 1) * Math.acos(w.c) * 0.999;
          const r = Math.sqrt(rng()) * R * 0.94;
          const cx = w.fx * Math.cos(phi) - w.fy * Math.sin(phi);
          const cy = w.fx * Math.sin(phi) + w.fy * Math.cos(phi);
          const px = a.lx + cx * r;
          const py = a.ly + cy * r * g;
          const inJs = inFan(a.lx, a.ly, a.x, a.y, px, py);
          const inK = inFan(b.lx, b.ly, b.x, b.y, px, py);
          samples++;
          if (inK) lit++;
          if (inJs !== inK) mismatches++;
        }
      }
      for (const item of js.selfLit) if (LightEmitter.coneCos[+item.slice(item.indexOf('@') + 1)] > -1) selfLitJs++;
      for (const item of k.selfLit) if (LightEmitter.coneCos[+item.slice(item.indexOf('@') + 1)] > -1) selfLitK++;
    });
    assert.ok(cones >= 40, `${cones} cone lights compared`);
    assert.ok(lit > samples * 0.3 && lit < samples, `lit and shadowed samples both (${lit} of ${samples})`);
    assert.ok(mismatches <= samples * 0.002, `${mismatches} of ${samples} samples differ`);
    // The cull: occluders outside a wedge are neither swept nor self-lit.
    assert.ok(selfLitK < selfLitJs * 0.8, `the cone lights' self-lit items: ${selfLitK} with the cull, ${selfLitJs} without`);
  });
}
