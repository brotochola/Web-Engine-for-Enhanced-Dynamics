import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCommandRingSab,
  bindCommandRing,
  drainCommandRing,
  enqueueSetAwake,
  enqueueSetLiquidFunLight,
  enqueueSetLiquidFunLayers,
  BOX2D_CMD,
} from '../../src/box2d/box2dCommandRing.js';
import { LiquidFun, LIQUIDFUN_FLAGS } from '../../src/core/liquidFun.js';
import { Layer } from '../../src/core/layer.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Scene } from '../../src/core/scene.js';
import { PHYSICS_DEFAULTS } from '../../src/util/configDefaults.js';
import { validatePhysicsConfig } from '../../src/util/utils.js';
import { bindLiquidFunRender, liquidFunRenderByteSize } from '../../src/render/liquidFunRender.js';
import { bindLiquidFunGroups, liquidFunGroupsByteSize, LIQUIDFUN_GROUPS_MAX } from '../../src/util/liquidFunGroups.js';
import {
  createLiquidFunExtractSab,
  bindLiquidFunExtractSab,
  liquidFunExtractAsync,
  servicePendingLiquidFunExtractBurst,
  LIQUIDFUN_EXTRACT_DEFAULT_INDEX_CAP,
} from '../../src/box2d/liquidFunExtract.js';

test('extract SAB default cap matches C g_extract_indices (4096)', () => {
  assert.equal(LIQUIDFUN_EXTRACT_DEFAULT_INDEX_CAP, 4096);
});

test('extract burst services one pending extract', async () => {
  const sab = createLiquidFunExtractSab();
  bindLiquidFunExtractSab(sab);
  const idx = new Int32Array([3, 7, 11]);
  const pending = liquidFunExtractAsync(4, idx, 3, { groupFlags: 0 });
  await new Promise((r) => setTimeout(r, 0));
  const n = servicePendingLiquidFunExtractBurst((groupId, indices, count, groupFlags) => {
    assert.equal(groupId, 4);
    assert.equal(count, 3);
    assert.equal(indices[0], 3);
    assert.equal(groupFlags, 0);
    return 9;
  }, 8);
  assert.equal(n, 1);
  assert.equal(await pending, 9);
  bindLiquidFunExtractSab(null);
});

test('LIQUIDFUN_FLAGS match liquidfun-c lfParticleFlag', () => {
  assert.equal(LIQUIDFUN_FLAGS.WATER, 0);
  assert.equal(LIQUIDFUN_FLAGS.ZOMBIE, 1 << 0);
  assert.equal(LIQUIDFUN_FLAGS.WALL, 1 << 1);
  assert.equal(LIQUIDFUN_FLAGS.VISCOUS, 1 << 2);
  assert.equal(LIQUIDFUN_FLAGS.TENSILE, 1 << 3);
  assert.equal(LIQUIDFUN_FLAGS.ELASTIC, 1 << 4);
  assert.equal(LIQUIDFUN_FLAGS.POWDER, 1 << 5);
  assert.equal(LIQUIDFUN_FLAGS.SPRING, 1 << 6);
  assert.equal(LIQUIDFUN_FLAGS.BARRIER, 1 << 7);
  assert.equal(LIQUIDFUN_FLAGS.STATIC_PRESSURE, 1 << 8);
  assert.equal(LIQUIDFUN_FLAGS.COLOR_MIXING, 1 << 9);
  assert.equal(LIQUIDFUN_FLAGS.REPULSIVE, 1 << 10);
  assert.equal(LIQUIDFUN_FLAGS.REACTIVE, 1 << 11);
});

test('ParticleEmitter has no LiquidFun API (use LiquidFun class)', () => {
  assert.equal(typeof ParticleEmitter.emitLiquidFunParticles, 'undefined');
  assert.equal(typeof ParticleEmitter.getLiquidFunParticleGroups, 'undefined');
  assert.equal(typeof ParticleEmitter.setLiquidFunGroupViscousScale, 'undefined');
  assert.equal(typeof LiquidFun.emit, 'function');
  assert.equal(typeof LiquidFun.queryAABB, 'function');
  assert.equal(typeof LiquidFun.extract, 'function');
  assert.equal(typeof LiquidFun.setUserData, 'function');
  assert.equal(typeof LiquidFun.setFlags, 'function');
  assert.equal(typeof LiquidFun.rayCast, 'function');
  assert.equal(typeof LiquidFun.queryAABBAsync, 'function');
  assert.equal(typeof LiquidFun.rayCastAsync, 'function');
  assert.equal(typeof GameObject.prototype.liquidFunQueryAABB, 'undefined');
  assert.equal(typeof GameObject.prototype.liquidFunRayCast, 'undefined');
  assert.equal(typeof Scene.prototype.liquidFunQueryAABB, 'undefined');
  assert.equal(typeof Scene.prototype.liquidFunRayCast, 'undefined');
});

