// N-417, E-549: the keyed statics' CPU copy (staticsMirror), which the renders' columns over keyed caster rows read. The
// real InstancedSpriteBatch methods over a batch's fields: the copy reads the updates' float views (N-417: they were
// emptied after being made, and every value read NaN), and keeps only the slots whose texture can cast columns, or did
// (E-549), nothing in an atlas without such a frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InstancedSpriteBatch } from '../../src/render/instancedSpriteBatch.js';
import { GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS, GPU_KEYED_TEX_WORDS } from '../../src/render/gpuPackClient.js';
import { keyedColumnTextures } from '../../src/render/sunShadowMap.js';
import { TEX_LUT_FLOATS } from '../../src/render/instancedSpriteBatch.js';

const SLOTS = 8;

/** A keyed batch's copy and update lists, as its constructor makes them; `columns` its atlas's flags (or none set). */
function batch(columns) {
  const updates = new Float32Array(4 * GPU_KEYED_ROW_WORDS);
  const tex = new Float32Array(4 * GPU_KEYED_TEX_WORDS);
  const b = Object.create(InstancedSpriteBatch.prototype);
  Object.assign(b, {
    _staticsMirror: new Float32Array(SLOTS * 3),
    _columnSlot: new Uint8Array(SLOTS),
    _columnTex: new Uint8Array(0),
    _columnTexCount: -1,
    _keyUpdates: new Uint32Array(updates.buffer),
    _keyUpdatesF: updates,
    _keyTexUpdates: new Uint32Array(tex.buffer),
    _keyTexUpdatesF: tex,
  });
  if (columns) b.setColumnTextures(columns.flags, columns.count);
  return b;
}

/** Update k: slot `slot` takes texture `texture` and scale (sx, sy). */
function update(b, k, slot, texture, sx, sy) {
  const at = k * GPU_KEYED_ROW_WORDS;
  b._keyUpdatesF[at] = sx;
  b._keyUpdatesF[at + 1] = sy;
  b._keyUpdatesF[at + 6] = texture;
  b._keyUpdates[at + GPU_KEYED_KEY_WORD] = slot;
}

function texUpdate(b, k, slot, texture) {
  b._keyTexUpdates[2 * k] = slot;
  b._keyTexUpdatesF[2 * k + 1] = texture;
}

const slotOf = (b, s) => Array.from(b._staticsMirror.subarray(s * 3, s * 3 + 3));

test('before the atlas\'s table every update is copied: texture, scale x, scale y', () => {
  const b = batch(null);
  update(b, 0, 2, 5, 1.5, -2);
  texUpdate(b, 0, 3, 7);
  b._mirrorKeyedStatics(1, 1);
  assert.deepEqual(slotOf(b, 2), [5, 1.5, -2]);
  assert.deepEqual(slotOf(b, 3), [7, 0, 0]);
});

test('with the table, only the slots that show a texture that casts columns, or showed one', () => {
  // Textures 0..3; 2 is a render (its base a contact with a height map).
  const lut = new Float32Array(4 * TEX_LUT_FLOATS);
  lut[2 * TEX_LUT_FLOATS + 10] = -2.25;
  const columns = keyedColumnTextures(lut, TEX_LUT_FLOATS);
  assert.equal(columns.count, 1);
  const b = batch(columns);
  update(b, 0, 1, 1, 1, 1); // a plain frame: not kept
  update(b, 1, 4, 2, 3, 4); // the render: kept
  b._mirrorKeyedStatics(2, 0);
  assert.deepEqual(slotOf(b, 1), [0, 0, 0]);
  assert.deepEqual(slotOf(b, 4), [2, 3, 4]);
  // The render's slot turns to a plain frame: kept, so the copy no longer says render.
  texUpdate(b, 0, 4, 3);
  b._mirrorKeyedStatics(0, 1);
  assert.deepEqual(slotOf(b, 4), [3, 3, 4]);
  // And after that a plain frame there is not copied again.
  texUpdate(b, 0, 4, 1);
  b._mirrorKeyedStatics(0, 1);
  assert.deepEqual(slotOf(b, 4), [3, 3, 4]);
});

// E-492: the keyed pack sends a slot's statics again only when they change, so a render copied before the atlas's table
// is never sent again to flag its slot: the table flags the slots from the copy, and the render's next frame, a plain one,
// goes in.
test('a render copied before the table: its slot is flagged by the table, and its turn to a plain frame copied', () => {
  const lut = new Float32Array(4 * TEX_LUT_FLOATS);
  lut[2 * TEX_LUT_FLOATS + 10] = -2.25;
  const b = batch(null);
  update(b, 0, 4, 2, 3, 4);
  update(b, 1, 5, 1, 1, 1);
  b._mirrorKeyedStatics(2, 0);
  const columns = keyedColumnTextures(lut, TEX_LUT_FLOATS);
  b.setColumnTextures(columns.flags, columns.count);
  assert.deepEqual(Array.from(b._columnSlot.subarray(0, 6)), [0, 0, 0, 0, 1, 0], 'the render\'s slot flagged, the plain one not');
  texUpdate(b, 0, 4, 3);
  texUpdate(b, 1, 5, 0);
  b._mirrorKeyedStatics(0, 2);
  assert.deepEqual(slotOf(b, 4), [3, 3, 4], 'the render\'s slot now shows a plain frame');
  assert.deepEqual(slotOf(b, 5), [1, 1, 1], 'a plain slot is not copied again');
});

test('an atlas without a texture that casts columns copies nothing', () => {
  const b = batch(keyedColumnTextures(new Float32Array(4 * TEX_LUT_FLOATS), TEX_LUT_FLOATS));
  assert.equal(b.columnTextureCount, 0);
  update(b, 0, 2, 2, 1, 1);
  b._mirrorKeyedStatics(1, 0);
  assert.deepEqual(slotOf(b, 2), [0, 0, 0]);
});
