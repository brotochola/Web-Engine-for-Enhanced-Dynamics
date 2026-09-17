import test from 'node:test';
import assert from 'node:assert/strict';
import { Flash } from '../../src/core/flash.js';

test('Flash.spawn is the only public factory', () => {
  assert.equal(typeof Flash.spawn, 'function');
  assert.equal(Flash.create, undefined);
});
