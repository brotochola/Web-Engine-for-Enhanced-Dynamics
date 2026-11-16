// N-197 / N-203: which frame each light's shadow rows of a directional caster draw. A card takes the frame that light sees
// (a fixed card its front); columns (a height map, a render's solid) are built from the frame the camera sees, whatever
// the sheet casts for the other light: a car's sheet casts its card for the sun and its solid for the lamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS, GPU_KEYED_CASTER_FLOATS, GPU_KEYED_STAMP_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { loadWorker } from '../bench/workerHarness.mjs';

const DIRS = 4;
const FRAMES = 2;
// Sheets by id: 1 one picture per direction with no contact (a person), 2 a render on a contact whose json keeps its card
// for the sun (a car), 3 a render that casts its solid (the barn).
const SHEETS = { 1: { solid: false, contact: false }, 2: { solid: false, contact: true }, 3: { solid: true, contact: true } };
const KIND = { AUTO: 0, SPRITE: 1, HEIGHT_MAP: 2 };
// The shipped row layout's floats pre-render's passes write (preRenderWorker.js GPU_ROW_*).
const ROW_SCALE_X = 2;
const ROW_TINT = 9;
const ROW_TEXTURE = 10;

function tablesSource() {
  const out = {};
  for (const [id, flags] of Object.entries(SHEETS)) {
    out[id] = {
      count: DIRS, uniform: true, start: 0, step: Math.PI / 2, angles: [0, Math.PI / 2, Math.PI, 1.5 * Math.PI],
      anim: [0, 1, 2, 3], flip: [0, 0, 0, 0], groups: ['walk'], ...flags,
    };
  }
  return out;
}

/** Each sheet's four directions as one animation each, FRAMES frames apiece, in sheet order: texture = its first + frame. */
function animationTables() {
  const proxy = {};
  const starts = [];
  const counts = [];
  let offset = 0;
  for (const id of Object.keys(SHEETS)) {
    proxy[id] = {};
    for (let d = 0; d < DIRS; d++) {
      const global = (id - 1) * DIRS + d;
      proxy[id][d] = global;
      starts[global] = offset;
      counts[global] = FRAMES;
      offset += FRAMES;
    }
  }
  return { proxy, starts, counts };
}

/** The frame value a row gets for sheet `sheet`'s direction d, frame 0: textureId + 1. */
const frameValue = (sheet, d) => ((sheet - 1) * DIRS + d) * FRAMES + 1;

// The casters: [sheet, kind, orient]. Each is drawn facing direction 0 (the camera's frame); its lamp stands west of it,
// so the lamp sees direction 3 (a quarter turn), and a fixed card's front is direction 1 (the frame facing the camera).
const CASTERS = [
  [1, KIND.AUTO, 0], // a person left to its sheet: a card for every light
  [2, KIND.AUTO, 0], // a car left to its sheet: columns for the lamps
  [2, KIND.SPRITE, 0], // a car asked for its card
  [1, KIND.HEIGHT_MAP, 0], // a height map asked of a sheet that casts its card
  [2, KIND.SPRITE, 1], // a car's fixed card
  [3, KIND.AUTO, 0], // a render that casts its solid
];

async function setup() {
  await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const mod = await import('../../src/workers/preRenderWorker.js');
  const n = CASTERS.length;
  const c = {
    mod,
    tables: mod.sunFrameTables(tablesSource()),
    ...animationTables(),
    active: new Uint8Array(n).fill(1),
    mode: new Uint8Array(n).fill(1),
    casts: new Uint8Array(n).fill(1),
    sheets: Uint8Array.from(CASTERS, (x) => x[0]),
    kinds: Uint8Array.from(CASTERS, (x) => x[1]),
    orients: Uint8Array.from(CASTERS, (x) => x[2]),
    dirs: new Uint8Array(n),
    anims: new Uint8Array(n),
    frames: new Uint16Array(n),
    lights: [{ id: 99999, x: 0, y: 0 }],
  };
  return c;
}

