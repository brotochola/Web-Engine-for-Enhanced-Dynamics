/**
 * DX-GBUF (plan §5.4, §6.4): what the G-buffer pass needs to know about each sprite instance, beyond its pixels. Two
 * floats an instance, each an exact integer under 2^24 (a float32 holds every one), in the batch's draw order:
 *
 * x, the sprite's word:
 * - bits 0-15: its entity's id in the G-buffer, (entity % 65535) + 1; 0 for a row that is no entity (a decoration, a
 *   particle) or a frame whose rows were not matched to their entities: such a row is lit as it always was;
 * - bits 16-21: SpriteRenderer.gbufFlags (normals, surface, emissive: GBUF_FLAGS);
 * - bits 22-23: ShadowCaster.selfShadow (0 the asset's way, 1 on, 2 off).
 *
 * y, the row's place: its zIndex band (DX-DEPTH, plan §6.5: the rank of its zIndex among the frame's, in draw order,
 * which the painter sorts zIndex first), bits 0-7.
 *
 * Pre-render writes them for the rows it packs (the GPU queue's gbuf region, GPU_FLAG_GBUF); Pixi for the rows it packs,
 * from the queue's key column (the entity of a sprite row).
 */

/** SpriteRenderer.gbufFlags: normals in bits 0-1, the surface in bit 2, the emissive level in bits 3-5. */
export const GBUF_FLAGS = Object.freeze({
  NORMALS_MASK: 3,
  FLOOR: 4,
  EMISSIVE_SHIFT: 3,
  EMISSIVE_MASK: 7 << 3,
});

/** SpriteRenderer.normals: where a sprite's normals come from (plan §5.4). */
export const SPRITE_NORMALS = Object.freeze({ AUTO: 0, MAP: 1, HEIGHT: 2, FLAT: 3 });
export const SPRITE_NORMALS_NAMES = Object.freeze(['auto', 'map', 'height', 'flat']);

/** The emissive level that `emissive = true` writes: a quarter of the glow a step, 4 is the sprite's own colour. */
export const EMISSIVE_LEVEL_ON = 4;
export const EMISSIVE_LEVEL_MAX = 7;

/** Word bits (the shaders decode them the same way). */
export const GBUF_ID_MASK = 0xffff;
export const GBUF_FLAGS_SHIFT = 16;
export const GBUF_SELF_SHIFT = 22;
/** The most zIndex bands the depth holds (plan §6.5's bands, 3 bits of it). */
export const GBUF_MAX_BANDS = 8;

/**
 * Whether a scene's Pixi worker runs the G-buffer pass, so its sprite instances carry words: lit (not raycasted), with
 * faces, a sheet with maps, or a shadow map (the maps keep their highest caster's entity, which a sprite's pixels compare
 * with their own: a caster's own shadow never paints its own sprite). Pre-render and Pixi decide it the same way.
 * @param {object} config the scene's config
 * @param {boolean} atlasMaps the atlas has a twin page (its json's meta.maps)
 */
export function gbufWanted(config, atlasMaps) {
  const lighting = config?.lighting;
  if (!lighting || !lighting.enabled || lighting.raycasted) return false;
  return lighting.faces?.enabled === true || atlasMaps === true || lighting.sunShadows === 'map' || lighting.lampShadows === 'map'
    || lighting.emissive === true;
}

/** An entity's id in the G-buffer: 1 to 65535, never 0 (0 is "no entity"). */
export function gbufEntityId(entity) {
  return (entity % 65535) + 1;
}

/** The emissive level a value of `SpriteRenderer.emissive` stores: false/0 off, true the sprite's colour, a number its glow. */
export function emissiveLevel(value) {
  if (value === true) return EMISSIVE_LEVEL_ON;
  const v = +value;
  if (!(v > 0)) return 0;
  const level = Math.round(v * EMISSIVE_LEVEL_ON);
  return level < 1 ? 1 : level > EMISSIVE_LEVEL_MAX ? EMISSIVE_LEVEL_MAX : level;
}

