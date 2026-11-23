// OL-9 (lighting.wallCache): a lamp's row is kept while what goes into its sweep is the same, and its sweep is skipped.
// On a real pre-render worker (tests/helpers/visibilityWired.mjs), both gathers: the same frames run with the cache off
// and with it on, the two write buffers taking turns as in the frame loop. Every frame must publish the same lamps and
// the same rows, bit for bit, whatever moved: a wall, a lamp, a wall's opacity, a lamp's reach, a lamp out of the frame
// and back (its row's place moves), a compound solid. And a still scene must stop sweeping.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LightEmitter } from '../../src/components/lightEmitter.js';
import { WALL_VERT0 } from '../../src/render/visibility/lampWallRow.js';
import { mulberry32 } from '../bench/benchMath.js';
import { bootPreRenderGather, makeScene, runFrame, writeFrame } from '../helpers/visibilityWired.mjs';
import { visibilityGatherJs } from '../reference/visibilityGatherJs.mjs';

const SCENE = { lights: 24, boxes: 150, circles: 50, polygons: 30, rings: 5, blockHalf: 0.25 };

/** A scene where nothing moves by itself: the test moves what it wants between frames. */
function stillScene(seed) {
  const s = makeScene(seed, SCENE);
  for (const e of s.ents) {
    e.vx = 0;
    e.vy = 0;
    e.spin = 0;
  }
  return s;
}

/** The lamps a frame published and each one's row, as bits (the row's own floats: its header, bins and vertices). */
function published(rows) {
  const out = [];
  for (let r = 0; r < rows.lamps.length; r++) {
    const o = r * rows.rowFloats;
    const used = 4 * (WALL_VERT0 + rows.f32[o] + 1);
    out.push({ lamp: rows.lamps[r], bits: new Uint32Array(rows.f32.slice(o, o + used).buffer) });
  }
  return out;
}

/**
 * Runs `steps` (each changes the scene, or nothing) on a worker booted by `boot`, a frame a step.
 * @returns {{ frames: Array, sweeps: number[] }} what each frame published, and the sweeps it ran
 */
async function play(boot, seed, steps, wallCache) {
  const scene = stillScene(seed);
  const b = await boot(scene, { wallCache, maxNeighbors: 512 });
  const kernel = b.pre._visSweep;
  const sweep = kernel.sweep;
  let calls = 0;
  kernel.sweep = (...args) => {
    calls++;
    return sweep(...args);
  };
  const frames = [];
  const sweeps = [];
  for (let f = 0; f < steps.length; f++) {
    const hidden = steps[f](scene) || [];
    writeFrame(b, 0);
    for (const lamp of hidden) LightEmitter.active[lamp] = 0;
    // The frame loop's turn of the two buffers (selectWriteBuffers).
    b.pre._wallRowsWrite = b.pre._wallRowBuffers[f & 1];
    calls = 0;
    frames.push(published(runFrame(b)));
    sweeps.push(calls);
  }
  return { frames, sweeps };
}

function assertSameFrames(off, on, label) {
  assert.equal(on.frames.length, off.frames.length);
  for (let f = 0; f < off.frames.length; f++) {
    const a = off.frames[f];
    const b = on.frames[f];
    assert.deepEqual(b.map((r) => r.lamp), a.map((r) => r.lamp), `${label} frame ${f}: the lamps with a row`);
    for (let r = 0; r < a.length; r++) {
      assert.equal(b[r].bits.length, a[r].bits.length, `${label} frame ${f} lamp ${a[r].lamp}: the row's length`);
      for (let i = 0; i < a[r].bits.length; i++) {
        if (a[r].bits[i] !== b[r].bits[i]) assert.fail(`${label} frame ${f} lamp ${a[r].lamp}: float ${i} differs`);
      }
    }
  }
}

const still = () => {};
const occluders = (scene) => scene.ents.map((e, i) => (e.kind === 'light' ? -1 : i)).filter((i) => i >= 0);
const lamps = (scene) => scene.ents.map((e, i) => (e.kind === 'light' ? i : -1)).filter((i) => i >= 0);

