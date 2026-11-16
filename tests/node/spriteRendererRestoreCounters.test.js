/**
 * N-186: a save restore writes SpriteRenderer's columns directly (applyEntitySaveRestore), past the zIndex and emissive
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

test('a restored glowing sprite with a zIndex counts in both counters; one restored without them leaves them', () => {
  boot();
  assert.equal(SpriteRenderer.emissiveUsers(), 0);
  assert.equal(SpriteRenderer.zIndexUsers(), 0);
  // The flags a glowing sprite carries, as a live one would have them after spriteRenderer.emissive = true.
  const live = { index: 2 };
  Object.setPrototypeOf(live, SpriteRenderer.prototype);
  live.emissive = true;
  const flags = SpriteRenderer.gbufFlags[2];
  live.emissive = false;
  SpriteRenderer.gbufFlags[2] = 0;
  assert.equal(SpriteRenderer.emissiveUsers(), 0);

  const before = SpriteRenderer.usersOfRow(5);
  applyEntitySaveRestore(5, Entity, { SpriteRenderer: { fields: { zIndex: 3, gbufFlags: flags } } });
  assert.equal(SpriteRenderer.emissiveUsers(), 0, 'the restore alone does not count (the bug)');
  SpriteRenderer.recountRow(5, before);
  assert.equal(SpriteRenderer.emissiveUsers(), 1);
  assert.equal(SpriteRenderer.zIndexUsers(), 1);

  const plain = SpriteRenderer.usersOfRow(6);
  applyEntitySaveRestore(6, Entity, { SpriteRenderer: { fields: { zIndex: 0, gbufFlags: 0 } } });
  SpriteRenderer.recountRow(6, plain);
  assert.equal(SpriteRenderer.emissiveUsers(), 1);
  assert.equal(SpriteRenderer.zIndexUsers(), 1);
});

test('a slot restored over a glowing one that the save brings back without glow leaves the counters', () => {
  boot();
  const s = { index: 1 };
  Object.setPrototypeOf(s, SpriteRenderer.prototype);
  s.emissive = 1.5;
  s.zIndex = 2;
  assert.equal(SpriteRenderer.emissiveUsers(), 1);
  assert.equal(SpriteRenderer.zIndexUsers(), 1);
  const before = SpriteRenderer.usersOfRow(1);
  applyEntitySaveRestore(1, Entity, { SpriteRenderer: { fields: { zIndex: 0, gbufFlags: 0 } } });
  SpriteRenderer.recountRow(1, before);
  assert.equal(SpriteRenderer.emissiveUsers(), 0);
  assert.equal(SpriteRenderer.zIndexUsers(), 0);
});
