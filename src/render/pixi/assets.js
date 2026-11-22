/**
 * N-256 PW-1: the renderer's assets, moved out of pixiWorker.js as they were. The textures the init message brings (the
 * atlas and its twin page, the loose textures, the tilesets), the atlas sheets the page posts earlier (SST-19), and the
 * tables made from the atlas: the texture lookup (per textureId UV, trim and orig, folded past TEX_LUT_MAX_ROWS), the
 * renders' footprints, the maps table (E-496) and the GPU particles' animation lookup, uploaded together.
 *
 * The worker owns the batches and programs these are bound to: rebuildTextureLut builds the tables, and the worker's
 * rebuildInstancedTextureLut points its batches at them. Until the renderer's other subsystems move (N-256), what this
 * class reads of the worker (its renderer, backend and config, the programs the footprints and the maps table are
 * bound to) goes through `this.worker`.
 */

import { GpuParticles } from '../../core/gpuParticles.js';
import { SpriteSheetRegistry } from '../../core/spriteSheetRegistry.js';
import { debugWorkerLog } from '../../util/debugLog.js';
import { loadMark } from '../../util/loadMarks.js';
import { ImageSource, Rectangle, Texture, TextureSource } from '../../vendor/pixi.min.js';
import { proxyTexturesByPrefix } from '../atlasProxyTextures.js';
import { FOOTPRINT_TEXELS, writeFootprintRow } from '../frameBase.js';
import { packAnimStartLookup } from '../gpuParticleBatch.js';
import { TEX_LUT_RGBA_WIDTH, buildTextureLut, packTextureLutRgba, textureLutLayout } from '../instancedSpriteBatch.js';
import { packMapsTable } from '../mapsTable.js';
import { setTwinFormat } from '../twinTexel.js';
import { writeRgba32Float } from '../webgpu/pinGpuTexture.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ ImageSource, Rectangle, Texture, TextureSource });