test('center+half box converts to a non-inverted AABB for WASM', () => {
  const posX = 2000;
  const posY = 100;
  const halfWidth = 60;
  const halfHeight = 60;
  const x0 = posX - halfWidth;
  const y0 = posY - halfHeight;
  const x1 = posX + halfWidth;
  const y1 = posY + halfHeight;
  assert.ok(x0 < x1);
  assert.ok(y0 < y1);
  assert.equal(x0, 1940);
  assert.equal(y0, 40);
  assert.equal(x1, 2060);
  assert.equal(y1, 160);
});

test('validatePhysicsConfig shallow-merges liquidFun defaults', () => {
  const merged = validatePhysicsConfig(null, {
    liquidFun: { enabled: true, radius: 8, maxCount: 0, subSteps: 0 },
  });
  assert.equal(merged.liquidFun.enabled, true);
  assert.equal(merged.liquidFun.radius, 8);
  assert.equal(merged.liquidFun.maxCount, 1);
  assert.equal(merged.liquidFun.subSteps, 1);
  assert.equal(merged.liquidFun.density, PHYSICS_DEFAULTS.liquidFun.density);
  assert.equal(merged.liquidFun.viscousStrength, PHYSICS_DEFAULTS.liquidFun.viscousStrength);
  assert.equal(merged.liquidFun.ejectionStrength, PHYSICS_DEFAULTS.liquidFun.ejectionStrength);
  assert.equal(merged.liquidFun.colorMixingStrength, 0.5);
  assert.equal(merged.liquidFun.repulsiveStrength, 1);
});

test('validatePhysicsConfig merges viscousStrength override', () => {
  const merged = validatePhysicsConfig(null, {
    liquidFun: { enabled: true, viscousStrength: 2.5 },
  });
  assert.equal(merged.liquidFun.viscousStrength, 2.5);
  assert.equal(merged.liquidFun.tensileStrength, PHYSICS_DEFAULTS.liquidFun.tensileStrength);
});

test('validatePhysicsConfig clamps liquidFun.maxCount to 65535', () => {
  const merged = validatePhysicsConfig(null, {
    liquidFun: { maxCount: 999999 },
  });
  assert.equal(merged.liquidFun.maxCount, 65535);
});

test('validatePhysicsConfig liquidFun is sim-only (no layer/renderScale)', () => {
  const merged = validatePhysicsConfig(null, {
    liquidFun: { enabled: true, layer: 'water', renderScale: 0.2 },
  });
  assert.equal(merged.liquidFun.layer, undefined);
  assert.equal(merged.liquidFun.renderScale, undefined);
  assert.equal(merged.liquidFun.enabled, true);
});

test('validatePhysicsConfig defaults strictContactCheck to false and respects override', () => {
  const defaulted = validatePhysicsConfig(null, { liquidFun: { enabled: true } });
  assert.equal(defaulted.liquidFun.strictContactCheck, false);
  assert.equal(defaulted.liquidFun.strictContactCheck, PHYSICS_DEFAULTS.liquidFun.strictContactCheck);

  const overridden = validatePhysicsConfig(null, {
    liquidFun: { enabled: true, strictContactCheck: true },
  });
  assert.equal(overridden.liquidFun.strictContactCheck, true);
});

