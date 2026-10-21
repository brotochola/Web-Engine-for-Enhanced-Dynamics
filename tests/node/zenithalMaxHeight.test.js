import test from 'node:test';
import assert from 'node:assert/strict';

import { PARTICLE_DEFAULTS, resolveZenithalMaxHeight } from '../../src/util/configDefaults.js';
import { loadWorker, quietly } from '../bench/workerHarness.mjs';

// Review R8. Pre-render read zenithalMaxHeight with `?? 50` and the Pixi worker
// with `> 0 ? h : 50`, so an explicit 0 left pre-render dividing heights by
// zero (an Infinity scale, every zenithal particle fully faded) while the
// particle-light splat used 50. Both resolve it the same way now.

test('a zenithal height of 0, negative or unset takes the default', () => {
  for (const cfg of [undefined, null, {}, { zenithalMaxHeight: 0 }, { zenithalMaxHeight: -10 }, { zenithalMaxHeight: NaN }]) {
    assert.equal(resolveZenithalMaxHeight(cfg), PARTICLE_DEFAULTS.zenithalMaxHeight, JSON.stringify(cfg));
  }
  assert.equal(resolveZenithalMaxHeight({ zenithalMaxHeight: 80 }), 80);
});

test('pre-render takes the default for a zenithal height of 0', async () => {
  const w = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  w.config = { particle: { zenithalMaxHeight: 0 } };
  // initialize reads the particle config early, then binds buffers this
  // minimal data does not carry; only the field matters here.
  await quietly(() => w.initialize({ buffers: {} }).catch(() => {}));
  assert.equal(w.zenithalMaxHeight, PARTICLE_DEFAULTS.zenithalMaxHeight);
});
