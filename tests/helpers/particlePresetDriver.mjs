// E-538, E-541, E-542: Predator's shot through particle, flash and bullet presets and its spatial sound, for the tests that read V8 itself: the bytecode lengths
// of the preset fronts (particlePresetFronts.test.js, run with --print-bytecode) and the bytes the shot allocates
// once V8 has optimized it (particlePresetAlloc.test.js: it prints one JSON line).
//
//   node tests/helpers/particlePresetDriver.mjs --alloc [--form preset|literal] [--warm N] [--ops N]
//
// --form preset: the shot from presets (define once, emitPreset / spawnPreset and the with* overrides per shot).
// --form literal: the same shot from literal configs, emit({...}) / spawnIndex({...}), as the control: the method sees
// what a call allocates.
import inspector from 'node:inspector/promises';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { FlashComponent } from '../../src/components/flashComponent.js';
import { BulletComponent } from '../../src/components/bulletComponent.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Transform } from '../../src/components/transform.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { Flash } from '../../src/core/flash.js';
import { BulletPool } from '../../src/core/bulletPool.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Layer } from '../../src/core/layer.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { SoundManager } from '../../src/core/soundManager.js';
import { Camera } from '../../src/core/camera.js';
import { seededRandom, rng } from '../../src/util/utils.js';

const POOL = 4096;
const FLASHES = 64;
const BULLETS = 256;
const SOUND_SLOTS = 64;

function argOf(name, fallback) {
  const k = process.argv.indexOf(`--${name}`);
  return k >= 0 ? process.argv[k + 1] : fallback;
}

Layer.reset();
Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
ParticleComponent.initializeArrays(new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL)), POOL);
ParticleComponent.particleCount = POOL;
ParticleEmitter.reset();
ParticleEmitter.initialize(POOL);
ParticleEmitter.initializeFreeList(new SharedArrayBuffer(POOL * 2), new SharedArrayBuffer(8));
ParticleEmitter.resetFreeListInterleaved(1);
SpriteSheetRegistry.register('bigAtlas', {
  animations: { _whiteCircle: ['_whiteCircle'], muzzle1: ['muzzle1'], muzzle2: ['muzzle2'], muzzle3: ['muzzle3'], bullet: ['bullet'] },
});
globalThis.rng = seededRandom(538, 'presetDriver');

// The flash's columns, and GameObject's spawn reduced to what it does for a Flash here: an index, then onSpawned (the
// engine's spawn machinery is GameObject's, measured on its own; this measures Flash's path).
Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(FLASHES)), FLASHES);
Transform.x = new Float32Array(FLASHES);
Transform.y = new Float32Array(FLASHES);
LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(FLASHES)), FLASHES);
FlashComponent.initializeArrays(new SharedArrayBuffer(FlashComponent.getBufferSize(FLASHES)), FLASHES);
Flash.initialize(FLASHES);
// E-541: the bullet pool, its slots recycled by the driver.
BulletComponent.initializeArrays(new SharedArrayBuffer(BulletComponent.getBufferSize(BULLETS)), BULLETS);
BulletComponent.bulletCount = BULLETS;
const bulletFreeList = new Uint16Array(new SharedArrayBuffer(BULLETS * 2));
const bulletTop = new Int32Array(new SharedArrayBuffer(8));
resetFreeList(bulletTop, bulletFreeList, BULLETS, 1);
BulletPool.initialize(BULLETS);
BulletPool.initializeFreeList(bulletFreeList.buffer, bulletTop.buffer);
// E-542: the sound's slots and Predator's bus, and a camera over the shots (play's spatial path: pan and falloff).
SoundManager.setEnabled(true);
SoundManager.initializeSlotSAB({
  sab: new SharedArrayBuffer((SoundManager.HEADER_SIZE + SOUND_SLOTS * SoundManager.SLOT_SIZE) * 4),
  maxSlots: SOUND_SLOTS,
});
SoundManager.configureChannels({ sfx: { volume: 1, pan: 0, maxVoices: 32 } });
SoundManager._assignId('ametralladora_disparo');
const cameraData = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
Camera.initialize(cameraData, 1280, 720);
Camera.setWorldBounds(Infinity, Infinity);
cameraData[0] = 1;
cameraData[5] = 1;
cameraData[1] = 300;
cameraData[2] = 100;
globalThis.Camera = Camera;
let nextFlash = 0;
GameObject._spawnAt = function spawnAtForTheDriver(EntityClass, spawnConfig) {
  const i = nextFlash;
  nextFlash = (nextFlash + 1) % FLASHES;
  EntityClass.onSpawned(i, spawnConfig);
  return i;
};

