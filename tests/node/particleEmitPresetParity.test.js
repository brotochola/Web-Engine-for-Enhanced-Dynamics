// E-538: one compiled core for literal emits and presets. Every config goes through the emitter before E-538
// (tests/helpers/legacyParticleEmitter.mjs, main da2b8eb5's code) and through today's, on the same columns, the same
// free-list order and the same seeded generator: every particle column must come out bit for bit the same, the
// generator must stand at the same number after it (the same draws, in the same order), and the same count must come
// back. Then a preset (define + emitPreset) against the old literal emit of the same config, its per-emit arguments and
// its with* overrides against the old emit of the config they stand for.
import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { Layer } from '../../src/core/layer.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { PARTICLE_EASE } from '../../src/util/configDefaults.js';
import { seededRandom, rng } from '../../src/util/utils.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import { LegacyParticleEmitter } from '../helpers/legacyParticleEmitter.mjs';

const POOL = 512;
const COLUMNS = Object.keys(ParticleComponent.ARRAY_SCHEMA);

function setup() {
  Layer.reset();
  Layer.initializeFromConfig({ fx: { zIndex: 5 }, glow: { zIndex: 6 } }, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  ParticleComponent.initializeArrays(new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL)), POOL);
  ParticleComponent.particleCount = POOL;
  for (const P of [ParticleEmitter, LegacyParticleEmitter]) {
    P.reset();
    P.initialize(POOL);
    P.initializeFreeList(new SharedArrayBuffer(POOL * 2), new SharedArrayBuffer(8));
  }
  SpriteSheetRegistry.clearForSceneUnload();
  // Animations are textures; civil1_hurt's frames f0..f5 are textures too (getFrameName -> getTextureId).
  SpriteSheetRegistry.register('bigAtlas', {
    animations: {
      blood: ['blood'], spark: ['spark'], smoke: ['smoke'], muzzle1: ['muzzle1'], muzzle2: ['muzzle2'], muzzle3: ['muzzle3'],
      civil1_hurt: ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'],
      f0: ['f0'], f1: ['f1'], f2: ['f2'], f3: ['f3'], f4: ['f4'], f5: ['f5'],
    },
  });
}

/** Run `emitWith` on fresh columns and a fresh free list, seeded: what it wrote, returned and left the generator at. */
function run(Emitter, seed, emitWith) {
  for (const key of COLUMNS) ParticleComponent[key].fill(0);
  ParticleComponent.rotC.fill(1);
  ParticleComponent.renderOnlyLive[0] = 0;
  Emitter.resetFreeListInterleaved(1);
  Emitter._warnedPoolExhausted = false;
  globalThis.rng = seededRandom(seed, 'parity');
  // Warn-once state (a missing layer, the debug build's checks) from the other side's run.
  Layer._subscriptionWarned.clear();
  resetWarnOnce();
  const warnings = [];
  const saved = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let returned;
  try {
    returned = emitWith(Emitter);
  } finally {
    console.warn = saved;
  }
  const columns = {};
  for (const key of COLUMNS) columns[key] = ParticleComponent[key].slice();
  return { returned, next: rng(), columns, warnings, live: ParticleComponent.renderOnlyLive[0] };
}

/** The slots a run left active, in slot order. */
function liveSlots() {
  const out = [];
  for (let i = 0; i < POOL; i++) if (ParticleComponent.active[i]) out.push(i);
  return out;
}

function assertSame(a, b, label) {
  assert.equal(b.returned, a.returned, `${label}: particles spawned`);
  for (const key of COLUMNS) {
    const x = a.columns[key];
    const y = b.columns[key];
    for (let i = 0; i < x.length; i++) {
      if (!Object.is(x[i], y[i])) assert.fail(`${label}: ${key}[${i}] ${y[i]} where the old emit wrote ${x[i]}`);
    }
  }
  assert.equal(b.live, a.live, `${label}: renderOnlyLive`);
  assert.equal(b.next, a.next, `${label}: the generator's next number (the draws)`);
  // The same warnings; a frame list's missing frames now warn once per emit, not once per particle.
  assert.deepEqual([...new Set(b.warnings)], [...new Set(a.warnings)], `${label}: warnings`);
}