/** The atlas, the textures and their tables, for one renderer worker. */
export class PixiAssets {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, backend, config and batches) */
  constructor(worker) {
    this.worker = worker;
    this.texLut = null;
    this.texLutCount = 0;
    this.texLutSource = null;
    this.texLutRgba = null;
    // N-111: the LUT texture's size (textureLutLayout), folded past TEX_LUT_MAX_ROWS textureIds.
    this.texLutWidth = TEX_LUT_RGBA_WIDTH;
    this.texLutHeight = 1;
    this.texLutNeedsGpuUpload = false;
    // DX-SHADOW3D: the renders' footprints (frameBase.js writeFootprintRow), a row each, uploaded with the LUT; a row
    // of nothing (count 0) when no frame has one, so the column programs always have the texture.
    this.footSource = null;
    this.footRgba = new Float32Array(0);
    this.footRows = 1;
    // E-496: the maps table (src/render/mapsTable.js), each frame's window in the twin page and its marks, a texel a
    // textureId, uploaded with the LUT; a texel of nothing before the atlas, so its readers always have the texture.
    this.mapsTableSource = null;
    this.mapsTableRgba = new Float32Array(0);
    this.mapsTableWidth = 1;
    this.mapsTableHeight = 1;
    // A baked atlas from before E-496: its twin page has the atlas's layout, so every frame reads at its atlas texel.
    this.mapsAtlasLayout = false;
    // GPU particle layers (LAYER_KIND.GPU_PARTICLES): animation index -> atlas lookup id, as RGBA32F (red).
    this.gpuAnimStartSource = null;
    this.gpuAnimStartRgba = new Float32Array(0);
    this.gpuAnimStartWidth = 0;
    this.gpuAnimStartHeight = 0;
    // Texture and spritesheet storage
    this.textures = {}; // Store simple PIXI textures by name
    this.spritesheets = {}; // Store loaded spritesheets by name
    this.tilemaps = {}; // Store PIXI tileset textures by tilemap name (tile data comes from TileMap SAB)
    // ========================================
    // All textures flattened into single array for O(1) lookup
    // Index = globalTextureId from pre_render_worker
    this.flatTextures = [];           // PIXI.Texture[] indexed by globalTextureId
    this.animationFrameStart = [];    // Starting index in flatTextures for each animation
    this.animationFrameCount = [];    // Number of frames per animation
    this.atlasUnshaded = false;
    this.atlasMapsSource = null; // DX-MAPS: the atlas's twin page (src/render/spriteMaps.js), when a sheet has maps
    /**
     * SST-19: the atlas sheets' pictures the page posted before the init ('atlasBitmaps'), by sheet name:
     * { imageBitmap, mapsBitmap, source, mapsSource }, the sources made and uploaded once the renderer is booted;
     * loadSpritesheets takes them. Empty after it.
     */
    this.earlyAtlas = {};
  }

  /**
   * Load simple textures from transferred ImageBitmaps
   * PixiJS 8: Uses ImageSource instead of BaseTexture
   */
  loadTextures(texturesData) {
    if (!texturesData) return;

    // console.log(
    //   `PIXI WORKER: Loading ${Object.keys(texturesData).length} textures`
    // );

    for (const [name, imageBitmap] of Object.entries(texturesData)) {
      // PixiJS 8: Create TextureSource from ImageBitmap, then create Texture
      const source = new PIXI.ImageSource({
        resource: imageBitmap,
        autoGenerateMipmaps: this.worker.autoGenerateMipmaps,
        scaleMode: this.worker.atlasScaleMode,
      });
      if (source.style) source.style.scaleMode = this.worker.atlasScaleMode;
      this.textures[name] = new PIXI.Texture({ source });

      // console.log(`✅ Loaded texture: ${name}`);
    }
  }

  /**
   * Load spritesheets from JSON + texture data
   * NOTE: PIXI.Spritesheet.parse() doesn't work in workers, so we manually build animations
   */
  loadSpritesheets(spritesheetData, proxySheets = {}) {
    if (!spritesheetData) {
      // console.log("PIXI WORKER: No spritesheets to load");
      return;
    }

    // console.log(
    //   `PIXI WORKER: Loading ${Object.keys(spritesheetData).length} spritesheets`
    // );

    for (const [name, data] of Object.entries(spritesheetData)) {
      try {
        // console.log(`  Loading spritesheet "${name}"...`);

        // SST-19: the pictures the page posted before the init, uploaded already (or made here if not yet).
        const early = this.earlyAtlas[name] || null;
        if ((!data.imageBitmap && !early) || !data.json) {
          throw new Error(`Missing imageBitmap or json for ${name}`);
        }
        const source = early !== null
          ? (early.source ?? (early.source = this._atlasSourceOf(early.imageBitmap)))
          : this._atlasSourceOf(data.imageBitmap);
        const jsonData = data.json;

        // Manually create textures for each frame. SST-7 step 4: one frame rectangle and one options object for all of
        // them (a Texture copies its frame; orig and trim it keeps, a Rectangle each).
        const frameTextures = {};
        const frameRect = new PIXI.Rectangle();
        const textureOptions = { source, frame: frameRect, orig: undefined, trim: undefined };
        for (const frameName in jsonData.frames) {
          const frameData = jsonData.frames[frameName];
          const frame = frameData.frame;
          const sourceSize = frameData.sourceSize;
          const spriteSourceSize = frameData.spriteSourceSize;
          frameRect.x = frame.x;
          frameRect.y = frame.y;
          frameRect.width = frame.w;
          frameRect.height = frame.h;

          // If frame is trimmed, add orig and trim for proper anchor handling
          // PixiJS uses these to offset the sprite so anchors work relative to original size
          if (sourceSize && spriteSourceSize &&
            (sourceSize.w !== frame.w || sourceSize.h !== frame.h)) {
            textureOptions.orig = new PIXI.Rectangle(0, 0, sourceSize.w, sourceSize.h);
            textureOptions.trim = new PIXI.Rectangle(
              spriteSourceSize.x, spriteSourceSize.y,
              spriteSourceSize.w, spriteSourceSize.h
            );
          } else {
            textureOptions.orig = undefined;
            textureOptions.trim = undefined;
          }

          const texture = new PIXI.Texture(textureOptions);
          // DX-SHADOW3D: where the frame stands (frameBase.js); writeLutSlot puts it in the texture table's spare floats.
          if (frameData.base) texture.weedBase = frameData.base;
          // E-496: its window in the twin page (the maps table, _buildMapsTable); DX-UNSHADED: its sheet's mark.
          if (frameData.maps) texture.weedMaps = frameData.maps;
          if (frameData.unshaded === true) texture.weedUnshaded = true;
          // A render's footprint: its solid sweeps north to it (_buildFootprintTexture).
          if (frameData.footprint) texture.weedFootprint = frameData.footprint;
          frameTextures[frameName] = texture;
        }

        // Manually build animation arrays
        const animations = {};
        if (jsonData.animations) {
          for (const [animName, frameNames] of Object.entries(jsonData.animations)) {
            animations[animName] = frameNames.map((frameName) => frameTextures[frameName]);
          }
        }

        // Store as a spritesheet-like object
        this.spritesheets[name] = {
          textures: frameTextures,
          animations: animations,
          source: source, // PixiJS 8: uses source instead of baseTexture
        };

        // BIGATLAST SUPPORT: If this is the bigAtlas, also populate this.textures
        // This allows static textures (like "bunny") to be accessed directly
        if (name === 'bigAtlas') {
          for (const [frameName, texture] of Object.entries(frameTextures)) {
            this.textures[frameName] = texture;
          }
          // DX-MAPS: the atlas's twin page (heights and normals at the same rectangles), data: nearest, no mipmaps,
          // no premultiplied alpha. The G-buffer pass samples it with the colour's UV.
          // DX-UNSHADED: a sheet of the atlas is unshaded (spriteSheetRegistry createBigAtlas's meta.unshaded).
          this.atlasUnshaded = jsonData.meta?.unshaded === true;
          // E-497: the twin page's format (meta.mapsFormat; A without one), before any of its readers' programs is made.
          setTwinFormat(jsonData.meta?.mapsFormat);
          // E-496: a twin page without frame windows is a bake's from before them, laid out as the atlas.
          this.mapsAtlasLayout = jsonData.meta?.maps === true && !Object.values(jsonData.frames).some((f) => f && f.maps);
          const mapsBitmap = data.mapsBitmap || early?.mapsBitmap || null;
          if (mapsBitmap) {
            this.atlasMapsSource = early?.mapsSource ?? this._atlasMapsSourceOf(mapsBitmap);
          }

          const textureKeys = Object.keys(frameTextures);

          debugWorkerLog(
            `✅ BigAtlas loaded: ${Object.keys(frameTextures).length} frames available as textures`
          );

          // DEBUG: Check if _lightGradient texture is available
          if (this.textures['_lightGradient']) {
            debugWorkerLog(`✅ PIXI WORKER: _lightGradient texture found in BigAtlas textures`);
          } else {
            console.warn(`⚠️ PIXI WORKER: _lightGradient texture NOT found in BigAtlas textures`);
            debugWorkerLog(`   Available texture keys (first 20):`, textureKeys.slice(0, 20));
            debugWorkerLog(
              `   Looking for textures with "light" or "gradient" in name:`,
              textureKeys.filter(
                (k) => k.toLowerCase().includes('light') || k.toLowerCase().includes('gradient')
              )
            );
          }

          // ========================================
          // BUILD FLAT TEXTURE LOOKUP ARRAY
          // ========================================
          // Flatten all animation frames into single array for O(1) lookup
          // pre_render writes textureId; pixi uploads via texLut / InstancedSpriteBatch
          this.flatTextures = [];
          this.animationFrameStart = [];
          this.animationFrameCount = [];

          // Get animation names in consistent order (same as SpriteSheetRegistry)
          const animNames = Object.keys(animations);
          for (let animIdx = 0; animIdx < animNames.length; animIdx++) {
            const animName = animNames[animIdx];
            const frames = animations[animName];

            this.animationFrameStart[animIdx] = this.flatTextures.length;
            this.animationFrameCount[animIdx] = frames.length;

            for (let f = 0; f < frames.length; f++) {
              this.flatTextures.push(frames[f]);
            }
          }

          debugWorkerLog(`✅ Built flat texture array: ${this.flatTextures.length} textures, ${animNames.length} animations`);
          loadMark('atlas textures');

          this.worker.rebuildInstancedTextureLut();
          loadMark('texture lut');
        }

        // console.log(
        //   `✅ Loaded spritesheet: ${name} with ${
        //     Object.keys(animations).length
        //   } animations`
        // );
      } catch (error) {
        console.error(`❌ Failed to load spritesheet ${name}:`, error);
      }
    }

    // Create proxy spritesheet entries that redirect to bigAtlas
    if (proxySheets && Object.keys(proxySheets).length > 0) {
      debugWorkerLog(`🔗 Creating ${Object.keys(proxySheets).length} proxy spritesheets...`);

      const bigAtlas = this.spritesheets.bigAtlas;
      if (!bigAtlas) {
        console.error('❌ Cannot create proxy sheets: bigAtlas not loaded!');
        return;
      }

      const texturesByPrefix = proxyTexturesByPrefix(bigAtlas.textures, proxySheets);
      for (const [proxyName, proxyData] of Object.entries(proxySheets)) {
        // Extract animations from bigAtlas that match this proxy's prefix
        const proxyAnimations = {};
        const proxyTextures = texturesByPrefix.get(proxyData.prefix);

        for (const [animName, animInfo] of Object.entries(proxyData.animations)) {
          const prefixedName = animInfo.prefixedName;
          if (bigAtlas.animations[prefixedName]) {
            // Map unprefixed name to bigAtlas animation
            proxyAnimations[animName] = bigAtlas.animations[prefixedName];
          } else {
            console.warn(
              `⚠️ Proxy "${proxyName}": Animation "${animName}" (${prefixedName}) not found in bigAtlas`
            );
          }
        }

        // Create proxy spritesheet entry (for PIXI rendering)
        this.spritesheets[proxyName] = {
          textures: proxyTextures,
          animations: proxyAnimations,
          source: bigAtlas.source, // PixiJS 8: uses source instead of baseTexture
          isProxy: true,
          targetSheet: 'bigAtlas',
        };

        // Also register in SpriteSheetRegistry (for animation lookups)
        SpriteSheetRegistry.registerProxy(proxyName, proxyData);

        debugWorkerLog(`  ✅ Proxy "${proxyName}": ${Object.keys(proxyAnimations).length} animations`);
      }
    }

    // console.log("PIXI WORKER: Finished loading all spritesheets");
    loadMark('proxy sheets');
  }

  /**
   * Load tileset bitmaps and create PIXI Textures for tilemap rendering.
   * Tile data is accessed via TileMap static class (SAB-backed, initialized by AbstractWorker).
   */
  loadTilesetBitmaps(tilesetBitmaps) {
    if (!tilesetBitmaps || Object.keys(tilesetBitmaps).length === 0) {
      return;
    }

    debugWorkerLog(`PIXI WORKER: Loading ${Object.keys(tilesetBitmaps).length} tileset textures...`);

    for (const [tilemapId, bitmap] of Object.entries(tilesetBitmaps)) {
      try {
        const source = new PIXI.ImageSource({
          resource: bitmap,
          autoGenerateMipmaps: false,
          scaleMode: 'linear',
        });
        if (source.style) {
          source.style.scaleMode = 'linear';
          source.style.addressMode = 'clamp-to-edge';
        }
        const tilesetTexture = new PIXI.Texture({ source });

        this.tilemaps[tilemapId] = { tilesetTexture };

        debugWorkerLog(`  ✅ Loaded tileset texture: ${tilemapId}`);
      } catch (error) {
        console.error(`  ❌ Failed to load tileset texture "${tilemapId}":`, error);
      }
    }
  }

  /**
   * The atlas's Pixi source over its picture. PixiJS 8's default alphaMode premultiplies on upload (PMA on the GPU):
   * InstancedSpriteBatch's fragment does not premultiply again (that darkens soft alpha).
   * @param {ImageBitmap} bitmap
   */
  _atlasSourceOf(bitmap) {
    const source = new PIXI.ImageSource({
      resource: bitmap,
      autoGenerateMipmaps: this.worker.autoGenerateMipmaps,
      scaleMode: this.worker.atlasScaleMode,
    });
    if (source.style) source.style.scaleMode = this.worker.atlasScaleMode;
    return source;
  }

  /**
   * DX-MAPS: the twin page's source (heights and normals at the atlas's rectangles): data, nearest, no mipmaps, no
   * premultiplied alpha. The G-buffer pass samples it with the colour's UV.
   * @param {ImageBitmap} bitmap
   */
  _atlasMapsSourceOf(bitmap) {
    return new PIXI.ImageSource({
      resource: bitmap,
      autoGenerateMipmaps: false,
      scaleMode: 'nearest',
      alphaMode: 'no-premultiply-alpha',
    });
  }

  /**
   * SST-19: the atlas sheets' pictures the page posted as soon as its atlas was in ('atlasBitmaps'), before it built the
   * init data: kept now, made Pixi sources and uploaded once the renderer is booted. loadSpritesheets takes them.
   * @param {Record<string, { imageBitmap: ImageBitmap, mapsBitmap: ImageBitmap | null }>} sheets
   */
  takeEarlyAtlas(sheets) {
    for (const name in sheets) {
      const sheet = sheets[name];
      if (!sheet?.imageBitmap) continue;
      this.earlyAtlas[name] = { imageBitmap: sheet.imageBitmap, mapsBitmap: sheet.mapsBitmap || null, source: null, mapsSource: null };
    }
    const booted = this.worker._bootPromise ?? Promise.resolve();
    booted.then(() => this._uploadEarlyAtlas(), () => {});
  }

  /** SST-19: the early atlas sheets' sources made and put on the GPU (the init's _uploadAssetTextures finds them there). */
  _uploadEarlyAtlas() {
    const textures = this.worker.pixiApp?.renderer?.texture;
    for (const name in this.earlyAtlas) {
      const early = this.earlyAtlas[name];
      if (early.source === null) early.source = this._atlasSourceOf(early.imageBitmap);
      if (early.mapsBitmap && early.mapsSource === null) early.mapsSource = this._atlasMapsSourceOf(early.mapsBitmap);
      if (textures && typeof textures.initSource === 'function') {
        textures.initSource(early.source);
        if (early.mapsSource) textures.initSource(early.mapsSource);
      }
    }
    loadMark('atlas uploaded');
  }

  /**
   * SST-7 step 1: the textures the init message brought (the atlas and its maps page, the loose textures, the tilesets)
   * made and uploaded on the GPU here, through Pixi's texture system as a first draw would (initSource: the GL texture or
   * the GPUTexture, and the image's upload), instead of in the first frame that draws each. Each source once.
   */
  uploadAssetTextures() {
    const textures = this.worker.pixiApp?.renderer?.texture;
    if (!textures || typeof textures.initSource !== 'function') return;
    const sources = new Set();
    for (const name in this.spritesheets) {
      const sheet = this.spritesheets[name];
      if (sheet && sheet.source) sources.add(sheet.source);
    }
    if (this.atlasMapsSource !== null) sources.add(this.atlasMapsSource);
    for (const name in this.textures) {
      const texture = this.textures[name];
      if (texture && texture.source) sources.add(texture.source);
    }
    for (const id in this.tilemaps) {
      const tileset = this.tilemaps[id]?.tilesetTexture;
      if (tileset && tileset.source) sources.add(tileset.source);
    }
    for (const source of sources) textures.initSource(source);
  }

  /** Resolve atlas ImageSource for instanced batches. */
  resolveAtlasSource() {
    if (this.flatTextures) {
      for (let i = 0; i < this.flatTextures.length; i++) {
        const t = this.flatTextures[i];
        if (t?.source) return t.source;
      }
    }
    return PIXI.Texture.WHITE.source;
  }

  /**
   * The texture lookup (per textureId UV, trim and orig) after the atlas loads, with the footprints and the maps table it
   * names and the GPU particles' animation lookup, uploaded. The worker's rebuildInstancedTextureLut points its batches
   * at them.
   */
  rebuildTextureLut() {
    const fallback = this.textures?.['_white'] || PIXI.Texture.WHITE;
    // Before the table: its rows name each render's footprint row.
    this._buildFootprintTexture();
    // E-496: each frame's window in the twin page.
    this._buildMapsTable();
    this.texLut = buildTextureLut(this.flatTextures || [], fallback);
    this.texLutCount = this.flatTextures?.length || 0;
    // N-317: the tallest frame, which bounds how far a pixel's sun ray lands past the screen (_fitSunMap).
    let tallest = 0;
    const flat = this.flatTextures || [];
    for (let i = 0; i < flat.length; i++) {
      const h = flat[i]?.orig?.height ?? flat[i]?.frame?.height ?? 0;
      if (h > tallest) tallest = h;
    }
    this.worker._sunMapTallestPx = tallest;
    // N-111: one textureId a row would pass MAX_TEXTURE_SIZE with a big atlas (9 020 frames drew nothing on
    // SwiftShader's 8 192): past TEX_LUT_MAX_ROWS the rows hold several.
    const layout = textureLutLayout(this.texLutCount);
    this.texLutWidth = layout.width;
    this.texLutHeight = layout.height;
    const rgba = packTextureLutRgba(this.texLut, Math.max(1, this.texLutCount));
    this.texLutRgba = rgba;
    this.texLutSource = PIXI.TextureSource.from({
      resource: rgba,
      width: layout.width,
      height: layout.height,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this.texLutSource.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';
    this.texLutNeedsGpuUpload = true;
    this.uploadTexLutTexture();
    this.rebuildGpuAnimStartLookup();
  }

  /**
   * DX-SHADOW3D: the renders' footprints, a row each (frameBase.js writeFootprintRow), for the solids' columns: a frame
   * with a contact base and a footprint gets a row (texture.weedFootSlot, which writeLutSlot puts in its base's spare
   * float). Made with the texture table, uploaded with it.
   */
  _buildFootprintTexture() {
    const textures = this.flatTextures || [];
    let rows = 0;
    for (let i = 0; i < textures.length; i++) {
      const t = textures[i];
      if (t && t.weedFootprint && t.weedBase && t.weedBase.contact >= 0 && this.worker.config?.lighting?.footprintSolids === true) t.weedFootSlot = rows++;
    }
    const height = Math.max(1, rows);
    const data = new Float32Array(height * FOOTPRINT_TEXELS * 4);
    for (let i = 0; i < textures.length; i++) {
      const t = textures[i];
      if (t && t.weedFootSlot >= 0) writeFootprintRow(data, t.weedFootSlot, t.weedFootprint);
    }
    this.footRgba = data;
    // Its texels go up with the LUT (_uploadTexLutTexture writes this array into the source's texture).
    this.texLutNeedsGpuUpload = true;
    // One source while the rows' count holds. A program binds it (uFoot) when it is made and keeps it: a new source
    // each rebuild left the lamps' columns on the old one, which WebGPU then failed every frame as destroyed.
    if (this.footSource !== null && this.footRows === height) return;
    this.footRows = height;
    const old = this.footSource;
    this.footSource = PIXI.TextureSource.from({
      resource: data,
      width: FOOTPRINT_TEXELS,
      height,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this.footSource.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';
    // Never unloaded by Pixi's texture GC while bound (writeRgba32Float pins it too, but only when it makes the texture).
    this.footSource.autoGarbageCollect = false;
    this.worker._pointFootPrograms();
    if (old !== null) old.destroy();
  }

  /** DX-SHADOW3D: the footprint texture, or one row of nothing before the atlas made it. */
  footSourceOrEmpty() {
    if (this.footSource === null) {
      this._buildFootprintTexture();
      // Uploaded with the LUT (uploadTextureLookupIfNeeded).
      this.texLutNeedsGpuUpload = true;
    }
    return this.footSource;
  }

  /**
   * E-496: the maps table (src/render/mapsTable.js packMapsTable) of flatTextures: each frame's window in the twin page (its
   * texture's weedMaps, from the atlas's json) and its marks. One source while its size holds, its texels uploaded with the
   * LUT; a new one re-points every program that binds it (uMapsLut), as the footprints do.
   */
  _buildMapsTable() {
    const packed = packMapsTable(this.flatTextures || [], this.mapsAtlasLayout && this.atlasMapsSource !== null);
    this.mapsTableRgba = packed.data;
    this.texLutNeedsGpuUpload = true;
    if (this.mapsTableSource !== null && this.mapsTableWidth === packed.width && this.mapsTableHeight === packed.height) return;
    this.mapsTableWidth = packed.width;
    this.mapsTableHeight = packed.height;
    const old = this.mapsTableSource;
    this.mapsTableSource = PIXI.TextureSource.from({
      resource: packed.data,
      width: packed.width,
      height: packed.height,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this.mapsTableSource.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';
    this.mapsTableSource.autoGarbageCollect = false;
    this.worker._pointMapsTablePrograms();
    if (old !== null) old.destroy();
  }

  /** E-496: the maps table, or a texel of nothing before the atlas made it (uploaded with the LUT). */
  mapsTableSourceOrEmpty() {
    if (this.mapsTableSource === null) {
      this._buildMapsTable();
      this.texLutNeedsGpuUpload = true;
    }
    return this.mapsTableSource;
  }

  /**
   * Force RGBA32F LUT into a GPUTexture Pixi samples (no RENDER_ATTACHMENT).
   */
  uploadTexLutTexture() {
    const source = this.texLutSource;
    const data = this.texLutRgba;
    if (!source || !data) return;
    if (this.worker._useWebGpu) {
      const renderer = this.worker.pixiApp?.renderer;
      if (!renderer?.gpu?.device) return;
      writeRgba32Float(
        renderer,
        source,
        data,
        this.texLutWidth,
        this.texLutHeight,
        'weed-tex-lut'
      );
      if (this.footSource) writeRgba32Float(renderer, this.footSource, this.footRgba, FOOTPRINT_TEXELS, this.footRows, 'weed-footprints');
      if (this.mapsTableSource) {
        writeRgba32Float(renderer, this.mapsTableSource, this.mapsTableRgba, this.mapsTableWidth, this.mapsTableHeight, 'weed-maps-table');
      }
      this.texLutNeedsGpuUpload = false;
      return;
    }
    this.worker._uploadRgba32FloatGl(source, data, this.texLutWidth, this.texLutHeight);
    if (this.footSource) this.worker._uploadRgba32FloatGl(this.footSource, this.footRgba, FOOTPRINT_TEXELS, this.footRows);
    if (this.mapsTableSource) {
      this.worker._uploadRgba32FloatGl(this.mapsTableSource, this.mapsTableRgba, this.mapsTableWidth, this.mapsTableHeight);
    }
    this.texLutNeedsGpuUpload = false;
  }

  /**
   * GPU particles store a texture as CPU particles do, an animation index; their vertex shader maps it to the
   * atlas lookup's id through this table (animationFrameStart, 0 = the white circle, as the emit kernel does).
   */
  rebuildGpuAnimStartLookup() {
    if (!GpuParticles.layers.some(Boolean)) return;
    const white = this.animationFrameStart?.[SpriteSheetRegistry.getTextureId('_whiteCircle')] ?? 0;
    const packed = packAnimStartLookup(this.animationFrameStart || [], white);
    this.gpuAnimStartRgba = packed.data;
    this.gpuAnimStartWidth = packed.width;
    this.gpuAnimStartHeight = packed.height;
    this.gpuAnimStartSource = PIXI.TextureSource.from({
      resource: packed.data,
      width: packed.width,
      height: packed.height,
      format: 'rgba32float',
      scaleMode: 'nearest',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this.gpuAnimStartSource.uploadMethodId = this.worker._useWebGpu ? 'external' : 'unknown';
    this._uploadGpuAnimStartLookup();
  }

  _uploadGpuAnimStartLookup() {
    const source = this.gpuAnimStartSource;
    if (!source) return;
    if (this.worker._useWebGpu) {
      const renderer = this.worker.pixiApp?.renderer;
      if (!renderer?.gpu?.device) return;
      writeRgba32Float(renderer, source, this.gpuAnimStartRgba, this.gpuAnimStartWidth, this.gpuAnimStartHeight, 'weed-gpu-anim-start');
      return;
    }
    this.worker._uploadRgba32FloatGl(source, this.gpuAnimStartRgba, this.gpuAnimStartWidth, this.gpuAnimStartHeight);
  }
}
