// E-76 W12, float32: integrate_batch_f32x4 (wasm/particleIntegrate.c) against integrate_batch, its double
// integrate, which particleIntegrateWasm.test.js ties to the JS integrate bit for bit. Each
// variant runs its own population for 60 frames from the same seeds through the shipped client wrapper
// (integrateParticlesWasm: the dead list back to the pool, Math.cos / Math.sin for the trig list), with frame
// times that make dtRatio 1, 1.37, 0.83, 2.5, 0.5 and 1.1 over and over, so float32 rounding has room to
// drift (a repeating dtRatio is the worst case: a particle whose step sits near a rounding midpoint takes the
// same extra float32 step each cycle). After every frame the variants must hold:
// - the same lists, deaths, free list (the order later spawns take), stamps, lifetimes, floor times and
//   animation frames as the shipped kernel, exactly;
// - every float within integrateF32Tolerance(60) of the shipped kernel's (particleIntegrateWasmMicrobench.mjs):
//   positions and velocities within max(1e-3 px, 60 float32 steps), one step a frame (0.015 px at 3 000 px);
//   alpha and scale within max(1e-6, 8 steps); rotC and rotS within 2.5e-7; a tint channel within 1. None of
//   it shows: positions move on a float32 grid the shipped kernel already rounds to every frame, a 256 px
//   sprite turned 2.5e-7 rad moves its corner 6e-5 px, an alpha of 1e-6 is 1/4000 of one 8-bit step.
// The mixes: the stress scene's (heighted, seven eases) and its spin case (rotation and tint tweens, an
// angular velocity: angles to 3e4 rad, a few past 2^20 * pi/2 for the trig list and a few NaN), particles that
// land within the run (despawn, stay and stamp, fade on the floor), and flat ones (emitFlat: a rotation tween
// alone, gravity on vy, cycling animation frames, render-only particles skipped). The worst errors go to the
// diagnostics. Three mutants must fail: a sine coefficient and the back ease's constant off by 4e-4 and 1e-5
// of themselves in the binary, and a dtRatio off by 2e-5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { buildActiveListBuffers } from '../reference/particleIntegrate.mjs';
import { seededRandom } from '../../src/util/utils.js';
import { integrateParticlesWasm } from '../../src/workers/particleIntegrateClient.js';
import {
  compareIntegrateStates,
  createIntegrateRig,
  emitConfig,
  INTEGRATE_F32_EXPORTS,
  integrateF32Tolerance,
  PARTICLE_EASES,
} from '../bench/particleIntegrateWasmMicrobench.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const N = 12000;
const FRAMES = 60;
const BURST = 9000;
const PER_FRAME = 600;
const DT_RATIOS = [1, 1.37, 0.83, 2.5, 0.5, 1.1];
const TOLERANCE = integrateF32Tolerance(FRAMES);

/** One emit of a mix: the bench's stress configs, or the landing and flat ones (emitFlat). */
function emitMix(mix, count, k, area) {
  const ease = PARTICLE_EASES[k % PARTICLE_EASES.length];
  if (mix === 'tween' || mix === 'spin') return ParticleEmitter.emit(emitConfig(mix, count, ease, area));
  const cfg = {
    count,
    x: area.x,
    y: area.y,
    vx: { min: -15, max: 15 },
    vy: { min: -15, max: 15 },
    lifespan: { min: 300, max: 3000 },
    scale: { from: { min: 0.4, max: 1 }, to: 1.6, ease },
    alpha: { from: { min: 0.5, max: 1 }, to: 0.1, ease },
    tint: { from: 0x3080ff, to: 0xffd010, ease },
  };
  if (mix === 'floor') {
    cfg.z = { min: -60, max: -1 };
    cfg.vz = { min: -3, max: 1 };
    cfg.gravity = 0.08;
    const landing = k % 3;
    if (landing === 0) cfg.despawnOnGroundContact = true;
    else if (landing === 1) cfg.stayOnTheFloor = true;
    else cfg.fadeOnTheFloor = 150 + 50 * (k % 4);
    return ParticleEmitter.emit(cfg);
  }
  cfg.rotation = { from: { min: 0, max: 360 }, to: { min: -720, max: 1080 }, ease };
  if (k % 4 === 3) cfg.renderOnly = true;
  return ParticleEmitter.emitFlat(cfg);
}

