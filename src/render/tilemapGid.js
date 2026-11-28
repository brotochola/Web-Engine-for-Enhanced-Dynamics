/**
 * CPU contract for native GPU tilemaps.
 * Pages the Tiled GID SAB into RGBA8 (same 4 bytes, little-endian) and
 * decodes flip flags the same way the GLSL/WGSL fragment shaders do.
 */

/**
 * One Mesh + GID texture per page.
 * Stay at WebGL2's portable max (2048). Do not raise to the GPU's MAX_TEXTURE_SIZE:
 * a map like carScene (2082 wide) would become one NPOT 2082 texture (driver hitch)
 * and WebGPU row bytes 2082*4 are not a multiple of 256.
 */
export const TILEMAP_GID_PAGE_TILES = 2048;

export const TILED_FLIP_H = 0x80000000;
export const TILED_FLIP_V = 0x40000000;
export const TILED_FLIP_D = 0x20000000;
export const TILED_GID_MASK = 0x1fffffff;

/**
 * @param {number} mapW
 * @param {number} mapH
 * @param {number} [pageTiles]
 * @returns {Array<{ minX: number, minY: number, maxX: number, maxY: number }>}
 */
export function listGidPages(mapW, mapH, pageTiles = TILEMAP_GID_PAGE_TILES) {
  const w = mapW | 0;
  const h = mapH | 0;
  const pw = pageTiles | 0;
  if (w <= 0 || h <= 0 || pw <= 0) return [];
  const pages = [];
  for (let y = 0; y < h; y += pw) {
    const maxY = y + pw < h ? y + pw : h;
    for (let x = 0; x < w; x += pw) {
      const maxX = x + pw < w ? x + pw : w;
      pages.push({ minX: x, minY: y, maxX, maxY });
    }
  }
  return pages;
}

/**
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} pageRect
 * @returns {{ pageW: number, pageH: number }}
 */
export function gidPageSize(pageRect) {
  const pageW = (pageRect.maxX | 0) - (pageRect.minX | 0);
  const pageH = (pageRect.maxY | 0) - (pageRect.minY | 0);
  return { pageW, pageH };
}

/** @param {number} pageW @param {number} pageH */
export function gidPageByteLength(pageW, pageH) {
  return (pageW | 0) * (pageH | 0) * 4;
}

/**
 * True if any GID in the page rect is non-zero. Early-outs on the first hit.
 * Load-only. Used so empty pages never get a Mesh / texture.
 * @param {ArrayLike<number>} layerInt32
 * @param {number} mapW
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} pageRect
 */
export function gidPageHasTile(layerInt32, mapW, pageRect) {
  const mw = mapW | 0;
  const minX = pageRect.minX | 0;
  const minY = pageRect.minY | 0;
  const maxX = pageRect.maxX | 0;
  const maxY = pageRect.maxY | 0;
  if (maxX <= minX || maxY <= minY) return false;
  for (let y = minY; y < maxY; y++) {
    const row = y * mw;
    for (let x = minX; x < maxX; x++) {
      if (layerInt32[row + x]) return true;
    }
  }
  return false;
}

/**
 * E-432: the side (tiles) of the chunks a GID page's quads are cut to (gidPageQuads).
 */
export const TILEMAP_GID_CHUNK_TILES = 8;

/**
 * E-432: a page drawn only where one of `layers` has tiles: the page split into chunks of `chunk` tiles a side, each run
 * of chunks along a chunk row that holds a tile one quad (two triangles over four corners), in world px (`tileW` x
 * `tileH` a tile). Each layer drew a quad over its whole page, and every pixel under it fetched its GID and was discarded
 * where the layer has no tile: Predator's 7 layers, full-screen each, 0.74 to 1.07 ms of GPU a frame at 1920 x 1080. Its
 * layers' chunks of 8 hold 40 % of that area. The fragments drawn are the same (the page's UV comes from the position),
 * so is the picture. The layers one draw composites (packGidStacksRgba8) share its quads. Load-only.
 * @param {ArrayLike<number>[]} layers row-major mapW * mapH each
 * @param {number} mapW
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} pageRect
 * @param {number} tileW
 * @param {number} tileH
 * @param {number} [chunk]
 * @returns {{ positions: Float32Array, indices: Uint16Array|Uint32Array, quads: number }} no quad: the page has no tile
 */
