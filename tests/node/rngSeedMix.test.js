import test from 'node:test';
import assert from 'node:assert/strict';

import { mixSeed, seededRandom } from '../../src/core/utils.js';

test('mixSeed is deterministic and splits main vs worker streams', () => {
  const seed = 123456;
  assert.equal(mixSeed(seed, 'main'), mixSeed(seed, 'main'));
  assert.notEqual(mixSeed(seed, 'main'), mixSeed(seed, 'logic0'));
  assert.notEqual(mixSeed(seed, 'logic0'), mixSeed(seed, 'physics'));

  const main = seededRandom(seed, 'main');
  const logic = seededRandom(seed, 'logic0');
  for (let i = 0; i < 32; i++) {
    assert.notEqual(main(), logic());
  }

  const a = seededRandom(seed, 'logic0');
  const b = seededRandom(seed, 'logic0');
  assert.equal(a(), b());
});
