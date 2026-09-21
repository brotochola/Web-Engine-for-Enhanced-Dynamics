/**
 * Scene entity-id width. 16 = current Uint16 lists (max 65535).
 * 32 = compose FL1 + PAIR3 + NBR1 + GRID1 + LIST-U32 (product ceiling 300000).
 * Bind once at SAB create / worker init. Do not branch === 32 in hot loops.
 */

export const ENTITY_ID_WIDTH_16 = 16;
export const ENTITY_ID_WIDTH_32 = 32;
export const MAX_ENTITIES_U16 = 65535;
export const MAX_ENTITIES_U32 = 300000;
export const ENTITY_ID_NONE_U16 = 0xffff;
export const ENTITY_ID_NONE_U32 = 0xffffffff;
export const PAIR_U32_STRIDE = 4294967296;

let width = ENTITY_ID_WIDTH_16;
let bytes = 2;
let ArrayType = Uint16Array;
let none = ENTITY_ID_NONE_U16;
let maxEntities = MAX_ENTITIES_U16;

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
    none = ENTITY_ID_NONE_U32;
    maxEntities = MAX_ENTITIES_U32;
  } else {
    bytes = 2;
    ArrayType = Uint16Array;
    none = ENTITY_ID_NONE_U16;
    maxEntities = MAX_ENTITIES_U16;
  }
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

export function entityIdNone() {
  return none;
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
  if (width === ENTITY_ID_WIDTH_32) {
    // PAIR3 Cantor: cheapest correct Set.has at 300k (kernel). Fits in 2^53 at 300k.
    return ((minE + maxE) * (minE + maxE + 1)) / 2 + maxE;
  }
  return ((minE & 0xffff) << 16) | (maxE & 0xffff);
}

export function collisionPairUnpackWide(key, out) {
  if (width === ENTITY_ID_WIDTH_32) {
    const w = Math.floor((Math.sqrt(8 * key + 1) - 1) / 2);
    out.b = key - (w * (w + 1)) / 2;
    out.a = w - out.b;
    return out;
  }
  out.a = (key >>> 16) & 0xffff;
  out.b = key & 0xffff;
  return out;
}
