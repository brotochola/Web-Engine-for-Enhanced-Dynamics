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

/** @param {number} r @param {number} g @param {number} b @param {number} a */
export function unpackGidRgba8(r, g, b, a) {
  return ((r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24)) >>> 0;
}

/** @param {number} raw */
export function decodeTiledGid(raw) {
  const u = raw >>> 0;
  return {
    gid: u & TILED_GID_MASK,
    flipH: (u & TILED_FLIP_H) !== 0,
    flipV: (u & TILED_FLIP_V) !== 0,
    flipD: (u & TILED_FLIP_D) !== 0,
  };
}

/** Same epsilon the GID shaders add before floor/fract on page UV. */
export const TILEMAP_GID_PAGE_UV_EPS = 1e-5;

/**
 * Page UV (0..1, corners of the page quad) → local tile + UV inside that tile.
 * Matches the GLSL/WGSL fragment: interpolate 0..1, not world pixels (those lose
 * precision across a 2048-tile quad and the ground looks like a lower FPS).
 * @param {number} pageU
 * @param {number} pageV
 * @param {number} pageW
 * @param {number} pageH
 * @returns {{ localX: number, localY: number, localU: number, localV: number }}
 */
export function pageUvToLocalTile(pageU, pageV, pageW, pageH) {
  const fx = +pageU * +pageW + TILEMAP_GID_PAGE_UV_EPS;
  const fy = +pageV * +pageH + TILEMAP_GID_PAGE_UV_EPS;
  const localX = Math.floor(fx);
  const localY = Math.floor(fy);
  return {
    localX,
    localY,
    localU: fx - localX,
    localV: fy - localY,
  };
}

/**
 * Local UV inside a tile after Tiled H/V/D (y-down, 0..1).
 * Diagonal transposes first, then H, then V — same order as the GPU shaders.
 * @param {number} localU
 * @param {number} localV
 * @param {boolean} flipH
 * @param {boolean} flipV
 * @param {boolean} flipD
 * @returns {{ u: number, v: number }}
 */
export function applyTiledLocalUv(localU, localV, flipH, flipV, flipD) {
  let u = +localU;
  let v = +localV;
  if (flipD) {
    const t = u;
    u = v;
    v = t;
  }
  if (flipH) u = 1 - u;
  if (flipV) v = 1 - v;
  return { u, v };
}

/**
 * Atlas UV (0..1) for a Tiled GID at a local tile UV, with 0.5 px inset.
 * @param {number} raw
 * @param {number} localU
 * @param {number} localV
 * @param {{ firstGid: number, columns: number, tileWidth: number, tileHeight: number, atlasWidth: number, atlasHeight: number }} opts
 * @returns {{ u: number, v: number } | null} null if empty / invalid
 */
export function tiledGidAtlasUv(raw, localU, localV, opts) {
  const decoded = decodeTiledGid(raw);
  if (decoded.gid === 0) return null;
  const firstGid = opts.firstGid | 0;
  const tileId = decoded.gid - firstGid;
  if (tileId < 0) return null;
  const columns = opts.columns | 0;
  const tw = +opts.tileWidth;
  const th = +opts.tileHeight;
  const aw = +opts.atlasWidth;
  const ah = +opts.atlasHeight;
  if (!(columns > 0) || !(tw > 0) || !(th > 0) || !(aw > 0) || !(ah > 0)) return null;
  const uv = applyTiledLocalUv(localU, localV, decoded.flipH, decoded.flipV, decoded.flipD);
  const col = tileId % columns;
  const row = (tileId / columns) | 0;
  const px = col * tw + 0.5 + uv.u * (tw - 1);
  const py = row * th + 0.5 + uv.v * (th - 1);
  return { u: px / aw, v: py / ah };
}
