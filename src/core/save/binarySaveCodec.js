// Binary save body codec — sectioned little-endian payload (sole wire format).

import { Layer } from '../layer.js';
import { TWEEN_RECORD_FIELDS, tweenFieldValue } from './tweenRecord.js';

export const SECTION = Object.freeze({
  META: 1,
  CAMERA: 2,
  SUN: 3,
  ENTITIES: 4,
  JOINTS: 5,
  LIQUIDFUN: 6,
  DECALS: 7,
  /** Legacy (no schema fingerprint). Read only; writes use SHARED_RESOURCES2. */
  SHARED_RESOURCES: 8,
  /** Legacy (no layout byte). Read only; writes use CHAINS2, FIXTURES2, MESHES2. */
  CHAINS: 9,
  FIXTURES: 10,
  MESHES: 11,
  NAV: 12,
  TIME: 13,
  /** Legacy (u16 entity). Read only; writes use TWEENS2. */
  TWEENS: 14,
  /** u8 layout version, then the TWEENS records with a u32 entity. */
  TWEENS2: 15,
  /** u8 layout, then records of name, u32 schema fingerprint (0 = unknown), bytes. */
  SHARED_RESOURCES2: 16,
  /** u8 layout, then the CHAINS / FIXTURES / MESHES records. */
  CHAINS2: 17,
  FIXTURES2: 18,
  MESHES2: 19,
  /** u8 layout, then the JSON text of Scene.onSaveGame()'s value. Absent when it returned nothing. */
  CUSTOM: 20,
});

/** 2: repeat, doneMsg, flags (DX 4.2). Layout 1 saves still read. */
const TWEENS2_LAYOUT = 2;
/** Record layout of SHARED_RESOURCES2, CHAINS2, FIXTURES2, MESHES2. Bump on any change. */
const SECTION_LAYOUT = 1;

const KIND = Object.freeze({
  F64: 0,
  F64_ARRAY: 1,
  NULL: 2,
});

const TYPED = Object.freeze({
  NONE: 0,
  F32: 1,
  U32: 2,
  U16: 3,
  I32: 4,
  U8: 5,
});

const DECAL_FMT = Object.freeze({
  raw: 0,
  png: 1,
});

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Component and field names repeat for every saved entity; each is encoded
// once (E-49). Schema names only, so the set stays small; capped anyway.
const _nameBytes = new Map();
const NAME_CACHE_MAX = 4096;

function nameBytes(s) {
  let b = _nameBytes.get(s);
  if (b === undefined) {
    if (_nameBytes.size >= NAME_CACHE_MAX) _nameBytes.clear();
    b = textEncoder.encode(s);
    _nameBytes.set(s, b);
  }
  return b;
}

class Writer {
  constructor(initial = 4096) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.o = 0;
  }

  _grow(need) {
    if (this.o + need <= this.buf.length) return;
    let n = this.buf.length || 1;
    while (n < this.o + need) n *= 2;
    const next = new Uint8Array(n);
    next.set(this.buf.subarray(0, this.o));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v) {
    this._grow(1);
    this.buf[this.o++] = v & 0xff;
  }

  u16(v) {
    this._grow(2);
    this.view.setUint16(this.o, v & 0xffff, true);
    this.o += 2;
  }

  u32(v) {
    this._grow(4);
    this.view.setUint32(this.o, v >>> 0, true);
    this.o += 4;
  }

  f32(v) {
    this._grow(4);
    this.view.setFloat32(this.o, v, true);
    this.o += 4;
  }

  f64(v) {
    this._grow(8);
    this.view.setFloat64(this.o, v, true);
    this.o += 8;
  }

  /** Length-prefixed bytes */
  bytes(u8) {
    const src = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8 || []);
    this.u32(src.byteLength);
    this.raw(src);
  }

  str(s) {
    this.bytes(textEncoder.encode(s == null ? '' : String(s)));
  }

  /** str() for a schema name: same bytes, encoded once per name. */
  name(s) {
    this.bytes(nameBytes(s));
  }

  /** Raw bytes without length prefix */
  raw(u8) {
    const src = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8 || []);
    if (!src.byteLength) return;
    this._grow(src.byteLength);
    this.buf.set(src, this.o);
    this.o += src.byteLength;
  }

  finish() {
    return this.buf.subarray(0, this.o);
  }
}

