// DX-SHADOW3D: where a frame stands (frameBase.js), measured from pictures drawn here: a person's feet, a tree's trunk
// over its roots, a render's legs; and how the base rides in the texture table's spare floats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ART_FLOOR_CODES,
  ART_FLOOR_MOST,
  ART_FLOOR_STEPS,
  CONTACT_HEIGHT,
  CONTACT_SHARE,
  MAPLESS_ROW_CODE,
  artFloorRatio,
  baseIsMapless,
  foreignArtFloor,
  maplessBaseShader,
  HEIGHT_PER_ROW_CODES,
  HEIGHT_PER_ROW_STEPS,
  isRenderDirections,
  lutBaseFloats,
  measureHeightPerRow,
  measureLowestContact,
  measureStandingBase,
  sheetArtFloor,
  sheetCastsSolid,
  sheetStandsOnContact,
} from '../../src/render/frameBase.js';
import { buildTextureLut, packTextureLutRgba, TEX_LUT_FLOATS } from '../../src/render/instancedSpriteBatch.js';

/** A w × h picture from rectangles [x0, y0, x1, y1) that are opaque. */
function picture(w, h, rects) {
  const on = new Uint8Array(w * h);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) on[y * w + x] = 1;
  }
  return (i, j) => on[j * w + i] === 1;
}

test('a person: the feet at the lowest rows, an ellipse 0.6 as deep as wide', () => {
  // 64 × 64: a body over two feet (rows 54..59), the lowest opaque row 60, the feet spanning x 24..39.
  const p = picture(64, 64, [[26, 10, 38, 54], [24, 54, 31, 60], [33, 54, 40, 60]]);
  const b = measureStandingBase(p, 64, 64);
  assert.equal(b.bottom, 60);
  assert.equal(b.cx, 32);
  assert.equal(b.rx, 8, 'half the feet\'s span, at most 8');
  assert.ok(Math.abs(b.ry - 4.8) < 1e-9);
});

test('a tree: the trunk above the roots, round', () => {
  // A canopy, a trunk 8 px wide (x 60..67) from row 40 to 180, roots spreading 40 px at the bottom (rows 176..180).
  const p = picture(128, 184, [[20, 0, 108, 40], [60, 40, 68, 180], [44, 176, 84, 180]]);
  const b = measureStandingBase(p, 128, 184);
  assert.equal(b.bottom, 180);
  assert.equal(b.cx, 64);
  assert.equal(b.rx, 4);
  assert.equal(b.ry, 4, 'a trunk is round');
});

test('an empty frame has no base', () => {
  assert.equal(measureStandingBase(() => false, 8, 8), null);
});

test('a render stands on its lowest contact: pixels within 1.5 px of its lowest point', () => {
  // Legs (height 0) at rows 30..39 and 20..29, a body (height 20) above: the lowest contact row is 39.
  const opaque = picture(40, 40, [[5, 20, 8, 30], [30, 30, 33, 40], [5, 5, 35, 20]]);
  const height = (i, j) => (j < 20 ? 20 : 0);
  assert.equal(measureLowestContact(opaque, height, 40, 40), 39.5);
  // Made smaller, a render's lowest visible pixels sit a little up: it still stands on them.
  assert.equal(measureLowestContact(opaque, (i, j) => (j < 20 ? 22.5 : 2.5), 40, 40), 39.5);
  assert.equal(measureLowestContact(opaque, () => CONTACT_HEIGHT + 1, 40, 40), 39.5, 'a frame all at one height: its lowest row');
  assert.equal(measureLowestContact(() => false, () => 0, 8, 8), null, 'an empty frame');
});

test('N-410: a render whose near wheels hide under its body stands on the low body, not on its far wheels', () => {
  // Seen from behind: the far wheels (height 0.9) at rows 10..14, the body above them, its lowest rows (height 3.7, the
  // rear's underside) at rows 30..39, the roof 40 px high at the top. Within 1.5 px only the far wheels count, and the
  // card stood on the far side of the bus; within a fifth of the heights the body's lowest row does.
  const opaque = picture(40, 40, [[20, 10, 24, 15], [5, 0, 35, 40]]);
  const height = (i, j) => (j < 10 ? 40 : j < 30 ? (i >= 20 && i < 24 && j < 15 ? 0.9 : 20) : 3.7);
  assert.equal(measureLowestContact(opaque, height, 40, 40), 39.5);
  assert.ok(CONTACT_SHARE * (40 - 0.9) > 3.7 - 0.9 && 3.7 - 0.9 > CONTACT_HEIGHT, 'the body is past 1.5 px and within the share');
  // A cow's head drawn below its hooves (held out towards the camera, 12 px up of its 30) is past a fifth of its heights:
  // the hooves' row stays its contact.
  const cow = picture(40, 40, [[0, 0, 30, 25], [5, 25, 8, 33], [30, 20, 38, 40]]);
  const cowHeight = (i, j) => (i >= 30 ? 12 : j < 25 ? 30 : 0);
  assert.equal(measureLowestContact(cow, cowHeight, 40, 40), 32.5);
});