test('LiquidFun enqueues SET_LIQUIDFUN_EMIT then create', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);

  LiquidFun.createSystem({ radius: 12, maxCount: 2000, subSteps: 3 });
  LiquidFun.emit({
    shape: 'box',
    posX: 100,
    posY: 200,
    halfWidth: 30,
    halfHeight: 40,
    flags: LIQUIDFUN_FLAGS.POWDER,
    spacing: 7,
    strength: 0.25,
    tint: 0xffcc00,
    textureId: 4,
  });
  LiquidFun.emit({
    flags: LIQUIDFUN_FLAGS.ELASTIC,
    strength: 0.55,
    tint: 0x33ff66,
    viscousScale: 1,
    shape: 'circle',
    posX: 150,
    posY: 250,
    radius: 25,
  });
  LiquidFun.destroyGroup(1);
  LiquidFun.destroySystem(0);

  const received = [];
  drainCommandRing(i32, f32, {
    createParticleSystem(systemId, radius, maxCount, subSteps) {
      received.push({ type: 'createParticleSystem', systemId, radius, maxCount, subSteps });
    },
    setLiquidFunEmit(packed, spacing, strength, tintBits, viscousScale) {
      received.push({
        type: 'setLiquidFunEmit',
        spacing,
        strength,
        tintBits: tintBits >>> 0,
        textureId: packed & 0xffff,
        trackGroup: (packed >>> 16) & 1,
        viscousScale,
      });
    },
    createParticleGroupBox(flags, posX, posY, halfWidth, halfHeight) {
      received.push({ type: 'createParticleGroupBox', flags, posX, posY, halfWidth, halfHeight });
    },
    createParticleGroupCircle(systemId, posX, posY, radius, flags) {
      received.push({ type: 'createParticleGroupCircle', systemId, posX, posY, radius, flags });
    },
    destroyParticleGroup(systemId, groupId) {
      received.push({ type: 'destroyParticleGroup', systemId, groupId });
    },
    destroyParticleSystem(systemId) {
      received.push({ type: 'destroyParticleSystem', systemId });
    },
  });

  assert.equal(BOX2D_CMD.SET_LIQUIDFUN_EMIT, 13);
  assert.equal(received.length, 7);
  assert.deepEqual(received[0], { type: 'createParticleSystem', systemId: 0, radius: 12, maxCount: 2000, subSteps: 3 });
  assert.deepEqual(received[1], {
    type: 'setLiquidFunEmit',
    spacing: 7,
    strength: 0.25,
    tintBits: 0xffcc00,
    textureId: 4,
    trackGroup: 0,
    viscousScale: 1,
  });
  assert.deepEqual(received[2], {
    type: 'createParticleGroupBox',
    flags: LIQUIDFUN_FLAGS.POWDER,
    posX: 100,
    posY: 200,
    halfWidth: 30,
    halfHeight: 40,
  });
  assert.equal(received[3].type, 'setLiquidFunEmit');
  assert.equal(received[3].spacing, 0);
  assert.ok(Math.abs(received[3].strength - 0.55) < 1e-6);
  assert.equal(received[3].tintBits, 0x33ff66);
  assert.equal(received[3].textureId, 0);
  assert.equal(received[3].viscousScale, 1);
  assert.deepEqual(received[4], {
    type: 'createParticleGroupCircle',
    systemId: 0,
    posX: 150,
    posY: 250,
    radius: 25,
    flags: LIQUIDFUN_FLAGS.ELASTIC,
  });
  assert.deepEqual(received[5], { type: 'destroyParticleGroup', systemId: 0, groupId: 1 });
  assert.deepEqual(received[6], { type: 'destroyParticleSystem', systemId: 0 });
});

test('thick viscous emit packs viscousScale 10', () => {
  const sab = createCommandRingSab(32);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  LiquidFun.emit({
    flags: LIQUIDFUN_FLAGS.VISCOUS | LIQUIDFUN_FLAGS.TENSILE,
    viscousScale: 10,
    tint: 0xc6862a,
    shape: 'circle',
    posX: 0,
    posY: 0,
    radius: 10,
  });
  const received = [];
  drainCommandRing(i32, f32, {
    setLiquidFunEmit(packed, spacing, strength, tintBits, viscousScale) {
      received.push({ viscousScale, trackGroup: (packed >>> 16) & 1 });
    },
    createParticleGroupCircle() {},
  });
  assert.equal(received[0].viscousScale, 10);
  assert.equal(received[0].trackGroup, 0);
});

