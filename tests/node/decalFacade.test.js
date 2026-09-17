import test from 'node:test';
import assert from 'node:assert/strict';
import { Decal } from '../../src/core/decal.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';

test('Decal.stamp returns 0 when ParticleEmitter pool is not initialized', { concurrency: false }, () => {
  ParticleEmitter.reset();
  assert.equal(ParticleEmitter.initialized, false);
  assert.equal(Decal.stamp({ x: 1, y: 2, texture: 'blood' }), 0);
});
