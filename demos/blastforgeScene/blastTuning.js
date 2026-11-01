// blastTuning.js – the preset as tuned in the panel, from the panel (main thread) to the Detonator (a logic worker).
// The panel keeps a tuned copy of every preset, as Blastforge does, and writes the active one here; the Detonator
// rebuilds its preset when the generation moves, never per blast.

import WEED from '/src/index.js';
import { PALETTES, SCHEMA } from './explosionPresets.js';

const { SharedResource } = WEED;

/** Palette keys, in BlastTuning.palette's order. */
export const PALETTE_KEYS = Object.keys(PALETTES);

/**
 * The tuned fields of one preset. One writer: the panel, on the main thread. Reader: the Detonator. Generation 0
 * means nothing was written yet: the Detonator then sets off the preset as it is.
 */
export class BlastTuning extends SharedResource {
  static schema = {
    values: { type: Float64Array, length: SCHEMA.length }, // the preset's fields, in SCHEMA's order, exact
    palette: Uint8Array, // index into PALETTE_KEYS
    preset: Uint8Array, // which preset these values tune (BlastSettings.preset's index)
    generation: Uint32Array, // bumped after each write
  };
}

/** The key of one of the PALETTES. */
export function paletteKey(palette) {
  const key = PALETTE_KEYS.find((k) => PALETTES[k] === palette);
  if (key === undefined) throw new Error('blastTuning: the palette is not one of PALETTES');
  return key;
}

/** Write preset `index`'s tuned fields for the Detonator. Main thread. */
export function writeTuning(index, preset) {
  const values = BlastTuning.values;
  for (let i = 0; i < SCHEMA.length; i++) values[i] = preset[SCHEMA[i][0]];
  BlastTuning.palette[0] = PALETTE_KEYS.indexOf(paletteKey(preset.palette));
  BlastTuning.preset[0] = index;
  Atomics.add(BlastTuning.generation, 0, 1);
}

/** The preset the Detonator sets off for preset `index`: `base` with the tuned fields, when they tune this preset. */
export function tunedPreset(index, base) {
  if (Atomics.load(BlastTuning.generation, 0) === 0 || BlastTuning.preset[0] !== index) return base;
  const preset = { ...base, palette: PALETTES[PALETTE_KEYS[BlastTuning.palette[0]]] };
  const values = BlastTuning.values;
  for (let i = 0; i < SCHEMA.length; i++) preset[SCHEMA[i][0]] = values[i];
  return preset;
}
