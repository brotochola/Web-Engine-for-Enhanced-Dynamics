import test from 'node:test';
import assert from 'node:assert/strict';

import { resetWarnOnce, warnOnce } from '../../src/util/dxWarn.js';

test('warnOnce says each subject and rule once, with the prefix', () => {
  const saved = console.warn;
  const lines = [];
  console.warn = (s) => lines.push(s);
  try {
    resetWarnOnce();
    assert.equal(warnOnce('Soldier', 'hook', 'Soldier is wrong'), true);
    assert.equal(warnOnce('Soldier', 'hook', 'Soldier is wrong'), false, 'the same subject and rule');
    assert.equal(warnOnce('Soldier', 'field', 'Soldier is wrong elsewhere'), true, 'another rule');
    assert.equal(warnOnce('Tank', 'hook', 'Tank is wrong'), true, 'another subject');
    resetWarnOnce();
    assert.equal(warnOnce('Soldier', 'hook', 'Soldier is wrong'), true, 'after a reset');
  } finally {
    console.warn = saved;
  }
  assert.deepEqual(lines, [
    'WeedJS: Soldier is wrong',
    'WeedJS: Soldier is wrong elsewhere',
    'WeedJS: Tank is wrong',
    'WeedJS: Soldier is wrong',
  ]);
});
