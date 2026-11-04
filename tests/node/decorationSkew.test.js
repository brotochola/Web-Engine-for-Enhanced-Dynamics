// DX-DECOSKEW: a decoration's skewX / skewY shear its scaled sprite about its anchor (x += skewX·y, y += skewY·x).
// The shear is the decoration's facing, as a shear sway's already was: rotC past SKEW_C_MIN says "shear", its distance from
// 1.5 carries skewY (t = skewY / (1 + |skewY|), read back with one division in the sprite shader), rotS carries skewX. Pre-render copies the facing
// to the render queue as it always did. A sheared decoration does not turn or sway. Conurbano-weed draws a house's
// walls from flat pieces this way, one texture for every heading.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { Transform } from '../../src/components/transform.js';
import { Decoration } from '../../src/core/decoration.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { GameObject } from '../../src/core/gameObject.js';
import { SKEW_C_MIN, SKEW_C_SPAN, skewMarkerC, SWAY_LOOP, SWAY_OFF, SWAY_SKEW_C } from '../../src/util/decorationSway.js';
import { setupAttachedSway } from '../bench/attachedSwayMicrobench.mjs';
import { setupDecorationCollect } from '../bench/decorationCollectMicrobench.mjs';
import { setupSwayKernel, swayDecorationsWasm } from '../bench/decorationSwayWasmMicrobench.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';

const D = DecorationComponent;
const f = Math.fround;

/** The two numbers each sprite shader decides a shear by, read from the shader as it ships. */
const SHADER_NUMBERS = ['instancedSprite.vert.glsl', 'instancedSpritePose.vert.glsl', 'instancedSprite.wgsl', 'instancedSpritePose.wgsl'].map((name) => {
  const source = fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');
  const isShear = source.match(/isShear = c > ([\d.]+);/);
  const scale = source.match(/t = \(c - 1\.5\) \* ([\d.]+);/);
  assert.ok(isShear && scale, `${name}: the shear's numbers`);
  return { name, min: Number(isShear[1]), scale: Number(scale[1]) };
});
const SHADER_MIN = SHADER_NUMBERS[0].min;
const SHADER_SCALE = SHADER_NUMBERS[0].scale;

/** The sprite shader's reading of a facing pair (instancedSprite.vert.glsl): where the local point (x, y) is drawn. */
function drawn(c, s, x, y) {
  if (f(c) > f(SHADER_MIN)) {
    const t = f((f(c) - 1.5) * f(SHADER_SCALE));
    const ky = t / (1 - Math.abs(t));
    return [x + y * s, y + x * ky];
  }
  return [x * c - y * s, x * s + y * c];
}

/** The facing a sheared decoration holds: the marker and skewX, in the base and drawn columns alike. */
function assertSheared(i, kx, ky, label) {
  const c = f(skewMarkerC(kx, ky));
  assert.ok(c > SKEW_C_MIN && c < 2, `${label}: c ${c}`);
  assert.deepEqual([D.baseRotC[i], D.baseRotS[i], D.rotC[i], D.rotS[i]], [c, f(kx), c, f(kx)], label);
}

test('the four sprite shaders decide a shear by the same numbers as skewMarkerC', () => {
  for (const { name, min, scale } of SHADER_NUMBERS) {
    assert.equal(min, SKEW_C_MIN, `${name}: where a shear starts`);
    assert.ok(Math.abs(scale * SKEW_C_SPAN - 1) < 1e-7, `${name}: ${scale} is 1 / SKEW_C_SPAN`);
  }
});

test('skewMarkerC: 0 without a shear, the shear sway marker without a vertical one, and one division reads skewY back', () => {
  assert.equal(skewMarkerC(0, 0), 0);
  assert.equal(skewMarkerC(0.4, 0), SWAY_SKEW_C);
  for (const ky of [-40, -3.2, -1, -0.31, -1e-3, 1e-3, 0.17, 0.5, 1, 2.75, 12]) {
    const c = f(skewMarkerC(0, ky));
    assert.ok(c > SKEW_C_MIN && c < 2, `ky ${ky}: c ${c} must say "shear" and stay under the shadow discard`);
    // The shader's reading (float32 math there; doubles here bound it from the same float32 c).
    const t = (c - 1.5) / SKEW_C_SPAN;
    const back = t / (1 - Math.abs(t));
    // Float32 holds c to 2^-24 near 1.5: the slope comes back to about 1e-7 · (1 + |ky|)².
    const tol = 2.5e-7 * (1 + Math.abs(ky)) ** 2;
    assert.ok(Math.abs(back - ky) <= tol, `ky ${ky}: read back ${back}`);
  }
  // Huge or infinite shears are held, short of c = 1 or 2.
  for (const ky of [1e9, Infinity, -1e9, -Infinity]) {
    const c = f(skewMarkerC(0, ky));
    assert.ok(c > SKEW_C_MIN && c < 2, `ky ${ky}: c ${c}`);
    const t = (c - 1.5) / SKEW_C_SPAN;
    assert.ok(Math.abs(t / (1 - Math.abs(t))) > 1e5, `ky ${ky}`);
  }
});

