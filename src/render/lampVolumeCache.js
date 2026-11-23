/**
 * E-508: the volumes in the lamps' map, cached. The volumes' draw (volumeShadowMap.js volumeLampVertex) runs every vertex of
 * every volume once a tile in use: in Buenos Aires at night (the houses' volumes, 6 lamps casting) 6.9 of the 16.6 ms of an
 * Intel HD 620's frame, 87 % of it the vertices (R-1296, R-1297). Houses and street lamps stand still, so a still lamp's
 * volumes are drawn once into a cache, an atlas of half tiles (the floor's half: the volumes draw nowhere else), with each
 * texel's depth beside it (its float's bits in a second colour target), and each frame copied into the lamp's tile after
 * the cards and the columns, writing that depth (volumeShadowMap.js lampCacheCopy*): what drawing the volumes there would
 * have kept, in the same order. A lamp that moves (a car's headlights), or one not yet still for LAMP_CACHE_HOLD_FRAMES
 * frames, draws its volumes as before.
 *
 * The volumes' draws and the copy read their tiles from lists in the tiles' texture's row LAMP_TILE_LIST_ROW, an entry an
 * instance: (the tile whose lamp it lands towards, the half tile it draws into: its column and row in tiles, 0). The direct
 * draw's list comes first, then the cached lamps' (the cache's paint and the copy read the same entries).
 */

/** Rows of the tiles' texture: the lamps (writeLampTile), their owners (writeLampTileOwner), the draws' lists. */
export const LAMP_TILE_ROWS = 3;
/** The tiles' texture's row of the draws' lists. */
export const LAMP_TILE_LIST_ROW = 2;
/** Frames a lamp's tile (its floor point, height and reach) stays the same, and the volumes too, before it is cached. */
export const LAMP_CACHE_HOLD_FRAMES = 2;
/**
 * Frames at least from one paint of the cache to the next: a paint draws every cached lamp's volumes again (the cache is
 * cleared whole), so lamps that come to rest often (cars stopping at a light) wait, drawn directly, rather than paint it
 * every few frames.
 */
export const LAMP_CACHE_REPAINT_GAP = 30;
/**
 * The volumes' indices a lamp's tile draws (every volume once a lamp) for each texel of the floor half its copy writes,
 * at least, for the cache to pay: a copy writes every texel of the half, the draw runs every vertex. On a GTX 1650, the
 * barrio's houses (274 000 indices a lamp, halves of 512²: 1.05 an index a texel) drew in 0.083 ms a lamp and copied in
 * 0.033; lampShadowStressScene's blocks (?volumes=300: 9 000 indices, halves of 256², 0.14) drew in 0.017 and copied in
 * 0.024.
 */
export const LAMP_CACHE_MIN_INDICES_PER_TEXEL = 0.5;

/**
 * Whether the cache pays for volumes of `indices` indices (all their layers') under lamps whose floor halves are `size`
 * texels a side (LAMP_CACHE_MIN_INDICES_PER_TEXEL).
 */
export function lampCachePays(indices, size) {
  return indices >= LAMP_CACHE_MIN_INDICES_PER_TEXEL * size * size;
}

/**
 * Entry `at` of the draws' lists (the tiles' texture's row LAMP_TILE_LIST_ROW, `width` texels a row).
 * @param {Float32Array} data the tiles' texture's data
 * @param {number} width the texture's width (texels a row)
 * @param {number} at the entry
 * @param {number} tile the tile whose lamp the instance lands towards
 * @param {number} column the half tile it draws into: its column in the target, in tiles
 * @param {number} row its row
 */
export function writeLampListEntry(data, width, at, tile, column, row, side) {
  const i = (LAMP_TILE_LIST_ROW * width + at) * 4;
  data[i] = tile;
  data[i + 1] = column;
  data[i + 2] = row;
  // E-551: the half's side, texels: column and row count in it.
  data[i + 3] = side;
}

/**
 * The direct draw's list for every tile of `n`, each into its own floor half (column (t % perRow) * 2, row t / perRow):
 * the volumes' draw as before the cache, which a frame without it keeps.
 */