// Predator's (demos/predatorScene/gameObjects/person.js): two muzzle sprites, the sparks, the muzzle's flash.
const MUZZLE = ParticleEmitter.define({
  count: 1,
  texture: ['muzzle1', 'muzzle2', 'muzzle3'],
  scaleX: { min: 0.5, max: 1 },
  scaleY: { min: 0.5, max: 1 },
  alpha: { min: 0.5, max: 1 },
  faceDirection: true,
  gravity: 0,
  lifespan: 50,
});
const SPARKS = ParticleEmitter.define({
  spread: (10 * Math.PI) / 180,
  speed: { min: 0.1, max: 10 },
  rotation: { min: 0, max: 360 },
  vz: { min: -1, max: 5 },
  gravity: 0.4,
  lifespan: { min: 33, max: 100 },
  scale: { min: 0.15, max: 0.5 },
  texture: '_whiteCircle',
  tint: { min: 0xffff00, max: 0xffffff },
  alpha: { min: 0.5, max: 0.8 },
  despawnOnGroundContact: true,
});
const MUZZLE_FLASH = Flash.define({ lifespan: 18, color: 0xffaa00, radius: 1000, glow: 0 });
const BULLET = BulletPool.define({ damage: 1, texture: 'bullet', scale: 1, anchorX: 1, anchorY: 0.5, trailWidth: 4 });

// What varies per shot, drawn ahead into typed arrays, so the driver's own code allocates nothing: a game's random
// draws and arithmetic are the game's (a double it passes to a call TurboFan leaves out is boxed), and this measures
// the engine's.
const SLOTS = 256;
const PX = new Float64Array(SLOTS);
const PY = new Float64Array(SLOTS);
const DX = new Float64Array(SLOTS);
const DY = new Float64Array(SLOTS);
const HEIGHT = new Float64Array(SLOTS);
const SPARK_COUNT = new Int32Array(SLOTS);
const VZ = new Float64Array(SLOTS);
const FLIP_X = new Uint8Array(SLOTS);
const FLIP_Y = new Uint8Array(SLOTS);
const FADE = new Float64Array(SLOTS);
const RADIUS = new Float64Array(SLOTS);
const GLOW = new Float64Array(SLOTS);
for (let s = 0; s < SLOTS; s++) {
  PX[s] = 100 + s * 7.25;
  PY[s] = 100 + s * 3.5;
  DX[s] = Math.cos(s * 0.37);
  DY[s] = Math.sin(s * 0.37);
  HEIGHT[s] = -34 - (s & 3) * 0.5;
  SPARK_COUNT[s] = Math.floor(rng() * 10) + 10;
  VZ[s] = -rng() * 2 - 2;
  FLIP_X[s] = rng() > 0.5 ? 1 : 0;
  FLIP_Y[s] = rng() > 0.5 ? 1 : 0;
  FADE[s] = 0.25 + rng() * 0.75;
  const strength = rng() * 1000 + 1000;
  RADIUS[s] = 10 * Math.sqrt(strength);
  GLOW[s] = strength / 50000;
}
let slot = 0;
let sink = 0;

/** A shot from presets: what Person.shoot emits. */
function presetShot(s) {
  const x = PX[s];
  const y = PY[s];
  const dx = DX[s];
  const dy = DY[s];
  const h = HEIGHT[s];
  sink += ParticleEmitter.emitPreset(MUZZLE, x, y + 1, h, 1, dx, dy);
  sink += ParticleEmitter.emitPreset(MUZZLE, x, y + 1, h, 1, dx, dy);
  sink += Flash.spawnPreset(MUZZLE_FLASH, x, y, -h);
  sink += ParticleEmitter.emitPreset(SPARKS, x, y + 1, h, SPARK_COUNT[s], dx, dy);
  sink += BulletPool.spawnPreset(BULLET, x, y, h, dx * 800, dy * 800, s & 15);
  sink += SoundManager.play('ametralladora_disparo', 0.33, 0.9, 1.1, 0, 0, x, y, 'sfx');
}

/** A hit from presets: every with* override (a fire's smoke, a barrel's sparks), and a flash with its own light. */
function presetHit(s) {
  sink += ParticleEmitter.withVz(VZ[s])
    .withFlip(FLIP_X[s] === 1, FLIP_Y[s] === 1)
    .withScaleFactor(FADE[s] * 1.5)
    .withAlphaFactor(FADE[s])
    .withSpeedFactor(1 + (s & 3) * 0.25)
    .emitPreset(SPARKS, PX[s], PY[s], -10.5, 4, DX[s], DY[s]);
  sink += Flash.withRadius(RADIUS[s]).withGlow(GLOW[s]).spawnPreset(MUZZLE_FLASH, PX[s], PY[s]);
}