test('spawn, spawnMany and addDecoration take skewX and skewY: the shear is the facing, with no turn and no sway', () => {
  buildPoolScene({ decorations: 64, maxAttached: 4 });
  const plain = DecorationPool.spawn({ x: 10, y: 20, rotation: 0.5, sway: true });
  assert.deepEqual([D.skewX[plain], D.skewY[plain]], [0, 0]);
  assert.equal(D.rotC[plain], f(Math.cos(0.5)), 'unsheared: turned as before');
  assert.equal(D.sway[plain], SWAY_LOOP);

  const wall = Decoration.spawn({ x: 10, y: 20, skewY: -0.25, scaleX: 0.8, rotation: 0.5, sway: true, swaySkew: true });
  assert.deepEqual([D.skewX[wall], D.skewY[wall]], [0, -0.25]);
  assertSheared(wall, 0, -0.25, 'wall');
  assert.equal(D.sway[wall], SWAY_OFF, 'a sheared decoration does not sway');

  // spawnMany: one value for all of them, or one per decoration.
  const each = new Int32Array(3).fill(-1);
  assert.equal(Decoration.spawnMany({ x: [1, 2, 3], y: [4, 5, 6], skewY: [0.5, -0.5, 0], skewX: 0.1, out: each }), 3);
  assert.deepEqual([...each].map((i) => D.skewY[i]), [0.5, -0.5, 0]);
  assertSheared(each[0], 0.1, 0.5, 'spawnMany 0');
  assertSheared(each[2], 0.1, 0, 'spawnMany 2');
  assert.equal(D.rotC[each[2]], SWAY_SKEW_C, 'skewX alone is the shear sway marker');

  // addDecoration hands its extra fields to spawn.
  const piece = GameObject.prototype.addDecoration.call({ index: 5 }, null, 0, -300, 1, 1, 0, { skewY: 1.25 });
  assert.ok(piece >= 0);
  assert.equal(D.skewY[piece], 1.25);
  assertSheared(piece, 0, 1.25, 'attached piece');
});

test('the facade reads and writes the shear; a sheared decoration ignores rotation and sway; (0, 0) draws it unturned', () => {
  buildPoolScene({ decorations: 16, maxAttached: 2 });
  const i = Decoration.spawn({ x: 10, y: 20, rotation: 0.4, sway: true });
  const d = Decoration.get(i);
  assert.equal(d.skewY, 0);
  d.skewY = -0.25;
  assertSheared(i, 0, -0.25, 'skewY set');
  assert.equal(D.sway[i], SWAY_OFF, 'a shear stops the sway');
  d.skewX = 0.5;
  assert.equal(D.skewY[i], -0.25, 'setting one shear keeps the other');
  assertSheared(i, 0.5, -0.25, 'skewX set');
  assert.equal(d.rotation, 0);
  d.rotation = 1;
  d.baseRotation = 1;
  d.setBaseRotCS(0, 1);
  d.sway = true;
  d.impulseSway(0.2, 1);
  assertSheared(i, 0.5, -0.25, 'still sheared');
  assert.equal(D.sway[i], SWAY_OFF);
  d.setSkew(0, 0);
  assert.deepEqual([D.baseRotC[i], D.baseRotS[i], D.rotC[i], D.rotS[i]], [1, 0, 1, 0]);
  d.rotation = 0.3;
  assert.equal(D.rotC[i], f(Math.cos(0.3)), 'turns again once unsheared');

  // A facade kept past a despawn leaves the slot's next decoration alone, and the next one starts unsheared.
  d.setSkew(0.3, 0.3);
  Decoration.despawn(i);
  assert.equal(d.skewY, 0);
  const next = DecorationPool.spawn({ x: 1, y: 1 });
  assert.equal(next, i, 'the free list hands the slot back');
  assert.deepEqual([D.skewX[next], D.skewY[next], D.rotC[next], D.rotS[next]], [0, 0, 1, 0]);
  d.skewY = 2;
  assert.equal(D.skewY[next], 0);
});