class Reader {
  constructor(bytes) {
    this.buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.o = 0;
  }

  _need(n) {
    if (this.o + n > this.buf.byteLength) {
      throw new Error('SaveGame: truncated binary body');
    }
  }

  u8() {
    this._need(1);
    return this.buf[this.o++];
  }

  u16() {
    this._need(2);
    const v = this.view.getUint16(this.o, true);
    this.o += 2;
    return v;
  }

  u32() {
    this._need(4);
    const v = this.view.getUint32(this.o, true);
    this.o += 4;
    return v;
  }

  f32() {
    this._need(4);
    const v = this.view.getFloat32(this.o, true);
    this.o += 4;
    return v;
  }

  f64() {
    this._need(8);
    const v = this.view.getFloat64(this.o, true);
    this.o += 8;
    return v;
  }

  bytes() {
    const len = this.u32();
    return this.raw(len);
  }

  str() {
    return textDecoder.decode(this.bytes());
  }

  raw(len) {
    this._need(len);
    const slice = this.buf.subarray(this.o, this.o + len);
    this.o += len;
    return slice.slice();
  }
}

function writeValue(w, value) {
  if (value == null || Number.isNaN(value)) {
    w.u8(KIND.NULL);
    return;
  }
  if (Array.isArray(value)) {
    w.u8(KIND.F64_ARRAY);
    w.u32(value.length);
    for (let i = 0; i < value.length; i++) w.f64(+value[i]);
    return;
  }
  w.u8(KIND.F64);
  w.f64(+value);
}

function readValue(r) {
  const kind = r.u8();
  if (kind === KIND.NULL) return null;
  if (kind === KIND.F64) return r.f64();
  if (kind === KIND.F64_ARRAY) {
    const n = r.u32();
    const arr = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = r.f64();
    return arr;
  }
  throw new Error(`SaveGame: bad value kind ${kind}`);
}

function typedCode(arr) {
  if (!arr || !arr.length) return TYPED.NONE;
  if (arr instanceof Float32Array) return TYPED.F32;
  if (arr instanceof Uint32Array) return TYPED.U32;
  if (arr instanceof Uint16Array) return TYPED.U16;
  if (arr instanceof Int32Array) return TYPED.I32;
  if (arr instanceof Uint8Array || arr instanceof Uint8ClampedArray) return TYPED.U8;
  throw new Error(`SaveGame: unsupported typed array ${arr.constructor?.name}`);
}