const MODES = ['emit', 'emitZenithal', 'emitFlat'];
const DEFINE = { emit: 'define', emitZenithal: 'defineZenithal', emitFlat: 'defineFlat' };

/** Hand-picked configs: every branch of the old spawn loop. */
const CASES = [
  { count: 3, x: 10, y: 20, lifespan: 500 },
  { count: { min: 2, max: 9 }, x: { min: 0, max: 100 }, y: { min: -5, max: 5 }, z: { min: -40, max: -10 }, texture: 'blood' },
  { count: 4.5, x: 1, y: 2, z: -3, dirX: 0.6, dirY: 0.8, speed: { min: 1, max: 4 }, spread: 0.3 },
  { count: 5, x: 1, y: 2, z: -3, dirX: -1, dirY: 0, speed: 2, spread: { min: -0.5, max: 0.5 } },
  { count: 5, x: 1, y: 2, z: -3, dirX: 0, dirY: 1, speed: 2, spread: 0 },
  { count: 5, x: 1, y: 2, dirX: 0, dirY: 1, speed: null },
  { count: 6, x: 0, y: 0, z: -1, angleXY: { min: 0, max: 360 }, speed: { min: 0.7, max: 1.66 }, vz: { min: -4, max: 0 } },
  { count: 6, x: 0, y: 0, z: -1, angleXY: 45, speed: 3 },
  { count: 6, x: 0, y: 0, z: -1, angleXY: null, speed: 3 },
  { count: 6, x: 0, y: 0, z: -1, angleXY: 30 },
  { count: 4, x: 0, y: 0, vx: { min: -2, max: 2 }, vy: 3, vz: 2, gravity: 0.4 },
  { count: 4, x: 0, y: 0, scale: { min: 0.12, max: 0.3 }, alpha: { min: 0.66, max: 0.95 }, tint: { min: 0xaaaaaa, max: 0xffffff } },
  { count: 4, x: 0, y: 0, scaleX: { min: 0.5, max: 1 }, scaleY: { min: 0.5, max: 1 }, rotC: 0.6, rotS: -0.8, alpha: 0.7 },
  { count: 4, x: 0, y: 0, scaleX: 2 },
  { count: 4, x: 0, y: 0, scaleX: { from: 1, to: 3, ease: PARTICLE_EASE.QUAD_OUT }, scaleY: { from: { min: 1, max: 2 }, to: 0 } },
  { count: 4, x: 0, y: 0, scale: { from: { min: 0.25, max: 0.4 }, to: { min: 0.6, max: 1 }, ease: PARTICLE_EASE.QUAD_OUT } },
  { count: 4, x: 0, y: 0, alpha: { from: { min: 0.15, max: 0.3 }, to: 0 }, tint: { from: 0xffe8b0, to: 0xff2a00, ease: PARTICLE_EASE.QUAD_OUT } },
  { count: 4, x: 0, y: 0, tint: { start: { min: 0x101010, max: 0x808080 }, end: { min: 0xff0000, max: 0xffff00 } } },
  { count: 4, x: 0, y: 0, alpha: { from: 1, to: 0, ease: PARTICLE_EASE.QUAD_IN }, scale: { from: 1, to: 3, ease: PARTICLE_EASE.CUBIC_OUT } },
  { count: 4, x: 0, y: 0, rotation: { min: 0, max: 360 }, angularVelocity: { min: -0.5, max: 0.5 } },
  { count: 4, x: 0, y: 0, rotation: { from: 0, to: 180, ease: PARTICLE_EASE.BACK_OUT }, angularVelocity: { from: 1, to: 0 } },
  { count: 4, x: 0, y: 0, rotation: 90, angularVelocity: 0.25 },
  { count: 4, x: 0, y: 0, rotation: { from: { min: 0, max: 90 }, to: 360 }, alpha: { from: 1, to: 0, ease: PARTICLE_EASE.EXPO_IN } },
  { count: 4, x: 0, y: 0, z: -8, flipX: true, flipY: 1, fadeOnTheFloor: 300, stayOnTheFloor: true, despawnOnGroundContact: true },
  { count: 4, x: 0, y: 0, z: -8, bounces: { min: 1, max: 3 }, bounciness: { min: 0.2, max: 0.5 }, bounceFriction: 0.6 },
  { count: 4, x: 0, y: 0, z: -8, bounces: 400 },
  { count: 4, x: 0, y: 0, blendMode: 1, renderOnly: true, layer: 'fx' },
  { count: 4, x: 0, y: 0, layers: ['fx', 'glow'] },
  { count: 4, x: 0, y: 0, layers: null },
  { count: 4, x: 0, y: 0, layer: 'nowhere' },
  { count: 4, x: 0, y: 0, lightRadius: 120 },
  { count: 4, x: 0, y: 0, lightRadius: { min: 40, max: 90 } },
  { count: 4, x: 0, y: 0, lightRadius: { min: -1, max: 90 } },
  { count: 4, x: 0, y: 0, lightRadius: -5 },
  { count: 3, x: 0, y: 0, texture: 'nothere' },
  { count: 3, x: 0, y: 0, spritesheet: 'civil1', animation: 'hurt', frame: -1 },
  { count: 3, x: 0, y: 0, spritesheet: 'civil1', animation: 'hurt' },
  { count: 3, x: 0, y: 0, spritesheet: 'civil1', animation: 'hurt', frame: 9 },
  { count: 3, x: 0, y: 0, spritesheet: 'civil1', animation: 'hurt', frame: [0, 2, 4] },
  { count: 3, x: 0, y: 0, spritesheet: 'civil1', animation: 'hurt', frame: [0, 2, 4, 5], anim: 'random' },
  { count: 3, x: 0, y: 0, spritesheet: 'civil1', animation: 'hurt', frame: [3], anim: 'random', texture: 'blood' },
  { count: 3, x: 0, y: 0, spritesheet: 'civil1', animation: 'hurt', frame: [0, 1, 2, 3, 4, 5, 0, 1, 2, 3] },
  { count: 3, x: 0, y: 0, spritesheet: 'civil1', animation: 'walk', frame: [0, 1] },
  { count: 3, x: 0, y: 0, animation: 'hurt', texture: 'spark' },
  // Mixed eases: easeIds holds each property's.
  {
    count: 3, x: 0, y: 0,
    alpha: { from: 1, to: 0, ease: PARTICLE_EASE.QUAD_IN },
    scale: { from: 1, to: 2, ease: PARTICLE_EASE.QUAD_OUT },
    tint: { from: 0xffffff, to: 0, ease: PARTICLE_EASE.CUBIC_IN },
    rotation: { from: 0, to: 90, ease: PARTICLE_EASE.BOUNCE_OUT },
    angularVelocity: { from: 0, to: 1, ease: PARTICLE_EASE.EXPO_OUT },
  },
  // Predator's: the sparks of a shot, a wall's chips, blood.
  {
    count: 14, x: 300, y: 401, z: -34, dirX: 0.8, dirY: -0.6, spread: (10 * Math.PI) / 180, speed: { min: 0.1, max: 10 },
    rotation: { min: 0, max: 360 }, vz: { min: -1, max: 5 }, gravity: 0.4, lifespan: { min: 33, max: 100 },
    scale: { min: 0.15, max: 0.5 }, texture: 'spark', tint: { min: 0xffff00, max: 0xffffff }, alpha: { min: 0.5, max: 0.8 },
    despawnOnGroundContact: true,
  },
  { count: 0, x: 0, y: 0 },
  { count: -3, x: 0, y: 0 },
  { count: NaN, x: 0, y: 0 },
];

