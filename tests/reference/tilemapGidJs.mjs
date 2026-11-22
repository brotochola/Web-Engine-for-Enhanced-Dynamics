// The GID tilemap shaders' math in JS, for the tests (N-303 CR-12: out of src/render/tilemapGid.js, where only tests
// read it): a page texel's gid, Tiled's flip bits, and a page UV to its tile's atlas UV, as the GLSL/WGSL fragments do.
import { TILED_FLIP_D, TILED_FLIP_H, TILED_FLIP_V, TILED_GID_MASK } from '../../src/render/tilemapGid.js';

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
 * Atlas UV (0..1) for a Tiled GID at a local tile UV, with a 0.5 px inset.
 * Maps the tile onto texel centers so a linear sampler blends inside the tile
 * and does not pull the neighbor tile in the atlas.
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