function writeTyped(w, arr) {
  const code = typedCode(arr);
  w.u8(code);
  if (code === TYPED.NONE) {
    w.u32(0);
    return;
  }
  w.u32(arr.length);
  w.raw(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

function readTyped(r) {
  const code = r.u8();
  const n = r.u32();
  if (code === TYPED.NONE || n === 0) {
    if (code === TYPED.F32) return new Float32Array(0);
    if (code === TYPED.U32) return new Uint32Array(0);
    if (code === TYPED.U16) return new Uint16Array(0);
    if (code === TYPED.I32) return new Int32Array(0);
    return new Uint8Array(0);
  }
  let bytesPer = 1;
  if (code === TYPED.F32 || code === TYPED.U32 || code === TYPED.I32) bytesPer = 4;
  else if (code === TYPED.U16) bytesPer = 2;
  else if (code !== TYPED.U8) throw new Error(`SaveGame: bad typed code ${code}`);
  const raw = r.raw(n * bytesPer);
  const aligned = new ArrayBuffer(raw.byteLength);
  new Uint8Array(aligned).set(raw);
  if (code === TYPED.F32) return new Float32Array(aligned);
  if (code === TYPED.U32) return new Uint32Array(aligned);
  if (code === TYPED.U16) return new Uint16Array(aligned);
  if (code === TYPED.I32) return new Int32Array(aligned);
  return new Uint8Array(aligned);
}

function pushSection(sections, tag, buildFn) {
  const inner = new Writer();
  buildFn(inner);
  sections.push({ tag, body: inner.finish() });
}

function writeMeta(w, payload) {
  w.str(payload.sceneName || 'Scene');
  w.str(payload.engineVersion || '');
  const layout = payload.layout || { types: [], totalEntityCount: 0 };
  const types = layout.types || [];
  w.u16(types.length);
  for (let i = 0; i < types.length; i++) {
    w.str(types[i].name || '');
    w.u32(types[i].poolSize | 0);
  }
  w.u32(layout.totalEntityCount | 0);
}

function readMeta(r) {
  const sceneName = r.str();
  const engineVersion = r.str();
  const typeCount = r.u16();
  const types = [];
  for (let i = 0; i < typeCount; i++) {
    types.push({ name: r.str(), poolSize: r.u32() });
  }
  return {
    sceneName,
    engineVersion,
    layout: { types, totalEntityCount: r.u32() },
  };
}

function writeCamera(w, camera) {
  if (!camera || !camera.length) {
    w.u32(0);
    return;
  }
  w.u32(camera.length);
  for (let i = 0; i < camera.length; i++) w.f64(+camera[i]);
}

function readCamera(r) {
  const n = r.u32();
  if (!n) return null;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = r.f64();
  return out;
}

function writeSun(w, sun) {
  if (!sun) {
    w.u8(0);
    return;
  }
  w.u8(1);
  w.u8(sun.enabled ? 1 : 0);
  const f32 = sun.f32 || [];
  w.u32(f32.length);
  for (let i = 0; i < f32.length; i++) w.f32(+f32[i]);
  w.u32((sun.color >>> 0) || 0);
}

function readSun(r) {
  if (!r.u8()) return null;
  const enabled = r.u8();
  const n = r.u32();
  const f32 = new Array(n);
  for (let i = 0; i < n; i++) f32[i] = r.f32();
  return { enabled, f32, color: r.u32() };
}

function writeEntities(w, entities) {
  const list = entities || [];
  const byType = new Map();
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    const key = rec.typeName || '';
    let arr = byType.get(key);
    if (!arr) {
      arr = [];
      byType.set(key, arr);
    }
    arr.push(rec);
  }
  w.u16(byType.size);
  for (const [typeName, recs] of byType) {
    w.str(typeName);
    w.u32(recs.length);
    for (let e = 0; e < recs.length; e++) {
      const rec = recs[e];
      w.u32(rec.entityIndex | 0);
      const components = rec.components || {};
      const names = Object.keys(components);
      w.u16(names.length);
      for (let c = 0; c < names.length; c++) {
        const name = names[c];
        const comp = components[name] || {};
        w.name(name);
        w.u32(comp.fingerprint >>> 0);
        const fields = comp.fields || {};
        const fieldNames = Object.keys(fields);
        w.u16(fieldNames.length);
        for (let f = 0; f < fieldNames.length; f++) {
          w.name(fieldNames[f]);
          writeValue(w, fields[fieldNames[f]]);
        }
      }
    }
  }
}

function readEntities(r) {
  const typeCount = r.u16();
  const entities = [];
  for (let t = 0; t < typeCount; t++) {
    const typeName = r.str();
    const entityCount = r.u32();
    for (let e = 0; e < entityCount; e++) {
      const entityIndex = r.u32();
      const componentCount = r.u16();
      const components = {};
      for (let c = 0; c < componentCount; c++) {
        const name = r.str();
        const fingerprint = r.u32();
        const fieldCount = r.u16();
        const fields = {};
        for (let f = 0; f < fieldCount; f++) {
          fields[r.str()] = readValue(r);
        }
        components[name] = { fingerprint, fields };
      }
      entities.push({ typeName, entityIndex, components });
    }
  }
  return entities;
}

function writeJoints(w, joints) {
  const list = joints || [];
  w.u32(list.length);
  for (let i = 0; i < list.length; i++) {
    const j = list[i] || {};
    const keys = Object.keys(j);
    w.u16(keys.length);
    for (let k = 0; k < keys.length; k++) {
      w.str(keys[k]);
      writeValue(w, j[keys[k]]);
    }
  }
}

function readJoints(r) {
  const n = r.u32();
  const joints = [];
  for (let i = 0; i < n; i++) {
    const fieldCount = r.u16();
    const rec = {};
    for (let f = 0; f < fieldCount; f++) {
      rec[r.str()] = readValue(r);
    }
    joints.push(rec);
  }
  return joints;
}

function writeLiquidFun(w, lf) {
  w.u32(lf.count | 0);
  w.f32(+lf.radius || 0);
  w.u32(lf.maxCount | 0);
  writeTyped(w, lf.x);
  writeTyped(w, lf.y);
  writeTyped(w, lf.vx);
  writeTyped(w, lf.vy);
  writeTyped(w, lf.flags);
  w.u8(lf.groupIndex ? 1 : 0);
  if (lf.groupIndex) writeTyped(w, lf.groupIndex);
  w.u8(lf.restOffset ? 1 : 0);
  if (lf.restOffset) writeTyped(w, lf.restOffset);

  const groups = lf.groups;
  if (!groups || !(groups.slotCount > 0)) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u32(groups.slotCount | 0);
    writeTyped(w, groups.alive);
    writeTyped(w, groups.flags);
    writeTyped(w, groups.groupFlags);
    writeTyped(w, groups.strength);
    writeTyped(w, groups.viscousScale);
    writeTyped(w, groups.firstIndex);
    writeTyped(w, groups.lastIndex);
  }

  const pairs = lf.pairs;
  if (!pairs || !(pairs.count > 0)) {
    w.u8(0);
  } else {
    w.u8(1);
    w.u32(pairs.count | 0);
    writeTyped(w, pairs.a);
    writeTyped(w, pairs.b);
    writeTyped(w, pairs.flags);
    writeTyped(w, pairs.distance);
    writeTyped(w, pairs.strength);
  }

  const render = lf.render;
  if (!render) {
    w.u8(0);
  } else {
    w.u8(1);
    writeTyped(w, render.tint);
    writeTyped(w, render.textureId);
    writeTyped(w, render.scaleX);
    writeTyped(w, render.scaleY);
    writeTyped(w, render.alpha);
    w.u8(render.rotC ? 1 : 0);
    if (render.rotC) writeTyped(w, render.rotC);
    w.u8(render.rotS ? 1 : 0);
    if (render.rotS) writeTyped(w, render.rotS);
    w.u8(render.layerMask ? 1 : 0);
    if (render.layerMask) writeTyped(w, render.layerMask);
  }

  // Appended after v4 render block; readers skip if the section ends here.
  w.u8(lf.groupsLightIntensity ? 1 : 0);
  if (lf.groupsLightIntensity) writeTyped(w, lf.groupsLightIntensity);
  w.u8(0); // no legacy feedLayerId
  w.u8(lf.userData ? 1 : 0);
  if (lf.userData) writeTyped(w, lf.userData);
  w.u8(lf.color ? 1 : 0);
  if (lf.color) writeTyped(w, lf.color);
}

