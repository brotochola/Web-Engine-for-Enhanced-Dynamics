/**
 * DX-GBUF (plan §5.4, §6.4): what the G-buffer pass needs to know about each sprite instance, beyond its pixels. Two
 * floats an instance, each an exact integer under 2^24 (a float32 holds every one), in the batch's draw order:
 *
 * x, the sprite's word:
 * - bits 0-15: its entity's id in the G-buffer, (entity % 65535) + 1; 0 for a row that is no entity (a decoration, a
 *   particle) or a frame whose rows were not matched to their entities: such a row is lit as it always was. N-273: a
 *   decoration with an owner (DecorationComponent.owner: a house's walls) carries its owner's id, its other bits 0, so
 *   the owner's own shadow volume leaves its pixels lit, as an entity's own sprite;
 * - bits 16-21: SpriteRenderer.gbufFlags (normals, surface, unshaded: GBUF_FLAGS);
 * - bits 22-23: ShadowCaster.selfShadow (0 the asset's way, 1 on, 2 off).
 *
 * y, the row's place: its zIndex band (DX-DEPTH, plan §6.5: the rank of its zIndex among the frame's, in draw order,
 * which the painter sorts zIndex first), bits 0-7.
 *
 * Pre-render writes them for the rows it packs (the GPU queue's gbuf region, GPU_FLAG_GBUF); Pixi for the rows it packs,
 * from the queue's key column (the entity of a sprite row). E-387: on Pixi's keyed frames the keyed pack writes them
 * (wasm/gpuPack.c pack_keyed, the same words as writeGbufWords from the key column); E-444: pre-render's split and
 * indexed packs too (pack_split, pack_split_scatter and pack_indexed_scatter's _gbuf exports, the same words from the
 * collector's columns). A change to the words is made in all of them: gpuPackKeyedGbuf.test.js and
 * gpuPackSplitGbuf.test.js hold them equal.
 */

/**
 * SpriteRenderer.gbufFlags: normals in bits 0-1, the surface in bit 2, unshaded in bit 5 (DX-UNSHADED; bits 3-4 free). Bit 5
 * was the top bit of DX-EMISSIVE's level, so a save from before reads a sprite's `emissive = true` (level 4) as unshaded.
 */
export const GBUF_FLAGS = Object.freeze({
  NORMALS_MASK: 3,
  FLOOR: 4,
  UNSHADED: 32,
});

/** SpriteRenderer.normals: where a sprite's normals come from (plan §5.4). */
export const SPRITE_NORMALS = Object.freeze({ AUTO: 0, MAP: 1, HEIGHT: 2, FLAT: 3 });
export const SPRITE_NORMALS_NAMES = Object.freeze(['auto', 'map', 'height', 'flat']);

/** Word bits (the shaders decode them the same way). */
export const GBUF_ID_MASK = 0xffff;
export const GBUF_FLAGS_SHIFT = 16;
export const GBUF_SELF_SHIFT = 22;
/** DX-UNSHADED: the word's unshaded bit (GBUF_FLAGS.UNSHADED's): the shaders read `(word >> 21u) & 1u`. */
export const GBUF_UNSHADED_BIT = 21;
/** The most zIndex bands the depth holds (plan §6.5's bands, 3 bits of it). */
export const GBUF_MAX_BANDS = 8;

/**
 * Whether a scene's sprite instances carry G-buffer words: lit (not raycasted), with a sheet with maps or an unshaded sheet, a shadow map (the maps keep their highest caster's entity, which a
 * sprite's pixels compare with their own: a caster's own shadow never paints its own sprite), or lighting.unshaded (a
 * sprite's own spriteRenderer.unshaded). Pre-render and Pixi decide it the same way.
 * @param {object} config the scene's config
 * @param {boolean|{ maps?: boolean, unshaded?: boolean }} atlas the atlas's json meta (meta.maps: it has a twin page;
 *   meta.unshaded: an unshaded sheet), or whether it has a twin page
 */
