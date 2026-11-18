// SST-5: the packed atlas built from the scene's images and spritesheets (createBigAtlas's body, moved out of
// spriteSheetRegistry.js): fetch and decode every source, read each sheet's pixels once (trim, standing base, texels),
// order by declaration, pack, draw, the twin page, the json. It runs in the atlas worker (src/workers/atlasWorker.js) and,
// where there is none, on the page (SpriteSheetRegistry.createBigAtlas, the bake). Its imports stay few (no utils.js, no
// GameObject): the built-in textures come drawn by the page (atlasBuiltins.js), the scene camera's heightScaleY as a
// number, and nothing here registers anything (the page registers the json's ids: SpriteSheetRegistry.
// registerPackedAtlasIds).

import {
  RELIEF_STRENGTH, artCameraHeightScale, maskTwinTexels, opaqueMask, readArtCamera, readHeights, twinPageInFormat,
} from '../../render/spriteMaps.js';
import { evenTexels, TWIN_PAD } from '../../render/mapsTable.js';
import {
  FRAME_GLOW, FRAME_HALF, FRAME_SOFT, frameAlphaKinds, frameSolidTexels, isRenderDirections, measureHeightPerRow, measureLowestContact,
  measureStandingBase, readFootprint,
} from '../../render/frameBase.js';
import { ASSETS_DEFAULTS } from '../../util/configDefaults.js';
import { debugWorkerLog } from '../../util/debugLog.js';
import { fetchAssetJson, fetchAssetRead, imageLoadError } from '../../util/fetchAsset.js';
import { loadMark } from '../../util/loadMarks.js';
import { MaxRectsPacker } from './maxRectsPacker.js';
import { makeCanvas2d } from './canvas2d.js';
import { cutPixels, decalTexturesFrom } from './atlasFrames.js';

/**
 * Put the atlas inputs back in the order the scene declares its assets. Loads
 * finish in network order, but animation indices and spritesheet ids come from
 * insertion order and are stored in components (saves, hot reload): a load in a
 * different order would make a saved id name another sheet. Built-ins (_empty
 * first) and anything undeclared keep their place after the declared assets.
 * Sorts are stable, so a sheet's frames and animations keep their own order.
 * @param {object} assetsConfig images by name, plus { spritesheets }
 * @param {Array<{ name: string }>} imagesToPack sorted in place
 * @param {Record<string, string[]>} animations reordered in place
 * @param {Record<string, object>} proxySheets reordered in place
 */