function readLiquidFun(r) {
  const count = r.u32();
  const radius = r.f32();
  const maxCount = r.u32();
  const x = readTyped(r);
  const y = readTyped(r);
  const vx = readTyped(r);
  const vy = readTyped(r);
  const flags = readTyped(r);
  const groupIndex = r.u8() ? readTyped(r) : null;
  const restOffset = r.u8() ? readTyped(r) : null;

  let groups = null;
  if (r.u8()) {
    groups = {
      slotCount: r.u32(),
      alive: readTyped(r),
      flags: readTyped(r),
      groupFlags: readTyped(r),
      strength: readTyped(r),
      viscousScale: readTyped(r),
      firstIndex: readTyped(r),
      lastIndex: readTyped(r),
    };
  }

  let pairs = null;
  if (r.u8()) {
    pairs = {
      count: r.u32(),
      a: readTyped(r),
      b: readTyped(r),
      flags: readTyped(r),
      distance: readTyped(r),
      strength: readTyped(r),
    };
  }

  let render = null;
  if (r.u8()) {
    render = {
      tint: readTyped(r),
      textureId: readTyped(r),
      scaleX: readTyped(r),
      scaleY: readTyped(r),
      alpha: readTyped(r),
      rotC: r.u8() ? readTyped(r) : null,
      rotS: r.u8() ? readTyped(r) : null,
      layerField: r.u8() ? readTyped(r) : null,
    };
  }

  let groupsLightIntensity = null;
  if (r.o < r.buf.byteLength) {
    groupsLightIntensity = r.u8() ? readTyped(r) : null;
  }
  let feedLayerId = null;
  if (r.o < r.buf.byteLength) {
    feedLayerId = r.u8() ? readTyped(r) : null;
  }
  if (render) {
    render.layerMask = Layer.maskFromLegacy(render.layerField, feedLayerId);
    delete render.layerField;
  }

  let userData = null;
  let color = null;
  if (r.o < r.buf.byteLength) {
    userData = r.u8() ? readTyped(r) : null;
  }
  if (r.o < r.buf.byteLength) {
    color = r.u8() ? readTyped(r) : null;
  }

  return {
    count,
    radius,
    maxCount,
    x,
    y,
    vx,
    vy,
    flags,
    userData,
    color,
    groupIndex,
    restOffset,
    groups,
    pairs,
    render,
    groupsLightIntensity,
  };
}

