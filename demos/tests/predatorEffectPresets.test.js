import test from 'node:test';
import assert from 'node:assert/strict';

import '../../tests/helpers/registerWebRoot.mjs';

// E-538: Predator's emit and flash call sites moved to presets (demos/predatorScene/effectPresets.js) draw what they
// drew. Each game object's real method runs against the code it had before (kept here as the reference: the literal
// configs and the call site's own random draws, in their order), from the same seed, on the same particle and flash
// columns: every particle column and every flash's light must come out the same, and the generator must stand at the
// same number after (the same draws). The literal emits of the reference go through today's emitter, whose literal
// path writes what main da2b8eb5's did (tests/node/particleEmitPresetParity.test.js). What a method does besides its
// effects (sounds, a kick to a body, an animation) is stubbed on both sides: none of it draws from the generator.

const { ParticleComponent } = await import('../../src/components/particleComponent.js');
const { Transform } = await import('../../src/components/transform.js');
const { Collider } = await import('../../src/components/collider.js');
const { LightEmitter } = await import('../../src/components/lightEmitter.js');
const { FlashComponent } = await import('../../src/components/flashComponent.js');
const { RigidBody } = await import('../../src/components/rigidBody.js');
const { SpriteRenderer } = await import('../../src/components/spriteRenderer.js');
const { ParticleEmitter } = await import('../../src/core/particleEmitter.js');
const { Flash } = await import('../../src/core/flash.js');
const { GameObject } = await import('../../src/core/gameObject.js');
const { Layer } = await import('../../src/core/layer.js');
const { SpriteSheetRegistry } = await import('../../src/core/spriteSheetRegistry.js');
const { SoundManager } = await import('../../src/core/soundManager.js');
const { Ray } = await import('../../src/core/ray.js');
const { seededRandom, rng } = await import('../../src/util/utils.js');
const { FireComponent } = await import('../predatorScene/components/fireComponent.js');
const { LootableComponent } = await import('../predatorScene/components/lootableComponent.js');
const { PersonComponent } = await import('../predatorScene/components/personComponent.js');
const presets = await import('../predatorScene/effectPresets.js');
// Civilian first, as predatorScene.js loads it: person.js, its FSMs and its subclasses import each other (a cycle that
// throws when person.js is the first of them loaded).
await import('../predatorScene/gameObjects/civilian.js');
const { Person } = await import('../predatorScene/gameObjects/person.js');
const { PersonAnimationFSM } = await import('../predatorScene/fsm/personAnimationFsm.js');
const { Fire } = await import('../predatorScene/gameObjects/fire.js');
const { Explosion } = await import('../predatorScene/gameObjects/explosion.js');
const { Lootable } = await import('../predatorScene/gameObjects/lootable.js');
const { Barrel } = await import('../predatorScene/gameObjects/barrel.js');
const { Rock } = await import('../predatorScene/gameObjects/rock.js');
const { House } = await import('../predatorScene/gameObjects/house.js');
const { TallLight } = await import('../predatorScene/gameObjects/tallLight.js');
const { Tree } = await import('../predatorScene/gameObjects/tree.js');
const { Player } = await import('../predatorScene/gameObjects/player.js');

const POOL = 512;
/** Entities 0..15 are the game's (shooters, fires, barrels); 16..31 are flashes. */
const ENTITIES = 32;
const FLASH_START = 16;
const PARTICLE_COLUMNS = Object.keys(ParticleComponent.ARRAY_SCHEMA);
const LIGHT_COLUMNS = Object.keys(LightEmitter.ARRAY_SCHEMA);
const FLASH_COLUMNS = Object.keys(FlashComponent.ARRAY_SCHEMA);

let nextFlash = FLASH_START;
const saved = [];
function stub(owner, key, value) {
  saved.push([owner, key, owner[key]]);
  owner[key] = value;
}