export function writeDirectLampList(data, width, n, rects) {
  for (let t = 0; t < n; t++) {
    const side = rects[t * 3 + 2];
    writeLampListEntry(data, width, t, t, rects[t * 3] / side, rects[t * 3 + 1] / side, side);
  }
}

/**
 * The cache's atlas: `slots` half tiles of `size` texels a side, as many a row as fit `maxSide`.
 * @returns {{ perRow: number, width: number, height: number }}
 */
export function lampCacheLayout(slots, size, maxSide = 4096) {
  const n = Math.max(1, slots | 0);
  const s = Math.max(1, size | 0);
  const perRow = Math.max(1, Math.min(n, Math.floor(maxSide / s)));
  return { perRow, width: perRow * s, height: Math.ceil(n / perRow) * s };
}

/** What the cache holds and what it saw last frame (planLampVolumeCache), typed arrays grown on use. */
export function createLampVolumeCache() {
  return {
    /** The cache's half tiles. */
    slots: 0,
    /** The volumes' epoch the slots were painted in (the caller's: it moves when a volume, the tile's size or the cache moves). */
    epoch: -1,
    /** Frames the epoch has held, and since the last paint. */
    sinceEpoch: 0,
    sincePaint: LAMP_CACHE_REPAINT_GAP,
    /** Each slot's lamp (an entity; -1 none) and its tile's key (floor point, height, reach) when painted. */
    slotId: new Int32Array(0),
    slotKey: new Float32Array(0),
    /** Last frame's tiles: their lamps, keys and the frames each key had held. */
    lastN: 0,
    lastIds: new Int32Array(0),
    lastKey: new Float32Array(0),
    lastHeld: new Uint16Array(0),
    /** This frame's, by tile: frames its key has held, and its slot (-1: drawn directly). */
    held: new Uint16Array(0),
    slotOf: new Int16Array(0),
    /** This frame's plan: the direct list's entries, the cached ones after them, and whether the cache is painted. */
    direct: 0,
    cached: 0,
    paint: false,
  };
}

function sameKey(a, ai, b, bi) {
  return a[ai] === b[bi] && a[ai + 1] === b[bi + 1] && a[ai + 2] === b[bi + 2] && a[ai + 3] === b[bi + 3];
}

/**
 * This frame's plan, and its lists into `data`'s row LAMP_TILE_LIST_ROW: each tile that casts is drawn directly (first in
 * the list) or copied from its cache slot (after them). A tile is cached when its lamp has a slot painted with the key it
 * has now; when lamps held still for LAMP_CACHE_HOLD_FRAMES have none, the cache is painted again with every lamp it can
 * hold (the cached ones and those), once the volumes have held too and LAMP_CACHE_REPAINT_GAP frames have gone since the
 * last paint. `c.direct`, `c.cached` and `c.paint` say what to draw.
 * @param {ReturnType<typeof createLampVolumeCache>} c
 * @param {Uint32Array} ids the tiles' lamps (entities)
 * @param {Float32Array} data the tiles' texture's data (row 0: the tiles' keys; written: the lists' row)
 * @param {number} width the texture's width (texels a row)
 * @param {number} n the tiles in use
 * @param {Float32Array} rects the tiles' rects in the lamps' map (E-551: x0, y0 and a half's side a tile, texels)
 * @param {number} slots the cache's half tiles (0: no cache, every casting tile drawn directly)
 * @param {number} slotsPerRow the cache's half tiles a row
 * @param {number} slotSide a cache slot's side, texels (a tile's half is drawn at its own side in its slot's corner)
 * @param {number} epoch the volumes' epoch
 */