test('every hand-picked config writes what the old emit wrote, in each mode', () => {
  setup();
  for (const [k, cfg] of CASES.entries()) {
    for (const mode of MODES) {
      const label = `${mode} case ${k} ${JSON.stringify(cfg)}`;
      const old = run(LegacyParticleEmitter, 1000 + k, (E) => E[mode](cfg));
      const now = run(ParticleEmitter, 1000 + k, (E) => E[mode](cfg));
      assertSame(old, now, label);
    }
  }
});

/** A seeded config of random keys, values and forms (numbers, ranges, tweens), for the fuzz. */
function randomConfig(r) {
  const pick = (list) => list[(r() * list.length) | 0];
  const num = (lo, hi) => lo + r() * (hi - lo);
  const val = (lo, hi) => (r() < 0.5 ? num(lo, hi) : { min: num(lo, hi), max: num(lo, hi) });
  const op = (lo, hi) => {
    const f = r();
    if (f < 0.3) return num(lo, hi);
    if (f < 0.6) return { min: num(lo, hi), max: num(lo, hi) };
    return { from: val(lo, hi), to: val(lo, hi), ...(r() < 0.5 ? { ease: (r() * 14) | 0 } : {}) };
  };
  const color = () => (r() < 0.3 ? (r() * 0xffffff) | 0 : { min: (r() * 0xffffff) | 0, max: (r() * 0xffffff) | 0 });
  const cfg = { x: val(-100, 100), y: val(-100, 100) };
  if (r() < 0.7) cfg.count = r() < 0.5 ? (r() * 12) | 0 : { min: num(0, 4), max: num(4, 14) };
  if (r() < 0.6) cfg.z = val(-60, 0);
  const v = r();
  if (v < 0.3) {
    const a = r() * Math.PI * 2;
    cfg.dirX = Math.cos(a);
    cfg.dirY = Math.sin(a);
    if (r() < 0.9) cfg.speed = val(0, 8);
    if (r() < 0.6) cfg.spread = r() < 0.5 ? num(0, 1) : { min: num(-1, 0), max: num(0, 1) };
  } else if (v < 0.6) {
    cfg.angleXY = val(0, 360);
    if (r() < 0.9) cfg.speed = val(0, 8);
  } else {
    if (r() < 0.7) cfg.vx = val(-3, 3);
    if (r() < 0.7) cfg.vy = val(-3, 3);
  }
  if (r() < 0.6) cfg.vz = val(-6, 2);
  if (r() < 0.7) cfg.lifespan = val(30, 3000);
  if (r() < 0.5) cfg.gravity = num(-0.2, 1);
  const s = r();
  if (s < 0.4) cfg.scale = op(0, 3);
  else if (s < 0.6) {
    cfg.scaleX = op(0, 3);
    cfg.scaleY = op(0, 3);
  } else if (s < 0.7) cfg.scaleY = op(0, 3);
  if (r() < 0.6) cfg.alpha = op(0, 1);
  if (r() < 0.5) cfg.tint = r() < 0.7 ? color() : { from: color(), to: color(), ...(r() < 0.5 ? { ease: (r() * 14) | 0 } : {}) };
  if (r() < 0.15) {
    cfg.rotC = num(-1, 1);
    cfg.rotS = num(-1, 1);
  } else if (r() < 0.6) cfg.rotation = op(0, 360);
  if (r() < 0.3) cfg.angularVelocity = op(-1, 1);
  if (r() < 0.2) cfg.flipX = r() < 0.5;
  if (r() < 0.2) cfg.flipY = r() < 0.5;
  if (r() < 0.2) cfg.fadeOnTheFloor = (r() * 800) | 0;
  if (r() < 0.3) cfg.stayOnTheFloor = r() < 0.5;
  if (r() < 0.3) cfg.despawnOnGroundContact = r() < 0.5;
  if (r() < 0.2) {
    cfg.bounces = val(0, 4);
    if (r() < 0.5) cfg.bounciness = val(0, 1);
    if (r() < 0.5) cfg.bounceFriction = val(0, 1);
  }
  if (r() < 0.1) cfg.blendMode = 1;
  if (r() < 0.1) cfg.renderOnly = true;
  if (r() < 0.2) cfg.lightRadius = val(0, 200);
  if (r() < 0.2) cfg.layer = pick(['fx', 'glow']);
  else if (r() < 0.1) cfg.layers = ['fx', 'glow'];
  const t = r();
  if (t < 0.5) cfg.texture = pick(['blood', 'spark', 'smoke']);
  else if (t < 0.6) {
    cfg.spritesheet = 'civil1';
    cfg.animation = 'hurt';
    cfg.frame = r() < 0.5 ? ((r() * 6) | 0) : [0, 1, 2, 3].slice(0, 1 + ((r() * 4) | 0));
    if (r() < 0.5) cfg.anim = 'random';
  }
  return cfg;
}