function writeDecals(w, decals) {
  w.u32(decals.tilesX | 0);
  w.u32(decals.tilesY | 0);
  w.u32(decals.tilePixelSize | 0);
  w.u32(decals.tileSize | 0);
  const tiles = decals.tiles || [];
  w.u32(tiles.length);
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    w.u32(tile.i | 0);
    w.u8(tile.fmt === 'png' ? DECAL_FMT.png : DECAL_FMT.raw);
    const bytes =
      tile.bytes instanceof Uint8Array ? tile.bytes : new Uint8Array(tile.bytes || []);
    w.bytes(bytes);
  }
}

function readDecals(r) {
  const tilesX = r.u32();
  const tilesY = r.u32();
  const tilePixelSize = r.u32();
  const tileSize = r.u32();
  const n = r.u32();
  const tiles = [];
  for (let i = 0; i < n; i++) {
    const index = r.u32();
    const fmtCode = r.u8();
    tiles.push({
      i: index,
      fmt: fmtCode === DECAL_FMT.png ? 'png' : 'raw',
      bytes: r.bytes(),
    });
  }
  return { tilesX, tilesY, tilePixelSize, tileSize, tiles };
}

function writeSharedResources(w, records) {
  const list = records || [];
  w.u8(SECTION_LAYOUT);
  w.u32(list.length);
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    w.str(rec.name || '');
    w.u32(rec.fingerprint >>> 0);
    const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes || []);
    w.bytes(bytes);
  }
}

/** @param {boolean} legacy SHARED_RESOURCES (tag 8): no fingerprint. */
function readSharedResources(r, legacy) {
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    const name = r.str();
    const fingerprint = legacy ? 0 : r.u32();
    out.push({ name, fingerprint: fingerprint || null, bytes: r.bytes() });
  }
  return out;
}

function writeChains(w, records) {
  const list = records || [];
  w.u8(SECTION_LAYOUT);
  w.u32(list.length);
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    w.u32(rec.entityIndex | 0);
    w.u8(rec.loop ? 1 : 0);
    w.u32(rec.count | 0);
    writeTyped(w, rec.xy);
  }
}

function readChains(r) {
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      entityIndex: r.u32(),
      loop: r.u8(),
      count: r.u32(),
      xy: readTyped(r),
    });
  }
  return out;
}

function writeFixtures(w, records) {
  const list = records || [];
  w.u8(SECTION_LAYOUT);
  w.u32(list.length);
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    w.u32(rec.entityIndex | 0);
    writeTyped(w, rec.counts);
    writeTyped(w, rec.xy);
  }
}

function readFixtures(r) {
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      entityIndex: r.u32(),
      counts: readTyped(r),
      xy: readTyped(r),
    });
  }
  return out;
}

function writeMeshes(w, records) {
  const list = records || [];
  w.u8(SECTION_LAYOUT);
  w.u32(list.length);
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    w.u32(rec.entityIndex | 0);
    writeTyped(w, rec.xy);
    w.u8(rec.uv ? 1 : 0);
    if (rec.uv) writeTyped(w, rec.uv);
    w.u8(rec.indices ? 1 : 0);
    if (rec.indices) writeTyped(w, rec.indices);
  }
}

function readMeshes(r) {
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    const entityIndex = r.u32();
    const xy = readTyped(r);
    const uv = r.u8() ? readTyped(r) : null;
    const indices = r.u8() ? readTyped(r) : null;
    out.push({ entityIndex, xy, uv, indices });
  }
  return out;
}

