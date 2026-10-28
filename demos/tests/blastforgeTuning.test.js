import test from 'node:test';
import assert from 'node:assert/strict';

import '../../tests/helpers/registerWebRoot.mjs';

// The Blastforge demo's presets carry all 32 of the lab's fields (SCHEMA), and the panel's tuning reaches the
// Detonator through BlastTuning exactly, for the preset it tunes. The panel itself is DOM, checked in Chromium.

const { SharedResource } = await import('../../src/core/sharedResource.js');
const { PALETTES, PRESETS, SCHEMA } = await import('../../demos/blastforgeScene/explosionPresets.js');
const { BlastTuning, PALETTE_KEYS, tunedPreset, writeTuning } = await import('../../demos/blastforgeScene/blastTuning.js');

test('every preset has every SCHEMA field, inside its slider\'s range, and a palette from PALETTES', () => {
  assert.equal(SCHEMA.length, 32);
  for (const preset of Object.values(PRESETS)) {
    for (const [key, , min, max] of SCHEMA) {
      const value = preset[key];
      assert.equal(typeof value, 'number', `${preset.name}.${key}`);
      assert.ok(value >= min && value <= max, `${preset.name}.${key} = ${value}, outside ${min}-${max}`);
    }
    assert.ok(PALETTE_KEYS.some((key) => PALETTES[key] === preset.palette), `${preset.name}'s palette`);
    assert.equal(typeof preset.palette.light, 'number', `${preset.name}'s palette has a light color`);
  }
});

test('the panel\'s tuning reaches the Detonator exactly, and only for the preset it tunes', () => {
  BlastTuning.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(BlastTuning.schema)), BlastTuning.schema);
  try {
    const list = Object.values(PRESETS);
    assert.equal(tunedPreset(2, list[2]), list[2], 'nothing written yet: the preset as it is');
    const tuned = { ...list[2], radius: 61, lobeSpread: 0.45, wave: 7.3, light: 0.05, palette: PALETTES.arcane };
    writeTuning(2, tuned);
    const out = tunedPreset(2, list[2]);
    for (const [key] of SCHEMA) assert.equal(out[key], tuned[key], key);
    assert.equal(out.palette, PALETTES.arcane);
    assert.equal(out.name, list[2].name);
    assert.equal(tunedPreset(3, list[3]), list[3], 'another preset is not tuned by it');
    assert.notEqual(list[2].radius, 61, 'the preset itself is untouched');
  } finally {
    BlastTuning.reset();
  }
});