function setup() {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  ParticleComponent.initializeArrays(new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL)), POOL);
  ParticleComponent.particleCount = POOL;
  ParticleEmitter.reset();
  ParticleEmitter.initialize(POOL);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(POOL * 2), new SharedArrayBuffer(8));
  SpriteSheetRegistry.clearForSceneUnload();
  SpriteSheetRegistry.register('bigAtlas', {
    animations: {
      _whiteCircle: ['_whiteCircle'], blood: ['blood'], square: ['square'], smoke: ['smoke'],
      muzzle1: ['muzzle1'], muzzle2: ['muzzle2'], muzzle3: ['muzzle3'],
    },
  });
  for (const C of [Transform, Collider, LightEmitter, FlashComponent, FireComponent, LootableComponent, PersonComponent]) {
    C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(ENTITIES)), ENTITIES);
  }
  Transform.x = new Float32Array(ENTITIES);
  Transform.y = new Float32Array(ENTITIES);
  for (let i = 0; i < FLASH_START; i++) {
    Transform.x[i] = 300 + i * 41.5;
    Transform.y[i] = 200 + i * 17.25;
    Collider.radius[i] = 8 + i * 1.5;
    FireComponent.baseScale[i] = 1 + (i % 5) * 0.1;
    LootableComponent.health[i] = 1e9;
  }
  Flash.initialize(FLASH_START);
  // GameObject's spawn reduced to its slot and the hook, for the flashes: their light is what onSpawned writes.
  stub(GameObject, '_spawnAt', (EntityClass, spawnConfig) => {
    const i = nextFlash;
    nextFlash = nextFlash + 1 < ENTITIES ? nextFlash + 1 : FLASH_START;
    EntityClass.onSpawned(i, spawnConfig);
    return i;
  });
  // What the methods do besides their effects, none of which draws from the generator.
  stub(SoundManager, 'play', () => -1);
  stub(RigidBody, 'addVelocity', () => {});
  stub(RigidBody, 'setLinearDamping', () => {});
  stub(PersonAnimationFSM, 'forceChangeState', () => {});
  stub(SpriteRenderer, 'getOriginalHeight', (i) => 40 + i * 3);
  stub(Ray, 'cast', () => -1);
}

function restore() {
  while (saved.length) {
    const [owner, key, value] = saved.pop();
    owner[key] = value;
  }
}

/** Run `fn` from `seed` on fresh columns: every particle column, every flash's light and life, the generator's next. */
function run(seed, fn) {
  for (const key of PARTICLE_COLUMNS) ParticleComponent[key].fill(0);
  ParticleComponent.rotC.fill(1);
  ParticleEmitter.resetFreeListInterleaved(1);
  for (const key of LIGHT_COLUMNS) LightEmitter[key].fill(0);
  for (const key of FLASH_COLUMNS) FlashComponent[key].fill(0);
  for (let i = FLASH_START; i < ENTITIES; i++) {
    Transform.x[i] = 0;
    Transform.y[i] = 0;
  }
  nextFlash = FLASH_START;
  PersonComponent.dead.fill(0);
  globalThis.rng = seededRandom(seed, 'predatorEffects');
  fn();
  const out = { next: rng() };
  for (const key of PARTICLE_COLUMNS) out[`particle.${key}`] = Array.from(ParticleComponent[key]);
  for (const key of LIGHT_COLUMNS) out[`light.${key}`] = Array.from(LightEmitter[key]);
  for (const key of FLASH_COLUMNS) out[`flash.${key}`] = Array.from(FlashComponent[key]);
  out.flashX = Array.from(Transform.x.subarray(FLASH_START));
  out.flashY = Array.from(Transform.y.subarray(FLASH_START));
  return out;
}

function assertSame(old, now, label) {
  assert.equal(now.next, old.next, `${label}: the generator's next number (the same draws)`);
  for (const key of Object.keys(old)) {
    const a = old[key];
    const b = now[key];
    if (!Array.isArray(a)) continue;
    for (let k = 0; k < a.length; k++) {
      if (!Object.is(a[k], b[k])) assert.fail(`${label}: ${key}[${k}] is ${b[k]}, was ${a[k]}`);
    }
  }
  assert.ok(old['particle.active'].some((v) => v === 1) || old['light.active'].some((v) => v === 1) || label.includes('may skip'),
    `${label}: the case drew something`);
}