export function gidPageQuads(layers, mapW, pageRect, tileW, tileH, chunk = TILEMAP_GID_CHUNK_TILES) {
  const mw = mapW | 0;
  const minX = pageRect.minX | 0;
  const minY = pageRect.minY | 0;
  const maxX = pageRect.maxX | 0;
  const maxY = pageRect.maxY | 0;
  const c = Math.max(1, chunk | 0);
  const cw = maxX > minX ? Math.ceil((maxX - minX) / c) : 0;
  const ch = maxY > minY ? Math.ceil((maxY - minY) / c) : 0;
  const filled = new Uint8Array(cw * ch);
  for (let l = 0; l < layers.length; l++) {
    const layerInt32 = layers[l];
    for (let y = minY; y < maxY; y++) {
      const row = y * mw;
      const cy = ((y - minY) / c) | 0;
      for (let x = minX; x < maxX; x++) {
        if (layerInt32[row + x]) filled[cy * cw + (((x - minX) / c) | 0)] = 1;
      }
    }
  }
  // The runs: [x0, x1) in chunks along each chunk row.
  const runs = [];
  for (let cy = 0; cy < ch; cy++) {
    let cx = 0;
    while (cx < cw) {
      if (!filled[cy * cw + cx]) {
        cx++;
        continue;
      }
      const start = cx;
      while (cx < cw && filled[cy * cw + cx]) cx++;
      runs.push(start, cx, cy);
    }
  }
  const quads = runs.length / 3;
  const positions = new Float32Array(quads * 8);
  const indices = quads * 4 > 65536 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  for (let q = 0; q < quads; q++) {
    const x0 = (minX + runs[q * 3] * c) * tileW;
    const x1 = Math.min(maxX, minX + runs[q * 3 + 1] * c) * tileW;
    const y0 = (minY + runs[q * 3 + 2] * c) * tileH;
    const y1 = Math.min(maxY, minY + (runs[q * 3 + 2] + 1) * c) * tileH;
    positions.set([x0, y0, x1, y0, x1, y1, x0, y1], q * 8);
    const v = q * 4;
    indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6);
  }
  return { positions, indices, quads };
}

/**
 * Pack a map-local tile rect into RGBA8 (byte-identical to Int32 little-endian).
 * @param {ArrayLike<number>} layerInt32 row-major mapW * mapH
 * @param {number} mapW
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} pageRect
 * @param {Uint8Array} outUint8
 * @returns {number} bytes written
 */
export function packGidPageRgba8(layerInt32, mapW, pageRect, outUint8) {
  const mw = mapW | 0;
  const minX = pageRect.minX | 0;
  const minY = pageRect.minY | 0;
  const maxX = pageRect.maxX | 0;
  const maxY = pageRect.maxY | 0;
  const pageW = maxX - minX;
  const pageH = maxY - minY;
  const need = gidPageByteLength(pageW, pageH);
  if (!outUint8 || outUint8.length < need) {
    throw new Error(`packGidPageRgba8: out needs ${need} bytes`);
  }
  if (pageW <= 0 || pageH <= 0) return 0;
  const cells = pageW * pageH;
  if ((outUint8.byteOffset & 3) === 0 && typeof layerInt32.subarray === 'function') {
    const out32 = new Uint32Array(outUint8.buffer, outUint8.byteOffset, cells);
    let dest = 0;
    for (let y = minY; y < maxY; y++) {
      const row = y * mw + minX;
      out32.set(layerInt32.subarray(row, row + pageW), dest);
      dest += pageW;
    }
    return cells * 4;
  }
  let o = 0;
  for (let y = minY; y < maxY; y++) {
    const row = y * mw;
    for (let x = minX; x < maxX; x++) {
      const raw = layerInt32[row + x] >>> 0;
      outUint8[o++] = raw & 255;
      outUint8[o++] = (raw >>> 8) & 255;
      outUint8[o++] = (raw >>> 16) & 255;
      outUint8[o++] = (raw >>> 24) & 255;
    }
  }
  return o;
}

/**
 * E-432: the most layers one draw composites over a page: a stack entry names its layer in 3 bits.
 */
export const TILEMAP_GID_LAYERS_PER_DRAW = 8;

/** E-432: a stack entry's layer (0, the draw's bottom one, to 7) sits in GID bits 26 to 28, under Tiled's flip flags. */
export const TILEMAP_GID_STACK_LAYER_SHIFT = 26;