export function orderAtlasByDeclaration(assetsConfig, imagesToPack, animations, proxySheets) {
  const declaredImages = Object.keys(assetsConfig).filter(
    (name) => name !== 'spritesheets' && typeof assetsConfig[name] === 'string',
  );
  const declaredSheets = Object.keys(assetsConfig.spritesheets || {});
  const imageRank = new Map(declaredImages.map((name, i) => [name, i]));
  // Longest prefix first, so "car_red_" wins over "car_".
  const sheetsByPrefix = declaredSheets
    .map((name, i) => ({ prefix: `${name}_`, rank: declaredImages.length + i }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const rankOf = (name) => {
    if (name === '_empty') return -1;
    if (imageRank.has(name)) return imageRank.get(name);
    for (const sheet of sheetsByPrefix) if (name.startsWith(sheet.prefix)) return sheet.rank;
    return Number.MAX_SAFE_INTEGER;
  };
  imagesToPack.sort((a, b) => rankOf(a.name) - rankOf(b.name));
  reorderKeys(animations, Object.keys(animations).sort((a, b) => rankOf(a) - rankOf(b)));
  reorderKeys(proxySheets, declaredSheets);
}

/** Rebuild obj's key order: keys in `order` first (missing ones skipped), then the rest. */
function reorderKeys(obj, order) {
  const copy = { ...obj };
  for (const key of Object.keys(obj)) delete obj[key];
  for (const key of order) if (key in copy && !(key in obj)) obj[key] = copy[key];
  for (const key of Object.keys(copy)) if (!(key in obj)) obj[key] = copy[key];
}

/**
 * Create a unified BigAtlas from individual images and spritesheets
 * This combines all textures into a single atlas for optimal rendering performance
 *
 * @param {Object} assetsConfig - Asset configuration
 * @param {Object} options - Packing options from config.assets
 * @param {number} options.maxAtlasWidth - Maximum atlas width (default: 4096)
 * @param {number} options.maxAtlasHeight - Maximum atlas height (default: 4096)
 * @param {number} options.atlasPadding - Padding between sprites (default: 2)
 * @param {boolean} options.trimImages - Trim transparent pixels from individual images (default: true)
 * @param {number} options.trimAlphaThreshold - Alpha threshold for trimming (default: 0)
 * @param {string} options.heuristic - Packing heuristic (default: 'best-short-side')
 * @param {boolean} [options.keepMapsTexels] - DX-MAPS: also return the twin page's texels as they are (`mapsTexels`),
 *   for the bake: its canvas stores premultiplied alpha, which loses a height under a low A (default: false)
 * @param {'A'|'B'|'C'} [options.twinFormat] - E-497: the twin page's format (twinTexel.js; assets.twinFormat, default 'A')
 * @param {number} [options.sceneHeightScaleY] - DX-MAPCAMERA: the scene camera's heightScaleY (cameraView.js
 *   resolveHeightScaleY of config.camera): a sheet drawn for another camera (its artCamera) has its heights scaled to it
 *   (spriteMaps.js artCameraHeightScale); NaN (no camera), none is
 * @param {Array<{ name: string, image: CanvasImageSource & { width: number, height: number }, unshaded?: boolean,
 *   afterSort?: boolean }>} options.builtins - the built-in textures (atlasBuiltins.js drawBuiltinTextures, as canvases
 *   or their ImageBitmaps), in their order; their unshaded marks are DX-GLOWRADIUS's unshadedGlows
 * @param {boolean} [options.decals] - also read every frame's pixels for the decal textures (atlasFrames.js
 *   decalTexturesFrom), from the atlas drawn here
 * @param {boolean} [options.mapsCanvas] - the twin page as a 2D canvas too (default: true); false returns its texels alone
 *   (with keepMapsTexels), as the renderer's bitmap is made from them
 * @returns {Promise<{ canvas: HTMLCanvasElement | OffscreenCanvas, mapsCanvas: HTMLCanvasElement | OffscreenCanvas | null,
 *   mapsTexels: Uint8ClampedArray | null, mapsSize: { w: number, h: number } | null, json: object, proxySheets: object,
 *   individualTextures: string[], decals: { textures: object, frameNameToId: object } | null }>}
 */
export async function buildBigAtlas(
  assetsConfig,
  options = {}
) {
  // Merge with defaults
  const {
    maxAtlasWidth = ASSETS_DEFAULTS.maxAtlasWidth,
    maxAtlasHeight = ASSETS_DEFAULTS.maxAtlasHeight,
    atlasPadding = ASSETS_DEFAULTS.atlasPadding,
    trimImages = ASSETS_DEFAULTS.trimImages,
    trimAlphaThreshold = ASSETS_DEFAULTS.trimAlphaThreshold,
    heuristic = ASSETS_DEFAULTS.heuristic,
    keepMapsTexels = false,
    sceneHeightScaleY = NaN,
    twinFormat = ASSETS_DEFAULTS.twinFormat,
    builtins = [],
    decals = false,
    mapsCanvas: wantMapsCanvas = true,
  } = options;

  debugWorkerLog('🎨 Creating BigAtlas from assets...');
  if (trimImages) {
    debugWorkerLog(`  📐 Trimming enabled (alpha threshold: ${trimAlphaThreshold})`);
  }

  const maxWidth = maxAtlasWidth;
  const maxHeight = maxAtlasHeight;
  const padding = atlasPadding;
  const packer = new MaxRectsPacker(maxWidth, maxHeight, padding);

  const frames = {};
  const animations = {
    _empty: ['_empty'],
  };
  const imagesToPack = [];
  const proxySheets = {}; // Track proxy sheet metadata

  // Load individual images (these become single-frame "animations")
  const individualImagePromises = [];
  for (const [name, url] of Object.entries(assetsConfig)) {
    if (name === 'spritesheets' || typeof url !== 'string') continue;

    individualImagePromises.push(
      loadImage(url).then((img) => {
        let sourceImg = img;
        let width = img.width;
        let height = img.height;
        let trimInfo = null;
        let trimResult = null;

        // Apply trimming to individual images (not spritesheet frames)
        if (trimImages) {
          trimResult = trimImage(img, trimAlphaThreshold);
          if (trimResult) {
            if (trimResult.wasTrimmed) {
              sourceImg = trimResult.canvas;
              width = trimResult.bounds.width;
              height = trimResult.bounds.height;
              trimInfo = trimResult.bounds;
              debugWorkerLog(
                `  ✅ Loaded image: ${name} (${img.width}x${img.height} → ${width}x${height} trimmed)`
              );
            } else {
              debugWorkerLog(`  ✅ Loaded image: ${name} (${img.width}x${img.height})`);
            }
          } else {
            // Fully transparent image - still add it but warn
            console.warn(`  ⚠️ Image "${name}" is fully transparent`);
          }
        } else {
          debugWorkerLog(`  ✅ Loaded image: ${name} (${img.width}x${img.height})`);
        }

        imagesToPack.push({
          name: name,
          sourceImg: sourceImg,     // Trimmed canvas or original image
          sourceRect: null,         // null = use entire source
          width: width,
          height: height,
          // For trimmed images, sourceSize = trimmed size (anchors relative to visible content)
          sourceX: 0,
          sourceY: 0,
          sourceWidth: width,
          sourceHeight: height,
          isSpritesheetFrame: false,
          trimInfo: trimInfo,       // Store trim info for debugging
          // H-EDGE: what its alphas hold (frameBase.js FRAME_SOFT, FRAME_HALF), from the trim's scan; E-448: its solid
          // texels.
          texels: trimImages && trimResult ? trimResult.bounds.kinds : undefined,
          solidTexels: trimImages && trimResult ? trimResult.bounds.solid : undefined,
        });

        // Create a single-frame "animation" for this image
        animations[name] = [name];
      })
    );
  }

  // Load spritesheets
  const spritesheetPromises = [];
  if (assetsConfig.spritesheets) {
    for (const [sheetName, config] of Object.entries(assetsConfig.spritesheets)) {
      spritesheetPromises.push(
        loadSpritesheet(sheetName, config).then((sheetData) => {
          const { img, jsonData, maps, unshaded = false, artCamera = null } = sheetData;
          const excluded = config.excludeAnimations || [];

          // 1. Determine which animations and frames are actually needed
          const requiredFrames = new Set();
          const animationsToProcess = [];

          if (jsonData.animations) {
            for (const [animName, frameList] of Object.entries(jsonData.animations)) {
              if (excluded.includes(animName)) continue;
              animationsToProcess.push({ animName, frameList });
              for (const f of frameList) requiredFrames.add(f);
            }
          } else {
            // If no animations defined, keep all frames
            for (const f of Object.keys(jsonData.frames)) requiredFrames.add(f);
          }

          // Create proxy sheet entry with its own index space
          proxySheets[sheetName] = {
            isProxy: true,
            targetSheet: 'bigAtlas',
            prefix: `${sheetName}_`,
            animations: {},
            indexToName: {},
          };
          // DX-DIRSPRITE: the directions its json declares (an exporter writes them); the scene builds the table.
          const jsonDirections = jsonData.directions ?? jsonData.meta?.directions;
          if (jsonDirections !== undefined) proxySheets[sheetName].directionsSpec = jsonDirections;
          // DX-MAPCAMERA: the camera its pictures and maps were drawn for, on its proxy (every worker gets the proxies:
          // SpriteSheetRegistry.artCameraOf), and its heights scaled to the scene's camera.
          if (artCamera !== null) {
            proxySheets[sheetName].artCamera = { floorScaleY: artCamera.floorScaleY, heightScaleY: artCamera.heightScaleY };
            const k = maps ? artCameraHeightScale(artCamera, sceneHeightScaleY) : 1;
            if (k !== 1) {
              maps.heightScale = k;
              maps.key += `|${k}`;
            }
          }

          // The sheet's pixels under the frames it keeps, read back once: each frame's trim is found in them, and a trimmed
          // frame is drawn into the atlas straight from the sheet, through its trimmed rectangle. A readback and a canvas a
          // frame cost 0.6 s of main thread for the Buenos Aires demo's 4 386 frames.
          let sheetPixels = null;
          if (trimImages) {
            let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
            for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
              if (!requiredFrames.has(frameName)) continue;
              const fr = frameData.frame;
              if (fr.x < rx0) rx0 = fr.x;
              if (fr.y < ry0) ry0 = fr.y;
              if (fr.x + fr.w > rx1) rx1 = fr.x + fr.w;
              if (fr.y + fr.h > ry1) ry1 = fr.y + fr.h;
            }
            if (rx1 > rx0) sheetPixels = readImagePixels(img, rx0, ry0, rx1 - rx0, ry1 - ry0);
          }

          // Stats for logging
          let trimmedCount = 0;
          let savedPixels = 0;

          // DX-SHADOW3D: each frame's footprint (floor px around its anchor), when the sheet's json has them: a render's
          // solid sweeps its cells north to it (sunShadowMap.js), as the light bench's heightmap did.
          const footprints = jsonData.meta?.footprints ?? jsonData.meta?.light3d?.footprints ?? null;
          // How its renders cast the sun's shadow: 'sprite', their card (the frame the sun sees); else their solid.
          const sunCard = (jsonData.meta?.shadowCast?.sun ?? jsonData.meta?.light3d?.cast?.sun) === 'sprite';
          let frameOrdinal = -1;

          // 2. Extract and optionally trim each frame
          for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
            frameOrdinal++;
            if (!requiredFrames.has(frameName)) continue;

            const prefixedName = `${sheetName}_${frameName}`;
            const frame = frameData.frame;
            const originalW = frame.w;
            const originalH = frame.h;

            // Default: no trimming
            let packedWidth = originalW;
            let packedHeight = originalH;
            let trimOffsetX = 0;
            let trimOffsetY = 0;
            let trimmed = false;

            // DX-SHADOW3D: where the frame stands (frameBase.js), from the pixels the trim reads anyway.
            let base = null;
            if (sheetPixels) {
              const px = sheetPixels;
              const ox = frame.x - px.x;
              const oy = frame.y - px.y;
              base = measureStandingBase(
                (i, j) => {
                  const x = ox + i;
                  const y = oy + j;
                  return x >= 0 && y >= 0 && x < px.width && y < px.height && px.data[(y * px.width + x) * 4 + 3] > 127;
                },
                originalW,
                originalH,
              );
            }

            if (sheetPixels) {
              const trimBounds = getTrimBoundsInPixels(sheetPixels, frame.x, frame.y, originalW, originalH, trimAlphaThreshold);

              if (trimBounds && (trimBounds.width < originalW || trimBounds.height < originalH)) {
                packedWidth = trimBounds.width;
                packedHeight = trimBounds.height;
                trimOffsetX = trimBounds.x;
                trimOffsetY = trimBounds.y;
                trimmed = true;
                trimmedCount++;
                savedPixels += (originalW * originalH) - (packedWidth * packedHeight);
              }
            }

            imagesToPack.push({
              name: prefixedName,
              // A frame is drawn from the sheet: the trimmed part of it, when it was trimmed
              sourceImg: img,
              sourceRect: trimmed
                ? { x: frame.x + trimOffsetX, y: frame.y + trimOffsetY, w: packedWidth, h: packedHeight }
                : frame,
              width: packedWidth,
              height: packedHeight,
              // PixiJS trim metadata: offset within original frame
              sourceX: trimOffsetX,
              sourceY: trimOffsetY,
              sourceWidth: originalW,   // Original frame size (for anchor calculations)
              sourceHeight: originalH,
              pivot: frameData.pivot,
              isSpritesheetFrame: true,
              isTrimmed: trimmed,
              // DX-MAPS: the sheet's height and normal maps (one object per sheet), read through the same sourceRect.
              maps,
              // E-496: the frame's rectangle in its sheet, untrimmed: sheets naming the same map files share the twin's
              // rectangle of a frame at the same place (_paintMapsPage).
              frameRect: frame,
              // The sheet's pixels the trim read (null without a trim): the twin page cuts the frame's colour from them
              // instead of reading the sheet back again.
              sheetPixels: maps ? sheetPixels : null,
              // DX-UNSHADED: no light touches the sheet's pixels (its json frame's `unshaded`, the maps table's mark);
              // H-EDGE: its frames may draw their solid pixels in DX-DEPTH's edge pass (FRAME_GLOW).
              unshaded,
              glow: unshaded,
              // DX-SHADOW3D: its base in its own pixels (untrimmed); a render's lowest contact replaces it (_paintMapsPage).
              base,
              // H-EDGE: what the drawn part's alphas hold (frameBase.js FRAME_SOFT, FRAME_HALF), from the pixels the trim read.
              texels: sheetPixels
                ? frameAlphaKinds(sheetPixels, frame.x + trimOffsetX, frame.y + trimOffsetY, packedWidth, packedHeight)
                : undefined,
              // E-448: its solid texels, which the opaque pass's cover counts.
              solidTexels: sheetPixels
                ? frameSolidTexels(sheetPixels, frame.x + trimOffsetX, frame.y + trimOffsetY, packedWidth, packedHeight)
                : undefined,
              footprint: Array.isArray(footprints) ? readFootprint(footprints[frameOrdinal]) : null,
              sunCard,
              renderDirections: isRenderDirections(config.directions ?? jsonDirections),
            });
          }

          // 3. Map included animations with prefixed names
          let proxyIndex = 0;
          for (const { animName, frameList } of animationsToProcess) {
            const prefixedAnimName = `${sheetName}_${animName}`;
            animations[prefixedAnimName] = frameList.map((f) => `${sheetName}_${f}`);

            proxySheets[sheetName].animations[animName] = {
              originalName: animName,
              prefixedName: prefixedAnimName,
              index: proxyIndex,
            };
            proxySheets[sheetName].indexToName[proxyIndex] = animName;
            proxyIndex++;
          }

          const totalFrames = requiredFrames.size;
          const savedKB = Math.round(savedPixels * 4 / 1024); // 4 bytes per pixel (RGBA)
          if (trimImages && trimmedCount > 0) {
            debugWorkerLog(
              `  ✅ Loaded spritesheet: ${sheetName} (${totalFrames} frames, ${trimmedCount} trimmed, ~${savedKB}KB saved)`
            );
          } else {
            debugWorkerLog(
              `  ✅ Loaded spritesheet: ${sheetName} (${totalFrames}/${Object.keys(jsonData.frames).length
              } frames, ${animationsToProcess.length} animations)`
            );
          }
        })
      );
    }
  }

  // Wait for all assets to load
  await Promise.all([...individualImagePromises, ...spritesheetPromises]);
  // SST-0: every source fetched, decoded and read back (trim, base, texels).
  loadMark('atlas sources');

  // Loads finish in network order; ids and indices must not (see orderAtlasByDeclaration).
  orderAtlasByDeclaration(assetsConfig, imagesToPack, animations, proxySheets);

  // The built-in textures (atlasBuiltins.js), after the scene's assets: _empty is animation index 0, so an accidental
  // textureId 0 draws nothing; DX-GLOWRADIUS: the glows unshaded where the halos join the entities (unshadedGlows).
  const builtinEntry = (b) => ({
    name: b.name,
    ...(b.unshaded !== undefined ? { unshaded: b.unshaded } : {}),
    sourceImg: b.image,
    sourceRect: null,
    width: b.image.width,
    height: b.image.height,
    sourceX: 0,
    sourceY: 0,
    sourceWidth: b.image.width,
    sourceHeight: b.image.height,
    isSpritesheetFrame: false,
  });
  for (const b of builtins) {
    if (b.afterSort) continue;
    imagesToPack.push(builtinEntry(b));
    if (b.name !== '_empty') animations[b.name] = [b.name];
  }

  // Sort images by size (largest first) for better packing
  imagesToPack.sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height));

  // DX-SPOT: a cone light's cookie, the light gradient's half disc. Packed after the sort, last, so no earlier frame
  // moves in the atlas, and its animation is the last built-in, so every earlier one keeps its index. The atlas
  // with it still samples a few hundred pixels of a scene 1/255 differently (any frame added does: dxCaptureScene
  // 389 to 519 of 921 600), the price of the frame.
  for (const b of builtins) {
    if (!b.afterSort) continue;
    imagesToPack.push(builtinEntry(b));
    animations[b.name] = [b.name];
  }

  // No need to wait for intermediate images anymore!
  // We now store references to source images and draw directly to final atlas.

  debugWorkerLog(`🎨 Packing ${imagesToPack.length} images into atlas...`);
  loadMark('atlas pack');

  // Pack all images
  let actualWidth = 0;
  let actualHeight = 0;
  let totalTrimmed = 0;
  let totalPixelsSaved = 0;

  for (const imgData of imagesToPack) {
    const rect = packer.insert(imgData.width, imgData.height, heuristic);

    if (!rect) {
      throw new Error(
        `Could not fit "${imgData.name}" into atlas. Try increasing maxWidth/maxHeight.`
      );
    }

    // Determine if this frame was trimmed (packed size differs from original size)
    const isTrimmed = imgData.width !== imgData.sourceWidth || imgData.height !== imgData.sourceHeight;
    if (isTrimmed) {
      totalTrimmed++;
      totalPixelsSaved += (imgData.sourceWidth * imgData.sourceHeight) - (imgData.width * imgData.height);
    }

    frames[imgData.name] = {
      frame: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      rotated: false,
      trimmed: isTrimmed,
      spriteSourceSize: {
        x: imgData.sourceX,
        y: imgData.sourceY,
        w: imgData.width,
        h: imgData.height,
      },
      sourceSize: { w: imgData.sourceWidth, h: imgData.sourceHeight },
    };

    if (imgData.pivot) {
      frames[imgData.name].pivot = imgData.pivot;
    }

    imgData.rect = rect;
    actualWidth = Math.max(actualWidth, rect.x + rect.width);
    actualHeight = Math.max(actualHeight, rect.y + rect.height);
  }

  // An atlas past 4096 a side is only possible when the scene raised maxAtlasWidth/Height past it (the packer stays
  // within them): its own choice, which the keys' docs (ASSETS_DEFAULTS) explain. It warned on every load, so a demo
  // mode packing 8190 px (Predator ?light3d=1) started with a warning.

  // The atlas's pixels: each frame drawn from its source at its rectangle (composeList: what a renderer composing the
  // atlas on the GPU draws). willReadFrequently: the decal textures read it back.
  loadMark('atlas draw');
  const compose = atlasComposeList(imagesToPack, actualWidth, actualHeight);
  const canvas = makeCanvas2d(actualWidth, actualHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, actualWidth, actualHeight);
  drawComposeList(ctx, compose);

  // DX-MAPS: the twin page, when a sheet has maps; the bake asks for its texels too (keepMapsTexels). E-496: the page
  // holds the frames with maps alone, each frame's window in its json frame (`maps`), its size in meta.mapsSize.
  const format = twinFormatFor(twinFormat, imagesToPack);
  loadMark('atlas maps');
  const twinA = paintMapsPage(
    imagesToPack, maxWidth, maxHeight, keepMapsTexels || format !== 'A' || !wantMapsCanvas, wantMapsCanvas && format === 'A',
  );
  // E-497: the page in its format (the windows stay in full-resolution texels; the shaders read through the format).
  const twin = twinA !== null && format !== 'A' ? twinPageIn(twinA, format, keepMapsTexels || !wantMapsCanvas, wantMapsCanvas) : twinA;
  const mapsCanvas = twin !== null ? twin.canvas : null;
  const mapsTexels = twin !== null ? twin.texels : null;
  if (twin !== null) {
    for (const d of imagesToPack) {
      if (!d.mapsAt || !frames[d.name]) continue;
      // Its marks: heights (a height map), relief (DX-RELIEF: a relief map and no height map).
      const at = { x: d.mapsAt.x, y: d.mapsAt.y };
      if (d.maps.heightImg) at.heights = true;
      else if (d.maps.reliefImg) at.relief = true;
      frames[d.name].maps = at;
    }
  }
  // DX-UNSHADED: an unshaded sheet's frames say so in their json frame (the maps table's mark), without a twin page.
  for (const d of imagesToPack) {
    if (d.unshaded === true && frames[d.name]) frames[d.name].unshaded = true;
  }
  // DX-SHADOW3D: each frame's base travels with its rectangle (the Pixi worker writes it into the texture table).
  for (const d of imagesToPack) {
    const b = d.base;
    if (!b || !frames[d.name]) continue;
    frames[d.name].base = b.contact >= 0
      ? (d.sunCard ? { contact: b.contact, heightPerRow: b.heightPerRow, card: true } : { contact: b.contact, heightPerRow: b.heightPerRow })
      : { cx: b.cx, rx: b.rx, ry: b.ry };
    // A render with its footprint casts its solid swept north to it (the Pixi worker's footprint texture).
    if (b.contact >= 0 && d.footprint) frames[d.name].footprint = d.footprint;
  }
  // H-EDGE: what each frame's texels hold, in its base too (the texture table keeps them a frame).
  markFrameTexels(frames, imagesToPack);

  // The individual textures' names, which the page registers as spritesheet ids (setSpritesheet("ball") works for a
  // static texture) before bigAtlas's: SpriteSheetRegistry.registerPackedAtlasIds.
  const individualTextures = [];
  for (const [name, url] of Object.entries(assetsConfig)) {
    if (name === 'spritesheets' || typeof url !== 'string') continue;
    individualTextures.push(name);
  }

  const atlasJson = {
    frames: frames,
    animations: animations,
    meta: {
      image: 'bigAtlas.png',
      format: 'RGBA8888',
      size: { w: actualWidth, h: actualHeight },
      scale: 1,
      proxySheets,
      individualTextures,
      maps: twin !== null,
      // E-496: the twin page's own size (each frame's window in it: its json frame's `maps`).
      ...(twin !== null ? { mapsSize: { w: twin.width, h: twin.height } } : {}),
      // E-497: the twin page's format, when it is not A (the renderer's setTwinFormat).
      ...(twin !== null && format !== 'A' ? { mapsFormat: format } : {}),
      // DX-UNSHADED: a sheet is unshaded (assets or its json's meta.unshaded): the Pixi worker runs the unshaded pass.
      unshaded: imagesToPack.some((d) => d.unshaded === true),
    },
  };

  // Log creation summary with trim stats
  const frameCount = Object.keys(frames).length;
  const animCount = Object.keys(animations).length;
  const savedKB = Math.round(totalPixelsSaved * 4 / 1024); // 4 bytes per RGBA pixel

  if (trimImages && totalTrimmed > 0) {
    debugWorkerLog(
      `✅ BigAtlas created: ${actualWidth}x${actualHeight} with ${frameCount} frames, ${animCount} animations\n` +
      `   📐 Trimming: ${totalTrimmed}/${frameCount} frames trimmed, ~${savedKB}KB saved`
    );
  } else {
    debugWorkerLog(
      `✅ BigAtlas created: ${actualWidth}x${actualHeight} with ${frameCount} frames, ${animCount} animations`
    );
  }
  // The decal textures (Scene.extractDecalTextures read them from this canvas on the page): every frame read once.
  const decalTextures = decals
    ? decalTexturesFrom(atlasJson, (x, y, w, h) => (w > 0 && h > 0 ? ctx.getImageData(x, y, w, h).data : new Uint8ClampedArray(0)))
    : null;
  loadMark('atlas built');

  return {
    canvas: canvas,
    mapsCanvas,
    mapsTexels: twin !== null ? mapsTexels : null,
    mapsSize: twin !== null ? { w: twin.width, h: twin.height } : null,
    json: atlasJson,
    proxySheets: proxySheets,
    individualTextures: individualTextures, // For reference
    decals: decalTextures,
  };
}

