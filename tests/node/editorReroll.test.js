// Another look (VISUAL_EDITOR_PLAN.md ED-56): the inspector's 🎲 writes a new seed for each selected placed entity
// (what its onSpawned draws at random), respawning it, as one undo; nothing selected, nothing to do.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../helpers/editorHandlesWorld.mjs';

test('one entity: a new seed, one respawn, undone by one Ctrl+Z', () => {
  const world = makeWorld();
  try {
    const { editMode, calls } = world;
    world.select('Ball1');
    calls.length = 0;
    assert.equal(editMode.rerollSelected(), true);
    assert.ok(Number.isInteger(world.record('Ball1').seed));
    assert.deepEqual(calls.map((c) => c[0]), ['despawn', 'spawn']);
    assert.equal(editMode.history._done.at(-1).label, 'another look for Ball1');
    editMode.undo();
    assert.equal('seed' in world.record('Ball1'), false);
  } finally {
    world.done();
  }
});

test('several: each its own seed, as one undo; nothing selected: nothing', () => {
  const world = makeWorld();
  try {
    const { editMode } = world;
    editMode.multi.selectNames(['Block1', 'Ball1', 'Rock1']);
    assert.equal(editMode.rerollSelected(), true);
    const seeds = ['Block1', 'Ball1', 'Rock1'].map((name) => world.record(name).seed);
    assert.ok(seeds.every(Number.isInteger));
    assert.equal(new Set(seeds).size, 3, 'each its own');
    editMode.undo();
    assert.deepEqual(['Block1', 'Ball1', 'Rock1'].map((name) => 'seed' in world.record(name)), [false, false, false]);
    editMode.multi.clear();
    editMode.selection.clear();
    assert.equal(editMode.rerollSelected(), false);
  } finally {
    world.done();
  }
});