test('three hundred seeded random configs write what the old emit wrote, in each mode', () => {
  setup();
  const r = seededRandom(538, 'fuzz');
  for (let k = 0; k < 300; k++) {
    const cfg = randomConfig(r);
    const mode = MODES[k % 3];
    const old = run(LegacyParticleEmitter, k, (E) => E[mode](cfg));
    const now = run(ParticleEmitter, k, (E) => E[mode](cfg));
    assertSame(old, now, `fuzz ${k} ${mode} ${JSON.stringify(cfg)}`);
  }
});

test('emitAlongLine writes what the old one wrote', () => {
  setup();
  const lines = [
    { x0: 0, y0: 0, x1: 100, y1: 50, count: 6, vx: { min: -0.5, max: 0.5 }, vy: { min: -0.5, max: 0.5 }, texture: 'spark' },
    { x0: 5, y0: 5, x1: -100, y1: 50, count: { min: 3, max: 9 }, scale: { from: { min: 1, max: 1.4 }, to: { min: 1.5, max: 2 } }, alpha: { from: { min: 0.55, max: 0.95 }, to: 0 }, layer: 'fx', gravity: -0.1 },
    { x0: 0, y0: 0, x1: 10, y1: 10 },
  ];
  for (const [k, cfg] of lines.entries()) {
    const old = run(LegacyParticleEmitter, 70 + k, (E) => E.emitAlongLine(cfg));
    const now = run(ParticleEmitter, 70 + k, (E) => E.emitAlongLine(cfg));
    assertSame(old, now, `line ${k}`);
  }
});