/**
 * The draws that compose a packed atlas, in pack order: each placed frame's source (an image, a sheet, a canvas or their
 * ImageBitmap) and the rectangle of it drawn at the frame's rectangle, at 1:1. The CPU path draws them into a 2D canvas
 * (drawComposeList); a renderer composing the atlas on the GPU draws the same list into an empty texture of
 * width × height (each source uploaded once, each draw a copy of its rectangle).
 * @param {Array<{ rect?: { x: number, y: number, width: number, height: number }, sourceImg: object,
 *   sourceRect: { x: number, y: number, w: number, h: number } | null }>} imagesToPack
 * @param {number} width
 * @param {number} height
 * @returns {{ width: number, height: number, sources: object[], draws: Int32Array }} draws: 7 ints a draw, (source index,
 *   sx, sy, w, h, dx, dy)
 */
export function atlasComposeList(imagesToPack, width, height) {
  const sources = [];
  const index = new Map();
  const draws = [];
  for (const d of imagesToPack) {
    if (!d.rect) continue;
    let i = index.get(d.sourceImg);
    if (i === undefined) {
      i = sources.length;
      sources.push(d.sourceImg);
      index.set(d.sourceImg, i);
    }
    const sr = d.sourceRect;
    draws.push(i, sr ? sr.x : 0, sr ? sr.y : 0, d.rect.width, d.rect.height, d.rect.x, d.rect.y);
  }
  return { width, height, sources, draws: Int32Array.from(draws) };
}

