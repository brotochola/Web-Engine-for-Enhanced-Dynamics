// E-370 to E-372: the frame passes of directional casters (pre-render's sun rows, keyed sun rows, lamp stamp rows full and
// keyed) write bit for bit what they wrote before, on random scenes: uniform tables of 4 to 32 directions and uneven ones,
// tables whose count is not a multiple of four or whose step is not a whole turn's share, flipped slots, slots the atlas
// lacks, fixed cards, casters whose kind is not a card, sheets that cast their solid or stand on a contact, rows of other
// types, entities out of range, lamps all around their casters (rays along the borders between two directions too) and
// lights missing. The reference is the passes as they were (E-368, E-369), copied here. E-372: the keyed sun rows' frames
// written by the keyed caster scan (gpuPack.wasm) itself, and the rows it leaves to the JS, against the same reference.
// E-393: the lamps' frames of the keyed and full stamp rows written by gpuPack.wasm's lamp_frames, and the rows it leaves
// to the JS, against the JS passes (applyKeyedLampFramesInto, applyLampFramesInto) and the reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_CASTER_FLOATS, GPU_KEYED_CASTER_FLOATS, GPU_KEYED_STAMP_FLOATS, GPU_SPRITE_FLOATS,
} from '../../src/render/gpuQueueLayout.js';
import {
  GPU_PACK_COLUMNS, KEYED_SUN_DEFER, KEYED_SUN_LAMP_GEO, KEYED_SUN_SHEET, KEYED_SUN_SHEET_WORDS, bindGpuPack,
  keyedSunRegionBytes, keyedSunViews, packKeyedCastersScanWasm,
} from '../../src/render/gpuPackClient.js';
import { DirectionalSprite } from '../../src/components/directionalSprite.js';
import { PICK_ARGS, pickDirection, pickDirectionArgs, wrapAngle } from '../../src/core/spriteDirections.js';
import { mulberry32 } from '../bench/benchMath.js';
import { loadWorker } from '../bench/workerHarness.mjs';

// The shipped row layout's floats the passes write (preRenderWorker.js GPU_ROW_*).
const GPU_ROW_SCALE_X = 2;
const GPU_ROW_TINT = 9;
const GPU_ROW_TEXTURE = 10;

// ---------------------------------------------------------------------------------------------------------------------
// The reference: preRenderWorker.js's frame passes at bdcca2e7, verbatim but for the names.

function refSunFrameTables(byId) {
  if (!byId) return null;
  const out = [];
  let any = false;
  for (const [id, src] of Object.entries(byId)) {
    if (!src || !(src.count > 0)) continue;
    const entry = {
      count: src.count,
      uniform: src.uniform === true,
      start: +src.start,
      step: +src.step,
      angles: Float64Array.from(src.angles),
      anim: Uint8Array.from(src.anim),
      flip: Uint8Array.from(src.flip),
      groups: src.groups.length,
      solid: src.solid === true,
      contact: src.contact === true,
      front: 0,
      slotStart: new Int32Array(0),
      slotCount: new Int32Array(0),
      slotsOf: null,
      maxFrames: 1,
      frameOf: new Int32Array(0),
      frameShift: -1,
      frameAt: new Int32Array(0),
    };
    entry.front = pickDirection(entry, Math.PI / 2, 255, 0);
    out[id | 0] = entry;
    any = true;
  }
  return any ? out : null;
}

function refSunFrameSlotsOf(t, map, starts, counts, proxy) {
  const slots = t.anim.length;
  const start = new Int32Array(slots).fill(-1);
  const count = new Int32Array(slots);
  for (let s = 0; s < slots; s++) {
    const global = map ? map[t.anim[s]] : undefined;
    if (global === undefined) continue;
    start[s] = starts[global] | 0;
    count[s] = counts[global] | 0;
  }
  t.slotStart = start;
  t.slotCount = count;
  t.slotsOf = proxy;
  let most = 1;
  for (let s = 0; s < slots; s++) if (count[s] > most) most = count[s];
  t.maxFrames = most;
  t.frameOf = new Int32Array(t.count * t.groups * most);
  t.frameShift = -1;
  t.frameAt = new Int32Array(t.count * t.groups * most);
  refSunFrameResolve(t, 0, t.frameAt);
}

function refSunFrameResolve(t, shift, out) {
  const count = t.count;
  const groups = t.groups;
  const most = t.maxFrames;
  for (let cur = 0; cur < count; cur++) {
    let d = cur + shift;
    if (d >= count) d -= count;
    for (let g = 0; g < groups; g++) {
      const slot = g * count + d;
      const start = t.slotStart[slot];
      const nf = t.slotCount[slot];
      const at = (cur * groups + g) * most;
      for (let f = 0; f < most; f++) {
        if (start < 0) {
          out[at + f] = 0;
          continue;
        }
        const tid = start + (f < nf ? f : 0) + 1;
        out[at + f] = t.flip[slot] === 1 ? -tid : tid;
      }
    }
  }
  if (out === t.frameOf) t.frameShift = shift;
}

const REF_SUN_TURN = new Float64Array(1);
const REF_LAMP_TURN = new Float64Array(1);
const REF_LAMP_RAY = new Float64Array(2);
const CARD_KIND = 1;

function refCastsCard(t, kinds, e, lamps) {
  const k = kinds !== null ? kinds[e] : 0;
  if (k === CARD_KIND) return true;
  if (k !== 0) return false;
  return lamps ? !t.contact : !t.solid;
}

function refPrepareSunFrames(tables, proxy, starts, counts, shift, shiftTurn, turn) {
  REF_SUN_TURN[0] = turn;
  for (let sheet = 0; sheet < tables.length; sheet++) {
    const t = tables[sheet];
    if (t === undefined) continue;
    if (t.slotsOf !== proxy) refSunFrameSlotsOf(t, proxy[sheet], starts, counts, proxy);
    if (t.uniform && shiftTurn[sheet] !== turn) {
      shiftTurn[sheet] = turn;
      shift[sheet] = Math.round(wrapAngle(turn) / t.step) % t.count;
    }
    if (t.uniform && t.frameShift !== shift[sheet]) refSunFrameResolve(t, shift[sheet], t.frameOf);
  }
}

function refSunFrameFor(e, active, mode, casts, sheets, dirs, anims, frames, tables, shift, orients, kinds) {
  if (active[e] !== 1 || mode[e] !== 1 || (casts !== null && casts[e] !== 1)) return 0;
  const sheet = sheets[e];
  const t = tables[sheet];
  if (t === undefined || !refCastsCard(t, kinds, e, false)) return 0;
  const fixed = orients !== null && orients[e] === 1;
  const cur = dirs[e];
  let d = 0;
  if (fixed) {
    d = t.front;
  } else if (t.uniform && cur < t.count) {
    let f = frames !== null ? frames[e] | 0 : 0;
    if (f < 0 || f >= t.maxFrames) f = 0;
    const g = anims[e];
    return t.frameOf[(cur * t.groups + (g < t.groups ? g : 0)) * t.maxFrames + f];
  } else {
    d = refSunFrameDirection(t, e, REF_SUN_TURN);
  }
  const g = anims[e];
  const slot = (g < t.groups ? g : 0) * t.count + d;
  const start = t.slotStart[slot];
  if (start < 0) return 0;
  let f = frames !== null ? frames[e] | 0 : 0;
  if (f < 0 || f >= t.slotCount[slot]) f = 0;
  const tid = start + f + 1;
  return t.flip[slot] === 1 ? -tid : tid;
}

function refApplySunFramesFor(rows, sunN, casters, types, entities, active, mode, casts, sheets, dirs, anims, frames,
  tables, shift, orients, kinds = null) {
  for (let k = 0; k < sunN; k++) {
    const row = casters[k];
    if (types[row] !== 0) continue;
    const v = refSunFrameFor(entities[row], active, mode, casts, sheets, dirs, anims, frames, tables, shift, orients, kinds);
    if (v === 0) continue;
    const at = k * GPU_CASTER_FLOATS;
    rows[at + GPU_ROW_TEXTURE] = (v < 0 ? -v : v) - 1;
    const sx = rows[at + GPU_ROW_SCALE_X];
    rows[at + GPU_ROW_SCALE_X] = (v < 0) === (sx < 0) ? sx : -sx;
  }
}

/** The worker's _tagCasterEntities loop: each full sun row's entity in its tint float. */
function refTagCasterEntities(rows, sunN, casters, types, entities) {
  for (let k = 0; k < sunN; k++) {
    const row = casters[k];
    rows[k * GPU_CASTER_FLOATS + GPU_ROW_TINT] = types[row] === 0 ? entities[row] : -1;
  }
}

function refApplyKeyedSunFramesFor(rows, keyedN, count, qType, shadowH, types, entities, active, mode, casts, sheets,
  dirs, anims, frames, tables, shift, orients, kinds = null) {
  let n = 0;
  for (let i = 0; i < count && n < keyedN; i++) {
    if (qType && qType[i] === 3) continue;
    if (!(shadowH[i] > 0)) continue;
    const k = n++;
    if (types[i] !== 0) continue;
    const v = refSunFrameFor(entities[i], active, mode, casts, sheets, dirs, anims, frames, tables, shift, orients, kinds);
    if (v !== 0) rows[k * GPU_KEYED_CASTER_FLOATS + 3] = v;
  }
}

function refFastAtan2(y, x) {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const big = ax > ay ? ax : ay;
  if (big === 0) return 0;
  const a = (ax > ay ? ay : ax) / big;
  const q = a * a;
  let r = a * (0.999866 + q * (-0.3302995 + q * (0.180141 + q * (-0.085133 + q * 0.0208351))));
  if (ay > ax) r = 1.5707963267948966 - r;
  if (x < 0) r = 3.141592653589793 - r;
  return y < 0 ? -r : r;
}

function refPrepareLampFrames(tables, proxy, starts, counts) {
  for (let sheet = 0; sheet < tables.length; sheet++) {
    const t = tables[sheet];
    if (t !== undefined && t.slotsOf !== proxy) refSunFrameSlotsOf(t, proxy[sheet], starts, counts, proxy);
  }
}

function refLampFrameFor(e, t, dirs, anims, frames) {
  const cur = dirs[e];
  let d = 0;
  if (t.uniform && cur < t.count) {
    const turn = -1.5707963267948966 - refFastAtan2(REF_LAMP_RAY[1], REF_LAMP_RAY[0]);
    d = (cur + Math.round(wrapAngle(turn) / t.step)) % t.count;
    if (d < 0) d += t.count;
  } else {
    REF_LAMP_TURN[0] = -1.5707963267948966 - Math.atan2(REF_LAMP_RAY[1], REF_LAMP_RAY[0]);
    d = refSunFrameDirection(t, e, REF_LAMP_TURN);
  }
  const g = anims[e];
  let f = frames !== null ? frames[e] | 0 : 0;
  if (f < 0 || f >= t.maxFrames) f = 0;
  return t.frameAt[(d * t.groups + (g < t.groups ? g : 0)) * t.maxFrames + f];
}