function writeNav(w, nav) {
  w.u32(nav.gridWidth | 0);
  w.u32(nav.gridHeight | 0);
  w.u32(nav.cellSize >>> 0);
  writeTyped(w, nav.walkability);
}

function readNav(r) {
  return {
    gridWidth: r.u32(),
    gridHeight: r.u32(),
    cellSize: r.u32(),
    walkability: readTyped(r),
  };
}

function writeCustom(w, value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new Error(`SaveGame: onSaveGame() must return JSON data (${err.message})`);
  }
  w.u8(SECTION_LAYOUT);
  w.str(text);
}

function readCustom(r) {
  return JSON.parse(r.str());
}

function writeTime(w, scale) {
  w.f32(+scale);
}

function readTime(r) {
  return r.f32();
}

// TWEENS2. The entity is u32 (entityIdWidth 32 indices exceed 65535). The leading
// layout byte lets the record grow without another tag.
function writeTweens(w, slots) {
  const list = slots || [];
  w.u8(TWEENS2_LAYOUT);
  w.u32(list.length);
  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    for (let f = 0; f < TWEEN_RECORD_FIELDS.length; f++) {
      const name = TWEEN_RECORD_FIELDS[f][0];
      const type = TWEEN_RECORD_FIELDS[f][1];
      const v = tweenFieldValue(type, rec[name]);
      if (type === 'f32') w.f32(v);
      else if (type === 'u32') w.u32(v);
      else w.u8(v);
    }
  }
}

/**
 * @param {Reader} r
 * @param {boolean} legacy TWEENS (tag 14): no layout byte, u16 entity.
 */
function readTweens(r, legacy) {
  let layout = 1;
  if (!legacy) {
    layout = r.u8();
    if (layout > TWEENS2_LAYOUT) {
      console.warn(`[SaveGame] tween section layout ${layout} is newer than this build; tweens skipped`);
      return null;
    }
  }
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    const rec = {};
    for (let f = 0; f < TWEEN_RECORD_FIELDS.length; f++) {
      const name = TWEEN_RECORD_FIELDS[f][0];
      const type = TWEEN_RECORD_FIELDS[f][1];
      const since = TWEEN_RECORD_FIELDS[f][2] || 1;
      if (since > layout) rec[name] = 0;
      else if (type === 'f32') rec[name] = r.f32();
      else if (type === 'u32') rec[name] = legacy && name === 'entity' ? r.u16() : r.u32();
      else rec[name] = r.u8();
    }
    out.push(rec);
  }
  return out;
}

/**
 * Encode logical save payload to uncompressed binary body (no magic/version/deflate).
 * @param {object} payload
 * @returns {Uint8Array}
 */
export function encodeBinarySaveBody(payload) {
  const sections = [];
  pushSection(sections, SECTION.META, (w) => writeMeta(w, payload));
  pushSection(sections, SECTION.CAMERA, (w) => writeCamera(w, payload.camera));
  pushSection(sections, SECTION.SUN, (w) => writeSun(w, payload.sun));
  pushSection(sections, SECTION.ENTITIES, (w) => writeEntities(w, payload.entities));
  pushSection(sections, SECTION.JOINTS, (w) => writeJoints(w, payload.joints));
  if (payload.liquidFun && (payload.liquidFun.count | 0) > 0) {
    pushSection(sections, SECTION.LIQUIDFUN, (w) => writeLiquidFun(w, payload.liquidFun));
  }
  if (payload.decals?.tiles?.length) {
    pushSection(sections, SECTION.DECALS, (w) => writeDecals(w, payload.decals));
  }
  if (payload.sharedResources?.length) {
    pushSection(sections, SECTION.SHARED_RESOURCES2, (w) => writeSharedResources(w, payload.sharedResources));
  }
  // Present (even empty) when the pool was bound: a load then clears geometry the
  // saved entities did not have. Absent means "unknown" and a load leaves it alone.
  if (Array.isArray(payload.chains)) {
    pushSection(sections, SECTION.CHAINS2, (w) => writeChains(w, payload.chains));
  }
  if (Array.isArray(payload.fixtures)) {
    pushSection(sections, SECTION.FIXTURES2, (w) => writeFixtures(w, payload.fixtures));
  }
  if (Array.isArray(payload.meshes)) {
    pushSection(sections, SECTION.MESHES2, (w) => writeMeshes(w, payload.meshes));
  }
  if (payload.nav?.walkability) {
    pushSection(sections, SECTION.NAV, (w) => writeNav(w, payload.nav));
  }
  if (payload.timeScale != null) {
    pushSection(sections, SECTION.TIME, (w) => writeTime(w, payload.timeScale));
  }
  if (payload.tweens?.length) {
    pushSection(sections, SECTION.TWEENS2, (w) => writeTweens(w, payload.tweens));
  }
  if (payload.custom !== undefined && payload.custom !== null) {
    pushSection(sections, SECTION.CUSTOM, (w) => writeCustom(w, payload.custom));
  }

  const out = new Writer();
  out.u16(sections.length);
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    out.u16(s.tag);
    out.u32(s.body.byteLength);
    out.raw(s.body);
  }
  return out.finish();
}