test('N-297: how much of the picture of a render is height, along its top edge', () => {
  // A box 40 px deep on the floor and 20 px tall, seen from a camera that draws the floor 0.75 as tall and a px of height
  // 0.5 px: its far top edge is 40 * 0.75 + 20 * 0.5 = 40 rows above its near bottom edge (the contact, a row lower), at 20 px of
  // height: half a px of height a row.
  const w = 30;
  const h = 60;
  const contact = 49.5;
  const opaque = picture(w, h, [[5, 10, 25, 50]]);
  const heightAt = (i, j) => (j < 20 ? 20 : j < 40 ? 20 : (50 - j) * 2);
  assert.ok(Math.abs(measureHeightPerRow(opaque, heightAt, w, h, contact) - 20 / 39) < 1e-9, "the top row (its centre 39 rows above the contact) and its height");
  // Columns whose tops differ: least squares over them (a cabin's roof beside a lower bed).
  const mixed = picture(w, h, [[5, 10, 15, 50], [15, 30, 25, 50]]);
  const mixedHeight = (i, j) => (i < 15 ? 20 : 8);
  const tall = 39;
  const low = 19;
  const want = (10 * 20 * tall + 10 * 8 * low) / (10 * tall * tall + 10 * low * low);
  assert.ok(Math.abs(measureHeightPerRow(mixed, mixedHeight, w, h, contact) - want) < 1e-9);
  assert.equal(measureHeightPerRow(opaque, () => 0, w, h, contact), 0, 'a flat picture: no height');
  assert.equal(measureHeightPerRow(opaque, heightAt, w, h, 5.5), 0, 'nothing above the contact');
  assert.equal(measureHeightPerRow(() => false, () => 0, 8, 8, 4.5), 0, 'an empty frame');
});

test('a render is a sheet drawn from 8 directions or more', () => {
  assert.equal(isRenderDirections(undefined), false);
  assert.equal(isRenderDirections({ walk: { up: 'a', left: 'b', down: 'c', right: 'd' } }), false, 'a person of 4');
  assert.equal(isRenderDirections({ stand: { count: 32, anims: 'x_{i}' } }), true);
  const half = { mirrorX: true };
  for (let k = 0; k < 5; k++) half[String(k * 45 - 90)] = `d${k}`;
  assert.equal(isRenderDirections({ drive: half }), true, 'five drawn and mirrored');
});

test('the base rides in the texture table\'s last two floats', () => {
  const out = new Float32Array(2);
  lutBaseFloats(null, out, 0);
  assert.deepEqual(Array.from(out), [0, 0]);
  lutBaseFloats({ cx: 32, rx: 8, ry: 4.8 }, out, 0);
  assert.deepEqual(Array.from(out), [33, 8], 'feet');
  lutBaseFloats({ cx: 64, rx: 4, ry: 4 }, out, 0);
  assert.deepEqual(Array.from(out), [65, -4], 'a trunk');
  // N-297: a render's contact is its row's centre, so the float keeps the whole row and, in its fraction, the height a
  // row of the picture is (a code in 512ths: 0 not measured, else 1 + 256ths of a px), as the shadow shaders read them.
  lutBaseFloats({ contact: 39.5 }, out, 0);
  assert.deepEqual(Array.from(out), [-40, 0], 'a render with no measure: the whole row alone');
  const decode = (v) => {
    const packed = -v - 1;
    const code = Math.round((packed - Math.floor(packed)) * HEIGHT_PER_ROW_CODES);
    return { contact: Math.floor(packed) + 0.5, perRow: code > 0 ? (code - 1) / HEIGHT_PER_ROW_STEPS : null };
  };
  assert.deepEqual(decode(out[0]), { contact: 39.5, perRow: null });
  lutBaseFloats({ contact: 39.5, heightPerRow: 0.25, card: true }, out, 0);
  assert.deepEqual(decode(out[0]), { contact: 39.5, perRow: 0.25 });
  assert.equal(out[1], -0.5, 'a card for the sun: the second float negative');
  lutBaseFloats({ contact: 4095.5, heightPerRow: 0.123 }, out, 0);
  assert.equal(decode(out[0]).contact, 4095.5, 'a row near 4 096 and its code: exact in a float32');
  assert.ok(Math.abs(decode(out[0]).perRow - 0.123) <= 0.5 / HEIGHT_PER_ROW_STEPS);
  assert.equal(out[1], 0, 'a solid: the second float not negative');
  lutBaseFloats({ contact: 0.5, heightPerRow: 0 }, out, 0);
  assert.deepEqual(decode(out[0]), { contact: 0.5, perRow: 0 }, 'a flat frame, measured: no height a row');
  lutBaseFloats({ contact: 10.5, heightPerRow: 9 }, out, 0);
  assert.equal(decode(out[0]).contact, 10.5, 'a measure past the codes is held under the next row');

  // Through the table: a texture carrying a base (the Pixi worker sets weedBase from the atlas's json).
  const tex = { orig: { width: 64, height: 64 }, uvs: { x0: 0, y0: 0, x2: 0.5, y2: 0.5 }, trim: null, width: 64, height: 64 };
  const lut = buildTextureLut([{ ...tex, weedBase: { cx: 32, rx: 8, ry: 4.8 } }, tex]);
  assert.equal(TEX_LUT_FLOATS, 12);
  assert.deepEqual(Array.from(lut.subarray(10, 12)), [33, 8]);
  assert.deepEqual(Array.from(lut.subarray(22, 24)), [0, 0], 'no base: zeros');
  const rgba = packTextureLutRgba(lut, 2);
  assert.deepEqual(Array.from(rgba.subarray(10, 12)), [33, 8], 'the third texel\'s zw');
});