/** What `SpriteRenderer.emissive` reads back for a level. */
export function emissiveValue(level) {
  if (level === 0) return false;
  if (level === EMISSIVE_LEVEL_ON) return true;
  return level / EMISSIVE_LEVEL_ON;
}

/**
 * One instance's word (x): its entity, its sprite's G-buffer flags and its caster's selfShadow.
 * @param {number} entity -1 for none
 * @param {number} flags SpriteRenderer.gbufFlags (6 bits)
 * @param {number} selfShadow ShadowCaster.selfShadow (0..2)
 */
export function gbufWord(entity, flags, selfShadow) {
  if (entity < 0) return 0;
  return gbufEntityId(entity) + (flags & 63) * 65536 + (selfShadow & 3) * 4194304;
}

/** The word's parts, for tests: { id, normals, floor, emissive, selfShadow }. */
export function decodeGbufWord(word) {
  const w = word >>> 0;
  return {
    id: w & GBUF_ID_MASK,
    normals: (w >>> GBUF_FLAGS_SHIFT) & 3,
    floor: ((w >>> GBUF_FLAGS_SHIFT) & GBUF_FLAGS.FLOOR) !== 0,
    emissive: (w >>> (GBUF_FLAGS_SHIFT + GBUF_FLAGS.EMISSIVE_SHIFT)) & 7,
    selfShadow: (w >>> GBUF_SELF_SHIFT) & 3,
  };
}

/**
 * The words of `n` instances in draw order (out[2k], out[2k + 1]): instance k is queue row `order[k]` (or k with no
 * order), whose entity `entityOf(row)` gives (-1 for none). The band (y) counts the zIndex changes along the draw order
 * when `zIndex` is given and the order is the painter's (zIndex first): 0 otherwise.
 * A module function over the columns it is handed: the loop is hot in a scene with a G-buffer (one pass a frame over the
 * drawn instances).
 * @param {Float32Array} out
 * @param {number} n
 * @param {Uint32Array|Int32Array|null} order
 * @param {Uint8Array} rowType the collector's types (0: a sprite entity), or null with `rowKey`
 * @param {Int32Array} rowEntity the collector's entity indices, or null with `rowKey`
 * @param {Uint32Array|null} rowKey the queue's key column (E-177: entity | flag bits), instead of the collector's
 * @param {number} entities the entity count (a key at or past it is a decoration's or a particle's)
 * @param {Uint8Array} flags SpriteRenderer.gbufFlags
 * @param {Uint8Array|null} selfShadow ShadowCaster.selfShadow
 * @param {Int16Array|null} zIndex SpriteRenderer.zIndex, when the order is the painter's
 */
export function writeGbufWords(out, n, order, rowType, rowEntity, rowKey, entities, flags, selfShadow, zIndex) {
  let band = 0;
  let lastZ = -32769;
  const selfN = selfShadow !== null ? selfShadow.length : 0;
  for (let k = 0; k < n; k++) {
    const row = order !== null ? order[k] : k;
    let e = -1;
    if (rowKey !== null) {
      const key = rowKey[row];
      if (key !== 0xffffffff) {
        const ke = key & 0x3fffffff;
        if (ke < entities) e = ke;
      }
    } else if (rowType[row] === 0) {
      e = rowEntity[row];
    }
    let word = 0;
    let z = 0;
    if (e >= 0) {
      word = (e % 65535) + 1 + (flags[e] & 63) * 65536 + (e < selfN ? (selfShadow[e] & 3) * 4194304 : 0);
      if (zIndex !== null) z = zIndex[e];
    }
    if (zIndex !== null && z !== lastZ) {
      if (lastZ !== -32769 && band < GBUF_MAX_BANDS - 1) band++;
      lastZ = z;
    }
    out[2 * k] = word;
    out[2 * k + 1] = band;
  }
}