/** One of everything that can change a row, with still frames between (a kept row needs both buffers written). */
function story() {
  return [
    still, still, still, still,
    // A wall moves, and stands.
    (s) => { s.ents[occluders(s)[40]].x += 7; },
    still, still,
    // A lamp moves, and stands (the fifth: every fifth light of the scene, from the fourth, casts nothing and has no row).
    (s) => { s.ents[lamps(s)[4]].y += 11; },
    still, still, still,
    // A wall turns.
    (s) => { s.ents[occluders(s)[12]].angle += 0.3; },
    still, still,
    // A wall's opacity changes: its shape does not, its code does.
    (s) => { for (const i of occluders(s).slice(0, 60)) s.ents[i].block = s.ents[i].block === 1 ? 0.5 : 1; },
    still, still,
    // A lamp's reach.
    (s) => { s.ents[lamps(s)[7]].sqrtI *= 1.2; },
    still, still,
    // Two lamps leave the frame for three frames: the rows after them move down, then up again.
    (s) => [lamps(s)[1], lamps(s)[9]],
    (s) => [lamps(s)[1], lamps(s)[9]],
    (s) => [lamps(s)[1], lamps(s)[9]],
    still, still, still,
    // A compound solid (the last entities are the rings) moves.
    (s) => { s.ents[s.ents.length - 1].x += 9; },
    still, still, still,
  ];
}

/** Frames where a few things move at random, a few stand, and lamps come and go. */
function randomSteps(seed, count) {
  const rng = mulberry32(seed);
  const steps = [];
  let hidden = [];
  for (let f = 0; f < count; f++) {
    const kind = rng();
    const pick = rng();
    const amount = (rng() - 0.5) * 30;
    const hide = rng();
    steps.push((s) => {
      const occ = occluders(s);
      const lit = lamps(s);
      if (kind < 0.35) {
        // nothing
      } else if (kind < 0.7) {
        const e = s.ents[occ[(pick * occ.length) | 0]];
        e.x += amount;
        e.angle = (e.angle || 0) + amount / 40;
      } else if (kind < 0.85) {
        s.ents[lit[(pick * lit.length) | 0]].x += amount;
      } else {
        const e = s.ents[occ[(pick * occ.length) | 0]];
        e.block = e.block === 1 ? 0.5 : 1;
      }
      if (hide < 0.15) hidden = hidden.length ? [] : [lit[(pick * lit.length) | 0], lit[((pick * 7919) | 0) % lit.length]];
      return hidden;
    });
  }
  return steps;
}

/** CR-38: the gather's JS twin in the kernel's place (tests/reference/visibilityGatherJs.mjs). */
async function bootPreRenderTwin(scene, opts) {
  const boot = await bootPreRenderGather(scene, opts);
  boot.pre._visGather = visibilityGatherJs(boot.pre);
  return boot;
}

for (const [name, boot] of [['the gather\'s JS twin', bootPreRenderTwin], ['visibilityGather.wasm', bootPreRenderGather]]) {
  test(`OL-9: a kept row is the row the sweep would write, through every kind of change (${name})`, async () => {
    const off = await play(boot, 0x0919, story(), false);
    const on = await play(boot, 0x0919, story(), true);
    assertSameFrames(off, on, name);
    // Without the cache every frame sweeps every lamp with something in reach.
    assert.ok(off.sweeps.every((n) => n === off.sweeps[0] || n > 0), 'the uncached run sweeps');
    // With it, a still scene stops sweeping once both buffers hold its rows under a signature. The first frame has no
    // frame before it to say the lamps stand, so its rows carry none: the two buffers are written in frames 1 and 2,
    // and frame 3 sweeps nothing.
    assert.ok(on.sweeps[2] > 0, 'frame 2 still writes its buffer');
    assert.equal(on.sweeps[3], 0, `frame 3 swept ${on.sweeps[3]} lamps`);
    // A wall moved in frame 4: only the lamps it reaches are swept, in that frame and the next (the other buffer).
    assert.ok(on.sweeps[4] > 0 && on.sweeps[4] < off.sweeps[4], `a wall moved: ${on.sweeps[4]} of ${off.sweeps[4]} lamps swept`);
    assert.equal(on.sweeps[5], on.sweeps[4], 'the same lamps again, for the other buffer');
    assert.equal(on.sweeps[6], 0, 'two frames after a wall moved');
    // A lamp moved in frame 7: its sweep alone, without a signature that frame, then once a buffer.
    assert.equal(on.sweeps[7], 1, 'a lamp moved: its sweep alone');
    assert.equal(on.sweeps[8], 1);
    assert.equal(on.sweeps[9], 1);
    assert.equal(on.sweeps[10], 0, 'three frames after a lamp moved');
  });

  test(`OL-9: forty frames of walls and lamps moving, standing and leaving publish the same rows (${name})`, async () => {
    for (const seed of [0x51, 0x52]) {
      const off = await play(boot, seed, randomSteps(seed * 31, 40), false);
      const on = await play(boot, seed, randomSteps(seed * 31, 40), true);
      assertSameFrames(off, on, `${name}, seed ${seed}`);
      const swept = on.sweeps.reduce((a, n) => a + n, 0);
      const all = off.sweeps.reduce((a, n) => a + n, 0);
      assert.ok(swept < all * 0.6, `${name}, seed ${seed}: ${swept} of ${all} sweeps ran`);
    }
  });
}
