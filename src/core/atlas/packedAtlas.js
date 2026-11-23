// SST-5 steps 1-3: a scene's atlas packed from its images and spritesheets off the page's main thread. The atlas worker
// fetches and decodes every source, reads each sheet's pixels once (trim, standing base, texels), packs, draws the atlas
// (atlasBuild.js), reads the decal textures from it and hands back the json, the renderer's bitmaps and the decal
// textures; the page only draws the built-in textures (small canvases, utils.js's) and registers the ids. Where there is
// no worker the page does the same on its own thread: the same atlas. SST-6: either loads it from the atlas cache
// (atlasCache.js) when the same scene packed it before (config.assets.atlasCache, on unless false).

import { resolvedAssetUrl } from '../../util/fetchAsset.js';
import { resolveAssetUrls } from './atlasCache.js';
import { resolveHeightScaleY } from '../../util/cameraView.js';
import { loadMark } from '../../util/loadMarks.js';
import { ASSETS_DEFAULTS } from '../../util/configDefaults.js';
import { debugWorkerLog } from '../../util/debugLog.js';
import { SpriteSheetRegistry } from '../spriteSheetRegistry.js';
import { drawBuiltinTextures } from './atlasBuiltins.js';
import { runJobOrHere } from '../assetWorkerClient.js';
import { makeCanvas2d } from './canvas2d.js';
import { packAtlas } from './atlasPackJob.js';

/**
 * The atlas's assets as the worker gets them: every URL resolved against the page, an Adobe sheet's decoded image as an
 * ImageBitmap (its json as it is). Returns the transfer list too.
 * @param {object} assetsToLoad images by name, plus { spritesheets }
 * @param {(url: string) => string} [resolve]
 * @returns {Promise<{ assets: object, transfer: Transferable[] }>}
 */
export async function assetsForWorker(assetsToLoad, resolve = resolvedAssetUrl) {
  const assets = resolveAssetUrls(assetsToLoad, resolve);
  const transfer = [];
  for (const c of Object.values(assets.spritesheets || {})) {
    // An Adobe Animate sheet comes decoded (Scene.prepareAdobeAnimateAssets): its image as a bitmap the worker can draw.
    if (c.img && typeof ImageBitmap !== 'undefined' && !(c.img instanceof ImageBitmap)) {
      c.img = await createImageBitmap(c.img);
      transfer.push(c.img);
    }
  }
  return { assets, transfer };
}

/**
 * Pack a scene's atlas.
 * @param {object} assetsToLoad images by name, plus { spritesheets } (the scene's and its Adobe Animate ones)
 * @param {{ options: object, camera?: object | null, unshadedGlows?: boolean, decals: boolean,
 *   worker: import('../assetWorkerClient.js').AssetWorker | null, withMapsTexels?: boolean }} opts
 *   options: config.assets (the packer's options, and atlasCache: false keeps the atlas cache out); camera: config.camera
 *   (DX-MAPCAMERA); unshadedGlows: DX-GLOWRADIUS; decals: read the decal textures; withMapsTexels: the twin page's
 *   texels too, as computed (the bake writes them)
 * @returns {Promise<{ json: object, imageBitmap: ImageBitmap, mapsBitmap: ImageBitmap | null, mapsTexels: Uint8ClampedArray | null,
 *   decals: { textures: object, frameNameToId: object } | null, inspect: () => Promise<HTMLCanvasElement | OffscreenCanvas> }>}
 */
export async function loadPackedAtlas(assetsToLoad, { options = {}, camera = null, unshadedGlows = false, decals, worker, withMapsTexels = false }) {
  // DX-MAPCAMERA: the scene's heightScaleY, to which a sheet drawn for another camera has its heights scaled.
  const sceneHeightScaleY = camera ? resolveHeightScaleY(camera) : NaN;
  const builtins = drawBuiltinTextures({ unshadedGlows });
  // DX-MAPS: the twin page's texels as computed (keepMapsTexels), its bitmap made from them, not from a canvas.
  const packOptions = { ...options, keepMapsTexels: true, mapsCanvas: false, sceneHeightScaleY, decals: decals === true };
  // SST-6: the atlas cache, unless the scene turns it off; a bundle's code is named by the engine's version.
  const cache = {
    enabled: (options.atlasCache ?? ASSETS_DEFAULTS.atlasCache ?? true) !== false,
    bundle: typeof window !== 'undefined' && window.WEED?.BUNDLE_MODE === true,
  };
  let job = null;
  if (worker) {
    const forWorker = await assetsForWorker(assetsToLoad);
    const bitmaps = await Promise.all(builtins.map((b) => createImageBitmap(b.canvas)));
    job = {
      args: {
        assets: forWorker.assets,
        options: packOptions,
        builtins: builtins.map((b, i) => ({ name: b.name, image: bitmaps[i], unshaded: b.unshaded })),
        cache,
        withMapsTexels,
      },
      transfer: [...forWorker.transfer, ...bitmaps],
    };
  }
  const packed = await runJobOrHere(worker, 'pack', job?.args, job?.transfer ?? [], async () => {
    // On this thread: the cache's key from the page's own URLs; a miss's write runs on after the atlas is handed over.
    const { result } = await packAtlas({
      assets: assetsToLoad,
      options: packOptions,
      builtins: builtins.map((b) => ({ name: b.name, image: b.canvas, unshaded: b.unshaded })),
      cache,
      makeCanvas: makeCanvas2d,
    });
    return result;
  });
  loadMark(packed.cache === 'hit' ? 'atlas from cache' : 'atlas packed');
  if (packed.cache === 'hit') debugWorkerLog('[Scene] bigAtlas loaded from the atlas cache');
  // The individual textures' spritesheet ids, before bigAtlas's (as createBigAtlas registered them while it packed).
  SpriteSheetRegistry.registerPackedAtlasIds(packed.json);
  return {
    json: packed.json,
    imageBitmap: packed.imageBitmap,
    mapsBitmap: packed.mapsBitmap,
    mapsTexels: withMapsTexels ? packed.mapsTexels ?? null : null,
    decals: packed.decals ?? null,
    // The inspector and the download, on demand: the atlas packed again on this thread (a debug view: lazy is allowed).
    inspect: async () => (await SpriteSheetRegistry.createBigAtlas(assetsToLoad, { ...options, camera, unshadedGlows })).canvas,
    // DBG-6: the twin page's texels for the inspector's maps modes, packed again the same way (null: no sheet has maps).
    inspectMaps: async () => {
      const again = await SpriteSheetRegistry.createBigAtlas(assetsToLoad, { ...options, camera, unshadedGlows, keepMapsTexels: true });
      return again.mapsTexels ? { texels: again.mapsTexels, width: again.mapsSize.w, height: again.mapsSize.h } : null;
    },
  };
}