test('setGroupViscousScale and setTuning enqueue', () => {
  const sab = createCommandRingSab(32);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  LiquidFun.setGroupViscousScale(3, 2.5);
  LiquidFun.setTuning({ viscousStrength: 1.5 });
  const received = [];
  drainCommandRing(i32, f32, {
    setGroupViscousScale(groupId, scale) {
      received.push({ type: 'setGroupViscousScale', groupId, scale });
    },
    setParticleTuning(phase, a, b, c, d) {
      received.push({ type: 'setParticleTuning', phase, a, b, c, d });
    },
  });
  assert.deepEqual(received[0], { type: 'setGroupViscousScale', groupId: 3, scale: 2.5 });
  assert.equal(received[1].type, 'setParticleTuning');
  assert.equal(received[1].phase, 0);
  assert.equal(received[1].c, 1.5);
  assert.equal(received.length, 5); // 1 setGroup + 4 tuning phases
});

test('LiquidFun enqueues SET_LIQUIDFUN_LIFESPAN (ms -> sec) only when options.lifespan is set', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);

  LiquidFun.createSystem();
  // No lifespan option - must not enqueue SET_LIQUIDFUN_LIFESPAN at all.
  LiquidFun.emit({ shape: 'circle', posX: 0, posY: 0, radius: 20 });
  // lifespan in ms, per ParticleComponent.lifespan's convention.
  LiquidFun.emit({
    shape: 'circle',
    posX: 10,
    posY: 20,
    radius: 20,
    lifespan: { min: 100, max: 1000 },
  });
  // Bare number = fixed life (min === max); fadeToAlpha0 defaults off.
  LiquidFun.emit({
    shape: 'circle',
    posX: 0,
    posY: 0,
    radius: 20,
    lifespan: 500,
  });
  // Explicit fade opt-in.
  LiquidFun.emit({
    shape: 'circle',
    posX: 0,
    posY: 0,
    radius: 20,
    lifespan: 200,
    fadeToAlpha0: true,
  });

  const received = [];
  drainCommandRing(i32, f32, {
    createParticleSystem() {},
    setLiquidFunEmit() {
      received.push({ type: 'setLiquidFunEmit' });
    },
    setLiquidFunLifespan(lifetimeMinSec, lifetimeMaxSec, fadeToAlpha0) {
      received.push({
        type: 'setLiquidFunLifespan',
        lifetimeMinSec,
        lifetimeMaxSec,
        fadeToAlpha0,
      });
    },
    createParticleGroupCircle() {
      received.push({ type: 'createParticleGroupCircle' });
    },
  });

  assert.equal(BOX2D_CMD.SET_LIQUIDFUN_LIFESPAN, 14);
  assert.deepEqual(
    received.map((r) => r.type),
    [
      'setLiquidFunEmit',
      'createParticleGroupCircle',
      'setLiquidFunEmit',
      'setLiquidFunLifespan',
      'createParticleGroupCircle',
      'setLiquidFunEmit',
      'setLiquidFunLifespan',
      'createParticleGroupCircle',
      'setLiquidFunEmit',
      'setLiquidFunLifespan',
      'createParticleGroupCircle',
    ],
  );
  const rangeCmd = received[3];
  assert.ok(Math.abs(rangeCmd.lifetimeMinSec - 0.1) < 1e-6, 'min: 100ms -> 0.1s');
  assert.ok(Math.abs(rangeCmd.lifetimeMaxSec - 1.0) < 1e-6, 'max: 1000ms -> 1.0s');
  assert.equal(rangeCmd.fadeToAlpha0, 0, 'fade defaults off');

  const numberCmd = received[6];
  assert.ok(Math.abs(numberCmd.lifetimeMinSec - 0.5) < 1e-6, 'number 500ms -> 0.5s min');
  assert.ok(Math.abs(numberCmd.lifetimeMaxSec - 0.5) < 1e-6, 'number 500ms -> 0.5s max');
  assert.equal(numberCmd.fadeToAlpha0, 0);

  const fadeCmd = received[9];
  assert.ok(Math.abs(fadeCmd.lifetimeMinSec - 0.2) < 1e-6);
  assert.ok(Math.abs(fadeCmd.lifetimeMaxSec - 0.2) < 1e-6);
  assert.equal(fadeCmd.fadeToAlpha0, 1, 'fadeToAlpha0: true -> 1');
});

