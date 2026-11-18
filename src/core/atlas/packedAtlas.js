// SST-5 steps 1-3: a scene's atlas packed from its images and spritesheets off the page's main thread. The atlas worker
// fetches and decodes every source, reads each sheet's pixels once (trim, standing base, texels), packs, draws the atlas
// (atlasBuild.js), reads the decal textures from it and hands back the json, the renderer's bitmaps and the decal
// textures; the page only draws the built-in textures (small canvases, utils.js's) and registers the ids. Where there is
// no worker the page does the same on its own thread (SpriteSheetRegistry.createBigAtlas): the same atlas.

import { resolvedAssetUrl } from '../../util/fetchAsset.js';
import { resolveHeightScaleY } from '../../util/cameraView.js';
import { loadMark } from '../../util/loadMarks.js';
import { SpriteSheetRegistry } from '../spriteSheetRegistry.js';
import { drawBuiltinTextures } from './atlasBuiltins.js';
import { buildBigAtlas } from './atlasBuild.js';
import { runJobOrHere } from '../assetWorkerClient.js';
import { packedBitmaps } from './packedBitmaps.js';

/** A spritesheet config's fields that name files: the worker resolves URLs against its own script, so they go absolute. */
const SHEET_URL_FIELDS = ['json', 'png', 'normalMap'];
/** Fields that are a URL or an object with a `png` URL (DX-MAPS heightMap, DX-RELIEF reliefMap). */
const SHEET_PNG_FIELDS = ['heightMap', 'reliefMap'];

/**
 * The atlas's assets as the worker gets them: every URL resolved against the page, an Adobe sheet's decoded image as an
 * ImageBitmap (its json as it is). Returns the transfer list too.
 * @param {object} assetsToLoad images by name, plus { spritesheets }
 * @param {(url: string) => string} [resolve]
 * @returns {Promise<{ assets: object, transfer: Transferable[] }>}
 */
export async function assetsForWorker(assetsToLoad, resolve = resolvedAssetUrl) {
  const assets = {};
  const transfer = [];
  for (const [name, value] of Object.entries(assetsToLoad || {})) {
    if (name === 'spritesheets') continue;
    assets[name] = typeof value === 'string' ? resolve(value) : value;
  }
  const sheets = {};
  for (const [name, config] of Object.entries(assetsToLoad?.spritesheets || {})) {
    const c = { ...config };
    for (const k of SHEET_URL_FIELDS) if (typeof c[k] === 'string') c[k] = resolve(c[k]);
    for (const k of SHEET_PNG_FIELDS) {
      if (typeof c[k] === 'string') c[k] = resolve(c[k]);
      else if (c[k] && typeof c[k] === 'object' && typeof c[k].png === 'string') c[k] = { ...c[k], png: resolve(c[k].png) };
    }
    // An Adobe Animate sheet comes decoded (Scene.prepareAdobeAnimateAssets): its image as a bitmap the worker can draw.
    if (c.img && typeof ImageBitmap !== 'undefined' && !(c.img instanceof ImageBitmap)) {
      c.img = await createImageBitmap(c.img);
      transfer.push(c.img);
    }
    sheets[name] = c;
  }
  if (assetsToLoad && 'spritesheets' in assetsToLoad) assets.spritesheets = sheets;
  return { assets, transfer };
}

/**
 * Pack a scene's atlas.
 * @param {object} assetsToLoad images by name, plus { spritesheets } (the scene's and its Adobe Animate ones)
 * @param {{ options: object, camera?: object | null, unshadedGlows?: boolean, decals: boolean,
 *   worker: import('../assetWorkerClient.js').AssetWorker | null }} opts
 *   options: config.assets (the packer's options); camera: config.camera (DX-MAPCAMERA); unshadedGlows: DX-GLOWRADIUS;
 *   decals: read the decal textures
 * @returns {Promise<{ json: object, imageBitmap: ImageBitmap, mapsBitmap: ImageBitmap | null,
 *   decals: { textures: object, frameNameToId: object } | null, inspect: () => Promise<HTMLCanvasElement | OffscreenCanvas> }>}
 */
export async function loadPackedAtlas(assetsToLoad, { options = {}, camera = null, unshadedGlows = false, decals, worker }) {
  // DX-MAPCAMERA: the scene's heightScaleY, to which a sheet drawn for another camera has its heights scaled.
  const sceneHeightScaleY = camera ? resolveHeightScaleY(camera) : NaN;
  const builtins = drawBuiltinTextures({ unshadedGlows });
  // DX-MAPS: the twin page's texels as computed (keepMapsTexels), its bitmap made from them, not from a canvas.
  const packOptions = { ...options, keepMapsTexels: true, mapsCanvas: false, sceneHeightScaleY, decals: decals === true };
  let job = null;
  if (worker) {
    const forWorker = await assetsForWorker(assetsToLoad);
    const bitmaps = await Promise.all(builtins.map((b) => createImageBitmap(b.canvas)));
    job = {
      args: {
        assets: forWorker.assets,
        options: packOptions,
        builtins: builtins.map((b, i) => ({ name: b.name, image: bitmaps[i], unshaded: b.unshaded, afterSort: b.afterSort })),
      },
      transfer: [...forWorker.transfer, ...bitmaps],
    };
  }
  const packed = await runJobOrHere(worker, 'pack', job?.args, job?.transfer ?? [], async () => {
    const built = await buildBigAtlas(assetsToLoad, {
      ...packOptions,
      builtins: builtins.map((b) => ({ name: b.name, image: b.canvas, unshaded: b.unshaded, afterSort: b.afterSort })),
    });
    const bitmaps = await packedBitmaps(built);
    return { json: built.json, ...bitmaps, decals: built.decals };
  });
  loadMark('atlas packed');
  // The individual textures' spritesheet ids, before bigAtlas's (as createBigAtlas registered them while it packed).
  SpriteSheetRegistry.registerPackedAtlasIds(packed.json);
  return {
    json: packed.json,
    imageBitmap: packed.imageBitmap,
    mapsBitmap: packed.mapsBitmap,
    decals: packed.decals ?? null,
    // The inspector and the download, on demand: the atlas packed again on this thread (a debug view: lazy is allowed).
    inspect: async () => (await SpriteSheetRegistry.createBigAtlas(assetsToLoad, { ...options, camera, unshadedGlows })).canvas,
  };
}