/** Column edits no emit config reaches, by slot (the same on every side). */
function poke(mix) {
  const pc = ParticleComponent;
  for (let i = 0; i < N; i++) {
    if (!pc.active[i]) continue;
    if (mix === 'spin') {
      if (i % 997 === 0) {
        pc.angularVelFrom[i] = 3000; // past 2^20 * pi/2 within a few frames: the trig list
        pc.angularVelTo[i] = 3000;
      } else if (i % 1009 === 1) pc.rotFrom[i] = NaN;
    } else if ((mix === 'floor' || mix === 'flat') && i % 5 === 0 && pc.animMode[i] === 0) {
      pc.animMode[i] = 1;
      pc.animCount[i] = 1 + (i % 7);
      for (let f = 0; f < 8; f++) pc.animFrames[i * 8 + f] = 100 + f;
    }
    if (mix === 'flat' && i % 3 === 0) pc.gravity[i] = 0.05; // emitFlat takes gravity 0; the flat pass adds it to vy
  }
}

/**
 * Each kernel its own population, frame after frame from the same seeds; `kernels` by variant, `dtSkew` per
 * variant scales the dtRatio it gets. Returns the first violation and the largest errors seen.
 */
function runMix(rig, mix, kernels, { dtSkew = {} } = {}) {
  const pc = ParticleComponent;
  const b = rig.binding;
  const names = Object.keys(kernels);
  const sides = Object.fromEntries(names.map((v) => [v, {
    state: rig.pristine,
    rng: seededRandom(0xc0de1234, 'f32'),
    driver: seededRandom(0x5eed, 'driver'),
    list: null,
    stamp: null,
  }]));
  const worst = {};
  let violation = null;
  let rotated = 0;
  let trigListed = 0;
  let stamped = 0;
  let dead = 0;
  let flatMoved = 0;
  for (let f = 0; f < FRAMES && !violation; f++) {
    const dtRatio = DT_RATIOS[f % DT_RATIOS.length];
    for (const v of names) {
      const s = sides[v];
      rig.restore(s.state);
      globalThis.rng = s.rng;
      if (f === 0) {
        for (let k = 0; k < PARTICLE_EASES.length; k++) {
          emitMix(mix, Math.floor(BURST / PARTICLE_EASES.length), k, { x: { min: 64, max: 3936 }, y: { min: 64, max: 2936 } });
        }
      }
      const cx = 64 + s.driver() * 3872;
      const cy = 64 + s.driver() * 2872;
      emitMix(mix, PER_FRAME, f, { x: { min: cx - 200, max: cx + 200 }, y: { min: cy - 200, max: cy + 200 } });
      poke(mix);
      const count = buildActiveListBuffers(N, pc.active, b.indices, null, N);
      s.list = b.indices.slice(0, count);
      b.integrate = kernels[v];
      const out = integrateParticlesWasm(b, pc, count, (1000 / 60) * dtRatio, dtRatio * (dtSkew[v] ?? 1), f % 2 === 1);
      s.stamp = b.stamp.slice(0, out.stampedCount);
      if (v === 'wasm') {
        trigListed += b.results[3];
        dead += b.results[2];
        for (const i of s.list) if (pc.flat[i] && pc.active[i] && !pc.renderOnly[i]) flatMoved++;
        stamped += out.stampedCount;
        for (const i of s.list) if (pc.hasAngularVel[i] || pc.tweenMask[i] & 16) rotated++;
      }
      s.state = rig.save();
    }
    const ref = sides.wasm;
    for (const v of names.slice(1)) {
      const s = sides[v];
      const sameList = s.list.length === ref.list.length && s.list.every((i, k) => i === ref.list[k]);
      const sameStamp = s.stamp.length === ref.stamp.length && s.stamp.every((i, k) => i === ref.stamp[k]);
      const bad = !sameList ? 'the active list differs' : !sameStamp ? 'the stamp list differs'
        : compareIntegrateStates(rig.stateOf(ref.state), rig.stateOf(s.state), ref.list, ref.list.length, (worst[v] ??= {}), TOLERANCE);
      if (bad) {
        violation = `${v}, frame ${f} (dtRatio ${dtRatio}): ${bad}`;
        break;
      }
    }
  }
  return { violation, worst, rotated, trigListed, stamped, dead, flatMoved, alive: sides.wasm.list.length };
}