/**
 * Draw a compose list into a 2D context, as createBigAtlas drew the atlas before SST-5: a sheet's frame through its
 * source rectangle, an image or canvas whole.
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof atlasComposeList>} list
 */
export function drawComposeList(ctx, list) {
  const { sources, draws } = list;
  for (let k = 0; k < draws.length; k += 7) {
    const img = sources[draws[k]];
    const w = draws[k + 3];
    const h = draws[k + 4];
    ctx.drawImage(img, draws[k + 1], draws[k + 2], w, h, draws[k + 5], draws[k + 6], w, h);
  }
}

/**
 * DX-MAPS: the atlas's twin page (spriteMaps.js). E-496: it holds the frames with maps alone, not the atlas's whole size:
 * each frame's heights and normals in a rectangle of the page, which frames of sheets naming the same map files share
 * (the same map pixels, at the same place of their sheets: the untrimmed frameRect), the union of their trims, each
 * frame's window in it its own trim (d.mapsAt, its top left in the page). The opaque pixels a shared rectangle holds maps
 * for are those of every frame in it (a frame's own colour still decides what it draws). The rectangles are TWIN_PAD
 * texels apart from each other and from the page's edges, at even texels and with even sizes (the Sobel's taps read
 * zeros past them; E-497's half resolution splits no rectangle). Each sheet's colour and maps are read back once, each
 * frame cut out of them in memory.
 * @param {Array<object>} imagesToPack the atlas's frames (createBigAtlas), placed (`rect`)
 * @param {number} maxWidth the page's largest width (the atlas's)
 * @param {number} maxHeight
 * @param {boolean} [keep] also return the texels as they are (`texels`: the bake, and the packed page's bitmap; its 2D
 *   canvas keeps premultiplied alpha, which loses a height under a low A)
 * @param {boolean} [withCanvas] the page as a 2D canvas too (default: true); false (with keep) leaves canvas null
 * @returns {{ canvas: HTMLCanvasElement|OffscreenCanvas|null, texels: Uint8ClampedArray|null, width: number, height: number }
 *   | null} null when no sheet has maps
 */
