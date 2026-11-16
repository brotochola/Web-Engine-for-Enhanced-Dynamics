// E-358 and E-359: the stamp's rows of the nearest lights (each caster's record of (distance, light) pairs, its counts
// tested sixteen at a time) and its keyed and full rows in fixed stores, against the JS reference
// (tests/reference/shadowStamp.mjs), bit for bit: the cursor, every stamp row and light index, and not a byte written
// past them. shadowStampWasm.test.js's random frames (lights in pairs on one spot, more lights over a caster than
// maxShadowsPerEntity keeps, empty light slots, cone and dim lights, a begin and a stride, few casters under many lights)
// with up to six lights a caster, a stamp cut at its last row, a row before it or before its base. Each frame is
// stamped from full rows and from keyed rows (the reference stamps full rows: a keyed row is its caster's seven floats
// and the reference row's light vec4), in a memory that ends right after the sun rows, the stamp rows, the light
// indices, the counts or the records, so that a load or a store past one traps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT, GPU_KEYED_CASTER_FLOATS, GPU_KEYED_STAMP_FLOATS, GPU_SPRITE_FLOATS,
} from '../../src/render/gpuQueueLayout.js';
import { STAMP_SLOTS, bindShadowStamp, stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { NULL_GUARD_BYTES, STAMP_GRID_CELLS, STAMP_LIGHT_DOUBLES, STAMP_TABLE_SLOTS, layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { LIGHTS, frame, rng } from '../helpers/shadowStampFrames.mjs';

const SF = GPU_CASTER_FLOATS;
const KF = GPU_KEYED_CASTER_FLOATS;
const KS = GPU_KEYED_STAMP_FLOATS;
const MAX_SUN = 3000;
const MAX_PE = 6;
const MAX_CAP = 20000;
const PAGE = 65536;
const SENTINEL = 0xa5a5a5a5;
/** The region each memory ends with (null: none). */
const ENDS = ['sun', 'stamp', 'lightIdx', 'nearCount', 'near', null];
const RECORDS_SLOT = STAMP_SLOTS.indexOf('nearDist');
const COUNT_SLOT = STAMP_SLOTS.indexOf('nearCount');

/** A memory with the stamp's regions, `end` last and only as long as a frame needs it (place). */
async function memoryEndingWith(end) {
  const sizes = {
    table: STAMP_TABLE_SLOTS * 4,
    lights: LIGHTS * STAMP_LIGHT_DOUBLES * 8,
    tmpIdx: MAX_SUN * 4,
    dist: MAX_SUN * 4,
    order: MAX_SUN * 4,
    keep: MAX_SUN * 4,
    gridCounts: STAMP_GRID_CELLS * 4,
    gridStarts: (STAMP_GRID_CELLS + 1) * 4,
    gridItems: MAX_SUN * 4,
    near: MAX_SUN * MAX_PE * 8,
    nearCount: MAX_SUN,
    packedX: MAX_SUN * 4,
    packedY: MAX_SUN * 4,
    cellOf: MAX_SUN * 4,
    dist64: MAX_SUN * 8,
    sun: MAX_SUN * SF * 4,
    stamp: MAX_CAP * SF * 4,
    lightIdx: MAX_CAP * 2,
  };
  const regions = [{ name: 'guard', owner: 'nobody', bytes: NULL_GUARD_BYTES }];
  for (const [name, bytes] of Object.entries(sizes)) if (name !== end) regions.push({ name, owner: 'test', bytes });
  const layout = layoutRegions(regions);
  const pages = Math.ceil((layout.bytes + (end ? sizes[end] : 0)) / PAGE);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const R = layout.regions;
  const at = (name) => (R[name] ? R[name].byte : 0);
  const b = await bindShadowStamp(memory, {
    maxSun: MAX_SUN, maxPerEntity: MAX_PE, maxLights: LIGHTS,
    tmpIdxByte: at('tmpIdx'), distByte: at('dist'), orderByte: at('order'), keepByte: at('keep'),
    gridCountsByte: at('gridCounts'), gridStartsByte: at('gridStarts'), gridItemsByte: at('gridItems'),
    nearByte: at('near'), nearCountByte: at('nearCount'), packedXByte: at('packedX'), packedYByte: at('packedY'),
    cellOfByte: at('cellOf'), dist64Byte: at('dist64'), lightsByte: at('lights'), tableByte: at('table'),
  });
  return { end, b, R, memEnd: pages * PAGE };
}

/** This frame's sun rows, stamp rows and light indices in `mem` (the end region right before the memory's end). */
function place(mem, nSun, sf, df, cap, maxPE) {
  const { end, b, R, memEnd } = mem;
  const span = (name, bytes) => (end === name ? memEnd - bytes : R[name].byte);
  if (end === 'near') b.table[RECORDS_SLOT] = memEnd - nSun * maxPE * 8;
  if (end === 'nearCount') b.table[COUNT_SLOT] = memEnd - nSun;
  const buf = b.buffer;
  return {
    sun: new Float32Array(buf, span('sun', nSun * sf * 4), nSun * sf),
    // The regions the stamp may write, whole: past cap rows they must keep the sentinel.
    stampWords: end === 'stamp' ? new Uint32Array(buf, memEnd - cap * df * 4, cap * df) : new Uint32Array(buf, R.stamp.byte, MAX_CAP * SF),
    idxRegion: end === 'lightIdx' ? new Uint16Array(buf, memEnd - cap * 2, cap) : new Uint16Array(buf, R.lightIdx.byte, MAX_CAP),
  };
}

/** The JS reference on the frame's full rows, standalone arrays: the cursor, its rows and its light indices. */
function reference(f, full, cap) {
  const stamp = new Float32Array(Math.max(1, cap) * SF);
  const stampLightIdx = new Uint16Array(Math.max(1, cap));
  const cursor = stampLightRange({
    sun: full, sunN: f.nSun, sunFloats: SF, lights: f.lights, lightBegin: f.lightBegin, lightEnd: f.lights.length,
    lightStride: f.lightStride, maxPerLight: f.maxPerLight, maxPerEntity: f.maxPerEntity,
    tmpIdx: new Uint32Array(MAX_SUN), dist: new Float32Array(MAX_SUN), order: new Uint32Array(MAX_SUN),
    keepIdx: new Uint32Array(MAX_SUN), gridCounts: new Int32Array(STAMP_GRID_CELLS),
    gridStarts: new Int32Array(STAMP_GRID_CELLS + 1), gridItems: new Uint32Array(MAX_SUN),
    stamp, stampFloats: SF, stampCap: cap, stampBase: f.stampBase, stampLightIdx, lightVec: new Float32Array(4),
  });
  return { cursor, words: new Uint32Array(stamp.buffer), stampLightIdx };
}

const bytesOf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

/** What the stamp region must hold after the call: the reference's rows (keyed: rebuilt from them), the sentinel elsewhere. */
function expected(ref, f, keyedWords, keyed, words, cap) {
  const want = new Uint32Array(words).fill(SENTINEL);
  const df = keyed ? KS : SF;
  for (let q = f.stampBase; q < ref.cursor && q < cap; q++) {
    if (!keyed) {
      want.set(ref.words.subarray(q * SF, q * SF + SF), q * SF);
      continue;
    }
    const c = new Float32Array(ref.words.buffer, (q * SF + 2) * 4, 1)[0]; // each caster's row holds its index
    want.set(keyedWords.subarray(c * KF, c * KF + KF), q * df);
    want.set(ref.words.subarray(q * SF + GPU_CASTER_LIGHT_FLOAT, q * SF + GPU_CASTER_LIGHT_FLOAT + 4), q * df + KF);
  }
  return want;
}

test('E-358, E-359: keyed and full stamp rows, with and without the nearest lights, are the reference\'s, nothing past them', async (t) => {
  const mems = [];
  for (const end of ENDS) mems.push(await memoryEndingWith(end));
  const r = rng(0x358);
  const caps = { maxSun: MAX_SUN, maxStamp: MAX_CAP };
  const full = new Float32Array((MAX_SUN + 1) * SF);
  const keyed = new Float32Array(MAX_SUN * KF);
  const keyedWords = new Uint32Array(keyed.buffer);
  const scratch = {
    tmpIdx: new Uint32Array(MAX_SUN), dist: new Float32Array(MAX_SUN), order: new Uint32Array(MAX_SUN),
    keepIdx: new Uint32Array(MAX_SUN), gridCounts: new Int32Array(STAMP_GRID_CELLS),
    gridStarts: new Int32Array(STAMP_GRID_CELLS + 1), gridItems: new Uint32Array(MAX_SUN), lightVec: new Float32Array(4),
  };
  const seen = { rows: 0, perEntityRows: 0, fewCasters: 0, crowdedCasters: 0, emptySlots: 0, cutAtLastRow: 0, cutBefore: 0 };
  const FRAMES = 144;
  for (let k = 0; k < FRAMES; k++) {
    const f = frame(r, k, caps, { sun: full });
    f.maxPerEntity = [0, 1, 3, MAX_PE][Math.floor(k / ENDS.length) % 4];
    for (let c = 0; c < f.nSun; c++) {
      const s = c * SF;
      full[s + 2] = c;
      const shadow = s + GPU_SPRITE_FLOATS;
      keyed.set([full[s], full[s + 1], c, 0, full[shadow], full[shadow + 1], full[shadow + 2]], c * KF);
    }
    // The stamp cut where the frame's generator put it, at its last row, or a row before it.
    const all = reference(f, full, MAX_CAP).cursor;
    const cut = k % 3;
    const cap = cut === 0 ? Math.min(f.stampCap, MAX_CAP) : Math.max(0, all - (cut === 2 ? 1 : 0));
    const ref = reference(f, full, cap);
    const mem = mems[k % ENDS.length];
    for (const isKeyed of [false, true]) {
      const sf = isKeyed ? KF : SF;
      const df = isKeyed ? KS : SF;
      const views = place(mem, f.nSun, sf, df, cap, f.maxPerEntity);
      views.sun.set(isKeyed ? keyed.subarray(0, f.nSun * KF) : full.subarray(0, f.nSun * SF));
      views.stampWords.fill(SENTINEL);
      views.idxRegion.fill(0xa5a5);
      const stamp = new Float32Array(views.stampWords.buffer, views.stampWords.byteOffset, cap * df);
      const stampLightIdx = new Uint16Array(views.idxRegion.buffer, views.idxRegion.byteOffset, cap);
      const label = `frame ${k} (${f.nSun} casters, ${f.lights.length} lights, ${f.maxPerEntity} a caster, cap ${cap}, ` +
        `${isKeyed ? 'keyed' : 'full'} rows, the memory ending with ${mem.end ?? 'nothing of the stamp'})`;
      const cursor = stampLightRangeWasm(mem.b, {
        sun: views.sun, sunN: f.nSun, sunFloats: sf, lights: f.lights, lightBegin: f.lightBegin, lightEnd: f.lights.length,
        lightStride: f.lightStride, maxPerLight: f.maxPerLight, maxPerEntity: f.maxPerEntity, used: null, ...scratch,
        stamp, stampFloats: df, stampCap: cap, stampBase: f.stampBase, stampLightIdx, lightFloat: isKeyed ? KF : GPU_CASTER_LIGHT_FLOAT,
      });
      assert.equal(cursor, ref.cursor, `${label}: cursor`);
      const want = expected(ref, f, keyedWords, isKeyed, views.stampWords.length, cap);
      if (!bytesOf(views.stampWords).equals(bytesOf(want))) {
        const at = views.stampWords.findIndex((w, i) => w !== want[i]);
        assert.fail(`${label}: stamp word ${at} (row ${Math.floor(at / df)}): ${views.stampWords[at]}, not ${want[at]}`);
      }
      const wantIdx = new Uint16Array(views.idxRegion.length).fill(0xa5a5);
      for (let q = f.stampBase; q < ref.cursor && q < cap; q++) wantIdx[q] = ref.stampLightIdx[q];
      if (!bytesOf(views.idxRegion).equals(bytesOf(wantIdx))) {
        const q = views.idxRegion.findIndex((w, i) => w !== wantIdx[i]);
        assert.fail(`${label}: light index ${q}: ${views.idxRegion[q]}, not ${wantIdx[q]}`);
      }
    }
    const rows = Math.max(0, ref.cursor - f.stampBase);
    seen.rows += rows;
    if (f.maxPerEntity > 0 && rows > 0) {
      seen.perEntityRows += rows;
      // A light's vec4 goes through a table when four floats a light fit the candidates' scratch, else row by row.
      if (f.lights.length > Math.floor(f.nSun / 4)) seen.fewCasters++;
      if (f.lights.some((L) => !L)) seen.emptySlots++;
      for (let c = 0; c < f.nSun; c++) {
        let n = 0;
        for (const L of f.lights) {
          if (!L || !(L.rangeSq > 0) || !(L.intensity > 0)) continue;
          const dx = full[c * SF] - L.x;
          const dy = full[c * SF + 1] - L.y;
          if (dx * dx + dy * dy <= L.rangeSq) n++;
        }
        if (n > f.maxPerEntity) seen.crowdedCasters++;
      }
      if (cut === 1 && cap > f.stampBase) seen.cutAtLastRow++;
      if (cut === 2 && cap > f.stampBase) seen.cutBefore++;
    }
  }
  t.diagnostic(JSON.stringify(seen));
  assert.ok(seen.perEntityRows > 20000, `the nearest lights write rows (${seen.perEntityRows})`);
  assert.ok(seen.fewCasters > 0, 'frames with more lights than the scratch holds vec4s for');
  assert.ok(seen.crowdedCasters > 1000, `casters under more lights than they keep (${seen.crowdedCasters})`);
  assert.ok(seen.emptySlots > 0, 'frames with an empty light slot');
  assert.ok(seen.cutAtLastRow > 0 && seen.cutBefore > 0, 'stamps cut at their last row and a row before it');
});
