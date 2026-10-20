/**
 * Scene entity-id width. 16 = current Uint16 lists (max 65535).
 * 32 = compose FL4 + PAIR3 + NBR1 + GRID1 + LIST-U32 (product ceiling 300000).
 * Bind once at SAB create / worker init. Hot loops call packPair / popEntity,
 * never `width === 32`.
 *
 * Spatial pair stamp shares FL4's 19-bit id ceiling (300000 < 2^19).
 * Frame lives in the high 13 bits (8192 frames, then the marker buffer is cleared).
 */

import { bindEntityFreeList } from './atomicFreeList.js';

export const ENTITY_ID_WIDTH_16 = 16;
export const ENTITY_ID_WIDTH_32 = 32;
export const MAX_ENTITIES_U16 = 65535;
export const MAX_ENTITIES_U32 = 300000;
export const ENTITY_ID_NONE_U16 = 0xffff;
export const ENTITY_ID_NONE_U32 = 0xffffffff;
export const PAIR_U32_STRIDE = 4294967296;

/** Id bits in the spatial processed-pair stamp. Same ceiling as FL4. */
export const SPATIAL_STAMP_ID_BITS = 19;
export const SPATIAL_STAMP_ID_MASK = (1 << SPATIAL_STAMP_ID_BITS) - 1;
export const SPATIAL_STAMP_FRAME_MASK = 0x1fff;

let width = ENTITY_ID_WIDTH_16;
let bytes = 2;
let ArrayType = Uint16Array;
let maxEntities = MAX_ENTITIES_U16;

export let entityIdNone = ENTITY_ID_NONE_U16;

function pack16(minE, maxE) {
  return ((minE & 0xffff) << 16) | (maxE & 0xffff);
}

function unpack16(key, out) {
  out.a = (key >>> 16) & 0xffff;
  out.b = key & 0xffff;
  return out;
}

function packCantor(minE, maxE) {
  return ((minE + maxE) * (minE + maxE + 1)) / 2 + maxE;
}

function unpackCantor(key, out) {
  const w = Math.floor((Math.sqrt(8 * key + 1) - 1) / 2);
  out.b = key - (w * (w + 1)) / 2;
  out.a = w - out.b;
  return out;
}

/**
 * Bound in `bindEntityIdWidth`. No width branch -- the caller sees one signature.
 *
 * **The key is a plain JS number, and that is a measured property, not an assumption.**
 * (E-26.)
 *
 * At the default 16-bit width `pack16` is `((minE & 0xffff) << 16) | (maxE & 0xffff)`.
 * JS `<<` yields a **32-bit signed** result, so the key is always an int32, never a
 * double. Boxing depends on the engine: Node runs V8 without pointer compression, where
 * every int32 is a Smi, but Chrome compresses pointers and its Smis are 31-bit, so a
 * key at or above 2^30 (minE >= 16384) is a heap number once it enters a Map or Set
 * (`_pairSlot`, `frameCollisions`). E-10 below ran in Node and cannot see that; the
 * Chrome question is E-54. A stale comment in `logicWorker.js` claimed
 * otherwise -- "Float64Array, not Int32Array: this key overflows a 32-bit int well
 * before the entity cap" -- over a key that file does not store in a typed array at
 * all. It was floating, attached to nothing, and read as a hashing-cost claim, which
 * is what made E-10 a two-line hypothesis that was already dead.
 *
 * **E-10 swept 715 838 805 keys and found 0 boxed** in Node. So in Node at 16 bits the
 * concern is settled by measurement; in Chrome it holds only below minE 16384.
 *
 * Under `entityIdWidth: 32` the bound becomes `packCantor`, whose result genuinely
 * does exceed int32 and is a double - that is the only configuration where the old
 * comment's arithmetic had any purchase, and it is also E-27's subject.
 */
export let packPair = pack16;
/** Bound in bindEntityIdWidth. No width branch. */
export let unpackPair = unpack16;

export function packSpatialPairStamp(frame, entityA) {
  return ((frame & SPATIAL_STAMP_FRAME_MASK) << SPATIAL_STAMP_ID_BITS) |
    (entityA & SPATIAL_STAMP_ID_MASK);
}

/** Old 16-bit id stamp. Tests use this to show the alias. Not called in src/. */
export function packSpatialPairStamp16(frame, entityA) {
  return ((frame & 0xffff) << 16) | (entityA & 0xffff);
}

export function resolveEntityIdWidth(config) {
  const raw = config?.entityIdWidth;
  if (raw === 32 || raw === '32' || raw === ENTITY_ID_WIDTH_32) return ENTITY_ID_WIDTH_32;
  return ENTITY_ID_WIDTH_16;
}

export function bindEntityIdWidth(nextWidth) {
  const w = nextWidth === ENTITY_ID_WIDTH_32 ? ENTITY_ID_WIDTH_32 : ENTITY_ID_WIDTH_16;
  width = w;
  if (w === ENTITY_ID_WIDTH_32) {
    bytes = 4;
    ArrayType = Uint32Array;
    entityIdNone = ENTITY_ID_NONE_U32;
    maxEntities = MAX_ENTITIES_U32;
    packPair = packCantor;
    unpackPair = unpackCantor;
  } else {
    bytes = 2;
    ArrayType = Uint16Array;
    entityIdNone = ENTITY_ID_NONE_U16;
    maxEntities = MAX_ENTITIES_U16;
    packPair = pack16;
    unpackPair = unpack16;
  }
  bindEntityFreeList(w === ENTITY_ID_WIDTH_32);
  return w;
}

export function entityIdWidth() {
  return width;
}

export function entityIdBytes() {
  return bytes;
}

export function EntityIdArray() {
  return ArrayType;
}

export function maxEntitiesForWidth(w = width) {
  return w === ENTITY_ID_WIDTH_32 ? MAX_ENTITIES_U32 : MAX_ENTITIES_U16;
}

export function createEntityIdList(length) {
  return new ArrayType(length);
}

export function viewEntityIdList(sab, byteOffset = 0, length) {
  if (length == null) return new ArrayType(sab, byteOffset);
  return new ArrayType(sab, byteOffset, length);
}

export function collisionPairKeyWide(minE, maxE) {
  // Stable function, not a rebound let: a predictable branch inlines; an
  // indirect packPair call did not (kernel pair_bound slower than pair_if).
  if (width === ENTITY_ID_WIDTH_32) return packCantor(minE, maxE);
  return pack16(minE, maxE);
}

export function collisionPairUnpackWide(key, out) {
  if (width === ENTITY_ID_WIDTH_32) return unpackCantor(key, out);
  return unpack16(key, out);
}