export function paintMapsPage(imagesToPack, maxWidth, maxHeight, keep = false, withCanvas = true) {
  const withMaps = imagesToPack.filter((d) => d.maps && d.rect && d.sourceRect);
  if (withMaps.length === 0) return null;
  const read = new Map();
  const pixelsOf = (img) => {
    if (!img) return null;
    let px = read.get(img);
    if (px === undefined) read.set(img, (px = readImagePixels(img)));
    return px;
  };
  // A rectangle of read pixels, a row at a time; outside them transparent.
  const cut = (px, sr) => cutPixels(px, sr.x, sr.y, sr.w, sr.h);
  // A frame's colour: from the pixels its sheet's trim read (they hold every frame it keeps), else its sheet read back.
  const colourPixelsOf = (d) => d.sheetPixels || pixelsOf(d.sourceImg);
  // A sheet's maps say which files they are (_loadSpritesheet's key); maps without one are their own.
  const ids = new Map();
  const keyOf = (maps) => {
    if (typeof maps.key === 'string') return maps.key;
    let id = ids.get(maps);
    if (id === undefined) ids.set(maps, (id = `#${ids.size}`));
    return id;
  };
  const groups = new Map();
  const colours = new Map();
  for (const d of withMaps) {
    const sr = d.sourceRect;
    const w = sr.w | 0;
    const h = sr.h | 0;
    if (w <= 0 || h <= 0 || w !== d.rect.width || h !== d.rect.height) continue;
    const tx = d.sourceX | 0;
    const ty = d.sourceY | 0;
    const fr = d.frameRect || { x: sr.x - tx, y: sr.y - ty, w: d.sourceWidth | 0, h: d.sourceHeight | 0 };
    const key = `${keyOf(d.maps)}|${fr.x},${fr.y},${fr.w},${fr.h}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { members: [], fr, maps: d.maps, x0: tx, y0: ty, x1: tx + w, y1: ty + h, texels: null, x: 0, y: 0 };
      groups.set(key, g);
    }
    g.members.push(d);
    if (tx < g.x0) g.x0 = tx;
    if (ty < g.y0) g.y0 = ty;
    if (tx + w > g.x1) g.x1 = tx + w;
    if (ty + h > g.y1) g.y1 = ty + h;
  }
  const placed = [];
  for (const g of groups.values()) {
    const gw = g.x1 - g.x0;
    const gh = g.y1 - g.y0;
    // The union of its frames' opaque pixels, in the rectangle's own texels.
    const opaque = new Uint8Array(gw * gh);
    for (const d of g.members) {
      const sr = d.sourceRect;
      const color = cut(colourPixelsOf(d), sr);
      colours.set(d, color);
      const mask = opaqueMask(color, sr.w, sr.h);
      const ox = (d.sourceX | 0) - g.x0;
      const oy = (d.sourceY | 0) - g.y0;
      for (let y = 0; y < sr.h; y++) {
        for (let x = 0; x < sr.w; x++) if (mask[y * sr.w + x] !== 0) opaque[(oy + y) * gw + ox + x] = 1;
      }
    }
    const src = { x: g.fr.x + g.x0, y: g.fr.y + g.y0, w: gw, h: gh };
    g.texels = maskTwinTexels({
      opaque,
      height: g.maps.heightImg ? cut(pixelsOf(g.maps.heightImg), src) : null,
      normal: g.maps.normalImg ? cut(pixelsOf(g.maps.normalImg), src) : null,
      relief: g.maps.reliefImg ? cut(pixelsOf(g.maps.reliefImg), src) : null,
      w: gw,
      h: gh,
      gray: g.maps.gray,
      reliefStrength: g.maps.reliefStrength,
      heightScale: g.maps.heightScale ?? 1,
    });
    if (g.texels !== null) placed.push(g);
  }
  // DX-SHADOW3D: a render stands on its contact nearest the light (frameBase.js), in its untrimmed frame's rows: its own
  // colour's opaque pixels, its own trim of the heights.
  for (const g of groups.values()) {
    if (!g.maps.heightImg) continue;
    for (const d of g.members) {
      if (!d.renderDirections) continue;
      const sr = d.sourceRect;
      const opaque = opaqueMask(colours.get(d), sr.w, sr.h);
      const heights = readHeights(cut(pixelsOf(g.maps.heightImg), sr), sr.w, sr.h, g.maps.gray);
      const k = g.maps.heightScale ?? 1;
      if (k !== 1) for (let p = 0; p < heights.length; p++) heights[p] *= k;
      const isOpaque = (i, j) => opaque[j * sr.w + i] !== 0;
      const heightAt = (i, j) => heights[j * sr.w + i];
      const lowest = measureLowestContact(isOpaque, heightAt, sr.w, sr.h);
      // N-297: and how much of its picture is height, for the card it casts (frameBase.js measureHeightPerRow).
      if (lowest !== null) {
        d.base = { contact: lowest + (d.sourceY | 0), heightPerRow: measureHeightPerRow(isOpaque, heightAt, sr.w, sr.h, lowest) };
      }
    }
  }
  if (placed.length === 0) return null;
  placed.sort((a, b) => Math.max(b.x1 - b.x0, b.y1 - b.y0) - Math.max(a.x1 - a.x0, a.y1 - a.y0));
  const packer = new MaxRectsPacker(maxWidth, maxHeight, TWIN_PAD);
  let right = 0;
  let bottom = 0;
  for (const g of placed) {
    const r = packer.insert(evenTexels(g.x1 - g.x0), evenTexels(g.y1 - g.y0), 'best-short-side');
    if (!r) throw new Error(`The twin page (height and normal maps) does not fit in ${maxWidth}x${maxHeight}: raise maxAtlasWidth/maxAtlasHeight.`);
    g.x = r.x;
    g.y = r.y;
    if (r.x + r.width > right) right = r.x + r.width;
    if (r.y + r.height > bottom) bottom = r.y + r.height;
  }
  const width = evenTexels(right + TWIN_PAD);
  const height = evenTexels(bottom + TWIN_PAD);
  const page = withCanvas || !keep ? makeCanvas2d(width, height) : null;
  const ctx = page !== null ? page.getContext('2d', { willReadFrequently: true }) : null;
  const texels = keep ? new Uint8ClampedArray(width * height * 4) : null;
  for (const g of placed) {
    const gw = g.x1 - g.x0;
    const gh = g.y1 - g.y0;
    if (ctx !== null) ctx.putImageData(new ImageData(g.texels, gw, gh), g.x, g.y);
    if (texels !== null) {
      for (let y = 0; y < gh; y++) texels.set(g.texels.subarray(y * gw * 4, (y + 1) * gw * 4), ((g.y + y) * width + g.x) * 4);
    }
    for (const d of g.members) d.mapsAt = { x: g.x + (d.sourceX | 0) - g.x0, y: g.y + (d.sourceY | 0) - g.y0 };
  }
  return { canvas: page, texels, width, height };
}

/**
 * E-497: the twin page's format for an atlas: the one asked for (assets.twinFormat), but A where it is no format, or for
 * B where a sheet brings a normal map (B keeps heights alone), said once.
 */
export function twinFormatFor(asked, imagesToPack) {
  if (asked !== 'A' && asked !== 'B' && asked !== 'C') {
    if (asked !== undefined && asked !== null) console.warn(`WeedJS: assets.twinFormat is 'A', 'B' or 'C', not ${JSON.stringify(asked)}: the twin page is A`);
    return 'A';
  }
  if (asked === 'B' && imagesToPack.some((d) => d.maps && d.maps.normalImg)) {
    console.warn("WeedJS: assets.twinFormat 'B' keeps heights alone, and a sheet brings a normal map: the twin page is A");
    return 'A';
  }
  return asked;
}

/** E-497: a format-A twin page (_paintMapsPage's, with its texels) in format B or C, its canvas and (`keep`) texels. */
export function twinPageIn(twin, format, keep, withCanvas = true) {
  const page = twinPageInFormat(twin.texels, twin.width, twin.height, format);
  let canvas = null;
  if (withCanvas || !keep) {
    canvas = makeCanvas2d(page.width, page.height);
    canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(page.texels, page.width, page.height), 0, 0);
  }
  return { canvas, texels: keep ? page.texels : null, width: page.width, height: page.height };
}

/**
 * H-EDGE: each packed frame's `base.texels` in the atlas's json (frameBase.js FRAME_SOFT, FRAME_HALF, FRAME_GLOW), for
 * the texture table (instancedSpriteBatch.js buildTextureLut): its alphas as the scans found them (d.texels: the frame's
 * drawn rectangle of its sheet, or its image), and FRAME_GLOW when its sheet is unshaded (d.glow: DX-UNSHADED, the
 * sheet's mark). A frame no scan read keeps no key (FRAME_UNSCANNED in the table).
 * @param {Record<string, { base?: object }>} frames the atlas's json frames
 * @param {Array<{ name: string, texels?: number, glow?: boolean }>} imagesToPack
 */
export function markFrameTexels(frames, imagesToPack) {
  for (const d of imagesToPack) {
    const f = frames[d.name];
    if (!f || typeof d.texels !== 'number') continue;
    f.base = { ...(f.base || {}), texels: d.texels | (d.glow === true ? FRAME_GLOW : 0) };
    // E-448: its solid texels (alpha 255), which the opaque pass's cover counts.
    if (typeof d.solidTexels === 'number') f.base.solidTexels = d.solidTexels;
  }
}

/**
 * Helper: Load an image from URL
 * @private
 */
export async function loadImage(url) {
  // Workers (and some environments) have no HTMLImageElement — use fetch + ImageBitmap.
  if (typeof Image === 'undefined') {
    const { body } = await fetchAssetRead(url, 'image', (r) => r.blob());
    return createImageBitmap(body);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    // DX-GUARDS C6: an <img> error carries no status; the error names the URL and asks the server for it.
    img.onerror = () => imageLoadError(url).then(reject);
    img.src = url;
  });
}

/**
 * Helper: Find the tight bounding box of non-transparent pixels in an image
 * Returns { x, y, width, height } of the content area, or null if fully transparent
 * @private
 * @param {HTMLImageElement|HTMLCanvasElement} img - Image to analyze
 * @param {number} alphaThreshold - Pixels with alpha <= this are considered transparent (0-255)
 * @returns {{x: number, y: number, width: number, height: number} | null}
 */
/** The trim's reused canvas (getTrimBounds). */
let trimCanvas = null;
let trimCtx = null;

export function getTrimBounds(img, alphaThreshold = 0) {
  // Draw image to canvas to read pixel data
  const w = img.width;
  const h = img.height;
  if (w === 0 || h === 0) return null;

  // Reuse trim canvas if available
  if (!trimCanvas) {
    trimCanvas = makeCanvas2d(w, h);
    trimCtx = trimCanvas.getContext('2d', { willReadFrequently: true });
  }
  const canvas = trimCanvas;
  const ctx = trimCtx;

  // Resize if needed
  if (canvas.width < w || canvas.height < h) {
    canvas.width = w;
    canvas.height = h;
  }

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  // H-EDGE: what its alphas hold (frameBase.js FRAME_SOFT, FRAME_HALF); E-448: how many are solid (255).
  let kinds = 0;
  let solid = 0;

  // Scan for non-transparent pixels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const alpha = data[(y * w + x) * 4 + 3];
      if (alpha !== 0 && alpha !== 255) kinds |= alpha < 128 ? FRAME_SOFT : FRAME_HALF;
      else if (alpha === 255) solid++;
      if (alpha > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // Check if any non-transparent pixels were found
  if (maxX < 0 || maxY < 0) {
    return null; // Fully transparent image
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    kinds,
    solid,
  };
}

/**
 * Helper: Get trim bounds from an already-drawn canvas context
 * Avoids redundant drawImage calls when extracting spritesheet frames
 * @private
 * @param {CanvasRenderingContext2D} ctx - Canvas context with image already drawn
 * @param {number} width - Width of drawn area
 * @param {number} height - Height of drawn area
 * @param {number} alphaThreshold - Pixels with alpha <= this are considered transparent
 * @returns {{x: number, y: number, width: number, height: number} | null}
 */
/**
 * An image's RGBA pixels in a rectangle, clamped to the image, read back once: { data, x, y, width, height }, where
 * data holds the rows of the clamped rectangle.
 */
export function readImagePixels(img, rx = 0, ry = 0, rw = img.width, rh = img.height) {
  const x = Math.max(0, Math.floor(rx));
  const y = Math.max(0, Math.floor(ry));
  const width = Math.max(1, Math.min(img.width, Math.ceil(rx + rw)) - x);
  const height = Math.max(1, Math.min(img.height, Math.ceil(ry + rh)) - y);
  const canvas = makeCanvas2d(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
  return { data: ctx.getImageData(0, 0, width, height).data, x, y, width, height };
}

/**
 * The visible part of a frame (alpha above the threshold) in an image's pixels, relative to the frame; outside the
 * image counts as transparent, as a frame drawn on its own canvas would. Null when the frame is all transparent.
 */
export function getTrimBoundsInPixels(pixels, fx, fy, width, height, alphaThreshold = 0) {
  const data = pixels.data;
  const iw = pixels.width;
  // The frame's origin in the read rectangle; what lies outside it lies outside the image.
  const ox = fx - pixels.x;
  const oy = fy - pixels.y;
  const x0 = Math.max(0, -ox);
  const y0 = Math.max(0, -oy);
  const x1 = Math.min(width, iw - ox);
  const y1 = Math.min(height, pixels.height - oy);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++) {
    const row = ((oy + y) * iw + ox) * 4 + 3;
    for (let x = x0; x < x1; x++) {
      if (data[row + x * 4] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Helper: Trim transparent pixels from an image
 * Returns a new canvas with trimmed content and the trim bounds
 * @private
 * @param {HTMLImageElement|HTMLCanvasElement} img - Image to trim
 * @param {number} alphaThreshold - Pixels with alpha <= this are trimmed
 * @returns {{canvas: HTMLCanvasElement, bounds: {x, y, width, height}} | null}
 */
export function trimImage(img, alphaThreshold = 0) {
  const bounds = getTrimBounds(img, alphaThreshold);
  if (!bounds) return null; // Fully transparent

  // If no trimming needed (bounds = full image), return original
  if (bounds.x === 0 && bounds.y === 0 &&
    bounds.width === img.width && bounds.height === img.height) {
    return { canvas: img, bounds, wasTrimmed: false };
  }

  // Create trimmed canvas
  const trimmedCanvas = makeCanvas2d(bounds.width, bounds.height);
  const trimmedCtx = trimmedCanvas.getContext('2d');

  trimmedCtx.drawImage(
    img,
    bounds.x, bounds.y, bounds.width, bounds.height,
    0, 0, bounds.width, bounds.height
  );

  return { canvas: trimmedCanvas, bounds, wasTrimmed: true };
}

/**
 * Helper: Load a spritesheet (JSON + PNG)
 * @private
 */
export async function loadSpritesheet(name, config) {
  if (config.jsonData && config.img) {
    return { img: config.img, jsonData: config.jsonData };
  }

  if (!config.json || !config.png) {
    throw new Error(`Invalid spritesheet config for "${name}": missing json or png`);
  }

  // DX-GUARDS C6: a 404 used to reach .json() and read "Unexpected token '<'".
  const heightSpec = config.heightMap;
  const heightUrl = typeof heightSpec === 'string' ? heightSpec : heightSpec?.png;
  // DX-RELIEF: a greyscale relief map, `{ png, strength }` (or its url): its normals, its surface's height.
  const reliefSpec = config.reliefMap;
  const reliefUrl = typeof reliefSpec === 'string' ? reliefSpec : reliefSpec?.png;
  const [jsonData, img, heightImg, normalImg, reliefImg] = await Promise.all([
    fetchAssetJson(config.json, `spritesheet "${name}" JSON`),
    loadImage(config.png),
    // DX-MAPS: the sheet's twins, same frames in the same places.
    heightUrl ? loadImage(heightUrl) : null,
    config.normalMap ? loadImage(config.normalMap) : null,
    reliefUrl ? loadImage(reliefUrl) : null,
  ]);
  // DX-UNSHADED: a sheet no light touches (its assets config or its json's meta): a mark a frame in the maps table, no
  // twin page.
  const unshaded = config.unshaded === true || jsonData?.meta?.unshaded === true;
  const gray = Number(heightSpec?.gray) > 0 ? Number(heightSpec.gray) : 0;
  const reliefStrength = Number(reliefSpec?.strength) > 0 ? Number(reliefSpec.strength) : RELIEF_STRENGTH;
  // E-496: which map files these are: sheets with the same key share the twin page's rectangles (_paintMapsPage).
  const key = JSON.stringify([heightUrl || '', config.normalMap || '', gray, reliefUrl || '', reliefUrl ? reliefStrength : 0]);
  const maps = heightImg || normalImg || reliefImg ? { heightImg, normalImg, reliefImg, gray, reliefStrength, key, heightScale: 1 } : null;
  // DX-MAPCAMERA: the camera its art was drawn for: its assets entry's, else its json's (createBigAtlas scales to it).
  const artCamera = readArtCamera(config.artCamera) ?? readArtCamera(jsonData?.meta?.artCamera);
  return { img, jsonData, maps, unshaded, artCamera };
}