/** Each site: the old code (the reference), the new (the game object's method as shipped), and its inputs. */
const SITES = {
  'Person.recieveDamage (wound blood)': {
    old: (i, k) => {
      const damage = 0.2 + k * 0.05;
      ParticleEmitter.emit({
        count: Math.floor(damage * (rng() * 10 + 4)), texture: 'blood', x: Transform.x[i], y: Transform.y[i], z: -30,
        angleXY: { min: 0, max: 360 }, speed: { min: 0.7, max: 1.66 }, vz: { min: -4, max: 0 }, lifespan: 2000,
        gravity: 0.22, scale: { min: 0.12, max: 0.3 }, alpha: { min: 0.66, max: 0.95 },
        tint: { min: 0xaaaaaa, max: 0xffffff }, stayOnTheFloor: true,
      });
    },
    now: (i, k) => Person.recieveDamage(i, 0.2 + k * 0.05, 0, 0),
  },
  'Person.die (death blood)': {
    old: (i) => {
      void ['dolor1', 'dolor2', 'dolor3', 'dolor4'][(rng() * 4) | 0];
      ParticleEmitter.emit({
        count: Math.floor(10 + rng() * 5), texture: 'blood', x: Transform.x[i], y: Transform.y[i], z: -10,
        angleXY: { min: 0, max: 360 }, speed: { min: 0.7, max: 2 }, vz: { min: -4, max: 0 }, lifespan: 2000,
        gravity: 0.15, scale: { min: 0.1, max: 0.2 }, alpha: { min: 0.4, max: 0.9 },
        tint: { min: 0xaaaaaa, max: 0xffffff }, stayOnTheFloor: true,
      });
    },
    now: (i) => Person.die(i),
  },
  'Person.shoot (muzzle sprites and flash, its lines)': {
    old: (i, k) => {
      const a = k * 0.61;
      const shotDirX = Math.cos(a);
      const shotDirY = Math.sin(a);
      const muzzleX = Transform.x[i] + shotDirX * 20;
      const muzzleY = Transform.y[i] + shotDirY * 20;
      const muzzleHeightPx = -34;
      for (let n = 0; n < 2; n++) {
        ParticleEmitter.emit({
          count: 1, x: muzzleX, y: muzzleY + 1, texture: 'muzzle' + Math.floor(rng() * 3 + 1),
          scaleX: rng() * 0.5 + 0.5, scaleY: rng() * 0.5 + 0.5, rotC: shotDirX, rotS: shotDirY,
          alpha: rng() * 0.5 + 0.5, anchorX: 0, anchorY: 0.5, z: muzzleHeightPx, gravity: 0, lifespan: 50, speed: 0,
        });
      }
      Flash.spawnIndex({ x: muzzleX, y: muzzleY, z: -muzzleHeightPx, lifespan: 18, color: 0xffaa00, radius: 1000, glow: 0, elevation: 30 });
    },
    // person.js's three lines (Person.shoot itself needs a weapon, a target and the bullet pool).
    now: (i, k) => {
      const a = k * 0.61;
      const shotDirX = Math.cos(a);
      const shotDirY = Math.sin(a);
      const muzzleX = Transform.x[i] + shotDirX * 20;
      const muzzleY = Transform.y[i] + shotDirY * 20;
      const muzzleHeightPx = -34;
      ParticleEmitter.emitPreset(presets.MUZZLE_SPRITE, muzzleX, muzzleY + 1, muzzleHeightPx, 1, shotDirX, shotDirY);
      ParticleEmitter.emitPreset(presets.MUZZLE_SPRITE, muzzleX, muzzleY + 1, muzzleHeightPx, 1, shotDirX, shotDirY);
      Flash.spawnPreset(presets.MUZZLE_FLASH, muzzleX, muzzleY, -muzzleHeightPx);
    },
  },
  'Person.shootingSparks': {
    old: (i, k) => {
      const dirX = Math.cos(k);
      const dirY = Math.sin(k);
      ParticleEmitter.emit({
        count: Math.floor(rng() * 10) + 10, x: Transform.x[i], y: Transform.y[i] + 1, z: -34, dirX, dirY,
        spread: (10 * Math.PI) / 180, speed: { min: 0.1, max: 10 }, rotation: { min: 0, max: 360 },
        vz: { min: -1, max: 5 }, gravity: 0.4, lifespan: { min: 33, max: 100 }, scale: { min: 0.15, max: 0.5 },
        texture: '_whiteCircle', tint: { min: 0xffff00, max: 0xffffff }, alpha: { min: 0.5, max: 0.8 },
        despawnOnGroundContact: true,
      });
    },
    now: (i, k) => Person.shootingSparks(Math.cos(k), Math.sin(k), Transform.x[i], Transform.y[i], -34),
  },
  'Fire.emitSparks (may skip)': {
    old: (i, k) => {
      const radius = Collider.radius[i];
      const fadeFactor = 0.7 + (k % 4) * 0.1;
      if (rng() > 0.4 * fadeFactor) return;
      ParticleEmitter.emit({
        count: Math.floor(rng() * 3 * fadeFactor) + 1,
        x: Transform.x[i] + (rng() * radius - radius * 0.5),
        y: Transform.y[i] + (rng() * radius - radius * 0.5),
        z: -radius - rng() * radius,
        angleXY: { min: 0, max: 360 }, speed: { min: 0, max: 1 }, vz: -rng() * 2 - 2, gravity: -0.1,
        lifespan: { min: 200, max: 500 }, scale: 0.25 * fadeFactor, texture: 'square',
        tint: { min: 0xffff00, max: 0xffbb00 }, alpha: { min: 0.8 * fadeFactor, max: 1 * fadeFactor },
      });
    },
    now: (i, k) => Fire.emitSparks(i, Collider.radius[i], 0.7 + (k % 4) * 0.1),
  },
  'Fire.emitSmoke (may skip)': {
    old: (i, k) => {
      const radius = Collider.radius[i];
      const fadeFactor = 0.7 + (k % 4) * 0.1;
      if (rng() > 0.3 * fadeFactor) return;
      const baseScale = FireComponent.baseScale[i];
      ParticleEmitter.emit({
        count: Math.floor(rng() * 2 * fadeFactor) + 1, x: Transform.x[i], y: Transform.y[i],
        angleXY: { min: 0, max: 360 }, speed: { min: 0, max: 1 }, vz: -rng() * 2 - 2, gravity: 0,
        rotation: { min: 0, max: 360 }, flipX: rng() > 0.5, flipY: rng() > 0.5, z: -radius * 2 - rng() * radius * 2,
        lifespan: { min: 500, max: 2000 }, scale: { min: baseScale * fadeFactor, max: baseScale * 3 * fadeFactor },
        texture: 'smoke', tint: { min: 0xaaaaaa, max: 0x666666 },
        alpha: { from: { min: 0.15 * fadeFactor, max: 0.3 * fadeFactor }, to: 0 },
      });
    },
    now: (i, k) => Fire.emitSmoke(i, Collider.radius[i], 0.7 + (k % 4) * 0.1),
  },
  'Explosion.emitSparks (may skip)': {
    old: (i) => {
      const radius = Collider.radius[i];
      if (rng() > 0.4) return;
      ParticleEmitter.emit({
        count: Math.floor(rng() * 30) + 10,
        x: Transform.x[i] + (rng() * radius - radius * 0.5),
        y: Transform.y[i] + (rng() * radius - radius * 0.5),
        z: -radius - rng() * radius,
        angleXY: { min: 0, max: 360 }, speed: { min: 10, max: 20 }, rotation: { min: 0, max: 360 },
        vz: -rng() * 2 - 2, gravity: 0.6, lifespan: { min: 100, max: 300 }, scale: { min: 0.25, max: 0.5 },
        texture: 'square', tint: { min: 0xffff00, max: 0xffbb00 }, alpha: { min: 0.8, max: 1 }, stayOnTheFloor: false,
      });
    },
    now: (i) => Explosion.emitSparks(i),
  },
  'Explosion.emitSmoke (may skip)': {
    old: (i) => {
      if (rng() > 0.3) return;
      const radius = Collider.radius[i];
      ParticleEmitter.emit({
        count: Math.floor(rng() * 2) + 1, x: Transform.x[i], y: Transform.y[i],
        angleXY: { min: 0, max: 360 }, speed: { min: 0, max: 1 }, vz: -rng() * 2 - 2, gravity: 0,
        rotation: { min: 0, max: 360 }, flipX: rng() > 0.5, flipY: rng() > 0.5, z: -radius * 2 - rng() * radius * 2,
        lifespan: { min: 500, max: 2000 }, scale: { min: 1, max: 3 }, texture: 'smoke',
        tint: { min: 0xaaaaaa, max: 0x666666 }, alpha: { from: { min: 0.15, max: 0.3 }, to: 0 },
      });
    },
    now: (i) => Explosion.emitSmoke(i),
  },
  'Lootable.emitSparks': {
    old: (i) => {
      const radius = Collider.radius[i];
      ParticleEmitter.emit({
        count: Math.floor(rng() * radius) + radius * 0.5,
        x: Transform.x[i] + (rng() * radius - radius * 0.5),
        y: Transform.y[i] + (rng() * radius - radius * 0.5),
        z: -radius - rng() * radius,
        angleXY: { min: 0, max: 360 }, speed: { min: radius * 0.1, max: radius * 0.2 },
        rotation: { min: 0, max: 360 }, vz: -rng() * 2 - 2, gravity: 0.6, lifespan: { min: 100, max: 300 },
        scale: { min: 0.25, max: 0.5 }, texture: 'square', tint: { min: 0xffff00, max: 0xffbb00 },
        alpha: { min: 0.8, max: 1 }, stayOnTheFloor: false,
      });
    },
    now: (i) => Lootable.emitSparks(i),
  },
  'Barrel.onGotShot': {
    old: (i, k) => {
      const hitX = Transform.x[i] + k;
      const hitY = Transform.y[i] - k;
      void (rng() > 0.5);
      const radius = Collider.radius[i];
      ParticleEmitter.emit({
        count: Math.floor(rng() * radius) + radius * 0.5, x: hitX, y: hitY,
        z: - rng() * SpriteRenderer.getOriginalHeight(i),
        angleXY: { min: 0, max: 360 }, speed: { min: radius * 0.2, max: radius * 0.4 },
        rotation: { min: 0, max: 360 }, vz: -rng() * 4 - 2, gravity: 0.6, lifespan: { min: 100, max: 300 },
        scale: { min: 0.15, max: 0.5 }, texture: '_whiteCircle', tint: { min: 0xffff00, max: 0xffbb00 },
        alpha: { min: 0.8, max: 1 }, stayOnTheFloor: false, despawnOnGroundContact: true,
      });
      const strength = rng() * 1000 + 1000;
      Flash.spawnIndex({ x: hitX, y: hitY, lifespan: 18, color: 0xffee00, radius: 10 * Math.sqrt(strength), glow: strength / 50000, elevation: 20 });
    },
    now: (i, k) => Barrel.onGotShot(i, 1, Transform.x[i] + k, Transform.y[i] - k, 0, 0),
  },
  'Rock.onGotShot': {
    old: (i, k) => {
      const hitX = Transform.x[i] + k;
      const hitY = Transform.y[i] - k;
      void (rng() > 0.5);
      ParticleEmitter.emit({
        count: 10 + rng() * 10, x: hitX, y: hitY, z: - rng() * SpriteRenderer.getOriginalHeight(i),
        angleXY: { min: 0, max: 360 }, speed: { min: 2, max: 4 }, rotation: { min: 0, max: 360 },
        vz: -rng() * 4 - 2, gravity: 0.6, lifespan: { min: 100, max: 300 }, scale: { min: 0.15, max: 0.5 },
        texture: '_whiteCircle', tint: { min: 0xffff00, max: 0xffbb00 }, alpha: { min: 0.8, max: 1 },
        stayOnTheFloor: false, despawnOnGroundContact: true,
      });
    },
    now: (i, k) => Rock.onGotShot(i, 1, Transform.x[i] + k, Transform.y[i] - k, 0, 0),
  },
  'House.onGotShot': {
    old: (i, k) => wallHitReference(i, k, false),
    now: (i, k) => House.onGotShot(i, 0.1 + k * 0.07, Transform.x[i] + k, Transform.y[i] - k, 0, 0),
  },
  'TallLight.onGotShot': {
    old: (i, k) => wallHitReference(i, k, true),
    now: (i, k) => TallLight.onGotShot(i, 0.1 + k * 0.07, Transform.x[i] + k, Transform.y[i] - k, 0, 0),
  },
  'Tree.onGotShot': {
    old: (i, k) => {
      const hitX = Transform.x[i] + k;
      const hitY = Transform.y[i] - k;
      const radius = Collider.radius[i];
      ParticleEmitter.emit({
        count: Math.floor(rng() * radius) + radius * 0.5,
        x: hitX + (rng() * radius - radius * 0.5),
        y: hitY + (rng() * radius - radius * 0.5),
        z: - rng() * 40,
        angleXY: { min: 0, max: 360 }, speed: { min: 2, max: 8 }, rotation: { min: 0, max: 360 },
        vz: -rng() * 4 - 2, gravity: 0.6, lifespan: { min: 100, max: 300 }, scale: { min: 0.15, max: 1 },
        texture: '_whiteCircle', tint: { min: 0x4A3728, max: 0xC4A484 }, alpha: 1, stayOnTheFloor: true,
      });
    },
    now: (i, k) => Tree.onGotShot(i, 1, Transform.x[i] + k, Transform.y[i] - k, 0, 0),
  },
  'Player.shoot (may skip)': {
    old: (i, k) => {
      const self = { x: Transform.x[i], y: Transform.y[i], vx: k % 2 ? 1 : -1 };
      if (rng() > 0.5) return;
      Flash.spawn({
        x: self.x + (self.vx > 0 ? 35 : -35), y: self.y - 35, z: 0, lifespan: 17, color: 0xffbb11, radius: 1581, glow: 0.5, elevation: 35,
      });
    },
    now: (i, k) => Player.prototype.shoot.call({ x: Transform.x[i], y: Transform.y[i], vx: k % 2 ? 1 : -1 }, 0, 0),
  },
};

