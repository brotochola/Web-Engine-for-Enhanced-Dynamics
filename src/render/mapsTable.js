/**
 * E-496: the maps table, a texture of its own beside the texture table (instancedSpriteBatch.js textureLutLayout): one
 * RGBA32F texel a textureId, read by the passes that read the twin page (the G-buffer's, pixel depth, the sun's and the
 * lamps' columns, the glow):
 * - x, y: the offset from the frame's rectangle in the atlas to its window in the twin page, in texels (a frame's twin texel
 *   is its atlas texel plus this: twinTexel.js twinCoord);
 * - z: the frame's marks, MAPS_* below (0: no maps at all);
 * - w: 0.
 * Every frame has its own window, also where several share a rectangle of the twin (the sheets that name the same map
 * files: their trims differ). The texture table's `width / 3` stays as every other reader has it.
 *
 * The atlas's json gives each frame with maps its window (`frames[name].maps`: { x, y, heights?, relief? }, the twin
 * page's texel of the frame's top left), and each frame of an unshaded sheet `frames[name].unshaded`. A baked atlas from before E-496 gives none: its twin page has the atlas's size
 * and rectangles, so every frame reads at its atlas texel (offset 0), as it always did.
 */

/** The frame has a window in the twin page (its texels say where it has a map: twinTexel.js twinPresent). */
export const MAPS_TWIN = 1;
/** Its sheet has a height map: the twin's heights are the pixels' heights above the floor. */
export const MAPS_HEIGHTS = 2;
/**
 * DX-RELIEF: its sheet has a relief map and no height map: the twin's heights are how far the shape bulges (its normals
 * come from them), and its height above the floor is its surface's (a card standing on its foot, or the floor).
 */
export const MAPS_RELIEF = 4;
/** DX-UNSHADED: its sheet is unshaded (no light touches its pixels): a mark without a window. */
export const MAPS_UNSHADED = 8;

/** Texels of zeros around each rectangle of the twin page: 1 for the Sobel's taps, 2 and even for E-497's half resolution. */
export const TWIN_PAD = 2;

/** The table's most rows: the texture table's (N-111), so it uploads on every GPU. */
export const MAPS_TABLE_MAX_ROWS = 2048;

/**
 * The table's texture for `count` textureIds: `width` texels a row (1 until count passes `maxRows`), `height` rows;
 * textureId t at (t % width, t / width).
 * @param {number} count
 * @param {number} [maxRows]
 * @returns {{ width: number, height: number }}
 */
export function mapsTableLayout(count, maxRows = MAPS_TABLE_MAX_ROWS) {
  const n = Math.max(1, count | 0);
  const width = Math.ceil(n / maxRows);
  return { width, height: Math.ceil(n / width) };
}

/**
 * A frame's marks and offset from what the atlas's json said of it (a texture's `weedMaps`, its `frame` rectangle).
 * @param {{ x: number, y: number, heights?: boolean } | null | undefined} maps the frame's window, or nothing
 * @param {{ x: number, y: number } | null | undefined} frame its rectangle in the atlas
 * @param {Float32Array} out
 * @param {number} at the texel's first float
 * @param {boolean} [atlasLayout] a twin page with the atlas's layout (a bake from before E-496): every frame at offset 0
 * @param {boolean} [unshaded] DX-UNSHADED: the frame's sheet is unshaded
 */
export function writeMapsTexel(maps, frame, out, at, atlasLayout = false, unshaded = false) {
  out[at] = 0;
  out[at + 1] = 0;
  out[at + 2] = unshaded ? MAPS_UNSHADED : 0;
  out[at + 3] = 0;
  if (maps && frame && Number.isFinite(maps.x) && Number.isFinite(maps.y)) {
    out[at] = maps.x - frame.x;
    out[at + 1] = maps.y - frame.y;
    out[at + 2] += MAPS_TWIN | (maps.heights === true ? MAPS_HEIGHTS : 0) | (maps.relief === true ? MAPS_RELIEF : 0);
  } else if (atlasLayout) {
    out[at + 2] += MAPS_TWIN | MAPS_HEIGHTS;
  }
}

/**
 * The table's texels for `textures` (flatTextures: a Pixi texture a textureId, with `weedMaps` and `weedUnshaded` from the
 * atlas's json and its `frame`), at the layout mapsTableLayout gives; the slots past them stay 0.
 * @param {Array<{ weedMaps?: object, weedUnshaded?: boolean, frame?: { x: number, y: number } } | null>} textures
 * @param {boolean} [atlasLayout] the twin page has the atlas's layout (writeMapsTexel)
 * @returns {{ data: Float32Array, width: number, height: number, mapped: number, heights: number }} mapped: the textureIds
 *   with a window; heights: those marked MAPS_HEIGHTS (E-500: with none, no instance's frame has heights)
 */
export function packMapsTable(textures, atlasLayout = false) {
  const n = textures ? textures.length : 0;
  const { width, height } = mapsTableLayout(n);
  const data = new Float32Array(width * height * 4);
  let mapped = 0;
  let heights = 0;
  for (let i = 0; i < n; i++) {
    const t = textures[i];
    if (!t) continue;
    writeMapsTexel(t.weedMaps, t.frame, data, i * 4, atlasLayout, t.weedUnshaded === true);
    const marks = data[i * 4 + 2];
    if ((marks & MAPS_TWIN) !== 0) mapped++;
    if ((marks & MAPS_HEIGHTS) !== 0) heights++;
  }
  return { data, width, height, mapped, heights };
}

/** A size rounded up to an even number of texels (E-497's half resolution). */
export function evenTexels(n) {
  return (n + 1) & ~1;
}