test('an attached sheared decoration hangs unturned under a turned parent, on screen or off; the others turn as before', async () => {
  buildPoolScene({ decorations: 16, maxAttached: 4 });
  const kid = GameObject.prototype.addDecoration.call({ index: 2 }, null, 0, -30, 1, 1, 0, { skewY: 1.5 });
  assert.equal(D.inheritParentRotation[kid], 0, 'spawn hangs a sheared decoration unturned');
  const turned = Decoration.spawn({ parent: 2, localY: -30, skewY: 0 });
  assert.equal(D.inheritParentRotation[turned], 1);
  Decoration.get(turned).setSkew(0.2, 0);
  assert.equal(D.inheritParentRotation[turned], 0, 'and so does setSkew');

  const s = await setupAttachedSway({ n: 400, parents: 8 });
  // Parent 0 turned 0.6 rad. Decorations 0 and 8 hang from it sheared, as spawn leaves them: 0 on screen, 8 off.
  Transform.rotC[0] = Math.cos(0.6);
  Transform.rotS[0] = Math.sin(0.6);
  for (const [i, kx, ky, on] of [[0, 0.2, -0.75, 1], [8, 0, 1.5, 0]]) {
    D.skewX[i] = kx;
    D.skewY[i] = ky;
    D.baseRotC[i] = skewMarkerC(kx, ky);
    D.baseRotS[i] = kx;
    D.sway[i] = SWAY_OFF;
    D.inheritParentRotation[i] = 0;
    D.isItOnScreen[i] = on;
  }
  // 16 hangs from it too, unsheared and still: it turns with the parent.
  D.sway[16] = SWAY_OFF;
  D.isItOnScreen[16] = 1;
  s.frame();
  assertSheared(0, 0.2, -0.75, 'on screen');
  assertSheared(8, 0, 1.5, 'off screen');
  assert.equal(D.x[0], f(Transform.x[0] + D.localX[0]), 'hung at parent + local, unturned');
  assert.equal(D.y[0], f(Transform.y[0] + D.localY[0]));
  assert.equal(D.rotC[16], f(f(Math.cos(0.6)) * D.baseRotC[16] - f(Math.sin(0.6)) * D.baseRotS[16]));
});

/** Nearly upright swaying decorations: base angles of ±0.05 rad, so the sway crosses upright under the small angle. */
function nearlyUpright(n) {
  for (let i = 0; i < n; i++) {
    const r = ((i % 41) - 20) * 0.0025;
    D.baseRotC[i] = Math.cos(r);
    D.baseRotS[i] = Math.sin(r);
    D.swayAmplitude[i] = 0.075;
    D.swayFrequency[i] = 1;
    D.sway[i] = SWAY_LOOP;
    D.isItOnScreen[i] = 1;
  }
}

/** Each facing drawn by the shader must be that facing read as a turn. Returns how many passed a cosine of 1. */
function assertTurned(n, label) {
  let overUnit = 0;
  for (let i = 0; i < n; i++) {
    const c = D.rotC[i];
    const s = D.rotS[i];
    if (c > 1) overUnit++;
    const [x, y] = drawn(c, s, 10, -100);
    assert.ok(Math.abs(x - (10 * c + 100 * s)) < 1e-4 && Math.abs(y - (10 * s - 100 * c)) < 1e-4, `${label} ${i}: c ${c}, s ${s}, drawn ${x}, ${y}`);
  }
  return overUnit;
}

test('a swayed facing past 1 is a turn, not a shear: the attached pass', async () => {
  const s = await setupAttachedSway({ n: 400, parents: 8 });
  nearlyUpright(s.n);
  s.frame();
  // The small angle composes (1, delta), not a unit pair: the case exists, or this test tests nothing.
  assert.ok(assertTurned(s.n, 'attached') > 0, 'no facing passed 1');
});

test('a swayed facing past 1 is a turn, not a shear: the world-owned sway kernel', async () => {
  const { worker, b } = await setupSwayKernel({ n: 400 });
  nearlyUpright(400);
  let overUnit = 0;
  for (let frame = 0; frame < 60; frame++) {
    worker.accumulatedTime += 1000 / 60;
    swayDecorationsWasm(b, worker, 1000 / 60);
    overUnit += assertTurned(400, `frame ${frame}`);
  }
  assert.ok(overUnit > 0, 'no facing passed 1');
});

test('the collect copies a sheared facing to the queue, and the shader reads it as the shear', async () => {
  const s = await setupDecorationCollect({ n: 64, parents: 4 });
  const { pre } = s;
  // As spawn writes them: 40 world-owned and sheared down 0.4, 41 leaning 0.6.
  D.rotC[40] = skewMarkerC(0, -0.4);
  D.rotS[40] = 0;
  D.rotC[41] = skewMarkerC(0.6, 0);
  D.rotS[41] = 0.6;
  assert.equal(s.frame(), s.n);
  const rowOf = (i) => {
    for (let k = 0; k < pre._renderableCount; k++) if (pre._renderableIndex[k] === i) return k;
    throw new Error(`decoration ${i} was not collected`);
  };
  const p40 = drawn(pre._collectRotC[rowOf(40)], pre._collectRotS[rowOf(40)], 10, -20);
  assert.ok(Math.abs(p40[0] - 10) < 1e-6 && Math.abs(p40[1] - (-20 - 0.4 * 10)) < 1e-5, `40: ${p40}`);
  const p41 = drawn(pre._collectRotC[rowOf(41)], pre._collectRotS[rowOf(41)], 10, -20);
  assert.ok(Math.abs(p41[0] - (10 - 0.6 * 20)) < 1e-5 && Math.abs(p41[1] + 20) < 1e-6, `41: ${p41}`);
});