const rigPromise = createIntegrateRig(N);

for (const mix of ['tween', 'spin', 'floor', 'flat']) {
  test(`float32 integrates stay within tolerance of the shipped kernel for 60 frames (${mix})`, async (t) => {
    const rig = await rigPromise;
    const r = runMix(rig, mix, rig.kernels);
    assert.equal(r.violation, null);
    assert.ok(r.alive > 1000, 'particles are alive at the end');
    if (mix === 'spin') {
      assert.ok(r.rotated > 100000 && r.trigListed > 0, `rotations ran (${r.rotated}), some through the trig list (${r.trigListed})`);
    }
    if (mix === 'floor') assert.ok(r.stamped > 0 && r.dead > 0, `particles landed: ${r.stamped} stamped, ${r.dead} dead`);
    if (mix === 'flat') assert.ok(r.flatMoved > 100000, `the flat pass ran (${r.flatMoved})`);
    const fmt = (w) => Object.entries(w)
      .filter(([, e]) => e.abs > 0 || e.channel > 0)
      .map(([c, e]) => (e.channel !== undefined ? `${c} ${e.channel} step` : `${c} ${e.abs.toExponential(2)} (${Math.round(e.share * 100)} % of its tolerance)`))
      .join(', ') || 'none';
    for (const [v, w] of Object.entries(r.worst)) t.diagnostic(`${mix} ${v}: worst ${fmt(w)}`);
  });
}

/** The module's bytes with every float32 `from` and `-from` (4 little-endian bytes) replaced by `to`, `-to`. */
function patchFloat(bytes, from, to) {
  const out = bytes.slice();
  let hits = 0;
  for (const sign of [1, -1]) {
    const pat = new Uint8Array(new Float32Array([sign * from]).buffer);
    const rep = new Uint8Array(new Float32Array([sign * to]).buffer);
    for (let k = 0; k + 4 <= out.length; k++) {
      if (out[k] === pat[0] && out[k + 1] === pat[1] && out[k + 2] === pat[2] && out[k + 3] === pat[3]) {
        out.set(rep, k);
        hits++;
        k += 3;
      }
    }
  }
  return { bytes: out, hits };
}

test('the tolerance catches a wrong sine coefficient, a wrong ease constant and a drifting dtRatio', async () => {
  const rig = await rigPromise;
  const original = new Uint8Array(fs.readFileSync(path.join(root, 'src/wasm/engine.wasm')));
  const mutants = [
    { from: -1.6666654611e-1, to: -1.6666e-1, mix: 'spin', caught: /rot[CS]\[/, minHits: 2, what: 'the sine coefficient' },
    // floor: lifespans of 0.3–3 s, so back.in runs to the end of its curve within the 60 frames.
    { from: 1.70158, to: 1.70160, mix: 'floor', caught: /alpha\[|scale[XY]\[/, minHits: 2, what: "the back ease's constant" },
  ];
  for (const m of mutants) {
    const { bytes, hits } = patchFloat(original, m.from, m.to);
    assert.ok(hits >= m.minHits, `${m.what} is in the binary (${hits} found)`);
    const mutant = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { memory: rig.mem.memory } }).exports;
    for (const [v, name] of Object.entries(INTEGRATE_F32_EXPORTS)) {
      const r = runMix(rig, m.mix, { wasm: rig.kernels.wasm, [v]: mutant[name] });
      assert.match(String(r.violation), m.caught, `${v} with ${m.what} changed`);
    }
  }
  const r = runMix(rig, 'tween', { wasm: rig.kernels.wasm, 'wasm-f32x4': rig.kernels['wasm-f32x4'] }, { dtSkew: { 'wasm-f32x4': 1 + 2e-5 } });
  assert.match(String(r.violation), /\b[xyz]\[|v[xyz]\[/, 'a dtRatio off by 2e-5');
});
