/**
 * N-186: a save restore writes SpriteRenderer's columns directly (applyEntitySaveRestore), past the zIndex and unshaded
 * setters that keep the two counters: SpriteRenderer.usersOfRow / recountRow bring the counters in line, as
 * GameObject._spawnAt does around the restore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { applyEntitySaveRestore } from '../../src/core/save/entitySaveSnapshot.js';

function boot(count = 8) {
  SpriteRenderer.clearArrays();
  const buffer = new SharedArrayBuffer(SpriteRenderer.getBufferSize(count));
  SpriteRenderer.initializeArrays(buffer, count, 0);
}

/** An entity class with a SpriteRenderer, as the restore reads it. */
const Entity = { name: 'Lantern', _componentClassMap: { SpriteRenderer } };

test('a restored unshaded sprite with a zIndex counts in both counters; one restored without them leaves them', () => {
  boot();
  assert.equal(SpriteRenderer.unshadedUsers(), 0);
  assert.equal(SpriteRenderer.zIndexUsers(), 0);
  // The flags an unshaded sprite carries, as a live one would have them after spriteRenderer.unshaded = true.
  const live = { index: 2 };
  Object.setPrototypeOf(live, SpriteRenderer.prototype);
  live.unshaded = true;
  const flags = SpriteRenderer.gbufFlags[2];
  live.unshaded = false;
  SpriteRenderer.gbufFlags[2] = 0;
  assert.equal(SpriteRenderer.unshadedUsers(), 0);

  const before = SpriteRenderer.usersOfRow(5);
  applyEntitySaveRestore(5, Entity, { SpriteRenderer: { fields: { zIndex: 3, gbufFlags: flags } } });
  assert.equal(SpriteRenderer.unshadedUsers(), 0, 'the restore alone does not count (the bug)');
  SpriteRenderer.recountRow(5, before);
  assert.equal(SpriteRenderer.unshadedUsers(), 1);
  assert.equal(SpriteRenderer.zIndexUsers(), 1);

  const plain = SpriteRenderer.usersOfRow(6);
  applyEntitySaveRestore(6, Entity, { SpriteRenderer: { fields: { zIndex: 0, gbufFlags: 0 } } });
  SpriteRenderer.recountRow(6, plain);
  assert.equal(SpriteRenderer.unshadedUsers(), 1);
  assert.equal(SpriteRenderer.zIndexUsers(), 1);
});

test('a slot restored over an unshaded one that the save brings back shaded leaves the counters', () => {
  boot();
  const s = { index: 1 };
  Object.setPrototypeOf(s, SpriteRenderer.prototype);
  s.unshaded = true;
  s.zIndex = 2;
  assert.equal(SpriteRenderer.unshadedUsers(), 1);
  assert.equal(SpriteRenderer.zIndexUsers(), 1);
  const before = SpriteRenderer.usersOfRow(1);
  applyEntitySaveRestore(1, Entity, { SpriteRenderer: { fields: { zIndex: 0, gbufFlags: 0 } } });
  SpriteRenderer.recountRow(1, before);
  assert.equal(SpriteRenderer.unshadedUsers(), 0);
  assert.equal(SpriteRenderer.zIndexUsers(), 0);
});

// DX-UNSHADED: yes or no; setting it twice counts once; the old name is said once and passed on.
test('spriteRenderer.unshaded is yes or no, counted once, and emissive passes on to it', () => {
  boot();
  const s = { index: 3 };
  Object.setPrototypeOf(s, SpriteRenderer.prototype);
  s.unshaded = true;
  s.unshaded = true;
  assert.equal(s.unshaded, true);
  assert.equal(SpriteRenderer.unshadedUsers(), 1);
  s.unshaded = 'yes';
  assert.equal(s.unshaded, false, 'only true turns it on');
  assert.equal(SpriteRenderer.unshadedUsers(), 0);
});
