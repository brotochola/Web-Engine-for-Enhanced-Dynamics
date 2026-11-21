import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import WEED from '../../src/index.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { FlashComponent } from '../../src/components/flashComponent.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { Transform } from '../../src/components/transform.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { Flash } from '../../src/core/flash.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Layer } from '../../src/core/layer.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { seededRandom } from '../../src/util/utils.js';

// E-538: the guide's preset examples run as written (docs/guide/PARTICLES.md's "Presets" section, FLASHES.md's
// "Presets"): each block is run with the engine's WEED, and what it defines is called once: the particles and the flash
// it says it fires come out.

const N = 8;

/** The ```javascript blocks of `file` between `heading` and the next heading of its level or higher. */
function blocksUnder(file, heading) {
  const text = readFileSync(new URL(`../../docs/guide/${file}`, import.meta.url), 'utf8');
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `${file}: no "${heading}"`);
  const level = heading.match(/^#+/)[0];
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  const section = next < 0 ? rest : rest.slice(0, next);
  return [...section.matchAll(/```javascript\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** Run a guide block with WEED in scope; return the names it defines that the caller asks for. */
function runBlock(code, names) {
  const exported = names.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ');
  return new Function('WEED', `${code}\nreturn { ${exported} };`)(WEED);
}

function setup() {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  ParticleComponent.initializeArrays(new SharedArrayBuffer(ParticleComponent.getBufferSize(256)), 256);
  ParticleComponent.particleCount = 256;
  ParticleEmitter.reset();
  ParticleEmitter.initialize(256);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(512), new SharedArrayBuffer(8));
  ParticleEmitter.resetFreeListInterleaved(1);
  SpriteSheetRegistry.clearForSceneUnload();
  SpriteSheetRegistry.register('bigAtlas', {
    animations: { spark: ['spark'], square: ['square'], muzzle1: ['muzzle1'], muzzle2: ['muzzle2'], muzzle3: ['muzzle3'] },
  });
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.x[0] = 100;
  Transform.y[0] = 50;
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  FlashComponent.initializeArrays(new SharedArrayBuffer(FlashComponent.getBufferSize(N)), N);
  Flash.initialize(N);
  globalThis.rng = seededRandom(5, 'guide');
}

function liveParticles() {
  let n = 0;
  for (let i = 0; i < ParticleComponent.active.length; i++) if (ParticleComponent.active[i]) n++;
  return n;
}

test('PARTICLES.md\'s preset examples run: the gunner\'s shot and the campfire\'s embers', () => {
  setup();
  const saved = GameObject._spawnAt;
  let flashes = 0;
  GameObject._spawnAt = (EntityClass, spawnConfig) => {
    const i = 4 + (flashes++ % 4);
    EntityClass.onSpawned(i, spawnConfig);
    return i;
  };
  try {
    const blocks = blocksUnder('PARTICLES.md', '## Presets: the bursts a game fires again and again');
    assert.equal(blocks.length, 2, 'the shot and the embers');
    const { Gunner } = runBlock(blocks[0], ['Gunner']);
    Gunner.shoot(0, 1, 0);
    assert.ok(liveParticles() >= 11, `the muzzle sprite and 10 to 15 sparks: ${liveParticles()}`);
    assert.equal(flashes, 1, 'the muzzle flash');
    assert.equal(LightEmitter.color[4], 0xffaa00);
    const before = liveParticles();
    const { Campfire } = runBlock(blocks[1], ['Campfire']);
    Campfire.emitEmbers(0, 0.5);
    assert.ok(liveParticles() > before, 'embers');
  } finally {
    GameObject._spawnAt = saved;
  }
});

test('FLASHES.md\'s preset example runs: a hit\'s flash and a spark of random strength', () => {
  setup();
  const saved = GameObject._spawnAt;
  const spawned = [];
  GameObject._spawnAt = (EntityClass, spawnConfig) => {
    const i = spawned.length;
    EntityClass.onSpawned(i, spawnConfig);
    spawned.push(i);
    return i;
  };
  try {
    const blocks = blocksUnder('FLASHES.md', '### Presets');
    assert.equal(blocks.length, 1);
    const { flashTheHit } = runBlock(blocks[0], ['flashTheHit']);
    flashTheHit(10, 20);
    assert.deepEqual(spawned, [0, 1]);
    assert.equal(LightEmitter.radius[0], 707);
    assert.ok(LightEmitter.radius[1] > 316 && LightEmitter.radius[1] < 448, `the spark's reach, 10·√strength: ${LightEmitter.radius[1]}`);
    assert.equal(LightEmitter.castShadows[1], 0);
  } finally {
    GameObject._spawnAt = saved;
  }
});
