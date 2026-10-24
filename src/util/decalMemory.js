// The decal memory (E-76 W26): the decal tiles in a shared WebAssembly.Memory of their own, at byte 0, so every
// worker views them as it viewed the tiles' own SharedArrayBuffer (particle stamps them; Pixi uploads them;
// Decal.getColor and saves read them on the main thread and in logic). After them, the stamp kernel's scratch
// and a copy of every decal texture (decalMemoryRegions). Made once the textures are loaded, before any worker
// is initialized, so nothing binds the tiles twice.

import { Decal } from '../core/decal.js';
import { DECAL_MAX_STAMPS, decalMemoryRegions } from './wasmMemoryMap.js';

// The module's import accepts up to 8192 pages (512 MB): wasm/modules.json maxMemoryPages.
const WASM_MAX_PAGES = 8192;

/**
 * @param {{ totalTiles: number, tilePixelSize: number, textures: Record<string, { width: number, height: number, rgba: ArrayBufferLike }> | null }} opts
 * @returns {null | { memory: WebAssembly.Memory, buffer: SharedArrayBuffer, layout: object }}
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
  if (map.pages > WASM_MAX_PAGES || map.regions.tiles.byte !== 0) return null;
  let memory;
  try {
    memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
  } catch {
    return null;
  }
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
 * With decals and wasm.decalStamp on, put the scene's tiles in a decal memory: the tiles' buffer becomes the
 * memory's (still empty: nothing stamps before the workers start) and the main thread's atlas is bound to it.
 * A scene whose memory cannot be made keeps its tiles' own SharedArrayBuffer and the JS stamp.
 */
export function installDecalMemory(scene) {
  scene.decalMemory = null;
  const cfg = scene.config;
  const p = cfg.particle || {};
  if (!p.decals || cfg.wasm?.decalStamp === false || !scene.buffers?.decalsTilesRGBA) return null;
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
