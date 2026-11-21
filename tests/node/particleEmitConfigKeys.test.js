import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { PARTICLE_EMIT_KEYS, ParticleEmitter } from '../../src/core/particleEmitter.js';
import { Layer } from '../../src/core/layer.js';

// Every public emit path compiles the caller's config into the emit's row (compileEmit: emit, emitZenithal, emitFlat
// and emitAlongLine on every call, define once for a preset). PARTICLE_EMIT_KEYS lists the keys it reads; define
// refuses any other, so a key the compile reads but the list lacks could not be put in a preset.

const BUILT_IN_LAYERS = { decals: {}, castedShadows: {}, entities: {}, lighting: {} };

function setup(max = 16) {
  Layer.reset();
  Layer.initializeFromConfig({ fx: { zIndex: 5 } }, BUILT_IN_LAYERS, true);
  const buffer = new SharedArrayBuffer(ParticleComponent.getBufferSize(max));
  ParticleComponent.initializeArrays(buffer, max);
  ParticleComponent.particleCount = max;
  ParticleEmitter.reset();
  ParticleEmitter.initialize(max);
  ParticleEmitter.initializeFreeList(
    new SharedArrayBuffer(max * Uint16Array.BYTES_PER_ELEMENT),
    new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT)
  );
  ParticleEmitter.resetFreeListInterleaved(1);
  return max;
}

function activeIndices(max) {
  const out = [];
  for (let i = 0; i < max; i++) if (ParticleComponent.active[i]) out.push(i);
  return out;
}

const base = { count: 1, x: 10, y: 20, lifespan: 500, speed: 0 };

for (const [name, call] of [
  ['emit', (cfg) => ParticleEmitter.emit(cfg)],
  ['emitZenithal', (cfg) => ParticleEmitter.emitZenithal(cfg)],
  ['emitFlat', (cfg) => ParticleEmitter.emitFlat(cfg)],
  ['emitAlongLine', (cfg) => ParticleEmitter.emitAlongLine({ ...cfg, x0: 0, y0: 0, x1: 10, y1: 0, count: 1 })],
]) {
  test(`${name} routes particles to the layer named in config`, () => {
    const max = setup();
    const fxBit = Layer.bit(Layer.get('fx').id);
    assert.notEqual(fxBit, Layer.entitiesMask());
    assert.equal(call({ ...base, layer: 'fx' }), 1);
    const [i] = activeIndices(max);
    assert.equal(ParticleComponent.layerMask[i], fxBit, `${name}: layer 'fx' was ignored`);
  });

  test(`${name} routes particles to the layers list in config`, () => {
    const max = setup();
    const both = Layer.bit(Layer.get('fx').id) | Layer.entitiesMask();
    assert.equal(call({ ...base, layers: ['fx', 'entities'] }), 1);
    const [i] = activeIndices(max);
    assert.equal(ParticleComponent.layerMask[i], both);
  });
}

test('without layer or layers a particle stays on the entities layer', () => {
  const max = setup();
  ParticleEmitter.emit({ ...base });
  const [i] = activeIndices(max);
  assert.equal(ParticleComponent.layerMask[i], Layer.entitiesMask());
});

// Structural guard for this bug class: a key the compile (cfg) or the emit (spec, by name: textures and layers) reads
// must be in PARTICLE_EMIT_KEYS, and every listed key must be read. The read count floor keeps the scan from passing
// vacuously if `cfg` is ever renamed.
test('every config key the compile and the emit read is in PARTICLE_EMIT_KEYS, and every listed key is read', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../src/core/particleEmitter.js', import.meta.url), 'utf8');
  const compileAt = src.indexOf('function compileEmit(');
  const compile = src.slice(compileAt, src.indexOf('\n}\n', compileAt));
  const emit = src.slice(src.indexOf('static _emitRow('), src.indexOf('static reset()'));
  const reads = new Set([
    ...[...compile.matchAll(/\bcfg\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
    ...[...emit.matchAll(/\bspec\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
  ]);
  assert.ok(reads.size >= 30, `only ${reads.size} cfg reads found; did cfg get renamed?`);
  reads.add('layer');
  reads.add('layers');
  const list = new Set(PARTICLE_EMIT_KEYS);
  const missing = [...reads].filter((k) => !list.has(k));
  assert.deepEqual(missing, [], `read but not listed: ${missing.join(', ')}`);
  const unread = [...list].filter((k) => !reads.has(k));
  assert.deepEqual(unread, [], `listed but never read: ${unread.join(', ')}`);
});

test('angularVelocity in config reaches the particle (degrees per ms)', () => {
  const max = setup();
  ParticleEmitter.emit({ ...base, angularVelocity: 90 });
  const [i] = activeIndices(max);
  assert.equal(ParticleComponent.hasAngularVel[i], 1);
  assert.ok(Math.abs(ParticleComponent.angularVelFrom[i] - Math.PI / 2) < 1e-6);
});

// E-538: define takes every emit key, and refuses anything else (a typo in a preset shows once, at load).
test('define accepts a config of every emit key and refuses one it does not know', () => {
  const config = {};
  for (const key of PARTICLE_EMIT_KEYS) config[key] = undefined;
  assert.equal(typeof ParticleEmitter.define(config), 'number');
  assert.throws(() => ParticleEmitter.define({ ...base, speeed: 2 }), /"speeed" is not an emit key/);
  assert.throws(() => ParticleEmitter.defineFlat({ ...base, x0: 0 }), /defineFlat: "x0"/);
});
