// SST-5 step 4: a baked atlas (a scene's assets.bigAtlas, the PNG and JSON the bake wrote) loaded without
// drawing it into a 2D canvas on the page. The renderer gets the PNG decoded by the browser (createImageBitmap decodes
// off the main thread); the pixels the page needs besides (the decal textures, and the frame texels a bake from before
// H-EDGE lacks) are read in the atlas worker from the same PNG, or on the page when there is no worker.

import { fetchAssetJson, fetchAssetRead } from '../../util/fetchAsset.js';
import { loadMark } from '../../util/loadMarks.js';
import { warnOnce } from '../../util/dxWarn.js';
import { debugWorkerLog } from '../../util/debugLog.js';
import { applyFrameTexels } from './atlasFrames.js';
import { runJobOrHere } from '../assetWorkerClient.js';
import { canvasOf, makeCanvas2d } from './canvas2d.js';
import { drawBuiltinTextures, missingBuiltins } from './atlasBuiltins.js';
import { addBuiltinsToJson, completeBakedPixels } from './bakedPixels.js';

/**
 * A file named beside another asset: `name` in the folder of `url` (its query and hash left out). An absolute URL or a
 * root path is itself.
 * @param {string} url
 * @param {string} name
 */
export function siblingAssetUrl(url, name) {
  if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(name)) return name;
  const s = String(url);
  const cut = s.split(/[?#]/, 1)[0].lastIndexOf('/');
  return cut >= 0 ? s.slice(0, cut + 1) + name : name;
}

/**
 * DX-MAPS: a baked atlas's twin page (heights and normals at each frame's rectangle), as data: `assets.bigAtlas.maps`,
 * else the file its JSON names (meta.mapsImage, beside the atlas png). Null when the atlas has no maps.
 * @param {{ png: string, maps?: string }} bigAtlasAsset
 * @param {object} json the baked JSON
 * @param {string} sceneName for the warning
 * @returns {Promise<ImageBitmap|null>}
 */
export async function loadBakedMapsPage(bigAtlasAsset, json, sceneName) {
  const named = json?.meta?.mapsImage;
  const url = typeof bigAtlasAsset.maps === 'string'
    ? bigAtlasAsset.maps
    : typeof named === 'string' && named !== '' ? siblingAssetUrl(bigAtlasAsset.png, named) : null;
  if (url === null) {
    if (json?.meta?.maps === true) {
      warnOnce(sceneName, 'baked-maps',
        `${sceneName}: its baked bigAtlas JSON says a sheet has maps but names no maps page (meta.mapsImage), so ` +
        `the sprites are lit flat. Bake it again (npm run bake:atlas), or give assets.bigAtlas.maps.`);
    }
    return null;
  }
  const { body } = await fetchAssetRead(url, 'baked bigAtlas maps PNG', (r) => r.blob());
  // Data, not colour, as the packed page: no premultiplied alpha, no colour space.
  return createImageBitmap(body, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/** What the pixel readers use of an atlas's JSON (a smaller structured clone to the worker). */
export function pixelJsonOf(json) {
  return { frames: json.frames, animations: json.animations, meta: { maps: json.meta?.maps, size: json.meta?.size } };
}

/**
 * Load a baked atlas.
 * @param {{ json: string, png: string, maps?: string }} bigAtlasAsset
 * @param {{ decals: boolean, sceneName: string, worker: import('../assetWorkerClient.js').AssetWorker | null,
 *   unshadedGlows?: boolean, padding?: number }} opts
 *   decals: the scene stamps decals (config.particle.decals), so every frame's pixels are read for them;
 *   unshadedGlows and padding: for the built-ins a bake from before them lacks (createBigAtlas's options)
 * @returns {Promise<{ json: object, imageBitmap: ImageBitmap, mapsBitmap: ImageBitmap | null,
 *   decals: { textures: object, frameNameToId: object } | null, inspect: () => Promise<HTMLCanvasElement | OffscreenCanvas> }>}
 */
export async function loadBakedAtlas(bigAtlasAsset, { decals, sceneName, worker, unshadedGlows = false, padding = 2 }) {
  const jsonPromise = fetchAssetJson(bigAtlasAsset.json, 'baked bigAtlas JSON');
  // DX-MAPS: the twin page the bake wrote beside the atlas, fetched once the JSON names it, while the atlas loads.
  const mapsPromise = jsonPromise.then((json) => loadBakedMapsPage(bigAtlasAsset, json, sceneName));
  const [json, png, mapsBitmap] = await Promise.all([
    jsonPromise,
    fetchAssetRead(bigAtlasAsset.png, 'baked bigAtlas PNG', (r) => r.blob()).then((r) => r.body),
    mapsPromise,
  ]);
  loadMark('atlas fetched');
  // The built-ins the bake lacks (the engine added them since): drawn here, placed and drawn into the atlas with its
  // pixel work; the completed atlas is then the renderer's bitmap.
  const missing = missingBuiltins(json);
  const builtins = missing.length > 0 ? drawBuiltinTextures({ unshadedGlows, only: missing }) : [];
  if (missing.length > 0) debugWorkerLog(`[Scene] The baked bigAtlas lacks the built-ins ${missing.join(', ')}: added at load.`);
  const builtinBitmaps = await Promise.all(builtins.map((b) => createImageBitmap(b.canvas)));
  // Otherwise the renderer's texture is the PNG decoded by the browser off this thread; the worker decodes its own copy.
  const bitmapPromise = builtins.length > 0 ? null : createImageBitmap(png);
  const pixelsPromise = runJobOrHere(
    worker,
    'bakedPixels',
    {
      png,
      json: pixelJsonOf(json),
      decals: decals === true,
      builtins: builtins.map((b, i) => ({ name: b.name, image: builtinBitmaps[i], unshaded: b.unshaded === true })),
      padding,
    },
    builtinBitmaps,
    // On this thread: the built-ins' canvases (their bitmaps went to the worker).
    async () => completeBakedPixels({
      image: bitmapPromise ? await bitmapPromise : await createImageBitmap(png),
      json,
      decals: decals === true,
      builtins: builtins.map((b) => ({ name: b.name, image: b.canvas, unshaded: b.unshaded === true })),
      padding,
      makeCanvas: makeCanvas2d,
    }),
  );
  if (bitmapPromise) {
    await bitmapPromise;
    loadMark('atlas decoded');
  }
  const pixels = await pixelsPromise;
  loadMark('atlas pixels');
  if (pixels.added) addBuiltinsToJson(json, pixels.added);
  const imageBitmap = pixels.bitmap || (await bitmapPromise);
  // H-EDGE (E-448): a bake from before H-EDGE wrote no frame texels; read from its pixels, once.
  if (pixels.texels) applyFrameTexels(json, pixels.texels);
  return {
    json,
    imageBitmap,
    mapsBitmap,
    decals: pixels.decals,
    // The inspector and the download, on demand: the bake's PNG decoded again into a canvas (the built-ins added at load
    // are in the renderer's bitmap, not in it).
    inspect: () => canvasOf(png),
  };
}
