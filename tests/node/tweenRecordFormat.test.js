import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { encodeBinarySaveBody, decodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';

// Review R9. The tween record's fields were listed four times (pack, restore,
// write, read); they come from one table now. The saved bytes must not move:
// this payload's body was hashed with the four hand-written lists.

const TWEENS = [
  { kind: 2, ease: 5, mask: 9, entity: 70000, duration: 1.5, elapsed: 0.25, from0: 0.1, to0: 0.9, from1: 2, to1: 3, from2: -4, to2: 4.5, from3: 0, to3: 0, tintFrom: 0xff8800, tintTo: 0x00ffaa },
  { kind: 0, ease: 1, mask: 1, entity: 3, duration: 2, elapsed: 1, from0: 1, to0: 2.5, from1: 0, to1: 0, from2: 0, to2: 0, from3: 0, to3: 0, tintFrom: 0, tintTo: 0 },
];

function payload() {
  return {
    sceneName: 'T',
    engineVersion: 'x',
    layout: { types: [], totalEntityCount: 0 },
    entities: [],
    joints: [],
    camera: null,
    sun: null,
    timeScale: 1,
    tweens: TWEENS,
  };
}

test('a save with tweens encodes to the same bytes as before the record table', () => {
  const bytes = encodeBinarySaveBody(payload());
  assert.equal(bytes.length, 190);
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    '01087f7e93d8b6bbb0d82c4cefde5fc3dfc7026d4301ab3fb058a7a8f434c47f',
  );
});

test('tween records read back field for field (f32 fields at f32 precision)', () => {
  const back = decodeBinarySaveBody(encodeBinarySaveBody(payload())).tweens;
  assert.equal(back.length, TWEENS.length);
  for (let i = 0; i < TWEENS.length; i++) {
    for (const [key, value] of Object.entries(TWEENS[i])) {
      assert.equal(back[i][key], Math.fround(value) === value ? value : Math.fround(value), `${i}.${key}`);
    }
  }
});