test('a pool that runs out mid-emit spawns what it can, as before, and warns once', () => {
  setup();
  const cfg = { count: POOL + 40, x: { min: 0, max: 10 }, y: 0, lifespan: { min: 100, max: 200 } };
  const old = run(LegacyParticleEmitter, 9, (E) => E.emit(cfg) + E.emit(cfg));
  const now = run(ParticleEmitter, 9, (E) => E.emit(cfg) + E.emit(cfg));
  assertSame(old, now, 'exhausted');
  assert.equal(now.returned, POOL);
  assert.equal(now.warnings.length, 1);
});

test('a preset writes what the old emit of its config wrote; its emit arguments what the old emit of the config with them', () => {
  setup();
  const r = seededRandom(5380, 'presets');
  for (let k = 0; k < 200; k++) {
    const cfg = randomConfig(r);
    const mode = MODES[k % 3];
    const id = ParticleEmitter[DEFINE[mode]](cfg);
    const old = run(LegacyParticleEmitter, k, (E) => E[mode](cfg));
    const now = run(ParticleEmitter, k, (E) => E.emitPreset(id));
    assertSame(old, now, `preset ${k} ${mode} ${JSON.stringify(cfg)}`);

    // Per emit: a position, a height, a direction and a count, each over the preset's own.
    const a = r() * Math.PI * 2;
    const args = { x: r() * 500, y: r() * 500, z: -r() * 40, dirX: Math.cos(a), dirY: Math.sin(a), count: (r() * 9) | 0 };
    const withArgs = { ...cfg, ...args };
    const oldArgs = run(LegacyParticleEmitter, k, (E) => E[mode](withArgs));
    const nowArgs = run(ParticleEmitter, k, (E) => E.emitPreset(id, args.x, args.y, args.z, args.count, args.dirX, args.dirY));
    assertSame(oldArgs, nowArgs, `preset ${k} ${mode} with ${JSON.stringify(args)}`);

    // Some of them: undefined keeps the preset's.
    const some = { ...cfg, x: args.x, y: args.y };
    const oldSome = run(LegacyParticleEmitter, k, (E) => E[mode](some));
    const nowSome = run(ParticleEmitter, k, (E) => E.emitPreset(id, args.x, args.y));
    assertSame(oldSome, nowSome, `preset ${k} ${mode} with x and y only`);
  }
});

/** cfg's value `v` (a number, a range, or a tween of them) with every value and range end times f. */
function times(v, f) {
  if (v === undefined || v === null) return v;
  if (typeof v === 'number') return v * f;
  if ('from' in v || 'to' in v || 'start' in v || 'end' in v) {
    const out = { ...v };
    for (const k of ['from', 'to', 'start', 'end']) if (k in v) out[k] = times(v[k], f);
    return out;
  }
  return { ...v, ...('min' in v ? { min: v.min * f } : {}), ...('max' in v ? { max: v.max * f } : {}) };
}