test('LiquidFun enqueues SET_LIQUIDFUN_SCALE for scale/alpha only', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);

  LiquidFun.createSystem();
  LiquidFun.emit({ shape: 'circle', posX: 0, posY: 0, radius: 20 });
  LiquidFun.emit({
    shape: 'circle',
    posX: 0,
    posY: 0,
    radius: 20,
    scale: 0.2,
  });
  LiquidFun.emit({
    shape: 'circle',
    posX: 0,
    posY: 0,
    radius: 20,
    scale: { min: 0.12, max: 0.3 },
    alpha: 0.5,
  });

  const received = [];
  drainCommandRing(i32, f32, {
    createParticleSystem() {},
    setLiquidFunEmit() {
      received.push({ type: 'setLiquidFunEmit' });
    },
    setLiquidFunScale(scaleMin, scaleMax, alphaMin, alphaMax) {
      received.push({ type: 'setLiquidFunScale', scaleMin, scaleMax, alphaMin, alphaMax });
    },
    createParticleGroupCircle() {
      received.push({ type: 'createParticleGroupCircle' });
    },
  });

  assert.equal(BOX2D_CMD.SET_LIQUIDFUN_SCALE, 15);
  assert.deepEqual(
    received.map((r) => r.type),
    [
      'setLiquidFunEmit',
      'createParticleGroupCircle',
      'setLiquidFunEmit',
      'setLiquidFunScale',
      'createParticleGroupCircle',
      'setLiquidFunEmit',
      'setLiquidFunScale',
      'createParticleGroupCircle',
    ],
  );
  assert.ok(Math.abs(received[3].scaleMin - 0.2) < 1e-6);
  assert.ok(Math.abs(received[3].scaleMax - 0.2) < 1e-6);
  assert.ok(Math.abs(received[3].alphaMin - 1) < 1e-6);
  assert.ok(Math.abs(received[3].alphaMax - 1) < 1e-6);
  assert.ok(Math.abs(received[6].scaleMin - 0.12) < 1e-6);
  assert.ok(Math.abs(received[6].scaleMax - 0.3) < 1e-6);
  assert.ok(Math.abs(received[6].alphaMin - 0.5) < 1e-6);
  assert.ok(Math.abs(received[6].alphaMax - 0.5) < 1e-6);
});

test('LiquidFun enqueues SET_LIQUIDFUN_LIGHT and forces trackGroup', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  LiquidFun.createSystem();
  LiquidFun.emit({
    shape: 'circle',
    posX: 0,
    posY: 0,
    radius: 20,
    lightIntensity: 5000,
  });

  const received = [];
  drainCommandRing(i32, f32, {
    createParticleSystem() {},
    setLiquidFunEmit(packed) {
      received.push({ type: 'setLiquidFunEmit', packed });
    },
    setLiquidFunLight(lightIntensity) {
      received.push({ type: 'setLiquidFunLight', lightIntensity });
    },
    createParticleGroupCircle() {
      received.push({ type: 'createParticleGroupCircle' });
    },
  });

  assert.equal(BOX2D_CMD.SET_LIQUIDFUN_LIGHT, 26);
  assert.deepEqual(
    received.map((r) => r.type),
    ['setLiquidFunEmit', 'setLiquidFunLight', 'createParticleGroupCircle'],
  );
  assert.ok(received[0].packed & (1 << 16), 'lightIntensity forces trackGroup');
  assert.ok(Math.abs(received[1].lightIntensity - 5000) < 1e-6);
});