export function planLampVolumeCache(c, ids, data, width, n, rects, slots, slotsPerRow, slotSide, epoch) {
  const HOLD = LAMP_CACHE_HOLD_FRAMES;
  if (c.slots !== slots) {
    c.slots = slots;
    c.slotId = new Int32Array(slots).fill(-1);
    c.slotKey = new Float32Array(slots * 4);
  }
  if (c.epoch !== epoch) {
    c.epoch = epoch;
    c.sinceEpoch = 0;
    c.slotId.fill(-1);
  } else if (c.sinceEpoch < 65535) {
    c.sinceEpoch++;
  }
  if (c.sincePaint < 65535) c.sincePaint++;
  if (c.held.length < n) {
    c.held = new Uint16Array(n);
    c.slotOf = new Int16Array(n);
  }
  const held = c.held;
  const slotOf = c.slotOf;
  const slotId = c.slotId;
  const slotKey = c.slotKey;
  const lastIds = c.lastIds;
  const lastKey = c.lastKey;
  const lastHeld = c.lastHeld;
  const lastN = c.lastN;
  let want = 0;
  for (let t = 0; t < n; t++) {
    const id = ids[t];
    const at = t * 4;
    let h = 0;
    for (let j = 0; j < lastN; j++) {
      if (lastIds[j] !== id) continue;
      if (sameKey(lastKey, j * 4, data, at)) h = lastHeld[j] < 65535 ? lastHeld[j] + 1 : 65535;
      break;
    }
    held[t] = h;
    let slot = -1;
    for (let s = 0; s < slots; s++) {
      if (slotId[s] === id && sameKey(slotKey, s * 4, data, at)) {
        slot = s;
        break;
      }
    }
    slotOf[t] = slot;
    // A tile that casts nothing has 0 height and reach (writeLampTile): no volumes, no list entry.
    if (slot < 0 && h >= HOLD && data[at + 2] > 0 && data[at + 3] > 0) want++;
  }
  let paint = want > 0 && slots > 0 && c.sinceEpoch >= HOLD && c.sincePaint >= LAMP_CACHE_REPAINT_GAP;
  if (paint) {
    slotId.fill(-1);
    let s = 0;
    for (let t = 0; t < n; t++) {
      const at = t * 4;
      const casts = data[at + 2] > 0 && data[at + 3] > 0;
      if (casts && s < slots && (slotOf[t] >= 0 || held[t] >= HOLD)) {
        slotId[s] = ids[t];
        slotKey[s * 4] = data[at];
        slotKey[s * 4 + 1] = data[at + 1];
        slotKey[s * 4 + 2] = data[at + 2];
        slotKey[s * 4 + 3] = data[at + 3];
        slotOf[t] = s++;
      } else {
        slotOf[t] = -1;
      }
    }
    paint = s > 0;
    c.sincePaint = 0;
  }
  const slotsPer = Math.max(1, slotsPerRow | 0);
  let at = 0;
  for (let t = 0; t < n; t++) {
    if (slotOf[t] >= 0 || !(data[t * 4 + 2] > 0 && data[t * 4 + 3] > 0)) continue;
    const side = rects[t * 3 + 2];
    writeLampListEntry(data, width, at++, t, rects[t * 3] / side, rects[t * 3 + 1] / side, side);
  }
  const direct = at;
  for (let t = 0; t < n; t++) {
    const s = slotOf[t];
    if (s < 0) continue;
    // E-551: the tile's half drawn at its own side in its slot's corner (a slot is slotSide texels a side).
    const side = rects[t * 3 + 2];
    writeLampListEntry(data, width, at++, t, ((s % slotsPer) * slotSide) / side, (((s / slotsPer) | 0) * slotSide) / side, side);
  }
  c.direct = direct;
  c.cached = at - direct;
  c.paint = paint;
  if (c.lastIds.length < n) {
    c.lastIds = new Int32Array(n);
    c.lastKey = new Float32Array(n * 4);
    c.lastHeld = new Uint16Array(n);
  }
  for (let t = 0; t < n; t++) {
    c.lastIds[t] = ids[t];
    c.lastKey[t * 4] = data[t * 4];
    c.lastKey[t * 4 + 1] = data[t * 4 + 1];
    c.lastKey[t * 4 + 2] = data[t * 4 + 2];
    c.lastKey[t * 4 + 3] = data[t * 4 + 3];
    c.lastHeld[t] = held[t];
  }
  c.lastN = n;
  return c;
}