export function gbufWanted(config, atlas) {
  const lighting = config?.lighting;
  if (!lighting || !lighting.enabled || lighting.raycasted) return false;
  const atlasMaps = atlas === true || (atlas !== null && typeof atlas === 'object' && (atlas.maps === true || atlas.unshaded === true));
  // DX-BARRIOS: faces need no words (a decoration is no entity); they turn the G-buffer pass on by themselves.
  return atlasMaps || lighting.sunShadows === 'map' || lighting.lampShadows === 'map' || lighting.unshaded === true;
}

/** An entity's id in the G-buffer: 1 to 65535, never 0 (0 is "no entity"). */
export function gbufEntityId(entity) {
  return (entity % 65535) + 1;
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

/** The word's parts, for tests: { id, normals, floor, unshaded, selfShadow }. */
export function decodeGbufWord(word) {
  const w = word >>> 0;
  return {
    id: w & GBUF_ID_MASK,
    normals: (w >>> GBUF_FLAGS_SHIFT) & 3,
    floor: ((w >>> GBUF_FLAGS_SHIFT) & GBUF_FLAGS.FLOOR) !== 0,
    unshaded: ((w >>> GBUF_UNSHADED_BIT) & 1) !== 0,
    selfShadow: (w >>> GBUF_SELF_SHIFT) & 3,
  };
}

/**
 * The words of `n` instances in draw order (out[2k], out[2k + 1]): instance k is queue row `order[k]` (or k with no
 * order), whose entity `entityOf(row)` gives (-1 for none). The band (y) counts the zIndex changes along the draw order
 * when `zIndex` is given and the order is the painter's (zIndex first): 0 otherwise. A row whose entity, from the key
 * or the collector, is at or past `entities` is none (E-444: the kernels read no column past it).
 * A module function over the columns it is handed: the loop is hot in a scene with a G-buffer (one pass a frame over the
 * drawn instances). E-387: Pixi's keyed frames take the keyed pack's twin of it (gpuPack.c pack_keyed); E-444:
 * pre-render's split and indexed frames, the split and indexed packs' (their _gbuf exports); this one writes the rest.
 * @param {Float32Array} out
 * @param {number} n
 * @param {Uint32Array|Int32Array|null} order
 * @param {Uint8Array} rowType the collector's types (0: a sprite entity), or null with `rowKey`
 * @param {Int32Array} rowEntity the collector's entity indices (one at or past `entities` is none), or null with `rowKey`
 * @param {Uint32Array|null} rowKey the queue's key column (E-177: entity | flag bits), instead of the collector's
 * @param {number} entities the entity count (a key at or past it is a decoration's or a particle's)
 * @param {Uint8Array} flags SpriteRenderer.gbufFlags
 * @param {Uint8Array|null} selfShadow ShadowCaster.selfShadow
 * @param {Int16Array|null} zIndex SpriteRenderer.zIndex, when the order is the painter's
 * @param {Uint32Array|null} [decorationOwner] N-273: DecorationComponent.owner, for the collector's decoration rows (type 2)
 */
export function writeGbufWords(out, n, order, rowType, rowEntity, rowKey, entities, flags, selfShadow, zIndex,
  decorationOwner = null) {
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
      const re = rowEntity[row];
      if (re < entities) e = re;
    }
    let word = 0;
    let z = 0;
    if (e >= 0) {
      word = (e % 65535) + 1 + (flags[e] & 63) * 65536 + (e < selfN ? (selfShadow[e] & 3) * 4194304 : 0);
      if (zIndex !== null) z = zIndex[e];
    } else if (rowKey === null && decorationOwner !== null && rowType[row] === 2) {
      const d = rowEntity[row];
      const owner = d >= 0 && d < decorationOwner.length ? decorationOwner[d] : 0;
      if (owner !== 0 && owner <= entities) word = (owner - 1) % 65535 + 1;
    }
    if (zIndex !== null && z !== lastZ) {
      if (lastZ !== -32769 && band < GBUF_MAX_BANDS - 1) band++;
      lastZ = z;
    }
    out[2 * k] = word;
    out[2 * k + 1] = band;
  }
}