function refFrameFacing(e, t, d, anims, frames) {
  if (d >= t.count) return 0;
  const g = anims[e];
  let f = frames !== null ? frames[e] | 0 : 0;
  if (f < 0 || f >= t.maxFrames) f = 0;
  return t.frameAt[(d * t.groups + (g < t.groups ? g : 0)) * t.maxFrames + f];
}

function refApplyLampFramesInto(rows, stampN, lightIdx, lights, invG, tables, proxy, starts, counts, frames, dsActive, dsMode,
  dirs, anims, sheets, orients, kinds = null) {
  refPrepareLampFrames(tables, proxy, starts, counts);
  for (let k = 0; k < stampN; k++) {
    const at = k * GPU_CASTER_FLOATS;
    const e = rows[at + GPU_ROW_TINT] | 0;
    if (e < 0 || e >= dsActive.length || dsActive[e] !== 1 || dsMode[e] !== 1) continue;
    const t = tables[sheets[e]];
    if (t === undefined) continue;
    const card = refCastsCard(t, kinds, e, true);
    const fixed = orients !== null && orients[e] === 1;
    let v = 0;
    if (card && !fixed) {
      const L = lights[lightIdx[k]];
      if (!L) continue;
      REF_LAMP_RAY[0] = rows[at] - L.x;
      REF_LAMP_RAY[1] = (rows[at + 1] - L.y) * invG;
      v = refLampFrameFor(e, t, dirs, anims, frames);
    } else {
      v = refFrameFacing(e, t, card ? t.front : dirs[e], anims, frames);
    }
    if (v === 0) continue;
    rows[at + GPU_ROW_TEXTURE] = (v < 0 ? -v : v) - 1;
    const sx = rows[at + GPU_ROW_SCALE_X];
    rows[at + GPU_ROW_SCALE_X] = (v < 0) === (sx < 0) ? sx : -sx;
  }
}

function refApplyKeyedLampFramesInto(rows, stampN, lightIdx, lights, invG, tables, proxy, starts, counts, frames, dsActive,
  dsMode, dirs, anims, sheets, orients, kinds = null) {
  refPrepareLampFrames(tables, proxy, starts, counts);
  for (let k = 0; k < stampN; k++) {
    const at = k * GPU_KEYED_STAMP_FLOATS;
    const e = rows[at + 2] | 0;
    if (e < 0 || e >= dsActive.length || dsActive[e] !== 1 || dsMode[e] !== 1) continue;
    const t = tables[sheets[e]];
    if (t === undefined) continue;
    if (!refCastsCard(t, kinds, e, true)) {
      if (rows[at + 3] !== 0) rows[at + 3] = 0;
      continue;
    }
    let v = 0;
    if (orients !== null && orients[e] === 1) {
      v = refFrameFacing(e, t, t.front, anims, frames);
    } else {
      const L = lights[lightIdx[k]];
      if (!L) continue;
      REF_LAMP_RAY[0] = rows[at] - L.x;
      REF_LAMP_RAY[1] = (rows[at + 1] - L.y) * invG;
      v = refLampFrameFor(e, t, dirs, anims, frames);
    }
    if (v !== 0) rows[at + 3] = v;
  }
}

/** The worker's drop of a lamp's own entity from its full stamp rows, which ran before the frames pass. */
function refDropOwnStampsInto(rows, stampN, lightIdx, lights) {
  for (let k = 0; k < stampN; k++) {
    const at = k * GPU_CASTER_FLOATS;
    const L = lights[lightIdx[k]];
    if (L && (rows[at + GPU_ROW_TINT] | 0) === L.id) rows[at + GPU_SPRITE_FLOATS] = 0;
  }
}

/** The same for keyed stamp rows. */
function refDropOwnKeyedStampsInto(rows, stampN, lightIdx, lights) {
  for (let k = 0; k < stampN; k++) {
    const at = k * GPU_KEYED_STAMP_FLOATS;
    const L = lights[lightIdx[k]];
    if (L && (rows[at + 2] | 0) === L.id) rows[at + 4] = 0;
  }
}

function refSunFrameDirection(t, e, turn) {
  const ax = DirectionalSprite.aimX[e];
  const ay = DirectionalSprite.aimY[e];
  const facing = DirectionalSprite.facingFrom[e] !== 0 && (ax !== 0 || ay !== 0) ? Math.atan2(ay, ax) : DirectionalSprite.facing[e];
  PICK_ARGS[0] = facing + turn[0];
  PICK_ARGS[1] = 0;
  return pickDirectionArgs(t, 255);
}

// ---------------------------------------------------------------------------------------------------------------------
// Random scenes.

const TWO_PI = Math.PI * 2;
const SHEET_IDS = 12;
const LIGHTS = 14;

/** A direction table as the scene sends it (spriteDirections.js buildDirectionTable's fields). */
function tableSource(r, kind) {
  const { count } = kind;
  const groups = 1 + Math.floor(r() * 3);
  let uniform = true;
  let step = TWO_PI / count;
  let start = r() < 0.5 ? 0 : r() * step;
  let angles = Array.from({ length: count }, (_, k) => start + k * step);
  if (kind.uneven) {
    uniform = false;
    angles = Array.from({ length: count }, () => r() * TWO_PI).sort((a, b) => a - b);
    start = angles[0];
  } else if (kind.oddStep) {
    // A uniform table whose step is not a whole turn's share (a hand-made one).
    step = (TWO_PI / count) * (1.5 + r());
  }
  const slots = groups * count;
  const flips = r() < 0.4 ? 0 : r() < 0.5 ? 0.5 : 1;
  return {
    count,
    uniform,
    start,
    step,
    angles,
    // Slots share an animation now and then (a mirrored side, a group that lacks a direction).
    anim: Array.from({ length: slots }, (_, s) => (r() < 0.8 ? s : Math.floor(r() * slots))),
    flip: Array.from({ length: slots }, () => (r() < flips ? 1 : 0)),
    groups: Array.from({ length: groups }, (_, g) => `g${g}`),
    solid: r() < 0.25,
    contact: r() < 0.4,
  };
}

const TABLE_KINDS = [
  { count: 4 }, { count: 4 }, { count: 32 }, { count: 8 }, { count: 16 }, { count: 12 }, { count: 6 }, { count: 3 },
  { count: 1 }, { count: 5, uneven: true }, { count: 8, oddStep: true },
];

function makeScene(seed, n) {
  const r = mulberry32(seed);
  const sources = {};
  const tableIds = [];
  for (let id = 1; id < SHEET_IDS; id++) {
    if (r() < 0.15) continue;
    sources[id] = tableSource(r, TABLE_KINDS[(id - 1) % TABLE_KINDS.length]);
    tableIds.push(id);
  }
  // proxyToGlobalAnim (some animations missing from the atlas) and the frame tables.
  const proxy = {};
  const starts = [];
  const counts = [];
  let global = 0;
  let offset = 0;
  for (const id of tableIds) {
    const map = {};
    const locals = sources[id].anim.length;
    for (let a = 0; a < locals; a++) {
      if (r() < 0.06) continue;
      map[a] = global;
      starts[global] = offset;
      counts[global] = 1 + Math.floor(r() * 6);
      offset += counts[global];
      global++;
    }
    proxy[id] = map;
  }
  const pick = (weights) => {
    let x = r();
    for (let k = 0; k < weights.length; k++) {
      if (x < weights[k]) return k;
      x -= weights[k];
    }
    return weights.length - 1;
  };
  const e = {
    active: new Uint8Array(n),
    mode: new Uint8Array(n),
    casts: new Uint8Array(n),
    sheets: new Uint8Array(n),
    sunKind: new Uint8Array(n),
    lampKind: new Uint8Array(n),
    orients: new Uint8Array(n),
    dirs: new Uint8Array(n),
    anims: new Uint8Array(n),
    frames: new Uint16Array(n),
  };
  for (let i = 0; i < n; i++) {
    e.active[i] = pick([0.1, 0.85, 0.05]);
    e.mode[i] = pick([0.08, 0.87, 0.05]);
    e.casts[i] = r() < 0.92 ? 1 : 0;
    e.sheets[i] = r() < 0.9 ? tableIds[Math.floor(r() * tableIds.length)] : Math.floor(r() * (SHEET_IDS + 2));
    e.sunKind[i] = pick([0.6, 0.25, 0.1, 0.05]);
    e.lampKind[i] = pick([0.6, 0.25, 0.1, 0.05]);
    e.orients[i] = pick([0.85, 0.12, 0.03]);
    const src = sources[e.sheets[i]];
    e.dirs[i] = r() < 0.05 ? 255 : Math.floor(r() * ((src ? src.count : 8) + (r() < 0.05 ? 3 : 0)));
    e.anims[i] = Math.floor(r() * 4);
    e.frames[i] = Math.floor(r() * 8);
  }
  // DirectionalSprite's facing columns (sunFrameDirection reads them for uneven tables and casters with no direction).
  const ds = {
    facing: Float32Array.from({ length: n }, () => (r() - 0.5) * 4 * TWO_PI),
    facingFrom: Uint8Array.from({ length: n }, () => pick([0.6, 0.3, 0.1])),
    aimX: Float32Array.from({ length: n }, () => (r() < 0.2 ? 0 : (r() - 0.5) * 200)),
    aimY: Float32Array.from({ length: n }, () => (r() < 0.2 ? 0 : (r() - 0.5) * 200)),
  };
  return { r, sources, proxy, starts, counts, e, ds, n };
}

function bindDirectionalSprite(ds) {
  DirectionalSprite.facing = ds.facing;
  DirectionalSprite.facingFrom = ds.facingFrom;
  DirectionalSprite.aimX = ds.aimX;
  DirectionalSprite.aimY = ds.aimY;
}

/** Some casters walk a frame, turn or change their animation between frames. */
function stepScene(s) {
  const { r, e, n } = s;
  for (let k = 0; k < n / 4; k++) {
    const i = Math.floor(r() * n);
    e.frames[i] = (e.frames[i] + 1) % 9;
    if (r() < 0.3) e.dirs[i] = r() < 0.03 ? 255 : Math.floor(r() * 34) % 33;
    if (r() < 0.1) e.anims[i] = Math.floor(r() * 4);
  }
}

/** A random float32 value as a row's float, zeros, negative zeros and NaN among them. */
function rowFloat(r) {
  const x = r();
  if (x < 0.03) return 0;
  if (x < 0.06) return -0;
  if (x < 0.07) return NaN;
  return (r() - 0.5) * 400;
}

/** Two row buffers bit for bit (NaN payloads, the sign of zero); `stride` floats a row, for the message. */
function sameBits(a, b, what, stride = GPU_CASTER_FLOATS) {
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < ua.length; i++) {
    if (ua[i] !== ub[i]) {
      assert.fail(`${what}: row ${Math.floor(i / stride)} float ${i % stride} is ${b[i]}, the reference wrote ${a[i]}`);
    }
  }
}

let mod = null;
async function worker() {
  if (mod === null) {
    await loadWorker('preRenderWorker.js', 'preRenderWorker');
    mod = await import('../../src/workers/preRenderWorker.js');
  }
  return mod;
}