test('the with* overrides write what the old emit of the config they stand for wrote', () => {
  setup();
  const r = seededRandom(53800, 'overrides');
  for (let k = 0; k < 200; k++) {
    const cfg = randomConfig(r);
    const mode = MODES[k % 3];
    const id = ParticleEmitter[DEFINE[mode]](cfg);
    const vz = -2 - r() * 4;
    const fx = r() < 0.5;
    const fy = r() < 0.5;
    const fs = 0.25 + r() * 2;
    const fa = r();
    const fv = 0.5 + r() * 3;
    // The old form of each: vz a value, the flips, the scale's, alpha's and speed's ends times the factor (one of
    // scale, scaleX, scaleY, as the emit reads it; with scale unset and both axes set, both axes).
    const stand = { ...cfg, vz, flipX: fx, flipY: fy, alpha: times(cfg.alpha ?? 1, fa), speed: times(cfg.speed, fv) };
    if (cfg.speed === undefined) delete stand.speed;
    if (cfg.scale == null && cfg.scaleX != null && cfg.scaleY != null) {
      stand.scaleX = times(cfg.scaleX, fs);
      stand.scaleY = times(cfg.scaleY, fs);
    } else {
      stand.scale = times(cfg.scale ?? cfg.scaleX ?? cfg.scaleY ?? 1, fs);
    }
    const old = run(LegacyParticleEmitter, k, (E) => E[mode](stand));
    const now = run(ParticleEmitter, k, (E) =>
      E.withVz(vz).withFlip(fx, fy).withScaleFactor(fs).withAlphaFactor(fa).withSpeedFactor(fv).emitPreset(id));
    assertSame(old, now, `overrides ${k} ${mode} ${JSON.stringify(cfg)}`);
    // The literal form reads them as well.
    const lit = run(ParticleEmitter, k, (E) =>
      E.withVz(vz).withFlip(fx, fy).withScaleFactor(fs).withAlphaFactor(fa).withSpeedFactor(fv)[mode](cfg));
    assertSame(old, lit, `overrides ${k} ${mode} on the literal`);
  }
});

test('the overrides hold for one emit only: the next emit is the preset as defined', () => {
  setup();
  const cfg = { count: 3, x: 1, y: 2, z: -5, vz: { min: -4, max: -2 }, scale: { min: 1, max: 2 }, alpha: 0.5, speed: 2, angleXY: { min: 0, max: 360 } };
  const id = ParticleEmitter.define(cfg);
  const old = run(LegacyParticleEmitter, 3, (E) => E.emit({ ...cfg, vz: -1 }) + E.emit(cfg));
  const now = run(ParticleEmitter, 3, (E) => E.withVz(-1).emitPreset(id) + E.emitPreset(id));
  assertSame(old, now, 'one emit');
  // An emit that spawns nothing (pool not ready) clears them too.
  const saved = ParticleEmitter.initialized;
  ParticleEmitter.initialized = false;
  try {
    assert.equal(ParticleEmitter.withVz(-1).withScaleFactor(9).emitPreset(id, 1, 2), 0);
  } finally {
    ParticleEmitter.initialized = saved;
  }
  const after = run(ParticleEmitter, 3, (E) => E.emitPreset(id));
  const plain = run(LegacyParticleEmitter, 3, (E) => E.emit(cfg));
  assertSame(plain, after, 'cleared by an emit that spawned nothing');
});

test('a texture list picks one per particle, drawn first: the same as the caller drawing it before the emit', () => {
  setup();
  // Predator's muzzle sprite: before E-538 the caller drew the texture, then scaleX, scaleY and alpha.
  const muzzle = ParticleEmitter.define({
    count: 1, texture: ['muzzle1', 'muzzle2', 'muzzle3'], scaleX: { min: 0.5, max: 1 }, scaleY: { min: 0.5, max: 1 },
    alpha: { min: 0.5, max: 1 }, gravity: 0, lifespan: 50, faceDirection: true,
  });
  for (let k = 0; k < 40; k++) {
    const a = k * 0.7;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const old = run(LegacyParticleEmitter, k, (E) =>
      E.emit({
        count: 1, x: 10, y: 11, texture: 'muzzle' + Math.floor(rng() * 3 + 1), scaleX: rng() * 0.5 + 0.5,
        scaleY: rng() * 0.5 + 0.5, rotC: dx, rotS: dy, alpha: rng() * 0.5 + 0.5, z: -34, gravity: 0, lifespan: 50, speed: 0,
      }));
    const now = run(ParticleEmitter, k, (E) => E.emitPreset(muzzle, 10, 11, -34, 1, dx, dy));
    assertSame(old, now, `muzzle ${k}`);
  }
});

