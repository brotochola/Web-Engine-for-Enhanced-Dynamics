// A packed atlas for the page, from the atlas cache (SST-6) or packed (SST-5): the atlas worker's 'pack' job, and the
// page's own when it has no worker. A miss hands the atlas over first and writes its cache entry after (`background`).

import { debugWorkerLog } from '../../util/debugLog.js';
import { loadMark } from '../../util/loadMarks.js';
import { buildBigAtlas } from './atlasBuild.js';
import { readAtlasPixels } from './atlasFrames.js';
import { atlasCacheHere, atlasCacheKey, atlasCacheSlotOf, readAtlasCacheSlot, writeAtlasCache } from './atlasCache.js';
import { packedBitmaps } from './packedBitmaps.js';

/** A 2D canvas's PNG, its pixels as they are now (both encoders copy the bitmap when called, then encode in parallel). */
function pngOf(canvas) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob gave nothing'))), 'image/png'));
}

/**
 * A cache entry as the page gets a packed atlas: the PNG decoded for the renderer, the twin page from its texels (data),
 * the decal textures read from the decoded atlas as the pack reads them from its canvas.
 * @param {{ json: object, png: Blob, maps: Uint8ClampedArray | null }} hit
 * @param {boolean} decals
 * @param {(w: number, h: number) => HTMLCanvasElement | OffscreenCanvas} makeCanvas
 */
async function fromEntry(hit, decals, makeCanvas) {
  const size = hit.json.meta?.mapsSize;
  const [imageBitmap, mapsBitmap] = await Promise.all([
    createImageBitmap(hit.png),
    hit.maps && size
      ? createImageBitmap(new ImageData(hit.maps, size.w, size.h), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      : null,
  ]);
  loadMark('atlas cache decoded');
  // Its frames' texels are in its json (a pack scans them; its built-ins it leaves unscanned): none read here.
  const read = decals ? readAtlasPixels(imageBitmap, hit.json, { decals: true, texels: false, makeCanvas }) : { decals: null };
  return { json: hit.json, imageBitmap, mapsBitmap, mapsTexels: hit.maps, decals: read.decals, cache: 'hit' };
}

/** A decoded entry that turned out not to be the atlas asked for: its bitmaps let go. */
function dropDecoded(decoded) {
  decoded
    .then((r) => {
      r.imageBitmap?.close?.();
      r.mapsBitmap?.close?.();
    })
    .catch(() => {});
}

/**
 * Load a scene's packed atlas from the atlas cache, or pack it.
 * @param {{
 *   assets: object,
 *   options: object,
 *   builtins: Array<{ name: string, image: CanvasImageSource & { width: number, height: number }, unshaded?: boolean }>,
 *   cache: { enabled: boolean, bundle: boolean } | null,
 *   makeCanvas: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas,
 *   cacheEnv?: { storage: CacheStorage, origin: string } | null,
 *   cacheKeyOptions?: object,
 * }} p options: buildBigAtlas's (keepMapsTexels true, mapsCanvas false, decals); cache.bundle: the code is a bundle's
 *   (the engine's version names it); cacheEnv, cacheKeyOptions: tests give their own Cache Storage, fetch and version
 * @returns {Promise<{ result: { json: object, imageBitmap: ImageBitmap, mapsBitmap: ImageBitmap | null,
 *   mapsTexels: Uint8ClampedArray | null, decals: object | null, cache: 'hit' | 'miss' | 'off' }, background: Promise<void> | null }>}
 *   mapsTexels: the twin page's texels as computed (the bake writes them; the renderer gets mapsBitmap)
 */
export async function packAtlas({ assets, options, builtins, cache, makeCanvas, cacheEnv, cacheKeyOptions = {} }) {
  const env = cache?.enabled ? (cacheEnv !== undefined ? cacheEnv : atlasCacheHere()) : null;
  let entry = null;
  if (env) {
    try {
      // SST-16: the slot's one entry read and decoded while the key hashes the sources (113 and 145 ms of a warm start,
      // one after the other before), kept only when its key is the key computed.
      const slot = await atlasCacheSlotOf(assets);
      const guess = slot === null
        ? null
        : readAtlasCacheSlot(env.storage, env.origin, slot)
          .then((found) => (found ? { key: found.key, decoded: fromEntry(found.hit, options.decals === true, makeCanvas) } : null))
          // A cache that fails to read is no cache, as before: the error goes to the catch below, after the key.
          .catch((error) => ({ error }));
      entry = await atlasCacheKey({ assets, options, builtins, bundle: cache.bundle === true, ...cacheKeyOptions });
      const found = guess ? await guess : null;
      if (found?.error) throw found.error;
      if (entry && found && found.key === entry.key && slot === entry.slot) {
        loadMark('atlas cache hit');
        return { result: await found.decoded, background: null };
      }
      if (found) dropDecoded(found.decoded);
      if (entry) loadMark('atlas cache miss');
    } catch (error) {
      // The cache is a shortcut: a source it could not read, a cache the browser refuses, and the atlas is packed.
      debugWorkerLog(`[atlas cache] not used: ${error?.message ?? error}`);
      entry = null;
    }
  }
  const packed = await buildBigAtlas(assets, { ...options, keepMapsTexels: true, builtins });
  const png = entry ? pngOf(packed.canvas) : null;
  const { imageBitmap, mapsBitmap } = await packedBitmaps(packed);
  const result = {
    json: packed.json, imageBitmap, mapsBitmap, mapsTexels: packed.mapsTexels, decals: packed.decals, cache: entry ? 'miss' : 'off',
  };
  const background = entry
    ? (async () => {
      await writeAtlasCache(env.storage, env.origin, entry.slot, entry.key, { json: packed.json, png: await png, maps: packed.mapsTexels });
      loadMark('atlas cache written');
    })().catch((error) => debugWorkerLog(`[atlas cache] not written: ${error?.message ?? error}`))
    : null;
  return { result, background };
}