/** The same shot from literal configs (the control). */
function literalShot(s) {
  const x = PX[s];
  const y = PY[s];
  const h = HEIGHT[s];
  for (let k = 0; k < 2; k++) {
    sink += ParticleEmitter.emit({
      count: 1, x, y: y + 1, z: h, texture: ['muzzle1', 'muzzle2', 'muzzle3'], scaleX: { min: 0.5, max: 1 },
      scaleY: { min: 0.5, max: 1 }, alpha: { min: 0.5, max: 1 }, dirX: DX[s], dirY: DY[s], faceDirection: true,
      gravity: 0, lifespan: 50,
    });
  }
  sink += Flash.spawnIndex({ x, y, z: -h, lifespan: 18, color: 0xffaa00, radius: 1000, glow: 0 });
  sink += ParticleEmitter.emit({
    count: SPARK_COUNT[s], x, y: y + 1, z: h, dirX: DX[s], dirY: DY[s], spread: (10 * Math.PI) / 180,
    speed: { min: 0.1, max: 10 }, rotation: { min: 0, max: 360 }, vz: { min: -1, max: 5 }, gravity: 0.4,
    lifespan: { min: 33, max: 100 }, scale: { min: 0.15, max: 0.5 }, texture: '_whiteCircle',
    tint: { min: 0xffff00, max: 0xffffff }, alpha: { min: 0.5, max: 0.8 }, despawnOnGroundContact: true,
  });
  sink += BulletPool.spawn({
    x, y, offsetY: h, vx: DX[s] * 800, vy: DY[s] * 800, damage: 1, ownerId: s & 15, shooterEntityType: 0,
    texture: 'bullet', scale: 1, anchorX: 1, anchorY: 0.5, trailWidth: 4,
  });
  sink += SoundManager.play('ametralladora_disparo', 0.33, 0.9, 1.1, 0, 0, x, y, 'sfx');
}

function literalHit(s) {
  sink += ParticleEmitter.emit({
    count: 4, x: PX[s], y: PY[s], z: -10.5, dirX: DX[s], dirY: DY[s], spread: (10 * Math.PI) / 180,
    speed: { min: 0.1 * (1 + (s & 3) * 0.25), max: 10 * (1 + (s & 3) * 0.25) }, rotation: { min: 0, max: 360 }, vz: VZ[s],
    gravity: 0.4, lifespan: { min: 33, max: 100 }, scale: { min: 0.15 * FADE[s] * 1.5, max: 0.5 * FADE[s] * 1.5 },
    texture: '_whiteCircle', tint: { min: 0xffff00, max: 0xffffff }, alpha: { min: 0.5 * FADE[s], max: 0.8 * FADE[s] },
    flipX: FLIP_X[s] === 1, flipY: FLIP_Y[s] === 1, despawnOnGroundContact: true,
  });
  sink += Flash.spawnIndex({ x: PX[s], y: PY[s], lifespan: 18, color: 0xffaa00, radius: RADIUS[s], glow: GLOW[s] });
}

function recycle() {
  const active = ParticleComponent.active;
  for (let i = 0; i < POOL; i++) {
    if (active[i]) {
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
    }
  }
}

/** The worklet's part: every sound slot ends (play() reclaims them from its bus list). */
function endSounds() {
  const i32 = SoundManager._i32;
  for (let s = 0; s < SOUND_SLOTS; s++) Atomics.store(i32, SoundManager.HEADER_SIZE + s * SoundManager.SLOT_SIZE, SoundManager.STATE_FREE);
}

function recycleBullets() {
  const active = BulletComponent.active;
  for (let i = 0; i < BULLETS; i++) if (active[i]) BulletPool.despawn(i);
}

const literal = argOf('form', 'preset') === 'literal';

/** A shot and a hit, the pool recycled when it runs low. */
function step() {
  const s = slot++ & (SLOTS - 1);
  if (literal) {
    literalShot(s);
    literalHit(s);
  } else {
    presetShot(s);
    presetHit(s);
  }
  if (ParticleEmitter.getFreeCount() < 256) recycle();
  if ((slot & 127) === 0) recycleBullets();
  if ((slot & 15) === 0) endSounds();
}

// Warm-up: the same calls until V8 has tiered the driver and the engine up (the interpreter and the lower tiers box
// every double, so an emit there allocates whatever the engine does).
const warm = Number(argOf('warm', 3000));
for (let k = 0; k < warm; k++) step();

if (process.argv.includes('--alloc')) {
  // V8's sampling heap profiler over the measured shots, every 32 bytes on average, counting the objects GCs already
  // collected (heap counters miss what a scavenge took in between): the bytes allocated in the engine's frames and the
  // driver's, by site. The profiler's own messages run in node: frames, not counted.
  const ops = Number(argOf('ops', 20000));
  const session = new inspector.Session();
  session.connect();
  await session.post('HeapProfiler.enable');
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 32,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let k = 0; k < ops; k++) step();
  const { profile } = await session.post('HeapProfiler.stopSampling');
  session.disconnect();
  const sites = new Map();
  let bytes = 0;
  const walk = (node) => {
    const f = node.callFrame;
    if (node.selfSize > 0 && /\/(src|tests)\//.test(f.url)) {
      const site = `${f.functionName || '(anonymous)'} ${f.url.replace(/^.*\/(src|tests)\//, '$1/')}:${f.lineNumber + 1}`;
      sites.set(site, (sites.get(site) || 0) + node.selfSize);
      bytes += node.selfSize;
    }
    for (const child of node.children || []) walk(child);
  };
  walk(profile.head);
  const top = [...sites].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([site, b]) => ({ site, bytesPerOp: b / ops }));
  console.log(JSON.stringify({ form: literal ? 'literal' : 'preset', ops, bytes, bytesPerOp: bytes / ops, top, sink }));
}
