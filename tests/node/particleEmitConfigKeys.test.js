import test from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { Layer } from '../../src/core/layer.js';

// Every public emit path merges the caller's config into a reusable scratch through
// ParticleEmitter._cfgFieldList (emit and emitZenithal pass mode overrides, emitFlat
// and emitAlongLine too). A key missing from that list never reaches the spawn loop.

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

// Structural guard for this bug class: a key read by the spawn loop but missing from the
// field list is dropped on every public path. The read count floor keeps the scan from
// passing vacuously if `cfg` is ever renamed.
test('every config key the spawn loop reads is in _cfgFieldList', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../src/core/particleEmitter.js', import.meta.url), 'utf8');
  const reads = new Set([...src.matchAll(/\bcfg\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  assert.ok(reads.size >= 20, `only ${reads.size} cfg reads found; did cfg get renamed?`);
  reads.add('layer');
  reads.add('layers');
  const list = new Set(ParticleEmitter._cfgFieldList);
  const missing = [...reads].filter((k) => !list.has(k));
  assert.deepEqual(missing, [], `read but never copied: ${missing.join(', ')}`);
});

test('angularVelocity in config reaches the particle (degrees per ms)', () => {
  const max = setup();
  ParticleEmitter.emit({ ...base, angularVelocity: 90 });
  const [i] = activeIndices(max);
  assert.equal(ParticleComponent.hasAngularVel[i], 1);
  assert.ok(Math.abs(ParticleComponent.angularVelFrom[i] - Math.PI / 2) < 1e-6);
});
