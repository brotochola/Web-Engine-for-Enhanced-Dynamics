import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPoolScene } from '../helpers/poolScene.mjs';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { writeGbufWords } from '../../src/render/gbufWord.js';

// N-273: a decoration can name the entity it is part of (a house's walls and roofs). Its rows then carry that entity's
// G-buffer id, so the light pass takes its pixels as the entity's and the entity's own shadow volume leaves them lit.

test('N-273: spawn and spawnMany keep the owner (an entity index or a GameObject), and a reused slot drops it', () => {
  buildPoolScene({ decorations: 8 });
  const D = DecorationComponent;
  const wall = DecorationPool.spawn({ x: 1, y: 2, owner: 5 });
  assert.equal(D.owner[wall], 6, 'entity 5, kept as 6');
  const byObject = DecorationPool.spawn({ x: 1, y: 2, owner: { index: 0 } });
  assert.equal(D.owner[byObject], 1, 'a GameObject gives its index');
  const loose = DecorationPool.spawn({ x: 1, y: 2 });
  assert.equal(D.owner[loose], 0, 'no owner');
  assert.ok(DecorationPool.despawn(wall));
  const next = DecorationPool.spawn({ x: 3, y: 3 });
  assert.equal(next, wall, 'the test needs the slot back');
  assert.equal(D.owner[next], 0, 'the slot does not keep the last owner');

  const out = new Int32Array(3);
  assert.equal(DecorationPool.spawnMany({ x: [1, 2, 3], y: 0, owner: 7, out }), 3);
  assert.deepEqual([...out].map((i) => D.owner[i]), [8, 8, 8], 'one owner for them all');
  buildPoolScene({ decorations: 8 });
  assert.equal(DecorationPool.spawnMany({ x: [1, 2, 3], y: 0, owner: [2, null, 4], out }), 3);
  assert.deepEqual([...out].map((i) => D.owner[i]), [3, 0, 5], 'one owner each');
});

test('N-273: a decoration row with an owner carries the owner\'s id alone; one without, or past the entities, none', () => {
  const entities = 70000;
  const flags = new Uint8Array(entities).fill(63);
  const selfShadow = new Uint8Array(entities).fill(3);
  const owner = new Uint32Array([0, 1, 65536, 70001, 9]);
  // Rows: an entity's sprite, then decorations 0 to 4 (type 2), and a particle (type 1) with decoration 1's index.
  const rowType = new Uint8Array([0, 2, 2, 2, 2, 2, 1]);
  const rowEntity = new Int32Array([3, 0, 1, 2, 3, 4, 1]);
  const out = new Float32Array(rowType.length * 2);
  writeGbufWords(out, rowType.length, null, rowType, rowEntity, null, entities, flags, selfShadow, null, owner);
  const words = [];
  for (let k = 0; k < rowType.length; k++) words.push(out[2 * k]);
  const sprite = 4 + 63 * 65536 + 3 * 4194304;
  // Decoration 0 has none; 1 is entity 0's; 2 entity 65535's, id 1 past the wrap; 3 past the entities; 4 entity 8's.
  assert.deepEqual(words, [sprite, 0, 1, 1, 0, 9, 0], 'the owner\'s id ((entity % 65535) + 1), no flags');
  writeGbufWords(out, rowType.length, null, rowType, rowEntity, null, entities, flags, selfShadow, null, null);
  assert.equal(out[2], 0, 'without the column a decoration is no entity, as before');
});