/** The lamp rows as the stamp pass copies them from the sun's: each caster 100 px east of the lamp, with a sun frame. */
function lampArgs(c, rows) {
  return [rows, CASTERS.length, new Uint8Array(CASTERS.length), c.lights, 1, c.tables, c.proxy, c.starts, c.counts, c.frames,
    c.active, c.mode, c.dirs, c.anims, c.sheets, c.orients, c.kinds];
}

test('N-203: keyed lamp rows: cards take the frame the lamp sees, columns the sprite\'s own', async () => {
  const c = await setup();
  const rows = new Float32Array(CASTERS.length * GPU_KEYED_STAMP_FLOATS);
  for (let e = 0; e < CASTERS.length; e++) {
    const at = e * GPU_KEYED_STAMP_FLOATS;
    rows[at] = 100;
    rows[at + 2] = e;
    rows[at + 3] = 777; // the sun's frame, copied with the row
    rows[at + 4] = 30;
  }
  c.mod.applyKeyedLampFramesInto(...lampArgs(c, rows));
  const got = CASTERS.map((_, e) => rows[e * GPU_KEYED_STAMP_FLOATS + 3]);
  assert.deepEqual(got, [frameValue(1, 3), 0, frameValue(2, 3), 0, frameValue(2, 1), 0]);
});

test('N-203: full lamp rows: cards take the frame the lamp sees, columns the frame the camera sees', async () => {
  const c = await setup();
  const rows = new Float32Array(CASTERS.length * GPU_CASTER_FLOATS);
  for (let e = 0; e < CASTERS.length; e++) {
    const at = e * GPU_CASTER_FLOATS;
    rows[at] = 100;
    rows[at + ROW_SCALE_X] = 1;
    rows[at + ROW_TINT] = e;
    rows[at + ROW_TEXTURE] = 777; // the sun's frame, copied with the row
  }
  c.mod.applyLampFramesInto(...lampArgs(c, rows));
  const got = CASTERS.map((_, e) => rows[e * GPU_CASTER_FLOATS + ROW_TEXTURE] + 1);
  const camera = (sheet) => frameValue(sheet, 0);
  assert.deepEqual(got, [frameValue(1, 3), camera(2), frameValue(2, 3), camera(1), frameValue(2, 1), camera(3)]);
});

test('N-203: the sun: a card takes the frame the sun sees, a height map or a solid keeps the camera\'s', async () => {
  const c = await setup();
  const n = CASTERS.length;
  const shift = new Int32Array(4);
  const shiftTurn = new Float64Array(4).fill(NaN);
  // A sun that turns the view by a quarter.
  c.mod.prepareSunFrames(c.tables, c.proxy, c.starts, c.counts, shift, shiftTurn, Math.PI / 2);
  const rows = new Float32Array(n * GPU_KEYED_CASTER_FLOATS);
  const zeros = new Uint8Array(n);
  const entities = Int32Array.from({ length: n }, (_, i) => i);
  c.mod.applyKeyedSunFramesFor(rows, n, n, zeros, new Float32Array(n).fill(30), zeros, entities, c.active, c.mode, c.casts,
    c.sheets, c.dirs, c.anims, c.frames, c.tables, shift, c.orients, c.kinds);
  const got = CASTERS.map((_, e) => rows[e * GPU_KEYED_CASTER_FLOATS + 3] !== 0);
  // The person and the car take the sun's frame (their sheets cast their cards for the sun), so do the cards asked for;
  // the height map asked of the person's sheet and the barn's solid keep the camera's (0, the sprite's own).
  assert.deepEqual(got, [true, true, true, false, true, false]);
  assert.equal(rows[4 * GPU_KEYED_CASTER_FLOATS + 3], frameValue(2, 1), 'the fixed card shows its front');
});