/** The columns a variant hands the passes: null for the optional ones now and then. */
function columns(s, variant) {
  const { e } = s;
  return {
    casts: variant & 1 ? null : e.casts,
    frames: variant & 2 ? null : e.frames,
    orients: variant & 4 ? null : e.orients,
    sunKinds: variant & 8 ? null : e.sunKind,
    lampKinds: variant & 8 ? null : e.lampKind,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The sun's rows.

/** A queue: its rows' types and entities, the casting rows listed in order, and its scale column. */
function makeQueue(s, rows) {
  const { r, n } = s;
  const types = Uint8Array.from({ length: rows }, () => (r() < 0.85 ? 0 : 1 + Math.floor(r() * 3)));
  const entities = Int32Array.from({ length: rows }, () => Math.floor(r() * n));
  const list = [];
  for (let i = 0; i < rows; i++) if (r() < 0.6) list.push(i);
  const casters = Uint32Array.from(list);
  const scaleX = Float32Array.from({ length: rows }, () => {
    const x = r();
    if (x < 0.02) return 0;
    if (x < 0.04) return -0;
    if (x < 0.05) return NaN;
    return (r() < 0.3 ? -1 : 1) * (0.25 + r() * 2);
  });
  const qType = Uint8Array.from({ length: rows }, () => (r() < 0.05 ? 3 : 0));
  const shadowH = Float32Array.from({ length: rows }, () => {
    const x = r();
    return x < 0.6 ? 5 + r() * 40 : x < 0.85 ? 0 : x < 0.95 ? -3 : NaN;
  });
  return { types, entities, casters, scaleX, qType, shadowH };
}

/** Full sun rows as the pack leaves them: random floats, each row's scale its queue row's. */
function packedSunRows(s, q) {
  const { r } = s;
  const sunN = q.casters.length;
  const rows = Float32Array.from({ length: sunN * GPU_CASTER_FLOATS }, () => rowFloat(r));
  for (let k = 0; k < sunN; k++) rows[k * GPU_CASTER_FLOATS + GPU_ROW_SCALE_X] = q.scaleX[q.casters[k]];
  return rows;
}

const SUN_TURNS = [0, Math.PI / 2, -2.2, 0.31, 3.9, -7.5, 13.1];

/**
 * The full sun rows' passes before E-370: the frames (applySunFramesFor), then the rows' entities in their tint floats
 * (_tagCasterEntities), against applySunFramesFor now, which does both: with the queue's scale column when the rows' scales
 * are the pack's (`fromQueue`), or reading the rows' scales back (any scale in the rows).
 */
async function fullSunRows(fromQueue) {
  const m = await worker();
  for (const seed of [11, 12, 13, 14]) {
    const s = makeScene(seed, 1500);
    bindDirectionalSprite(s.ds);
    const refTables = refSunFrameTables(s.sources);
    const newTables = m.sunFrameTables(s.sources);
    const refShift = new Int16Array(256);
    const refShiftTurn = new Float64Array(256).fill(NaN);
    const newShift = new Int16Array(256);
    const newShiftTurn = new Float64Array(256).fill(NaN);
    for (let frame = 0; frame < 6; frame++) {
      const variant = (seed * 7 + frame) & 15;
      const c = columns(s, variant);
      const q = makeQueue(s, 1200);
      const turn = SUN_TURNS[(seed + frame) % SUN_TURNS.length];
      // A new proxy map now and then (the slots rebuilt).
      const proxy = frame === 3 ? JSON.parse(JSON.stringify(s.proxy)) : s.proxy;
      refPrepareSunFrames(refTables, proxy, s.starts, s.counts, refShift, refShiftTurn, turn);
      m.prepareSunFrames(newTables, proxy, s.starts, s.counts, newShift, newShiftTurn, turn);
      const ref = packedSunRows(s, q);
      const sunN = q.casters.length;
      // Read back, the rows' scales need not be the queue's (a shadow texture changed some, or their signs).
      if (!fromQueue) for (let k = 0; k < sunN; k += 3) ref[k * GPU_CASTER_FLOATS + GPU_ROW_SCALE_X] = rowFloat(s.r);
      const got = ref.slice();
      refApplySunFramesFor(ref, sunN, q.casters, q.types, q.entities, s.e.active, s.e.mode, c.casts, s.e.sheets, s.e.dirs,
        s.e.anims, c.frames, refTables, refShift, c.orients, c.sunKinds);
      refTagCasterEntities(ref, sunN, q.casters, q.types, q.entities);
      m.applySunFramesFor(got, sunN, q.casters, q.types, q.entities, s.e.active, s.e.mode, c.casts, s.e.sheets, s.e.dirs,
        s.e.anims, c.frames, newTables, newShift, c.orients, c.sunKinds, fromQueue ? q.scaleX : null);
      sameBits(ref, got, `seed ${seed} frame ${frame}`);
      stepScene(s);
    }
  }
}

test('E-370: full sun rows, the flips from the queue\'s scales: the same textures, flips and entities as before', async () => {
  await fullSunRows(true);
});

test('E-370: full sun rows, the scales read back: the same textures, flips and entities as before', async () => {
  await fullSunRows(false);
});

// The worker's passes over the full sun rows after the pack, as they were (their row loops; the caster codes from the
// shipped computeCasterCodes, which E-370 leaves alone).
const GPU_ROW_ANCHOR_X = 4;
const GPU_ROW_DEPTH = 8;
const GPU_ROW_TILE_INV = 11;
const GPU_ROW_TILE_OFF = 13;

function refApplyShadowTextures(rows, sunN, casters, types, entities, SC) {
  for (let k = 0; k < sunN; k++) {
    const row = casters[k];
    if (types[row] !== 0) continue;
    const e = entities[row];
    const id = SC.textureId[e];
    if (id === 0) continue;
    const at = k * GPU_CASTER_FLOATS;
    const sx = SC.textureScaleX[e];
    const sy = SC.textureScaleY[e];
    if (sx !== 0) rows[at + GPU_ROW_SCALE_X] = rows[at + GPU_ROW_SCALE_X] < 0 ? -sx : sx;
    if (sy !== 0) rows[at + GPU_ROW_SCALE_X + 1] = rows[at + GPU_ROW_SCALE_X + 1] < 0 ? -sy : sy;
    const ax = SC.textureAnchorX[e];
    const ay = SC.textureAnchorY[e];
    if (ax === ax) rows[at + GPU_ROW_ANCHOR_X] = ax;
    if (ay === ay) rows[at + GPU_ROW_ANCHOR_X + 1] = ay;
    rows[at + GPU_ROW_TEXTURE] = id - 1;
  }
}

function refTagCasterRows(rows, sunN, casters, types, entities, codes, radius) {
  for (let k = 0; k < sunN; k++) {
    const row = casters[k];
    if (types[row] !== 0) continue;
    const e = entities[row];
    const at = k * GPU_CASTER_FLOATS;
    rows[at + GPU_ROW_DEPTH] = -(codes[e] + 1);
    if (e < radius.length && radius[e] > 0 && rows[at + GPU_ROW_TILE_INV] === 0 && rows[at + GPU_ROW_TILE_INV + 1] === 0) {
      rows[at + GPU_ROW_TILE_OFF] = radius[e];
    }
  }
}

/** The pack's caster rows, stood in for: each float a function of its queue row, the scale the queue's, tiles 0 at times. */
function stubPackRows(q, indices, n, rows) {
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    const at = k * GPU_CASTER_FLOATS;
    for (let f = 0; f < GPU_CASTER_FLOATS; f++) rows[at + f] = Math.sin(i * 12.9898 + f * 78.233) * 437.5;
    rows[at + GPU_ROW_SCALE_X] = q.scaleX[i];
    if (i % 3 !== 0) {
      rows[at + GPU_ROW_TILE_INV] = 0;
      rows[at + GPU_ROW_TILE_INV + 1] = 0;
    }
  }
}

test('E-370: _packGpuSun on the real worker (the pack stood in for): the full sun rows as the old passes left them', async () => {
  const m = await worker();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const { ShadowCaster } = await import('../../src/components/shadowCaster.js');
  const { SpriteRenderer } = await import('../../src/components/spriteRenderer.js');
  const { Sun } = await import('../../src/core/sun.js');
  const { cameraFloorScaleY } = await import('../../src/util/cameraView.js');
  const n = 1500;
  const rowsInQueue = 1400;
  const cap = 700;
  const s = makeScene(61, n);
  bindDirectionalSprite(s.ds);
  const { r, e } = s;
  DirectionalSprite.active = e.active;
  DirectionalSprite.mode = e.mode;
  DirectionalSprite.directionIndex = e.dirs;
  DirectionalSprite.animation = e.anims;
  SpriteRenderer.spritesheetId = e.sheets;
  Object.assign(ShadowCaster, {
    active: e.casts,
    sunKind: e.sunKind,
    lampKind: e.lampKind,
    orient: e.orients,
    opacity: Float32Array.from({ length: n }, () => (r() < 0.8 ? 1 : r())),
    baseRadius: Float32Array.from({ length: n }, () => (r() < 0.8 ? 0 : 3 + r() * 9)),
    textureId: Uint16Array.from({ length: n }, () => (r() < 0.7 ? 0 : 1 + Math.floor(r() * 400))),
    textureScaleX: Float32Array.from({ length: n }, () => (r() < 0.3 ? 0 : (r() < 0.3 ? -1 : 1) * (0.5 + r()))),
    textureScaleY: Float32Array.from({ length: n }, () => (r() < 0.3 ? 0 : 0.5 + r())),
    textureAnchorX: Float32Array.from({ length: n }, () => (r() < 0.5 ? NaN : r())),
    textureAnchorY: Float32Array.from({ length: n }, () => (r() < 0.5 ? NaN : r())),
  });
  Sun.initialize(new SharedArrayBuffer(Sun.BYTE_LENGTH));
  try {
    const config = {};
    Object.assign(pre, {
      config,
      shadowsEnabled: true,
      gpuQueueCaps: { maxSun: cap },
      _gpuPackOpts: {},
      _gpuPackCtx: {},
      _gpuCasterIdx: new Uint32Array(rowsInQueue),
      _sunFrameTables: m.sunFrameTables(s.sources),
      proxyToGlobalAnim: s.proxy,
      animationFrameStart: s.starts,
      animationFrameCount: s.counts,
      entityFrameIndex: e.frames,
      renderQueueMaxItems: rowsInQueue,
      _casterScanTick: 1e9,
    });
    pre._packRows = (q, ctx, dst, dstU32, floatsPer, capacity) => {
      const rows = Math.min(ctx.scanCount, capacity);
      stubPackRows(q, ctx.indices, rows, dst);
      return rows;
    };
    const refTables = refSunFrameTables(s.sources);
    const refShift = new Int16Array(256);
    const refShiftTurn = new Float64Array(256).fill(NaN);
    const cases = [
      { textures: false, kinds: false, sun: true },
      { textures: true, kinds: false, sun: true },
      { textures: false, kinds: true, sun: true },
      { textures: true, kinds: true, sun: true },
      { textures: false, kinds: false, sun: false },
      { textures: true, kinds: true, sun: false },
    ];
    for (let c = 0; c < cases.length; c++) {
      const { textures, kinds, sun } = cases[c];
      const angle = c * 1.3 - 2;
      Sun._float32[Sun.F32.SHADOW_DIR_X] = Math.cos(angle);
      Sun._float32[Sun.F32.SHADOW_DIR_Y] = Math.sin(angle);
      if (!sun) Sun._sab = null;
      const q = makeQueue(s, rowsInQueue);
      const queue = { count: rowsInQueue, type: q.qType, shadowH: q.shadowH, scaleX: q.scaleX };
      Object.assign(pre, {
        _renderableType: q.types,
        _renderableIndex: q.entities,
        _collectedRows: rowsInQueue,
        renderQueueType: q.qType,
        _shadowFramesOn: textures,
        _casterKindsOn: kinds,
      });
      const dst = { sun: new Float32Array(cap * GPU_CASTER_FLOATS) };
      const sunN = pre._packGpuSun(dst, queue);
      // The old order: the pack, shadow textures, the sun's frames, the caster codes, the rows' entities.
      const list = [];
      for (let i = 0; i < rowsInQueue && list.length < cap; i++) if (q.qType[i] !== 3 && q.shadowH[i] > 0) list.push(i);
      assert.equal(sunN, list.length, `case ${c}: the rows packed`);
      const ref = new Float32Array(cap * GPU_CASTER_FLOATS);
      stubPackRows(q, list, list.length, ref);
      if (textures) refApplyShadowTextures(ref, sunN, list, q.types, q.entities, ShadowCaster);
      if (sun) {
        const turn = -Math.PI / 2 - Math.atan2(Sun.shadowDirY / cameraFloorScaleY(config), Sun.shadowDirX);
        refPrepareSunFrames(refTables, s.proxy, s.starts, s.counts, refShift, refShiftTurn, turn);
        refApplySunFramesFor(ref, sunN, list, q.types, q.entities, e.active, e.mode, e.casts, e.sheets, e.dirs, e.anims, e.frames,
          refTables, refShift, e.orients, e.sunKind);
      }
      if (kinds) {
        const codes = new Int32Array(n);
        m.computeCasterCodes(codes, e.casts, e.sunKind, e.lampKind, e.orients, ShadowCaster.opacity, e.active, s.ds.facing, n,
          pre._sunFrameTables, e.sheets, e.dirs);
        refTagCasterRows(ref, sunN, list, q.types, q.entities, codes, ShadowCaster.baseRadius);
      }
      refTagCasterEntities(ref, sunN, list, q.types, q.entities);
      sameBits(ref, dst.sun, `case ${c}`);
      if (!sun) Sun.initialize(new SharedArrayBuffer(Sun.BYTE_LENGTH));
      stepScene(s);
    }
  } finally {
    Sun.unbind();
  }
});

test('E-370: keyed sun rows: the same frames as before', async () => {
  const m = await worker();
  for (const seed of [21, 22, 23]) {
    const s = makeScene(seed, 1500);
    bindDirectionalSprite(s.ds);
    const refTables = refSunFrameTables(s.sources);
    const newTables = m.sunFrameTables(s.sources);
    const refShift = new Int16Array(256);
    const refShiftTurn = new Float64Array(256).fill(NaN);
    const newShift = new Int16Array(256);
    const newShiftTurn = new Float64Array(256).fill(NaN);
    for (let frame = 0; frame < 6; frame++) {
      const variant = (seed * 5 + frame) & 15;
      const c = columns(s, variant);
      const q = makeQueue(s, 1500);
      const turn = SUN_TURNS[(seed + frame) % SUN_TURNS.length];
      refPrepareSunFrames(refTables, s.proxy, s.starts, s.counts, refShift, refShiftTurn, turn);
      m.prepareSunFrames(newTables, s.proxy, s.starts, s.counts, newShift, newShiftTurn, turn);
      let casting = 0;
      for (let i = 0; i < q.types.length; i++) if (q.qType[i] !== 3 && q.shadowH[i] > 0) casting++;
      // The kernel's cap now and then below the casting rows.
      const keyedN = frame & 1 ? casting : Math.max(0, casting - 37);
      const ref = Float32Array.from({ length: keyedN * GPU_KEYED_CASTER_FLOATS }, () => rowFloat(s.r));
      for (let k = 0; k < keyedN; k++) ref[k * GPU_KEYED_CASTER_FLOATS + 3] = 0;
      const got = ref.slice();
      const qType = frame === 2 ? null : q.qType;
      refApplyKeyedSunFramesFor(ref, keyedN, q.types.length, qType, q.shadowH, q.types, q.entities, s.e.active, s.e.mode,
        c.casts, s.e.sheets, s.e.dirs, s.e.anims, c.frames, refTables, refShift, c.orients, c.sunKinds);
      m.applyKeyedSunFramesFor(got, keyedN, q.types.length, qType, q.shadowH, q.types, q.entities, s.e.active, s.e.mode,
        c.casts, s.e.sheets, s.e.dirs, s.e.anims, c.frames, newTables, newShift, c.orients, c.sunKinds);
      sameBits(ref, got, `seed ${seed} frame ${frame}`, GPU_KEYED_CASTER_FLOATS);
      stepScene(s);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The lamps' rows.

/** Lamps; half of them an entity's own (a car's headlights), whose rows of that entity they drop. */
function makeLights(r, n) {
  const lights = [];
  for (let i = 0; i < LIGHTS - 2; i++) {
    // Whole-pixel lamps most of the time (a row's x and y are float32), some anywhere.
    const x = r() < 0.7 ? Math.round(r() * 1500) : r() * 1500;
    const y = r() < 0.7 ? Math.round(r() * 1500) : r() * 1500;
    lights.push({ id: r() < 0.5 ? Math.floor(r() * n) : 100000 + i, x, y, intensity: 1.4, rangeSq: 90000 });
  }
  return lights;
}

/** The step of a uniform table of `count` directions: the borders a ray is stressed against. */
const STRESS_COUNTS = [4, 8, 16, 32, 12];

/**
 * A ray (dx, dy on the floor, dy already times invG) from lamp to caster: anywhere, on a border between two directions of
 * a table of STRESS_COUNTS (within 3e-4 rad either way, fastAtan2's error band and the borders' margin), along an axis, or
 * none at all (the caster on its lamp).
 */
function ray(r) {
  const x = r();
  const len = 1 + r() * 300;
  if (x < 0.02) return [0, 0];
  if (x < 0.06) {
    const a = Math.floor(r() * 4) * (Math.PI / 2);
    return [Math.round(Math.cos(a)) * len, Math.round(Math.sin(a)) * len];
  }
  if (x < 0.5) {
    const count = STRESS_COUNTS[Math.floor(r() * STRESS_COUNTS.length)];
    const step = TWO_PI / count;
    const j = Math.floor(r() * count);
    const off = (r() - 0.5) * 6e-4 * (r() < 0.5 ? 1 : 0.05);
    // The lamp's turn is the angle of (-dy, -dx): its borders sit at (j + 1/2) steps.
    const phi = (j + 0.5) * step + off;
    return [-Math.sin(phi) * len, -Math.cos(phi) * len];
  }
  const a = r() * TWO_PI;
  return [Math.cos(a) * len, Math.sin(a) * len];
}

/** Stamp rows: each a caster near its lamp (its entity where the row names it), random floats elsewhere. */
function stampRows(s, lights, invG, stampN, floats, entityFloat, keyed) {
  const { r, n } = s;
  const rows = Float32Array.from({ length: stampN * floats }, () => rowFloat(r));
  const lightIdx = new Uint8Array(stampN);
  // The stamp lists come by light: runs of a light's rows, a missing light now and then.
  let l = 0;
  for (let k = 0; k < stampN; k++) {
    if (r() < 0.05) l = Math.floor(r() * LIGHTS);
    lightIdx[k] = l;
    const at = k * floats;
    const x = r();
    // An entity, none (-1), one out of range, one not a whole number.
    const ent = Math.floor(r() * n);
    rows[at + entityFloat] = x < 0.02 ? -1 : x < 0.04 ? n + Math.floor(r() * 50) : x < 0.06 ? ent + 0.5 : ent;
    const L = lights[l];
    // Rows of the lamp's own entity now and then.
    if (L && r() < 0.05) rows[at + entityFloat] = L.id;
    if (L) {
      const [dx, dy] = ray(r);
      rows[at] = L.x + dx;
      rows[at + 1] = L.y + dy / invG;
    }
    if (keyed) rows[at + 3] = r() < 0.5 ? 0 : (r() < 0.5 ? -1 : 1) * Math.floor(1 + r() * 300);
    else rows[at + GPU_ROW_SCALE_X] = (r() < 0.3 ? -1 : 1) * (0.5 + r());
  }
  return { rows, lightIdx };
}

test('E-372: fastAtan2 stays within 2e-5 rad of the arctangent (the lamps\' border margin is five times that)', async () => {
  const m = await worker();
  let worst = 0;
  for (let k = 0; k <= 200000; k++) {
    const a = k / 200000;
    const d = Math.abs(m.fastAtan2(a, 1) - Math.atan(a));
    if (d > worst) worst = d;
  }
  assert.ok(worst < 2e-5, `worst ${worst}`);
});

test('E-372: full lamp rows: the same textures, flips and own rows dropped as before', async () => {
  const m = await worker();
  for (const seed of [31, 32, 33, 34]) {
    const s = makeScene(seed, 1500);
    bindDirectionalSprite(s.ds);
    const refTables = refSunFrameTables(s.sources);
    const newTables = m.sunFrameTables(s.sources);
    for (let frame = 0; frame < 5; frame++) {
      const variant = (seed * 3 + frame) & 15;
      const c = columns(s, variant);
      const lights = makeLights(s.r, s.n);
      const invG = frame & 1 ? 1 : 1 / 0.7364;
      const proxy = frame === 2 ? JSON.parse(JSON.stringify(s.proxy)) : s.proxy;
      const { rows: ref, lightIdx } = stampRows(s, lights, invG, 6000, GPU_CASTER_FLOATS, GPU_ROW_TINT, false);
      const got = ref.slice();
      refDropOwnStampsInto(ref, 6000, lightIdx, lights);
      refApplyLampFramesInto(ref, 6000, lightIdx, lights, invG, refTables, proxy, s.starts, s.counts, c.frames, s.e.active,
        s.e.mode, s.e.dirs, s.e.anims, s.e.sheets, c.orients, c.lampKinds);
      m.applyLampFramesInto(got, 6000, lightIdx, lights, invG, newTables, proxy, s.starts, s.counts, c.frames, s.e.active,
        s.e.mode, s.e.dirs, s.e.anims, s.e.sheets, c.orients, c.lampKinds);
      sameBits(ref, got, `seed ${seed} frame ${frame}`);
      stepScene(s);
    }
  }
});

test('E-372: keyed lamp rows: the same frames and own rows dropped as before', async () => {
  const m = await worker();
  for (const seed of [41, 42, 43, 44]) {
    const s = makeScene(seed, 1500);
    bindDirectionalSprite(s.ds);
    const refTables = refSunFrameTables(s.sources);
    const newTables = m.sunFrameTables(s.sources);
    for (let frame = 0; frame < 5; frame++) {
      const variant = (seed * 3 + frame) & 15;
      const c = columns(s, variant);
      const lights = makeLights(s.r, s.n);
      const invG = frame & 1 ? 1 / 0.7364 : 1;
      const { rows: ref, lightIdx } = stampRows(s, lights, invG, 6000, GPU_KEYED_STAMP_FLOATS, 2, true);
      const got = ref.slice();
      refDropOwnKeyedStampsInto(ref, 6000, lightIdx, lights);
      refApplyKeyedLampFramesInto(ref, 6000, lightIdx, lights, invG, refTables, s.proxy, s.starts, s.counts, c.frames,
        s.e.active, s.e.mode, s.e.dirs, s.e.anims, s.e.sheets, c.orients, c.lampKinds);
      m.applyKeyedLampFramesInto(got, 6000, lightIdx, lights, invG, newTables, s.proxy, s.starts, s.counts, c.frames,
        s.e.active, s.e.mode, s.e.dirs, s.e.anims, s.e.sheets, c.orients, c.lampKinds);
      sameBits(ref, got, `seed ${seed} frame ${frame}`, GPU_KEYED_STAMP_FLOATS);
      stepScene(s);
    }
  }
});

test('E-372: a lamp all around a caster of each uniform table: every direction as before', async () => {
  const m = await worker();
  // One caster per table, its lamp turned round it a ten-thousandth of a degree at a time near each border.
  const s = makeScene(51, 64);
  bindDirectionalSprite(s.ds);
  const refTables = refSunFrameTables(s.sources);
  const newTables = m.sunFrameTables(s.sources);
  const ids = Object.keys(s.sources).map(Number);
  const e = s.e;
  for (let i = 0; i < ids.length; i++) {
    e.active[i] = 1;
    e.mode[i] = 1;
    e.sheets[i] = ids[i];
    e.lampKind[i] = 1;
    e.orients[i] = 0;
    e.dirs[i] = i % s.sources[ids[i]].count;
    e.anims[i] = 0;
  }
  const lights = [{ id: -5, x: 0, y: 0 }];
  for (const invG of [1, 1 / 0.7364]) {
    const per = 4000;
    const stampN = ids.length * per;
    const ref = new Float32Array(stampN * GPU_KEYED_STAMP_FLOATS);
    for (let i = 0; i < ids.length; i++) {
      const count = s.sources[ids[i]].count;
      const step = TWO_PI / count;
      for (let k = 0; k < per; k++) {
        const at = (i * per + k) * GPU_KEYED_STAMP_FLOATS;
        // Half the rays sweep the whole turn, half sit within 2e-4 rad of a border.
        const phi = k & 1 ? (k / per) * TWO_PI : (Math.floor((k / per) * count) + 0.5) * step + ((k % 97) - 48) * 4e-6;
        ref[at] = -Math.sin(phi) * 250;
        ref[at + 1] = (-Math.cos(phi) * 250) / invG;
        ref[at + 2] = i;
      }
    }
    const got = ref.slice();
    const lightIdx = new Uint8Array(stampN);
    refDropOwnKeyedStampsInto(ref, stampN, lightIdx, lights);
    refApplyKeyedLampFramesInto(ref, stampN, lightIdx, lights, invG, refTables, s.proxy, s.starts, s.counts, e.frames,
      e.active, e.mode, e.dirs, e.anims, e.sheets, e.orients, e.lampKind);
    m.applyKeyedLampFramesInto(got, stampN, lightIdx, lights, invG, newTables, s.proxy, s.starts, s.counts, e.frames,
      e.active, e.mode, e.dirs, e.anims, e.sheets, e.orients, e.lampKind);
    sameBits(ref, got, `invG ${invG}`, GPU_KEYED_STAMP_FLOATS);
  }
});

test('E-370: _packGpuShadows on the real worker (sun pack and stamp stood in for): own rows dropped, frames as before', async () => {
  const m = await worker();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const { ShadowCaster } = await import('../../src/components/shadowCaster.js');
  const { SpriteRenderer } = await import('../../src/components/spriteRenderer.js');
  const { cameraFloorScaleY } = await import('../../src/util/cameraView.js');
  const n = 1500;
  const s = makeScene(71, n);
  bindDirectionalSprite(s.ds);
  const { e } = s;
  DirectionalSprite.active = e.active;
  DirectionalSprite.mode = e.mode;
  DirectionalSprite.directionIndex = e.dirs;
  DirectionalSprite.animation = e.anims;
  SpriteRenderer.spritesheetId = e.sheets;
  ShadowCaster.orient = e.orients;
  ShadowCaster.lampKind = e.lampKind;
  // An oblique camera: the lamps' rays are stretched by 1 / its floor scale (invG).
  const config = { camera: { pitch: 47 } };
  const invG = 1 / cameraFloorScaleY(config);
  const stampN = 3000;
  const lights = makeLights(s.r, n);
  const cases = [
    { keyed: false, frames: true, proxy: true },
    { keyed: true, frames: true, proxy: true },
    { keyed: false, frames: true, proxy: false },
    { keyed: true, frames: false, proxy: true },
    { keyed: false, frames: false, proxy: true },
  ];
  for (let c = 0; c < cases.length; c++) {
    const { keyed, frames, proxy } = cases[c];
    const floats = keyed ? GPU_KEYED_STAMP_FLOATS : GPU_CASTER_FLOATS;
    const { rows: stamped, lightIdx } = stampRows(s, lights, invG, stampN, floats, keyed ? 2 : GPU_ROW_TINT, keyed);
    const refTables = refSunFrameTables(s.sources);
    Object.assign(pre, {
      config,
      shadowsEnabled: true,
      gpuQueueCaps: { maxSun: 8, maxStamp: stampN, maxCookie: 8 },
      shadowUpdateInterval: 1,
      visibilityPolygonsEnabled: false,
      _emitSkippedStatics: false,
      _stampLights: lights,
      _stampLightCount: lights.length,
      _sunFrameTables: frames ? m.sunFrameTables(s.sources) : null,
      proxyToGlobalAnim: proxy ? s.proxy : null,
      animationFrameStart: s.starts,
      animationFrameCount: s.counts,
      entityFrameIndex: e.frames,
    });
    pre._packGpuSun = () => {
      pre._gpuSunKeyed = keyed;
      return 5;
    };
    pre._stampAgainstSun = (dst) => {
      dst.stamp.set(stamped);
      dst.stampLightIdx.set(lightIdx);
      return stampN;
    };
    pre._packGpuCookies = () => 0;
    const dst = {
      sun: new Float32Array(8 * GPU_CASTER_FLOATS),
      stamp: new Float32Array(stampN * floats),
      stampLightIdx: new Uint8Array(stampN),
      cookie: new Float32Array(8 * GPU_SPRITE_FLOATS),
    };
    const res = pre._packGpuShadows(dst, {});
    assert.equal(res.stamp, stampN, `case ${c}: the stamp rows`);
    const ref = stamped.slice();
    if (keyed) refDropOwnKeyedStampsInto(ref, stampN, lightIdx, lights);
    else refDropOwnStampsInto(ref, stampN, lightIdx, lights);
    if (frames && proxy) {
      const apply = keyed ? refApplyKeyedLampFramesInto : refApplyLampFramesInto;
      apply(ref, stampN, lightIdx, lights, invG, refTables, s.proxy, s.starts, s.counts, e.frames, e.active, e.mode, e.dirs,
        e.anims, e.sheets, e.orients, e.lampKind);
    }
    sameBits(ref, dst.stamp, `case ${c}`, floats);
    stepScene(s);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// E-372: the keyed sun rows' frames written by the keyed caster scan (gpuPack.wasm pack_casters_keyed_scan) itself.

/** The scans' key base: every key of these queues is below it. */
const SCAN_KEY_BASE = 1 << 20;

/**
 * One shared memory holding what the keyed caster scan reads, the kernel bound on it: the queue's columns (the pack's
 * column table, its key and type), the collector's row types and entities, the entity columns sunFrameFor reads, two
 * sets of keyed rows (the reference's and the scan's) and the sun frames' region.
 */
async function scanMemory(rows, n) {
  const memory = new WebAssembly.Memory({ initial: 48, maximum: 48, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const place = (bytes) => {
    top = (top + 63) & ~63;
    const at = top;
    top += bytes;
    return at;
  };
  const alloc = (Ctor, len) => new Ctor(buf, place(len * Ctor.BYTES_PER_ELEMENT), len);
  const u16 = new Set(['textureId', 'tileOffsetU', 'tileOffsetV']);
  const q = { count: rows, key: alloc(Uint32Array, rows), type: alloc(Uint8Array, rows) };
  for (const c of GPU_PACK_COLUMNS) q[c] = alloc(c === 'tint' ? Uint32Array : u16.has(c) ? Uint16Array : Float32Array, rows);
  const mem = {
    types: alloc(Uint8Array, rows),
    entities: alloc(Int32Array, rows),
    active: alloc(Uint8Array, n),
    mode: alloc(Uint8Array, n),
    casts: alloc(Uint8Array, n),
    sheets: alloc(Uint8Array, n),
    kinds: alloc(Uint8Array, n),
    orients: alloc(Uint8Array, n),
    dirs: alloc(Uint8Array, n),
    anims: alloc(Uint8Array, n),
    frames: alloc(Uint16Array, n),
    ref: alloc(Float32Array, rows * GPU_KEYED_CASTER_FLOATS),
    got: alloc(Float32Array, rows * GPU_KEYED_CASTER_FLOATS),
  };
  const tableByte = place(4 * GPU_PACK_COLUMNS.length * 4);
  const indexByte = place(rows * 4);
  const particlesByte = place(144);
  const keyedSunByte = place(keyedSunRegionBytes());
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const b = await bindGpuPack(memory, {
    tableByte, tableSlots: 4, indexByte, indexCap: rows, particlesByte, inverseByte: 0, keyedSunByte,
  });
  return { q, mem, b };
}

/**
 * A frame of scene s in the scan's memory: its entity columns, and queue qq (makeQueue's) as the queue's type and shadow
 * columns and the collector's rows, a few entities out of range among them (-1, past the entities); poses and offsets at
 * random, every key an entity's below SCAN_KEY_BASE (some marked changed).
 */
function loadScanFrame(s, sm, qq) {
  const { r, e, n } = s;
  const { q, mem } = sm;
  mem.active.set(e.active);
  mem.mode.set(e.mode);
  mem.casts.set(e.casts);
  mem.sheets.set(e.sheets);
  mem.kinds.set(e.sunKind);
  mem.orients.set(e.orients);
  mem.dirs.set(e.dirs);
  mem.anims.set(e.anims);
  mem.frames.set(e.frames);
  const rows = qq.types.length;
  for (let i = 0; i < rows; i++) {
    const x = r();
    mem.types[i] = qq.types[i];
    mem.entities[i] = x < 0.01 ? -1 : x < 0.02 ? n + Math.floor(r() * 40) : qq.entities[i];
    q.type[i] = qq.qType[i];
    q.shadowH[i] = qq.shadowH[i];
    q.x[i] = (r() - 0.5) * 4000;
    q.y[i] = (r() - 0.5) * 4000;
    q.shadowOffX[i] = r() - 0.5;
    q.shadowOffY[i] = r() - 0.5;
    q.key[i] = (Math.floor(r() * n) | (r() < 0.1 ? 0x80000000 : 0)) >>> 0;
  }
  q.count = rows;
}

/** The scan's columns for a variant (columns(s, variant)'s nulls), in the scan's memory. */
function scanColumns(mem, variant) {
  return {
    types: mem.types,
    entities: mem.entities,
    active: mem.active,
    mode: mem.mode,
    dirs: mem.dirs,
    anims: mem.anims,
    casts: variant & 1 ? null : mem.casts,
    orients: variant & 4 ? null : mem.orients,
    kinds: variant & 8 ? null : mem.kinds,
    sheets: mem.sheets,
    frames: variant & 2 ? null : mem.frames,
    framed: false,
    listed: 0,
  };
}

/**
 * The queue in sm scanned twice: without the frames, then the keyed rows' pass before E-372 (the reference copy, on its
 * prepared tables); and with them (the shipped tables synced into the region), then the rows the scan listed. The same
 * rows bit for bit.
 * @returns {{ framed: number, listed: number }} the rows whose frame the scan wrote (not 0) and the rows it listed
 */
function scanBoth(m, sm, refTables, refShift, newTables, newShift, variant, typed, cap, label) {
  const { q, mem, b } = sm;
  const qq = typed ? q : { ...q, type: null };
  const count = q.count;
  const sun = scanColumns(mem, variant);
  mem.ref.fill(-7);
  mem.got.fill(-7);
  const keyedN = packKeyedCastersScanWasm(b, qq, count, mem.ref, SCAN_KEY_BASE, cap);
  assert.ok(keyedN > 0, `${label}: the scan took the queue`);
  refApplyKeyedSunFramesFor(mem.ref, keyedN, count, qq.type, qq.shadowH, mem.types, mem.entities, mem.active, mem.mode,
    sun.casts, mem.sheets, mem.dirs, mem.anims, sun.frames, refTables, refShift, sun.orients, sun.kinds);
  assert.equal(packKeyedCastersScanWasm(b, qq, count, mem.got, SCAN_KEY_BASE, cap, sun), keyedN, `${label}: as many rows`);
  assert.equal(sun.framed, true, `${label}: the scan wrote the frames`);
  assert.ok(sun.listed <= b.keyedSun.listCap, `${label}: the list holds the rows left (${sun.listed})`);
  let framed = 0;
  for (let k = 0; k < keyedN; k++) if (mem.got[k * GPU_KEYED_CASTER_FLOATS + 3] !== 0) framed++;
  m.applyListedSunFramesFor(mem.got, b.keyedSun.list, sun.listed, mem.active, mem.mode, sun.casts, mem.sheets, mem.dirs,
    mem.anims, sun.frames, newTables, newShift, sun.orients, sun.kinds);
  const floats = keyedN * GPU_KEYED_CASTER_FLOATS;
  sameBits(mem.ref.subarray(0, floats), mem.got.subarray(0, floats), label, GPU_KEYED_CASTER_FLOATS);
  return { framed, listed: sun.listed };
}

/** Random scenes' frames through scanBoth: the sun's turn, the columns' variant, the type column and the cap change. */
async function scanScenes(seeds, frames, adjust = null) {
  const m = await worker();
  const n = 1500;
  let framed = 0;
  let listed = 0;
  let mostListed = 0;
  for (const seed of seeds) {
    const s = makeScene(seed, n);
    if (adjust) adjust.scene(s);
    bindDirectionalSprite(s.ds);
    const sm = await scanMemory(1500, n);
    const refTables = refSunFrameTables(s.sources);
    const newTables = m.sunFrameTables(s.sources);
    if (adjust) adjust.tables(refTables, newTables, sm);
    const refShift = new Int16Array(256);
    const refShiftTurn = new Float64Array(256).fill(NaN);
    const newShift = new Int16Array(256);
    const newShiftTurn = new Float64Array(256).fill(NaN);
    for (let frame = 0; frame < frames; frame++) {
      const variant = (seed * 3 + frame) & 15;
      loadScanFrame(s, sm, makeQueue(s, 1500));
      const turn = SUN_TURNS[(seed + frame) % SUN_TURNS.length];
      // A new proxy map now and then (the slots and both frame tables rebuilt, the region's tables written again).
      const proxy = frame === 5 ? JSON.parse(JSON.stringify(s.proxy)) : s.proxy;
      refPrepareSunFrames(refTables, proxy, s.starts, s.counts, refShift, refShiftTurn, turn);
      m.prepareSunFrames(newTables, proxy, s.starts, s.counts, newShift, newShiftTurn, turn);
      m.syncKeyedSunTables(sm.b.keyedSun, newTables);
      if (adjust) adjust.synced(sm, newTables);
      const got = scanBoth(m, sm, refTables, refShift, newTables, newShift, variant, frame !== 2, frame & 1 ? 1500 : 600,
        `seed ${seed} frame ${frame}`);
      framed += got.framed;
      listed += got.listed;
      if (got.listed > mostListed) mostListed = got.listed;
      stepScene(s);
      if (adjust) adjust.scene(s);
    }
  }
  return { framed, listed, mostListed };
}

test('E-372: the keyed caster scan writes the keyed rows\' sun frames as before, the JS the rows it lists', async () => {
  const { framed, listed } = await scanScenes([31, 32, 33, 34], 8);
  assert.ok(framed > 4000, `the scan wrote frames (${framed})`);
  assert.ok(listed > 100, `and listed rows for the JS: uneven tables, no direction drawn (${listed})`);
});

test('E-372: on uniform tables every caster with a direction drawn takes its frame from the scan, none from the JS', async () => {
  // Only the uniform tables, and each caster's direction one of its table's.
  const uniformOnly = (s) => {
    for (const id of Object.keys(s.sources)) if (!s.sources[id].uniform) delete s.sources[id];
    for (let i = 0; i < s.n; i++) {
      const src = s.sources[s.e.sheets[i]];
      if (src) s.e.dirs[i] %= src.count;
    }
  };
  const { framed, mostListed } = await scanScenes([41, 42], 6, { scene: uniformOnly, tables() {}, synced() {} });
  assert.ok(framed > 2000, `the scan wrote frames (${framed})`);
  assert.equal(mostListed, 0, 'no row left to the JS');
});

test('E-372: a sheet whose frames the region cannot hold, or whose front is no direction, goes to the JS as before', async () => {
  let deferred = 0;
  const odd = [];
  const adjust = {
    scene() {},
    tables(refTables, newTables, sm) {
      // A uniform table's front past its directions (a fixed card of it reads past them, sunFrameFor's way).
      const id = newTables.findIndex((t) => t !== undefined && t.uniform && t.count >= 3);
      refTables[id].front = refTables[id].count;
      newTables[id].front = newTables[id].count;
      odd.push(id);
      // A region whose pool holds a few sheets' frames.
      const region = keyedSunViews(sm.b.buffer, sm.b.keyedSun.byte);
      region.pool = region.pool.subarray(0, 300);
      sm.b.keyedSun = region;
    },
    synced(sm) {
      const flags = (sheet) => sm.b.keyedSun.sheets[sheet * KEYED_SUN_SHEET_WORDS + KEYED_SUN_SHEET.FLAGS];
      assert.ok((flags(odd[odd.length - 1]) & KEYED_SUN_DEFER) !== 0, 'the sheet with its front past its directions');
      let n = 0;
      for (let sheet = 0; sheet < 256; sheet++) if ((flags(sheet) & KEYED_SUN_DEFER) !== 0) n++;
      if (n > deferred) deferred = n;
    },
  };
  const { framed, listed } = await scanScenes([51, 52], 6, adjust);
  assert.ok(deferred >= 3, `sheets left to the JS (${deferred})`);
  assert.ok(framed > 200 && listed > 300, `the scan wrote frames (${framed}) and listed rows (${listed})`);
});

test('E-372: _packGpuSun keyed on the real worker, the scan writing the frames: the keyed rows as before', async () => {
  const m = await worker();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const { ShadowCaster } = await import('../../src/components/shadowCaster.js');
  const { SpriteRenderer } = await import('../../src/components/spriteRenderer.js');
  const { Sun } = await import('../../src/core/sun.js');
  const { cameraFloorScaleY } = await import('../../src/util/cameraView.js');
  const n = 1500;
  const rows = 1400;
  const cap = 900;
  const s = makeScene(81, n);
  bindDirectionalSprite(s.ds);
  const sm = await scanMemory(rows, n);
  const { q, mem, b } = sm;
  const region = b.keyedSun;
  const listCap = region.listCap;
  DirectionalSprite.active = mem.active;
  DirectionalSprite.mode = mem.mode;
  DirectionalSprite.directionIndex = mem.dirs;
  DirectionalSprite.animation = mem.anims;
  SpriteRenderer.spritesheetId = mem.sheets;
  const caster = { active: ShadowCaster.active, orient: ShadowCaster.orient, sunKind: ShadowCaster.sunKind };
  Object.assign(ShadowCaster, { active: mem.casts, orient: mem.orients, sunKind: mem.kinds });
  // The worker is the module's one instance: an earlier test stood in for its _packGpuSun.
  delete pre._packGpuSun;
  pre._keyedCastersLive = () => true;
  Sun.initialize(new SharedArrayBuffer(Sun.BYTE_LENGTH));
  try {
    const config = { camera: { pitch: 50 } };
    Object.assign(pre, {
      config,
      shadowsEnabled: true,
      gpuQueueCaps: { maxSun: cap },
      _gpuPackOpts: {},
      _gpuPackWasm: b,
      _keyedKeyBase: SCAN_KEY_BASE,
      _casterScanTick: 1e9,
      _casterKindsOn: false,
      _sunFrameTables: m.sunFrameTables(s.sources),
      _sunShift: new Int16Array(256),
      _sunShiftTurn: new Float64Array(256).fill(NaN),
      proxyToGlobalAnim: s.proxy,
      animationFrameStart: s.starts,
      animationFrameCount: s.counts,
      _renderableType: mem.types,
      _renderableIndex: mem.entities,
      renderQueueType: q.type,
    });
    const refTables = refSunFrameTables(s.sources);
    const refShift = new Int16Array(256);
    const refShiftTurn = new Float64Array(256).fill(NaN);
    const cases = [
      { what: 'the scan writes the frames', framed: true },
      { what: 'more rows for the JS than the list holds', framed: true, listCap: 3 },
      { what: 'no region', framed: false, region: false },
      { what: 'the entities\' frames outside the memory', framed: false, framesOut: true },
      { what: 'a queue that is not the collector\'s rows (no frames)', rowsOff: true },
      { what: 'the scan writes the frames, the sun turned', framed: true },
    ];
    for (let c = 0; c < cases.length; c++) {
      const k = cases[c];
      const angle = c * 1.1 - 2.5;
      Sun._float32[Sun.F32.SHADOW_DIR_X] = Math.cos(angle);
      Sun._float32[Sun.F32.SHADOW_DIR_Y] = Math.sin(angle);
      loadScanFrame(s, sm, makeQueue(s, rows));
      b.keyedSun = k.region === false ? null : region;
      region.listCap = k.listCap ?? listCap;
      pre.entityFrameIndex = k.framesOut ? Uint16Array.from(mem.frames) : mem.frames;
      pre._collectedRows = k.rowsOff ? rows - 1 : rows;
      pre._keyedSun.framed = !k.framed;
      mem.got.fill(-7);
      const keyedN = pre._packGpuSun({ sun: mem.got }, q);
      assert.equal(pre._gpuSunKeyed, true, `${k.what}: keyed rows`);
      if (!k.rowsOff) assert.equal(pre._keyedSun.framed, k.framed, `${k.what}: the scan wrote the frames or not`);
      if (k.listCap) assert.ok(pre._keyedSun.listed > k.listCap, `${k.what}: ${pre._keyedSun.listed} rows listed`);
      // The reference: the scan's rows without frames, then the keyed rows' pass as it was where the rows carry frames.
      mem.ref.fill(-7);
      assert.equal(packKeyedCastersScanWasm(b, q, rows, mem.ref, SCAN_KEY_BASE, cap), keyedN, `${k.what}: the rows`);
      if (!k.rowsOff) {
        const turn = -Math.PI / 2 - Math.atan2(Sun.shadowDirY / cameraFloorScaleY(config), Sun.shadowDirX);
        refPrepareSunFrames(refTables, s.proxy, s.starts, s.counts, refShift, refShiftTurn, turn);
        refApplyKeyedSunFramesFor(mem.ref, keyedN, rows, q.type, q.shadowH, mem.types, mem.entities, mem.active, mem.mode,
          mem.casts, mem.sheets, mem.dirs, mem.anims, mem.frames, refTables, refShift, mem.orients, mem.kinds);
      }
      const floats = keyedN * GPU_KEYED_CASTER_FLOATS;
      sameBits(mem.ref.subarray(0, floats), mem.got.subarray(0, floats), k.what, GPU_KEYED_CASTER_FLOATS);
      stepScene(s);
    }
  } finally {
    b.keyedSun = region;
    region.listCap = listCap;
    delete pre._keyedCastersLive;
    Object.assign(ShadowCaster, caster);
    Sun.unbind();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// E-393: the lamps' frames of the stamp rows written by gpuPack.wasm's lamp_frames.

/**
 * One shared memory holding what lamp_frames reads, the kernel bound on it: `stampN` stamp rows of `floats`, their u16
 * light index, the entity columns the lamps' passes read and the sun frames' region.
 */
async function lampMemory(stampN, floats, n, pages = 48) {
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const place = (bytes) => {
    top = (top + 63) & ~63;
    const at = top;
    top += bytes;
    return at;
  };
  const alloc = (Ctor, len) => new Ctor(buf, place(len * Ctor.BYTES_PER_ELEMENT), len);
  const mem = {
    rows: alloc(Float32Array, stampN * floats),
    lightIdx: alloc(Uint16Array, stampN),
    active: alloc(Uint8Array, n),
    mode: alloc(Uint8Array, n),
    sheets: alloc(Uint8Array, n),
    kinds: alloc(Uint8Array, n),
    orients: alloc(Uint8Array, n),
    dirs: alloc(Uint8Array, n),
    anims: alloc(Uint8Array, n),
    frames: alloc(Uint16Array, n),
  };
  const tableByte = place(4 * GPU_PACK_COLUMNS.length * 4);
  const indexByte = place(64);
  const particlesByte = place(144);
  const keyedSunByte = place(keyedSunRegionBytes());
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const b = await bindGpuPack(memory, {
    tableByte, tableSlots: 4, indexByte, indexCap: 16, particlesByte, inverseByte: 0, keyedSunByte,
  });
  return { mem, b };
}

/** Scene s's entity columns into the lamps' memory (the lamps' kind in `kinds`). */
function loadLampColumns(s, mem) {
  const { e } = s;
  mem.active.set(e.active);
  mem.mode.set(e.mode);
  mem.sheets.set(e.sheets);
  mem.kinds.set(e.lampKind);
  mem.orients.set(e.orients);
  mem.dirs.set(e.dirs);
  mem.anims.set(e.anims);
  mem.frames.set(e.frames);
}

/** The kernel's columns for a variant (columns(s, variant)'s nulls), in the lamps' memory. */
function lampCols(mem, variant) {
  return {
    active: mem.active,
    mode: mem.mode,
    dirs: mem.dirs,
    anims: mem.anims,
    sheets: mem.sheets,
    orients: variant & 4 ? null : mem.orients,
    kinds: variant & 8 ? null : mem.kinds,
    frames: variant & 2 ? null : mem.frames,
    listed: 0,
  };
}

const ODD_ENTITY = [NaN, Infinity, -Infinity, 3e9, -3e9, -2147483648, 2147483520, -0.75];

/**
 * Rows the kernel must leave to the JS or get right at the edges: entity floats that are no int32 (NaN, infinities, past
 * the range), frame floats NaN or -0 (keyed), scales NaN, 0 or -0 (full).
 */
function oddStampRows(r, rows, stampN, floats, keyed) {
  const entityFloat = keyed ? 2 : GPU_ROW_TINT;
  for (let k = 0; k < stampN; k++) {
    const at = k * floats;
    if (r() < 0.01) rows[at + entityFloat] = ODD_ENTITY[Math.floor(r() * ODD_ENTITY.length)];
    const y = r();
    if (keyed) {
      if (y < 0.02) rows[at + 3] = y < 0.01 ? NaN : -0;
    } else if (y < 0.03) {
      rows[at + GPU_ROW_SCALE_X] = y < 0.01 ? NaN : y < 0.02 ? 0 : -0;
    }
  }
}

/**
 * Random scenes' stamp rows (keyed or full) through the JS pass and through applyLampFramesWasm, the kernel and the JS for
 * the rows it lists: the same rows bit for bit. With `odd`, lights missing (past the list, or null), a lamp at NaN, a
 * light count below the lights the rows name and oddStampRows' rows; always lamps of their own entities, a new proxy map,
 * both floor scales, columns missing.
 * @returns {{ listed: number, rows: number, written: number }} the rows the kernel left to the JS, of all the rows, and
 *   the rows whose frame (keyed) or texture (full) changed
 */
async function lampKernelScenes(keyed, seeds, framesPer, adjust = null, odd = true) {
  const m = await worker();
  const n = 1500;
  const stampN = 6000;
  const floats = keyed ? GPU_KEYED_STAMP_FLOATS : GPU_CASTER_FLOATS;
  const frameFloat = keyed ? 3 : GPU_ROW_TEXTURE;
  let listed = 0;
  let rowsSeen = 0;
  let written = 0;
  for (const seed of seeds) {
    const s = makeScene(seed, n);
    if (adjust && adjust.scene) adjust.scene(s);
    bindDirectionalSprite(s.ds);
    const lm = await lampMemory(stampN, floats, n);
    const tables = m.sunFrameTables(s.sources);
    if (adjust && adjust.tables) adjust.tables(tables, lm);
    for (let frame = 0; frame < framesPer; frame++) {
      const variant = (seed * 3 + frame) & 15;
      loadLampColumns(s, lm.mem);
      const lights = makeLights(s.r, n);
      if (odd && frame === 1) lights[3] = null;
      if (odd && frame === 4) lights[5].x = NaN;
      // Without `odd`, every light the rows name (LIGHTS of them) is there.
      if (!odd) lights.push(...makeLights(s.r, n).slice(0, LIGHTS - lights.length));
      const lightCount = odd && frame === 3 ? 8 : lights.length;
      const invG = frame & 1 ? 1 / 0.7364 : 1;
      const proxy = frame === 2 ? JSON.parse(JSON.stringify(s.proxy)) : s.proxy;
      const { rows, lightIdx } = stampRows(s, lights, invG, stampN, floats, keyed ? 2 : GPU_ROW_TINT, keyed);
      if (odd) oddStampRows(s.r, rows, stampN, floats, keyed);
      const cols = lampCols(lm.mem, variant);
      const ref = rows.slice();
      const apply = keyed ? m.applyKeyedLampFramesInto : m.applyLampFramesInto;
      apply(ref, stampN, lightIdx, lights, invG, tables, proxy, s.starts, s.counts, cols.frames, cols.active, cols.mode,
        cols.dirs, cols.anims, cols.sheets, cols.orients, cols.kinds);
      lm.mem.rows.set(rows);
      lm.mem.lightIdx.set(lightIdx);
      const ran = m.applyLampFramesWasm(lm.b, lm.mem.rows, stampN, lm.mem.lightIdx, lights, lightCount, invG, tables, proxy,
        s.starts, s.counts, cols, keyed);
      assert.equal(ran, true, `seed ${seed} frame ${frame}: the kernel took the call`);
      sameBits(ref, lm.mem.rows, `seed ${seed} frame ${frame}`, floats);
      for (let k = 0; k < stampN; k++) if (!Object.is(rows[k * floats + frameFloat], ref[k * floats + frameFloat])) written++;
      listed += cols.listed;
      rowsSeen += stampN;
      if (adjust && adjust.after) adjust.after(lm, tables);
      stepScene(s);
      if (adjust && adjust.scene) adjust.scene(s);
    }
  }
  return { listed, rows: rowsSeen, written };
}

test('E-393: keyed lamp rows through lamp_frames: the same frames and own rows dropped as the JS pass', async () => {
  const { listed, rows } = await lampKernelScenes(true, [91, 92, 93, 94], 6);
  assert.ok(listed > 200, `rows left to the JS: uneven tables, no direction drawn, borders, lights unknown (${listed})`);
  assert.ok(listed < rows * 0.6, `the kernel decided rows (${listed} of ${rows} listed)`);
});

test('E-393: full lamp rows through lamp_frames: the same textures, flips and own rows dropped as the JS pass', async () => {
  const { listed, rows } = await lampKernelScenes(false, [95, 96, 97, 98], 6);
  assert.ok(listed > 200 && listed < rows * 0.6, `rows left to the JS (${listed} of ${rows})`);
});

test('E-393: on tables whose borders the kernel reads, it decides every row but the rays near a border', async () => {
  // Only uniform tables of a multiple of four directions a whole turn's share apart, each caster's direction one of them.
  const quartered = (s) => {
    for (const id of Object.keys(s.sources)) {
      const src = s.sources[id];
      if (!src.uniform || src.count % 4 !== 0 || !(Math.abs(src.step * src.count - TWO_PI) < 1e-9)) delete s.sources[id];
    }
    for (let i = 0; i < s.n; i++) {
      const src = s.sources[s.e.sheets[i]];
      if (src) s.e.dirs[i] %= src.count;
    }
  };
  for (const keyed of [true, false]) {
    const { listed, rows, written } = await lampKernelScenes(keyed, [106, 107], 4, { scene: quartered }, false);
    const what = keyed ? 'keyed' : 'full';
    assert.ok(listed < rows * 0.12, `${what}: the rays near a border alone left to the JS (${listed} of ${rows})`);
    assert.ok(written > rows * 0.2, `${what}: frames written (${written} of ${rows})`);
  }
});

test('E-393: lamp_frames with a short list stops at the row it cannot list, and the JS pass does the rest', async () => {
  for (const keyed of [true, false]) {
    const adjust = {
      tables(tables, lm) {
        const region = keyedSunViews(lm.b.buffer, lm.b.keyedSun.byte);
        region.list = region.list.subarray(0, 7);
        lm.b.keyedSun = region;
      },
    };
    const { listed } = await lampKernelScenes(keyed, [101, 102], 4, adjust);
    assert.ok(listed > 0 && listed <= 7 * 8, `the list held what it could (${listed})`);
  }
});

test('E-393: a pool that holds few sheets: their lamp rows go to the JS (no frames, no geometry), as before', async () => {
  let deferred = 0;
  for (const keyed of [true, false]) {
    const adjust = {
      tables(tables, lm) {
        const region = keyedSunViews(lm.b.buffer, lm.b.keyedSun.byte);
        region.pool = region.pool.subarray(0, 300);
        lm.b.keyedSun = region;
      },
      after(lm, tables) {
        let n = 0;
        for (let sheet = 0; sheet < tables.length; sheet++) {
          const flags = lm.b.keyedSun.sheets[sheet * KEYED_SUN_SHEET_WORDS + KEYED_SUN_SHEET.FLAGS];
          if (tables[sheet] !== undefined && (flags & (KEYED_SUN_DEFER | KEYED_SUN_LAMP_GEO)) !== KEYED_SUN_LAMP_GEO) n++;
        }
        if (n > deferred) deferred = n;
      },
    };
    const { listed } = await lampKernelScenes(keyed, [103, 104], 3, adjust);
    assert.ok(listed > 300, `rows left to the JS (${listed})`);
  }
  assert.ok(deferred >= 3, `sheets without their frames or geometry in the pool (${deferred})`);
});

test('E-393: the region holds each uniform table’s border geometry, as lampTurnGeometry made it', async () => {
  const m = await worker();
  const s = makeScene(105, 64);
  const tables = m.sunFrameTables(s.sources);
  m.prepareSunFrames(tables, s.proxy, s.starts, s.counts, new Int16Array(256), new Float64Array(256).fill(NaN), 0.4);
  const lm = await lampMemory(16, GPU_KEYED_STAMP_FLOATS, 64);
  m.syncKeyedSunTables(lm.b.keyedSun, tables);
  let geo = 0;
  for (let sheet = 0; sheet < tables.length; sheet++) {
    const t = tables[sheet];
    if (t === undefined) continue;
    const w = sheet * KEYED_SUN_SHEET_WORDS;
    const flags = lm.b.keyedSun.sheets[w + KEYED_SUN_SHEET.FLAGS];
    assert.equal((flags & KEYED_SUN_LAMP_GEO) !== 0, t.lampQuarter > 0, `sheet ${sheet}: the geometry where the table has it`);
    if (t.lampQuarter > 0) {
      const at = lm.b.keyedSun.sheets[w + KEYED_SUN_SHEET.LAMP_GEO];
      assert.equal(at % 8, 0, 'doubles on their own boundary');
      const copy = new Float64Array(lm.b.buffer, at, t.lampGeo.length);
      assert.deepEqual(Array.from(copy), Array.from(t.lampGeo));
      geo++;
    }
  }
  assert.ok(geo >= 3, `uniform tables with the geometry (${geo})`);
});

test('E-393: a lamp all around a caster of each uniform table, through lamp_frames: every direction as the JS pass', async () => {
  const m = await worker();
  const s = makeScene(51, 64);
  bindDirectionalSprite(s.ds);
  const tables = m.sunFrameTables(s.sources);
  const ids = Object.keys(s.sources).map(Number);
  const e = s.e;
  for (let i = 0; i < ids.length; i++) {
    e.active[i] = 1;
    e.mode[i] = 1;
    e.sheets[i] = ids[i];
    e.lampKind[i] = 1;
    e.orients[i] = 0;
    e.dirs[i] = i % s.sources[ids[i]].count;
    e.anims[i] = 0;
  }
  const lights = [{ id: -5, x: 0, y: 0 }];
  const per = 2000;
  const stampN = ids.length * per;
  for (const keyed of [true, false]) {
    const floats = keyed ? GPU_KEYED_STAMP_FLOATS : GPU_CASTER_FLOATS;
    const lm = await lampMemory(stampN, floats, 64, 96);
    loadLampColumns(s, lm.mem);
    for (const invG of [1, 1 / 0.7364]) {
      const rows = new Float32Array(stampN * floats);
      for (let i = 0; i < ids.length; i++) {
        const count = s.sources[ids[i]].count;
        const step = TWO_PI / count;
        for (let k = 0; k < per; k++) {
          const at = (i * per + k) * floats;
          // Half the rays sweep the whole turn, half sit within 2e-4 rad of a border.
          const phi = k & 1 ? (k / per) * TWO_PI : (Math.floor((k / per) * count) + 0.5) * step + ((k % 97) - 48) * 4e-6;
          rows[at] = -Math.sin(phi) * 250;
          rows[at + 1] = (-Math.cos(phi) * 250) / invG;
          rows[at + (keyed ? 2 : GPU_ROW_TINT)] = i;
          if (!keyed) rows[at + GPU_ROW_SCALE_X] = k % 3 === 0 ? -1.25 : 0.75;
        }
      }
      const lightIdx = new Uint16Array(stampN);
      const cols = lampCols(lm.mem, 0);
      const ref = rows.slice();
      const apply = keyed ? m.applyKeyedLampFramesInto : m.applyLampFramesInto;
      apply(ref, stampN, lightIdx, lights, invG, tables, s.proxy, s.starts, s.counts, cols.frames, cols.active, cols.mode,
        cols.dirs, cols.anims, cols.sheets, cols.orients, cols.kinds);
      lm.mem.rows.set(rows);
      lm.mem.lightIdx.set(lightIdx);
      assert.equal(m.applyLampFramesWasm(lm.b, lm.mem.rows, stampN, lm.mem.lightIdx, lights, 1, invG, tables, s.proxy,
        s.starts, s.counts, cols, keyed), true);
      sameBits(ref, lm.mem.rows, `${keyed ? 'keyed' : 'full'} invG ${invG}`, floats);
      assert.ok(cols.listed > 0 && cols.listed < stampN * 0.9, `the rays near a border left to the JS (${cols.listed})`);
    }
  }
});

test('E-393: _packGpuShadows on the real worker, the lamp frames through lamp_frames: the rows as the old passes left them', async () => {
  const m = await worker();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const { ShadowCaster } = await import('../../src/components/shadowCaster.js');
  const { SpriteRenderer } = await import('../../src/components/spriteRenderer.js');
  const { cameraFloorScaleY } = await import('../../src/util/cameraView.js');
  const n = 1500;
  const s = makeScene(111, n);
  bindDirectionalSprite(s.ds);
  const stampN = 3000;
  const config = { camera: { pitch: 47 } };
  const invG = 1 / cameraFloorScaleY(config);
  const caster = { orient: ShadowCaster.orient, lampKind: ShadowCaster.lampKind };
  const cases = [
    { what: 'keyed rows, the kernel', keyed: true, kernel: true },
    { what: 'full rows, the kernel', keyed: false, kernel: true },
    { what: 'no region: the JS pass', keyed: true, kernel: false, region: false },
    { what: 'the light index outside the memory: the JS pass', keyed: false, kernel: false, lightIdxOut: true },
    { what: 'the entities’ frames outside the memory: the JS pass', keyed: false, kernel: false, framesOut: true },
  ];
  try {
    for (let c = 0; c < cases.length; c++) {
      const k = cases[c];
      const floats = k.keyed ? GPU_KEYED_STAMP_FLOATS : GPU_CASTER_FLOATS;
      const lm = await lampMemory(stampN, floats, n);
      loadLampColumns(s, lm.mem);
      DirectionalSprite.active = lm.mem.active;
      DirectionalSprite.mode = lm.mem.mode;
      DirectionalSprite.directionIndex = lm.mem.dirs;
      DirectionalSprite.animation = lm.mem.anims;
      SpriteRenderer.spritesheetId = lm.mem.sheets;
      ShadowCaster.orient = lm.mem.orients;
      ShadowCaster.lampKind = lm.mem.kinds;
      const lights = makeLights(s.r, n);
      const { rows: stamped, lightIdx } = stampRows(s, lights, invG, stampN, floats, k.keyed ? 2 : GPU_ROW_TINT, k.keyed);
      oddStampRows(s.r, stamped, stampN, floats, k.keyed);
      let calls = 0;
      const real = lm.b.lampFrames;
      lm.b.lampFrames = (...args) => {
        calls++;
        return real(...args);
      };
      if (k.region === false) lm.b.keyedSun = null;
      Object.assign(pre, {
        config,
        shadowsEnabled: true,
        gpuQueueCaps: { maxSun: 8, maxStamp: stampN, maxCookie: 8 },
        shadowUpdateInterval: 1,
        visibilityPolygonsEnabled: false,
        _emitSkippedStatics: false,
        _stampLights: lights,
        _stampLightCount: lights.length,
        _sunFrameTables: m.sunFrameTables(s.sources),
        _gpuPackWasm: lm.b,
        proxyToGlobalAnim: s.proxy,
        animationFrameStart: s.starts,
        animationFrameCount: s.counts,
        entityFrameIndex: k.framesOut ? Uint16Array.from(lm.mem.frames) : lm.mem.frames,
      });
      pre._packGpuSun = () => {
        pre._gpuSunKeyed = k.keyed;
        return 5;
      };
      pre._stampAgainstSun = (dst) => {
        dst.stamp.set(stamped);
        dst.stampLightIdx.set(lightIdx);
        return stampN;
      };
      pre._packGpuCookies = () => 0;
      const dst = {
        sun: new Float32Array(8 * GPU_CASTER_FLOATS),
        stamp: lm.mem.rows,
        stampLightIdx: k.lightIdxOut ? new Uint16Array(stampN) : lm.mem.lightIdx,
        cookie: new Float32Array(8 * GPU_SPRITE_FLOATS),
      };
      const res = pre._packGpuShadows(dst, {});
      assert.equal(res.stamp, stampN, `${k.what}: the stamp rows`);
      assert.equal(calls > 0, k.kernel, `${k.what}: the kernel ran or not`);
      // The reference: the drop of each lamp's own entity, then the frames' pass as it was.
      const refTables = refSunFrameTables(s.sources);
      const ref = stamped.slice();
      if (k.keyed) refDropOwnKeyedStampsInto(ref, stampN, lightIdx, lights);
      else refDropOwnStampsInto(ref, stampN, lightIdx, lights);
      const apply = k.keyed ? refApplyKeyedLampFramesInto : refApplyLampFramesInto;
      apply(ref, stampN, lightIdx, lights, invG, refTables, s.proxy, s.starts, s.counts, lm.mem.frames, lm.mem.active,
        lm.mem.mode, lm.mem.dirs, lm.mem.anims, lm.mem.sheets, lm.mem.orients, lm.mem.kinds);
      sameBits(ref, dst.stamp, k.what, floats);
      stepScene(s);
    }
  } finally {
    // The worker is the module's one instance: later tests run its own methods.
    delete pre._stampAgainstSun;
    delete pre._packGpuSun;
    delete pre._packGpuCookies;
    pre._gpuPackWasm = null;
    Object.assign(ShadowCaster, caster);
  }
});
