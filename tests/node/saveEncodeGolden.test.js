import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { collectSerializableEntities } from '../../src/core/save/entitySaveSnapshot.js';
import { encodeBinarySaveBody, decodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';
import { savePopulation } from '../bench/saveEncodeMicrobench.mjs';
import { entityTable, tableField } from '../helpers/saveTable.mjs';

// The bytes a fixed population saves to: a change that means to keep the format must keep them.
// E-539 (format 6) saves the entities by columns, one table per type: the 24 entities' body went from 55 388 bytes
// (format 5: every value an f64 behind its field's name, entity by entity) to 16 988; size and hash re-taken. N-303
// CR-33 (format 9) dropped META's layout hint nothing read: 16 988 -> 16 982; size and hash re-taken.

function payloadOf(entities) {
  return {
    sceneName: 'Golden',
    engineVersion: '0',
    camera: null,
    sun: null,
    entities,
    joints: [],
  };
}

test('a fixed population saves to the same bytes as before', () => {
  const entities = collectSerializableEntities(savePopulation(24, 0x5a7e));
  const bytes = encodeBinarySaveBody(payloadOf(entities));
  assert.equal(bytes.length, 16982);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'e72d92a110c304f313a6f7bb210900f25b3ec36b92712f3897ed63ca0cb6b5c5',
  );
});

test('more distinct names than the name cache holds still round-trip', () => {
  const fields = {};
  for (let i = 0; i < 5000; i++) fields[`field${i}`] = Float64Array.of(i * 0.5, i * 0.25);
  const entities = [entityTable('Wide', [3, 4], { Wide: { fingerprint: 7, fields } })];
  const back = decodeBinarySaveBody(encodeBinarySaveBody(payloadOf(entities)));
  assert.equal(back.entities.length, 1);
  assert.deepEqual([...back.entities[0].indices], [3, 4]);
  assert.equal(back.entities[0].components[0].fingerprint, 7);
  for (let i = 0; i < 5000; i++) {
    assert.deepEqual([...tableField(back.entities[0], 'Wide', `field${i}`)], [i * 0.5, i * 0.25]);
  }
});