test('faceDirection turns each particle to its own direction: the spread one, or the angle one', () => {
  setup();
  const id = ParticleEmitter.define({ count: 20, x: 0, y: 0, z: -5, speed: { min: 1, max: 3 }, spread: 0.4, faceDirection: true });
  run(ParticleEmitter, 4, (E) => E.emitPreset(id, 0, 0, -5, undefined, 0, 1));
  const pc = ParticleComponent;
  for (const i of liveSlots()) {
    const speed = Math.sqrt(pc.vx[i] * pc.vx[i] + pc.vy[i] * pc.vy[i]);
    assert.ok(Math.abs(pc.rotC[i] - pc.vx[i] / speed) < 1e-5 && Math.abs(pc.rotS[i] - pc.vy[i] / speed) < 1e-5, `particle ${i} faces its flight`);
  }
  const angled = ParticleEmitter.define({ count: 20, x: 0, y: 0, z: -5, angleXY: { min: 0, max: 360 }, speed: 2, faceDirection: true });
  run(ParticleEmitter, 5, (E) => E.emitPreset(angled));
  assert.equal(liveSlots().length, 20);
  for (const i of liveSlots()) {
    assert.ok(Math.abs(pc.rotC[i] - pc.vx[i] / 2) < 1e-5 && Math.abs(pc.rotS[i] - pc.vy[i] / 2) < 1e-5, `particle ${i} faces its angle`);
  }
  // No direction at all: the rotation key.
  const still = ParticleEmitter.define({ count: 1, x: 0, y: 0, rotation: 90, faceDirection: true });
  run(ParticleEmitter, 6, (E) => E.emitPreset(still));
  assert.ok(Math.abs(pc.rotS[liveSlots()[0]] - 1) < 1e-6, 'rotation 90 without a direction');
});

test('define refuses what an emit cannot read, and emitPreset what define did not make', () => {
  assert.throws(() => ParticleEmitter.define({ count: 1, anchorX: 0 }), /"anchorX" is not an emit key/);
  assert.throws(() => ParticleEmitter.define(null), TypeError);
  assert.throws(() => ParticleEmitter.define({ texture: [] }), /1 to 8 names/);
  assert.throws(() => ParticleEmitter.define({ texture: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }), /1 to 8 names/);
  assert.throws(() => ParticleEmitter.define({ alpha: { from: 1, to: 0, ease: 'quad.out' } }), TypeError);
  assert.throws(() => ParticleEmitter.emitPreset(-1, 0, 0), /not a preset/);
  assert.throws(() => ParticleEmitter.emitPreset(1e6, 0, 0), /not a preset/);
  assert.throws(() => ParticleEmitter.emitPreset(0.5, 0, 0), /not a preset/);
});

test('a preset keeps its config as defined: changing the object afterwards changes nothing', () => {
  setup();
  const cfg = { count: 3, x: 0, y: 0, texture: ['spark', 'smoke'], layers: ['fx'], scale: { min: 1, max: 2 } };
  const id = ParticleEmitter.define(cfg);
  const before = run(ParticleEmitter, 8, (E) => E.emitPreset(id));
  cfg.texture.push('blood');
  cfg.layers.push('glow');
  cfg.scale.max = 50;
  cfg.count = 9;
  const after = run(ParticleEmitter, 8, (E) => E.emitPreset(id));
  assertSame(before, after, 'the same preset');
});

test('presets outlive a scene change: reset() keeps them', () => {
  setup();
  const id = ParticleEmitter.define({ count: 2, x: 5, y: 6, texture: 'spark' });
  ParticleEmitter.reset();
  setup();
  assert.equal(run(ParticleEmitter, 1, (E) => E.emitPreset(id)).returned, 2);
  assert.equal(ParticleComponent.x[liveSlots()[0]], 5);
});
