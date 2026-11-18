// A packed atlas for the page, from the atlas cache (SST-6) or packed (SST-5): the atlas worker's 'pack' job, and the
// page's own when it has no worker. A miss hands the atlas over first and writes its cache entry after (`background`).

import { debugWorkerLog } from '../../util/debugLog.js';
import { loadMark } from '../../util/loadMarks.js';
import { buildBigAtlas } from './atlasBuild.js';
import { readAtlasPixels } from './atlasFrames.js';
import { atlasCacheHere, atlasCacheKey, readAtlasCache, writeAtlasCache } from './atlasCache.js';
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
  return { json: hit.json, imageBitmap, mapsBitmap, decals: read.decals, cache: 'hit' };
}

/**
 * Load a scene's packed atlas from the atlas cache, or pack it.
 * @param {{
 *   assets: object,
 *   options: object,
 *   builtins: Array<{ name: string, image: CanvasImageSource & { width: number, height: number }, unshaded?: boolean, afterSort?: boolean }>,
 *   cache: { enabled: boolean, bundle: boolean } | null,
 *   makeCanvas: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas,
 *   cacheEnv?: { storage: CacheStorage, origin: string } | null,
 *   cacheKeyOptions?: object,
 * }} p options: buildBigAtlas's (keepMapsTexels true, mapsCanvas false, decals); cache.bundle: the code is a bundle's
 *   (the engine's version names it); cacheEnv, cacheKeyOptions: tests give their own Cache Storage, fetch and version
 * @returns {Promise<{ result: { json: object, imageBitmap: ImageBitmap, mapsBitmap: ImageBitmap | null,
 *   decals: object | null, cache: 'hit' | 'miss' | 'off' }, background: Promise<void> | null }>}
 */
export async function packAtlas({ assets, options, builtins, cache, makeCanvas, cacheEnv, cacheKeyOptions = {} }) {
  const env = cache?.enabled ? (cacheEnv !== undefined ? cacheEnv : atlasCacheHere()) : null;
  let entry = null;
  if (env) {
    try {
      entry = await atlasCacheKey({ assets, options, builtins, bundle: cache.bundle === true, ...cacheKeyOptions });
      if (entry) {
        const hit = await readAtlasCache(env.storage, env.origin, entry.slot, entry.key);
        if (hit) {
          loadMark('atlas cache hit');
          return { result: await fromEntry(hit, options.decals === true, makeCanvas), background: null };
        }
        loadMark('atlas cache miss');
      }
    } catch (error) {
      // The cache is a shortcut: a source it could not read, a cache the browser refuses, and the atlas is packed.
      debugWorkerLog(`[atlas cache] not used: ${error?.message ?? error}`);
      entry = null;
    }
  }
  const packed = await buildBigAtlas(assets, { ...options, keepMapsTexels: true, builtins });
  const png = entry ? pngOf(packed.canvas) : null;
  const { imageBitmap, mapsBitmap } = await packedBitmaps(packed);
  const result = { json: packed.json, imageBitmap, mapsBitmap, decals: packed.decals, cache: entry ? 'miss' : 'off' };
  const background = entry
    ? (async () => {
      await writeAtlasCache(env.storage, env.origin, entry.slot, entry.key, { json: packed.json, png: await png, maps: packed.mapsTexels });
      loadMark('atlas cache written');
    })().catch((error) => debugWorkerLog(`[atlas cache] not written: ${error?.message ?? error}`))
    : null;
  return { result, background };
}
