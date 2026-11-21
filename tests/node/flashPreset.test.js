// E-538: Flash presets. Flash.define compiles a config once; Flash.spawnPreset spawns from it with what varies per
// spawn (position, height, a cone's direction) and the with* overrides (radius, glow). One core for both forms: a
// literal spawnIndex(config) is compiled into the same row. Every column must come out as Flash's onSpawned before
// E-538 wrote it from the same config (kept here as the reference), through GameObject.spawnIndex as the game calls it
// (its slot handling reduced to an index, then onSpawned).
import test from 'node:test';
import assert from 'node:assert/strict';

import { Flash, FLASH_KEYS } from '../../src/core/flash.js';
import { GameObject } from '../../src/core/gameObject.js';
import { FlashComponent } from '../../src/components/flashComponent.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Transform } from '../../src/components/transform.js';
import { Camera } from '../../src/core/camera.js';

const N = 8;

/** Flash's onSpawned before E-538, from the config spawnIndex filled (its defaults, then onSpawned's). */
function referenceOnSpawned(i, spawnConfig) {
  Transform.setPosition(i, spawnConfig.x ?? 0, spawnConfig.y ?? 0);
  LightEmitter.offsetY[i] = -(spawnConfig.z ?? 0);
  LightEmitter.color[i] = spawnConfig.color ?? 0xffffff;
  LightEmitter.radius[i] = spawnConfig.radius ?? 1000;
  LightEmitter.brightness[i] = spawnConfig.brightness ?? 1;
  LightEmitter.setGlow(i, spawnConfig.glow ?? 0.2);
  LightEmitter.setGlowRadius(i, spawnConfig.glowRadius ?? 0);
  LightEmitter.active[i] = 1;
  LightEmitter.castShadows[i] = spawnConfig.castShadows !== 0 && spawnConfig.castShadows !== false ? 1 : 0;
  LightEmitter.setConeAngle(i, spawnConfig.coneAngle ?? Math.PI * 2);
  LightEmitter.setConeSoftness(i, spawnConfig.coneSoftness ?? 0);
  LightEmitter.setDirection(i, spawnConfig.direction ?? 0);
  FlashComponent.lifespan[i] = spawnConfig.lifespan ?? 100;
  FlashComponent.currentLife[i] = 0;
  FlashComponent.initialRadius[i] = LightEmitter.radius[i];
  FlashComponent.initialGlow[i] = LightEmitter.glow[i];
  FlashComponent.active[i] = 1;
}

let nextIndex = 0;
const savedSpawnAt = GameObject._spawnAt;

function setup() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  FlashComponent.initializeArrays(new SharedArrayBuffer(FlashComponent.getBufferSize(N)), N);
  Flash.initialize(N);
  nextIndex = 0;
  // GameObject's spawn reduced to its slot and the hook: the flash's columns are what onSpawned writes.
  GameObject._spawnAt = (EntityClass, spawnConfig) => {
    const i = nextIndex++ % N;
    EntityClass.onSpawned(i, spawnConfig);
    return i;
  };
}

function restore() {
  GameObject._spawnAt = savedSpawnAt;
}

/** Every column of entity i a flash spawn writes. */
function columnsOf(i) {
  const out = { x: Transform.x[i], y: Transform.y[i] };
  for (const key of Object.keys(LightEmitter.ARRAY_SCHEMA)) out[`le.${key}`] = LightEmitter[key][i];
  for (const key of Object.keys(FlashComponent.ARRAY_SCHEMA)) out[`fc.${key}`] = FlashComponent[key][i];
  return out;
}

function clearRow(i) {
  Transform.x[i] = 0;
  Transform.y[i] = 0;
  for (const key of Object.keys(LightEmitter.ARRAY_SCHEMA)) LightEmitter[key][i] = 0;
  for (const key of Object.keys(FlashComponent.ARRAY_SCHEMA)) FlashComponent[key][i] = 0;
}

/** What the old onSpawned wrote for `config` on slot 0, against what `spawn` writes on its slot. */
function assertSameAsReference(config, spawn, label) {
  clearRow(0);
  referenceOnSpawned(0, config);
  const want = columnsOf(0);
  clearRow(0);
  nextIndex = 0;
  const i = spawn();
  assert.equal(i, 0, `${label}: spawned`);
  assert.deepEqual(columnsOf(0), want, label);
}

const CONFIGS = [
  { x: 10, y: 20 },
  { x: 10.5, y: -20.25, z: 34, lifespan: 18, color: 0xffaa00, radius: 1000, glow: 0 },
  { x: 1, y: 2, lifespan: 17, color: 0xffbb11, radius: 1581, glow: 0.5, castShadows: false },
  { x: 1, y: 2, glowRadius: 24, brightness: 2.5, castShadows: 0 },
  { x: 1, y: 2, coneAngle: Math.PI / 2, coneSoftness: 0.6, direction: Math.PI / 3 },
  { x: 1, y: 2, coneAngle: 7, coneSoftness: 2, direction: -1, glow: -1 },
];

