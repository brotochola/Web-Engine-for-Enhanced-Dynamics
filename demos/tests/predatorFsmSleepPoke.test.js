import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const files = [
  'demos/predatorScene/fsm/soldierBehaviorFsm.js',
  'demos/predatorScene/fsm/civilianBehaviorFsm.js',
];

test('predator behavior FSMs do not poke RigidBody.sleeping', () => {
  for (const rel of files) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
    assert.equal(src.includes('RigidBody.sleeping'), false, rel);
  }
});