/** E-432: the largest GID a stack entry holds (below its layer's bits). */
export const TILEMAP_GID_STACK_GID_MAX = (1 << TILEMAP_GID_STACK_LAYER_SHIFT) - 1;

/**
 * E-432: how many layers one draw takes over a page `pageH` tiles high: its stacks are at most that many entries deep,
 * each entry `pageH` rows of one texture, which must fit within the GPU's `maxSide` rows; at most
 * TILEMAP_GID_LAYERS_PER_DRAW, at least 1.
 * @param {number} pageH
 * @param {number} maxSide the GPU's largest texture side
 */
export function gidLayersPerDraw(pageH, maxSide) {
  const h = pageH | 0;
  if (h <= 0) return 1;
  const fit = ((maxSide | 0) / h) | 0;
  return fit < 1 ? 1 : fit > TILEMAP_GID_LAYERS_PER_DRAW ? TILEMAP_GID_LAYERS_PER_DRAW : fit;
}

/**
 * E-432: one draw's GID texture: each tile's stack of the layers that have a tile there, the top one first. Entry s of
 * the page's tile (x, y) is texel (x, s * pageH + y), RGBA8 as packGidPageRgba8 writes a GID, holding the GID with
 * Tiled's flip flags and its layer's index in `layers` (0, the bottom one) at TILEMAP_GID_STACK_LAYER_SHIFT; a tile
 * with fewer entries than the depth ends with a 0. The shader reads a pixel's stack until an opaque texel or its end,
 * so a layer with no tile there costs it nothing (a texture with every layer's page in turn cost it a fetch a layer: on
 * the GTX 1650 the one draw took what Predator's 7 took).
 * @param {ArrayLike<number>[]} layers row-major mapW * mapH each, bottom first, at most TILEMAP_GID_LAYERS_PER_DRAW
 * @param {number} mapW
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} pageRect
 * @returns {{ depth: number, bytes: Uint8Array }} depth: the deepest stack (0: no tile in the page); bytes:
 *   pageW * pageH * depth texels
 */
export function packGidStacksRgba8(layers, mapW, pageRect) {
  if (layers.length > TILEMAP_GID_LAYERS_PER_DRAW) {
    throw new Error(`packGidStacksRgba8: ${layers.length} layers, at most ${TILEMAP_GID_LAYERS_PER_DRAW}`);
  }
  const mw = mapW | 0;
  const minX = pageRect.minX | 0;
  const minY = pageRect.minY | 0;
  const { pageW, pageH } = gidPageSize(pageRect);
  if (pageW <= 0 || pageH <= 0) return { depth: 0, bytes: new Uint8Array(0) };
  const plane = pageW * pageH;
  const layerCount = layers.length;
  // N-466: one loop over the page's tiles (x wraps to the next row), not one over columns inside one over rows: Chrome
  // OSR'd the column loop with Maglev, which deopts on leaving an OSR'd inner loop, so each pass deopted once a row
  // (Predator's map: 153 and 155 deopts at load).
  const rowSkip = mw - pageW;
  let depth = 0;
  let src = minY * mw + minX;
  for (let tile = 0, x = 0; tile < plane; tile++) {
    let n = 0;
    for (let l = 0; l < layerCount; l++) if (layers[l][src]) n++;
    if (n > depth) depth = n;
    src++;
    if (++x === pageW) {
      x = 0;
      src += rowSkip;
    }
  }
  const out = new Uint32Array(plane * depth);
  src = minY * mw + minX;
  for (let tile = 0, x = 0; tile < plane; tile++) {
    let at = tile;
    for (let l = layerCount - 1; l >= 0; l--) {
      const raw = layers[l][src] >>> 0;
      if (raw === 0) continue;
      const gid = raw & TILED_GID_MASK;
      if (gid > TILEMAP_GID_STACK_GID_MAX) {
        throw new Error(`WeedJS: tilemap GID ${gid} is over ${TILEMAP_GID_STACK_GID_MAX}, the most a tilemap layer can hold`);
      }
      out[at] = ((raw & ~TILED_GID_MASK) | gid | (l << TILEMAP_GID_STACK_LAYER_SHIFT)) >>> 0;
      at += plane;
    }
    src++;
    if (++x === pageW) {
      x = 0;
      src += rowSkip;
    }
  }
  return { depth, bytes: new Uint8Array(out.buffer) };
}
