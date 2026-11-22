// The decal memory (E-76 W26): the decal tiles in a shared WebAssembly.Memory of their own, at byte 0, so every
// worker views them as it viewed the tiles' own SharedArrayBuffer (particle stamps them; Pixi uploads them;
// Decal.getColor and saves read them on the main thread and in logic). After them, the stamp kernel's scratch
// and a copy of every decal texture (decalMemoryRegions). Made once the textures are loaded, before any worker
// is initialized, so nothing binds the tiles twice. The decal stamp and premultiply run only in WebAssembly, so a
// scene with decals always has one: a memory past the 2 GB cap, or one the browser will not make, is an error that
// names its size.

import { Decal } from '../core/decal.js';
import { DECAL_MAX_STAMPS, createWasmMemory, decalMemoryRegions } from './wasmMemoryMap.js';

/**
 * @param {{ totalTiles: number, tilePixelSize: number, textures: Record<string, { width: number, height: number, rgba: ArrayBufferLike }> | null }} opts
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: object }} null without tiles
 */
export function createDecalMemory({ totalTiles, tilePixelSize, textures }) {
  const tiles = totalTiles | 0;
  const pixels = tilePixelSize | 0;
  if (tiles <= 0 || pixels <= 0) return null;
  const tileBytes = tiles * pixels * pixels * 4;
  const placed = [];
  let textureBytes = 0;
  for (const [id, t] of Object.entries(textures || {})) {
    const bytes = (t.width | 0) * (t.height | 0) * 4;
    if (bytes <= 0 || !t.rgba || t.rgba.byteLength < bytes) continue;
    placed.push({ id, at: textureBytes, bytes, t });
    textureBytes += (bytes + 63) & ~63;
  }
  const map = decalMemoryRegions(tileBytes, tiles, textureBytes, pixels);
  if (map.regions.tiles.byte !== 0) throw new Error('decal memory: the tiles must start at byte 0');
  const memory = createWasmMemory(map.pages, 'decal memory', `(${tiles} tiles of ${pixels}x${pixels} px)`,
    'lower particle.decalsResolution or the world size');
  const r = map.regions;
  const buffer = memory.buffer;
  const textureLayout = {};
  for (const p of placed) {
    const byte = r.textures.byte + p.at;
    new Uint8Array(buffer, byte, p.bytes).set(new Uint8Array(p.t.rgba, 0, p.bytes));
    textureLayout[p.id] = { byte, width: p.t.width | 0, height: p.t.height | 0 };
  }
  return {
    memory,
    buffer,
    // Plain numbers, so the layout posts to workers as it is.
    layout: {
      tilesByte: 0,
      tileBytes,
      totalTiles: tiles,
      tilePixels: pixels,
      touchedByte: r.touched.byte,
      stampsByte: r.stamps.byte,
      maxStamps: DECAL_MAX_STAMPS,
      columnsByte: r.columns.byte,
      columnsCap: pixels,
      tableByte: r.table.byte,
      premultipliedByte: r.premultiplied.byte,
      textures: textureLayout,
    },
  };
}

/**
 * With decals, put the scene's tiles in a decal memory: the tiles' buffer becomes the memory's (still empty:
 * nothing stamps before the workers start) and the main thread's atlas is bound to it. createDecalMemory throws
 * when the memory cannot be made.
 */
export function installDecalMemory(scene) {
  scene.decalMemory = null;
  const cfg = scene.config;
  const p = cfg.particle || {};
  if (!p.decals || !scene.buffers?.decalsTilesRGBA) return null;
  const m = createDecalMemory({
    totalTiles: scene.decalsTotalTiles,
    tilePixelSize: p.decalsTilePixelSize,
    textures: scene.decalTextureData,
  });
  if (!m) return null;
  scene.decalMemory = m;
  scene.buffers.decalsTilesRGBA = m.buffer;
  Decal.bindAtlas({
    tilesSab: m.buffer,
    tileSize: p.decalsTileSize,
    tilePixelSize: p.decalsTilePixelSize,
    tilesX: scene.decalsTilesX,
    tilesY: scene.decalsTilesY,
  });
  return m;
}