/** House's and TallLight's onGotShot before E-538 (the lamp post draws its clang's sound first). */
function wallHitReference(i, k, clang) {
  const damage = 0.1 + k * 0.07;
  const hitX = Transform.x[i] + k;
  const hitY = Transform.y[i] - k;
  if (clang) void (rng() > 0.5);
  const count = Math.floor(damage * 8) + 3;
  ParticleEmitter.emit({
    count, texture: 'square', x: hitX, y: hitY, z: -20, angleXY: { min: 0, max: 360 }, speed: { min: 1.5, max: 4 },
    vz: { min: 2, max: 6 }, lifespan: { min: 400, max: 800 }, gravity: 0.35, scale: { min: 0.15, max: 0.4 },
    alpha: { min: 0.7, max: 1 }, tint: { min: 0xffff00, max: 0xffffff }, rotation: { min: 0, max: 360 },
    stayOnTheFloor: false, despawnOnGroundContact: true,
  });
  Flash.spawnIndex({ x: hitX, y: hitY, lifespan: 18, color: 0xffee00, radius: 707, glow: 0.1, elevation: 20 });
}

for (const [name, site] of Object.entries(SITES)) {
  test(`${name} draws what it drew before its presets`, { concurrency: false }, () => {
    setup();
    try {
      let drew = 0;
      for (let k = 0; k < 64; k++) {
        const i = k % FLASH_START;
        const seed = 538_000 + k * 7919;
        const old = run(seed, () => site.old(i, k));
        const now = run(seed, () => site.now(i, k));
        assertSame(old, now, `${name}, case ${k}`);
        if (old['particle.active'].some((v) => v === 1) || old['light.active'].some((v) => v === 1)) drew++;
      }
      assert.ok(drew >= 6, `${name}: only ${drew} of 64 cases drew anything`);
    } finally {
      restore();
    }
  });
}