/** A shadow shader's own artFloorRatio, its text run here (its operators are JavaScript's). */
function shaderArtFloorRatio(file) {
  const src = readFileSync(new URL('../../src/shaders/' + file, import.meta.url), 'utf8');
  const at = src.search(/(float|fn) artFloorRatio\(/);
  assert.ok(at >= 0, file + ' has its artFloorRatio');
  const open = src.indexOf('{', at);
  const body = src.slice(open + 1, src.indexOf('\n}', open)).replace(/\b(float|let) code/, 'const code');
  const fract = (v) => v - Math.floor(v);
  const select = (no, yes, when) => (when ? yes : no);
  return new Function('fract', 'abs', 'floor', 'select', 'return (y, groundInvScaleY) => {' + body + '};')(
    fract, Math.abs, Math.floor, select);
}

test('a render of another camera keeps its art floor beside the card\'s mark and the footprint\'s row, as the shaders read it', () => {
  const tex = { orig: { width: 64, height: 64 }, uvs: { x0: 0, y0: 0, x2: 0.5, y2: 0.5 }, trim: null, width: 64, height: 64 };
  const readers = [shaderArtFloorRatio('instancedSpriteShadow.vert.glsl'), shaderArtFloorRatio('instancedSpriteShadow.wgsl')];
  const base = { contact: 39.5, heightPerRow: 0.25 };
  for (const card of [false, true]) {
    for (const slot of [-1, 0, 1, 54, 4095, 8190]) {
      for (const floor of [0, 0.736, 0.5, 0.7, 1, 0.01, 1.9]) {
        const t = { ...tex, weedBase: { ...base, card }, weedArtFloor: floor };
        if (slot >= 0) t.weedFootSlot = slot;
        const y = buildTextureLut([t])[11];
        const what = 'card ' + card + ', footprint ' + slot + ', floor ' + floor;
        // The card's mark and the footprint's row, as every program reads them.
        assert.equal(y < 0, card, what + ': the sign');
        assert.equal(Math.abs(y) >= 1, slot >= 0, what + ': a footprint or none');
        if (slot >= 0) assert.equal(Math.trunc(Math.abs(y) + 0.5) - 1, slot, what + ': the row');
        for (const sceneFloor of [0.5, 0.736]) {
          const want = artFloorRatio(floor, sceneFloor);
          for (const read of readers) assert.ok(Math.abs(read(y, 1 / sceneFloor) - want) < 1e-6, what + ': the ratio');
          if (floor === 0) assert.equal(want, 1, 'no art floor: exactly the scene\'s');
          else assert.ok(Math.abs(want - floor / sceneFloor) < 0.0021, what + ': ' + want);
        }
      }
    }
  }
  assert.equal(ART_FLOOR_MOST, ART_FLOOR_CODES / 2 - 1, 'a half is the mark of a card with no footprint: no code reaches it');
  assert.ok(artFloorRatio(99, 1) * ART_FLOOR_STEPS <= ART_FLOOR_MOST, 'a floor past the codes is held at the last');
  // With no art floor the table holds what it held before, to the bit.
  const out = new Float32Array(2);
  lutBaseFloats({ ...base, card: true }, out, 0, 0);
  assert.equal(out[1], -0.5);
  lutBaseFloats(base, out, 0);
  assert.equal(Object.is(out[1], 0), true);
});

test('only a render drawn for another camera than the scene\'s has an art floor of its own', () => {
  const scene = { camera: { floorScaleY: 0.5 } };
  assert.equal(foreignArtFloor(0.736, scene, 0.5), 0.736);
  assert.equal(foreignArtFloor(0.736, { camera: {} }, 0.7364193217154872), 0, 'the same camera, written with more digits');
  assert.equal(foreignArtFloor(0.736, {}, 1), 0, 'a scene with no camera draws no heights');
  assert.equal(foreignArtFloor(undefined, scene, 0.5), 0);
  const json = {
    animations: { car_drive_0: ['car/0'], walker_walk_up: ['walker/0'] },
    frames: { 'car/0': { base: { contact: 41, card: true, artFloor: 0.736 } }, 'walker/0': { base: { cx: 8, rx: 5, ry: 3 } } },
  };
  assert.equal(sheetArtFloor(json, { animations: { drive_0: { prefixedName: 'car_drive_0' } } }), 0.736);
  assert.equal(sheetArtFloor(json, { animations: { walk_up: { prefixedName: 'walker_walk_up' } } }), 0);
  assert.equal(sheetArtFloor(null, { animations: {} }), 0);
});

test('a sheet casts its solid when a frame of it stands on a contact (a render with height maps)', () => {
  const json = {
    animations: { barn_stand_0: ['barn/0'], barn_stand_1: ['barn/1'], walker_walk_up: ['walker/0'] },
    frames: { 'barn/0': { base: { contact: 41 } }, 'barn/1': { base: { contact: 40 } }, 'walker/0': { base: { cx: 8, rx: 5, ry: 3 } } },
  };
  const barn = { animations: { stand_0: { prefixedName: 'barn_stand_0' }, stand_1: { prefixedName: 'barn_stand_1' } } };
  const walker = { animations: { walk_up: { prefixedName: 'walker_walk_up' } } };
  assert.equal(sheetCastsSolid(json, barn), true);
  assert.equal(sheetCastsSolid(json, walker), false);
  // A contact at row 0 is one; a sheet the atlas does not know, or no atlas, is not.
  json.frames['walker/0'].base = { contact: 0 };
  assert.equal(sheetCastsSolid(json, walker), true);
  assert.equal(sheetCastsSolid(json, { animations: { x: { prefixedName: 'missing' } } }), false);
  assert.equal(sheetCastsSolid(null, barn), false);
});

test('N-412: a render with no height map stands on its lowest row for its card, and casts no solid for any light', () => {
  const out = new Float32Array(2);
  lutBaseFloats({ contact: 394.5, heightPerRow: -1, card: true, mapless: true }, out, 0);
  assert.equal(baseIsMapless(out[0]), true, 'its code is the mapless one');
  assert.equal(out[1], -0.5, 'a card for the sun');
  const packed = -out[0] - 1;
  assert.equal(Math.floor(packed) + 0.5, 394.5, 'its contact, the row the shaders read');
  // A measured render, however tall a row, keeps a code below it; ellipses and empty bases are no render at all.
  lutBaseFloats({ contact: 10.5, heightPerRow: 9 }, out, 0);
  assert.equal(baseIsMapless(out[0]), false, 'a measure past the codes stops one short of the mapless code');
  assert.ok(Math.round((-out[0] - 1 - 10) * HEIGHT_PER_ROW_CODES) === MAPLESS_ROW_CODE - 1);
  assert.equal(baseIsMapless(33), false);
  assert.equal(baseIsMapless(0), false);
  // The shaders' test reads the same float the same way (GLSL's floor and fract, here in JS).
  const shader = maplessBaseShader('b');
  const fract = (v) => v - Math.floor(v);
  const read = (x) => new Function('b', 'floor', 'fract', `return ${shader};`)({ x }, Math.floor, fract);
  lutBaseFloats({ contact: 394.5, mapless: true, card: true }, out, 0);
  assert.equal(read(out[0]), true);
  lutBaseFloats({ contact: 394.5, heightPerRow: 0.4, card: true }, out, 0);
  assert.equal(read(out[0]), false);
  // A sheet whose frames are such renders stands on no contact and casts no solid: its lamps and its sun take its card.
  const json = { animations: { car_drive_0: ['car/0'] }, frames: { 'car/0': { base: { contact: 60.5, heightPerRow: -1, card: true, mapless: true } } } };
  const car = { animations: { drive_0: { prefixedName: 'car_drive_0' } } };
  assert.equal(sheetStandsOnContact(json, car), false);
  assert.equal(sheetCastsSolid(json, car), false);
});