test('LiquidFun enqueues join/split/force ring commands', () => {
  const sab = createCommandRingSab(32);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);

  LiquidFun.joinParticleGroups(2, 5);
  LiquidFun.splitParticleGroup(7);
  LiquidFun.applyForce(3, 10, -4);
  LiquidFun.applyLinearImpulse(4, 1.5, 2.5);
  LiquidFun.groupApplyForce(8, 100, 50);
  LiquidFun.groupApplyLinearImpulse(9, -3, 6);

  const received = [];
  drainCommandRing(i32, f32, {
    joinParticleGroups(groupA, groupB) {
      received.push({ type: 'joinParticleGroups', groupA, groupB });
    },
    splitParticleGroup(groupId) {
      received.push({ type: 'splitParticleGroup', groupId });
    },
    particleApplyForce(index, fx, fy) {
      received.push({ type: 'particleApplyForce', index, fx, fy });
    },
    particleApplyImpulse(index, ix, iy) {
      received.push({ type: 'particleApplyImpulse', index, ix, iy });
    },
    groupApplyForce(groupId, fx, fy) {
      received.push({ type: 'groupApplyForce', groupId, fx, fy });
    },
    groupApplyImpulse(groupId, ix, iy) {
      received.push({ type: 'groupApplyImpulse', groupId, ix, iy });
    },
  });

  assert.equal(BOX2D_CMD.JOIN_PARTICLE_GROUPS, 18);
  assert.equal(BOX2D_CMD.SPLIT_PARTICLE_GROUP, 19);
  assert.equal(BOX2D_CMD.PARTICLE_APPLY_FORCE, 20);
  assert.deepEqual(received[0], { type: 'joinParticleGroups', groupA: 2, groupB: 5 });
  assert.deepEqual(received[1], { type: 'splitParticleGroup', groupId: 7 });
  assert.deepEqual(received[2], { type: 'particleApplyForce', index: 3, fx: 10, fy: -4 });
  assert.deepEqual(received[3], { type: 'particleApplyImpulse', index: 4, ix: 1.5, iy: 2.5 });
  assert.deepEqual(received[4], { type: 'groupApplyForce', groupId: 8, fx: 100, fy: 50 });
  assert.deepEqual(received[5], { type: 'groupApplyImpulse', groupId: 9, ix: -3, iy: 6 });
  assert.equal(received.length, 6);
});

test('LiquidFun.clear enqueues CLEAR_LIQUIDFUN_PARTICLES', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);

  LiquidFun.clear(0);

  const received = [];
  drainCommandRing(i32, f32, {
    clearLiquidFunParticles(systemId) {
      received.push({ type: 'clearLiquidFunParticles', systemId });
    },
  });

  assert.equal(BOX2D_CMD.CLEAR_LIQUIDFUN_PARTICLES, 24);
  assert.equal(BOX2D_CMD.SET_AWAKE, 25);
  assert.deepEqual(received, [{ type: 'clearLiquidFunParticles', systemId: 0 }]);
});

test('enqueueSetAwake drains SET_AWAKE to setAwake(entity, flag)', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);

  enqueueSetAwake(42, 0);
  enqueueSetAwake(7, 1);

  const received = [];
  drainCommandRing(i32, f32, {
    setAwake(entity, flag) {
      received.push({ entity, flag });
    },
  });

  assert.deepEqual(received, [
    { entity: 42, flag: 0 },
    { entity: 7, flag: 1 },
  ]);
});

test('enqueueSetLiquidFunLight drains SET_LIQUIDFUN_LIGHT', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);

  enqueueSetLiquidFunLight(5000);
  enqueueSetLiquidFunLight(0);

  const received = [];
  drainCommandRing(i32, f32, {
    setLiquidFunLight(lightIntensity) {
      received.push(lightIntensity);
    },
  });

  assert.equal(BOX2D_CMD.SET_LIQUIDFUN_LIGHT, 26);
  assert.equal(received.length, 2);
  assert.ok(Math.abs(received[0] - 5000) < 1e-6);
  assert.equal(received[1], 0);
});

test('LiquidFun enqueues SET_LIQUIDFUN_LAYERS for layer/layers', () => {
  try {
    Layer.reset();
    Layer.initializeFromConfig({
      fire: { shader: { fragment: 'f', compute: 's' } },
    }, {
      BACKGROUND: {},
      DECALS: {},
      CASTED_SHADOWS: {},
      ENTITIES: {},
      LIGHTING: {},
    }, true);
    const fireId = Layer.getId('fire');
    assert.ok(fireId >= 0);
    const entities = Layer.entitiesMask();

    const sab = createCommandRingSab(64);
    bindCommandRing(sab);
    const i32 = new Int32Array(sab);
    const f32 = new Float32Array(sab);
    LiquidFun.createSystem();
    LiquidFun.emit({ shape: 'circle', posX: 0, posY: 0, radius: 20 });
    LiquidFun.emit({ shape: 'circle', posX: 0, posY: 0, radius: 20, layer: 'fire' });
    LiquidFun.emit({ shape: 'circle', posX: 0, posY: 0, radius: 20, layers: [] });

    const received = [];
    drainCommandRing(i32, f32, {
      createParticleSystem() {},
      setLiquidFunEmit() {
        received.push({ type: 'setLiquidFunEmit' });
      },
      setLiquidFunLayers(mask) {
        received.push({ type: 'setLiquidFunLayers', mask });
      },
      createParticleGroupCircle() {
        received.push({ type: 'createParticleGroupCircle' });
      },
    });

    assert.equal(BOX2D_CMD.SET_LIQUIDFUN_LAYERS, 27);
    const layers = received.filter((r) => r.type === 'setLiquidFunLayers');
    assert.equal(layers.length, 3);
    assert.equal(layers[0].mask, entities);
    assert.equal(layers[1].mask, 1 << fireId);
    assert.equal(layers[2].mask, 0);
  } finally {
    Layer.reset();
  }
});