/**
 * A section written with a leading layout byte (tag) or its older form
 * without one (legacyTag). A layout newer than this build reads as absent.
 * @returns {*} read(reader, legacy), or null
 */
function readVersioned(map, tag, legacyTag, what, read) {
  if (map[tag]) {
    const r = new Reader(map[tag]);
    const layout = r.u8();
    if (layout !== SECTION_LAYOUT) {
      console.warn(`[SaveGame] ${what} section layout ${layout} is newer than this build; skipped`);
      return null;
    }
    return read(r, false);
  }
  return map[legacyTag] ? read(new Reader(map[legacyTag]), true) : null;
}

/**
 * Decode uncompressed binary body into logical save payload.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {object}
 */
export function decodeBinarySaveBody(bytes) {
  const r = new Reader(bytes);
  const sectionCount = r.u16();
  const map = Object.create(null);
  for (let i = 0; i < sectionCount; i++) {
    const tag = r.u16();
    const len = r.u32();
    map[tag] = r.raw(len);
  }
  if (!map[SECTION.META]) throw new Error('SaveGame: missing META section');

  const meta = readMeta(new Reader(map[SECTION.META]));
  return {
    sceneName: meta.sceneName,
    engineVersion: meta.engineVersion,
    layout: meta.layout,
    camera: map[SECTION.CAMERA] ? readCamera(new Reader(map[SECTION.CAMERA])) : null,
    sun: map[SECTION.SUN] ? readSun(new Reader(map[SECTION.SUN])) : null,
    entities: map[SECTION.ENTITIES] ? readEntities(new Reader(map[SECTION.ENTITIES])) : [],
    joints: map[SECTION.JOINTS] ? readJoints(new Reader(map[SECTION.JOINTS])) : [],
    liquidFun: map[SECTION.LIQUIDFUN]
      ? readLiquidFun(new Reader(map[SECTION.LIQUIDFUN]))
      : null,
    decals: map[SECTION.DECALS] ? readDecals(new Reader(map[SECTION.DECALS])) : null,
    sharedResources: readVersioned(
      map, SECTION.SHARED_RESOURCES2, SECTION.SHARED_RESOURCES, 'shared resource', readSharedResources,
    ),
    chains: readVersioned(map, SECTION.CHAINS2, SECTION.CHAINS, 'chain', readChains),
    fixtures: readVersioned(map, SECTION.FIXTURES2, SECTION.FIXTURES, 'fixture', readFixtures),
    meshes: readVersioned(map, SECTION.MESHES2, SECTION.MESHES, 'mesh', readMeshes),
    nav: map[SECTION.NAV] ? readNav(new Reader(map[SECTION.NAV])) : null,
    timeScale: map[SECTION.TIME] ? readTime(new Reader(map[SECTION.TIME])) : null,
    tweens: map[SECTION.TWEENS2]
      ? readTweens(new Reader(map[SECTION.TWEENS2]), false)
      : map[SECTION.TWEENS]
        ? readTweens(new Reader(map[SECTION.TWEENS]), true)
        : null,
    // Older saves have no CUSTOM section: null, not an error.
    custom: readVersioned(map, SECTION.CUSTOM, -1, 'custom', readCustom),
  };
}
