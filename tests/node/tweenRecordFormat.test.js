import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { encodeBinarySaveBody, decodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';

// Review R9. The tween record's fields were listed four times (pack, restore,
// write, read); they come from one table now. The saved bytes must not move:
// this payload's body was hashed with the four hand-written lists.
// DX 4.2 bumped the section to layout 2 (repeat u32, doneMsg u32, flags u8 per
// record: +9 bytes each, 190 -> 208); size and hash re-taken. The
// layout 1 bytes still decode (tweenOptions.test.js).

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
  assert.equal(bytes.length, 208);
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    '00ebf015e8e048c4c274820861f4315bdc4b76fd6e32ef90adfc5df1df466ed9',
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