test('enqueueSetLiquidFunLayers drains SET_LIQUIDFUN_LAYERS', () => {
  const sab = createCommandRingSab(64);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);

  enqueueSetLiquidFunLayers(1 << 3);
  enqueueSetLiquidFunLayers(0);

  const received = [];
  drainCommandRing(i32, f32, {
    setLiquidFunLayers(mask) {
      received.push(mask);
    },
  });

  assert.equal(BOX2D_CMD.SET_LIQUIDFUN_LAYERS, 27);
  assert.deepEqual(received, [1 << 3, 0]);
});

test('liquidFun render SAB is not ParticleComponent', () => {
  const n = 16;
  const sab = new SharedArrayBuffer(liquidFunRenderByteSize(n));
  const views = bindLiquidFunRender(sab, n);
  assert.equal(views.count.length, 1);
  assert.equal(views.x.length, n);
  assert.equal(views.textureId.length, n);
  assert.equal(views.baseAlpha.length, n);
  assert.equal(views.layerMask.length, n);
  assert.equal(views.layerMask[0], 0);
  views.count[0] = 3;
  views.x[2] = 42;
  views.tint[2] = 0x3399ff;
  views.baseAlpha[2] = 0.5;
  views.layerMask[2] = 1 << 4;
  assert.equal(views.y[2], 0);
  assert.equal(views.baseAlpha[2], 0.5);
  assert.equal(views.layerMask[2], 1 << 4);
  // px/py: previous-frame position snapshot feeding preRender.interpolation
  // 'interpolate' - not the same thing as ParticleComponent's simulation
  // state, which is why lifespan/flat (CPU-particle-only fields) still must
  // not exist here (LiquidFun's own age-based destruction is JS-invisible -
  // it only ever shows up as the particle disappearing, plus optional alpha
  // fade when fadeToAlpha0 was set at create).
  assert.equal(views.px.length, n);
  assert.equal(views.py.length, n);
  assert.ok(!('vx' in views));
  assert.ok(!('vy' in views));
  assert.ok(!('lifespan' in views));
  assert.ok(!('flat' in views));
});

test('liquidFun render SAB fits bind when maxCount is odd', () => {
  for (const n of [1, 32767, 65535]) {
    const sab = new SharedArrayBuffer(liquidFunRenderByteSize(n));
    const views = bindLiquidFunRender(sab, n);
    assert.equal(views.layerMask.length, n);
    views.layerMask[n - 1] = 1;
    assert.equal(views.layerMask[n - 1], 1);
  }
});

test('liquidFun groups SAB fits bindLiquidFunGroups (first/last + pose + lightIntensity + groupFlags)', () => {
  const n = LIQUIDFUN_GROUPS_MAX;
  assert.equal(liquidFunGroupsByteSize(n), 4 + n * 4 * 14);
  const sab = new SharedArrayBuffer(liquidFunGroupsByteSize(n));
  const views = bindLiquidFunGroups(sab, n);
  assert.equal(views.count.length, 1);
  assert.equal(views.id.length, n);
  assert.equal(views.particleCount.length, n);
  assert.equal(views.firstIndex.length, n);
  assert.equal(views.lastIndex.length, n);
  assert.equal(views.groupFlags.length, n);
  assert.equal(views.viscousScale.length, n);
  assert.equal(views.x.length, n);
  assert.equal(views.y.length, n);
  assert.equal(views.vx.length, n);
  assert.equal(views.vy.length, n);
  assert.equal(views.angularVelocity.length, n);
  assert.equal(views.angle.length, n);
  assert.equal(views.lightIntensity.length, n);
  assert.equal(views.sqrtLightIntensity.length, n);
  views.count[0] = 1;
  views.id[n - 1] = 7;
  views.firstIndex[n - 1] = 10;
  views.lastIndex[n - 1] = 40;
  views.groupFlags[n - 1] = 3;
  views.angle[n - 1] = 1.5;
  views.lightIntensity[7] = 5000;
  views.sqrtLightIntensity[7] = Math.sqrt(5000);
  assert.equal(views.id[n - 1], 7);
  assert.equal(views.firstIndex[n - 1], 10);
  assert.equal(views.lastIndex[n - 1], 40);
  assert.equal(views.groupFlags[n - 1], 3);
  assert.equal(views.angle[n - 1], 1.5);
  assert.equal(views.lightIntensity[7], 5000);
  assert.ok(Math.abs(views.sqrtLightIntensity[7] - Math.sqrt(5000)) < 1e-6);
});