test('spawnIndex(config) writes what it wrote before E-538', () => {
  setup();
  try {
    for (const [k, config] of CONFIGS.entries()) {
      assertSameAsReference(config, () => Flash.spawnIndex(config), `config ${k}`);
    }
  } finally {
    restore();
  }
});

test('a preset writes what spawnIndex of its config wrote, and its spawn arguments what the config with them', () => {
  setup();
  try {
    for (const [k, config] of CONFIGS.entries()) {
      const { x, y, ...rest } = config;
      const id = Flash.define(rest);
      assertSameAsReference({ ...rest, x: 0, y: 0 }, () => Flash.spawnPreset(id), `preset ${k}`);
      assertSameAsReference(config, () => Flash.spawnPreset(id, x, y), `preset ${k} at x, y`);
      const moved = { ...config, z: 12.5, direction: 0.75 };
      assertSameAsReference(moved, () => Flash.spawnPreset(id, x, y, 12.5, 0.75), `preset ${k} with z and direction`);
      const full = Flash.define(config);
      assertSameAsReference(config, () => Flash.spawnPreset(full), `preset ${k} holding its position`);
    }
  } finally {
    restore();
  }
});

test('withRadius and withGlow set the next flash only; the literal form reads them too', () => {
  setup();
  try {
    const id = Flash.define({ lifespan: 18, color: 0xffee00, radius: 707, glow: 0.1 });
    const strength = 1234.5;
    assertSameAsReference(
      { x: 5, y: 6, lifespan: 18, color: 0xffee00, radius: 10 * Math.sqrt(strength), glow: strength / 50000 },
      () => Flash.withRadius(10 * Math.sqrt(strength)).withGlow(strength / 50000).spawnPreset(id, 5, 6),
      'overridden',
    );
    assertSameAsReference({ x: 5, y: 6, lifespan: 18, color: 0xffee00, radius: 707, glow: 0.1 }, () => Flash.spawnPreset(id, 5, 6), 'the next one');
    assertSameAsReference({ x: 5, y: 6, radius: 50 }, () => Flash.withRadius(50).spawnIndex({ x: 5, y: 6, radius: 900 }), 'literal');
  } finally {
    restore();
  }
});

test('an off-screen or uninitialised spawn returns -1 and clears the overrides', () => {
  setup();
  const savedData = Camera._data;
  const savedOnScreen = Flash.isOnScreen;
  try {
    const id = Flash.define({ radius: 300 });
    Flash.isOnScreen = () => false;
    assert.equal(Flash.withRadius(9).spawnPreset(id, 1, 2), -1);
    assert.equal(Flash.withGlow(9).spawnIndex({ x: 1, y: 2 }), -1);
    Flash.isOnScreen = savedOnScreen;
    Flash.initialized = false;
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(Flash.withRadius(9).spawnPreset(id, 1, 2), -1);
    } finally {
      console.warn = warn;
      Flash.initialized = true;
    }
    assertSameAsReference({ x: 1, y: 2, radius: 300 }, () => Flash.spawnPreset(id, 1, 2), 'no override left');
  } finally {
    Camera._data = savedData;
    Flash.isOnScreen = savedOnScreen;
    restore();
  }
});

test('from the page, a preset spawn posts a full config, which the worker compiles to the same flash', () => {
  setup();
  const savedWindow = globalThis.window;
  const savedSelf = globalThis.self;
  let posted = null;
  try {
    globalThis.self = globalThis.self ?? {};
    globalThis.window = { scene: { _spawnFromPage: (EntityClass, config) => { posted = { EntityClass, config }; return 3; } } };
    const id = Flash.define({ lifespan: 18, color: 0xffaa00, radius: 1000, glow: 0, coneAngle: 1 });
    assert.equal(Flash.withGlow(0.4).spawnPreset(id, 7, 8, 9), 3);
    assert.equal(posted.EntityClass, Flash);
    assert.deepEqual(Object.keys(posted.config).sort(), [...FLASH_KEYS].sort(), 'every key, structured-clonable');
    delete globalThis.window;
    const want = { lifespan: 18, color: 0xffaa00, radius: 1000, glow: 0.4, coneAngle: 1, x: 7, y: 8, z: 9 };
    assertSameAsReference(want, () => {
      Flash.onSpawned(0, structuredClone(posted.config));
      return 0;
    }, 'the worker, from the posted config');
  } finally {
    if (savedWindow === undefined) delete globalThis.window;
    else globalThis.window = savedWindow;
    if (savedSelf === undefined) delete globalThis.self;
    else globalThis.self = savedSelf;
    restore();
  }
});

test('Flash.define refuses a key a flash does not know, spawnPreset an id define did not make', () => {
  assert.throws(() => Flash.define({ radius: 1, raduis: 2 }), /"raduis" is not a flash key/);
  assert.throws(() => Flash.define(null), TypeError);
  assert.throws(() => Flash.spawnPreset(-1, 0, 0), /not a preset/);
  assert.throws(() => Flash.spawnPreset(99999, 0, 0), /not a preset/);
});
