import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { collectSerializableEntities } from '../../src/core/save/entitySaveSnapshot.js';
import { encodeBinarySaveBody, decodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';
import { savePopulation } from '../bench/saveEncodeMicrobench.mjs';

// E-49. Saving built a schema fingerprint and lists per entity and encoded
// every component and field name again for every entity. Both are done once
// per save now; the bytes on disk must not change. The hash below was taken
// from the code before the change (and matches it after).

function payloadOf(entities) {
  return {
    sceneName: 'Golden',
    engineVersion: '0',
    layout: { types: [], totalEntityCount: entities.length },
    camera: null,
    sun: null,
    entities,
    joints: [],
  };
}

test('a fixed population saves to the same bytes as before', () => {
  const entities = collectSerializableEntities(savePopulation(24, 0x5a7e));
  const bytes = encodeBinarySaveBody(payloadOf(entities));
  assert.equal(bytes.length, 51908);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '7d71cd1a41900e45472a9448b099228787c35ea16b05f87ae65af1a025738698',
  );
});

test('more distinct names than the name cache holds still round-trip', () => {
  const fields = {};
  for (let i = 0; i < 5000; i++) fields[`field${i}`] = i * 0.5;
  const entities = [
    { typeName: 'Wide', entityIndex: 3, components: { Wide: { fingerprint: 7, fields } } },
    { typeName: 'Wide', entityIndex: 4, components: { Wide: { fingerprint: 7, fields } } },
  ];
  const back = decodeBinarySaveBody(encodeBinarySaveBody(payloadOf(entities)));
  assert.equal(back.entities.length, 2);
  for (const e of back.entities) {
    assert.deepEqual(e.components.Wide.fields, fields);
    assert.equal(e.components.Wide.fingerprint, 7);
  }
});