test('logic worker binds LiquidFun HEAP pose on box2dReady and liquidFunHeap', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../src/workers/logicWorker.js'),
    'utf8',
  );
  assert.match(src, /LiquidFun\.bindHeapPose\(data\.liquidFunHeap\)/);
  assert.match(src, /default:\s*super\.handleCustomMessage\(data\);/);
});

test('bindSabs after bindHeapPose keeps HEAP userData and groupIndex', () => {
  const n = 4;
  const giOff = 16;
  const udOff = giOff + n * 4;
  const sab = new SharedArrayBuffer(udOff + n * 4);
  const render = new SharedArrayBuffer(liquidFunRenderByteSize(n));
  try {
    LiquidFun.unbindSabs();
    LiquidFun.bindHeapPose({
      sab,
      maxCount: n,
      countByteOffset: 0,
      xByteOffset: 16,
      yByteOffset: 16,
      alphaByteOffset: 0,
      groupIndexByteOffset: giOff,
      userDataByteOffset: udOff,
    });
    LiquidFun.bindSabs({ render, maxCount: n });
    const views = LiquidFun.getViews();
    assert.ok(views.userData, 'userData must stay HEAP-backed after bindSabs');
    assert.ok(views.groupIndex, 'groupIndex must stay HEAP-backed after bindSabs');
  } finally {
    LiquidFun.unbindSabs();
  }
});

test('physicsHostImpl group SAB layout matches util bindLiquidFunGroups', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../src/box2d');
  const host = readFileSync(join(dir, 'physicsHostImpl.js'), 'utf8');
  const post = readFileSync(join(dir, 'weedjsPost.js'), 'utf8');
  const start = host.indexOf('function bindLiquidFunGroupsViews');
  assert.ok(start >= 0, 'missing bindLiquidFunGroupsViews');
  const bind = host.slice(start, host.indexOf('function schemaEntry', start));
  assert.match(
    bind,
    /lastIndex[\s\S]*groupFlags[\s\S]*viscousScale[\s\S]*lightIntensity[\s\S]*sqrtLightIntensity/,
  );
  assert.match(host, /groupFlags: packView\(G\.groupFlags\)/);
  assert.match(post, /groupFlags: data\.liquidFunGroupsViews\.groupFlags/);
});

test('LiquidFun mutators enqueue opaque userData on i32 slots', () => {
  const sab = createCommandRingSab(32);
  bindCommandRing(sab);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  LiquidFun.setUserData(3, 0x80000001);
  LiquidFun.setFlags(4, LIQUIDFUN_FLAGS.COLOR_MIXING);
  LiquidFun.setGroupFlags(2, 0);
  const received = [];
  drainCommandRing(i32, f32, {
    setParticleUserData(index, bits) {
      received.push({ type: 'userData', index, bits: bits >>> 0 });
    },
    setParticleFlags(index, flags) {
      received.push({ type: 'flags', index, flags: flags >>> 0 });
    },
    setGroupFlags(groupId, flags) {
      received.push({ type: 'groupFlags', groupId, flags: flags >>> 0 });
    },
  });
  assert.equal(BOX2D_CMD.SET_PARTICLE_USER_DATA, 28);
  assert.equal(BOX2D_CMD.SET_PARTICLE_FLAGS, 32);
  assert.equal(BOX2D_CMD.SET_GROUP_FLAGS, 35);
  assert.deepEqual(received, [
    { type: 'userData', index: 3, bits: 0x80000001 },
    { type: 'flags', index: 4, flags: LIQUIDFUN_FLAGS.COLOR_MIXING },
    { type: 'groupFlags', groupId: 2, flags: 0 },
  ]);
});
