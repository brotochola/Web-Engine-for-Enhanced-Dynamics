// SpriteSheetRegistry.js - Centralized spritesheet metadata management
// Provides string->index mapping for animations without runtime overhead
// String lookups happen ONCE at setup, game loop uses fast numeric indices

import { resolveHeightScaleY } from '../util/cameraView.js';
import { drawBuiltinTextures } from './atlas/atlasBuiltins.js';
import { debugWorkerLog } from '../util/debugLog.js';
import { MaxRectsPacker } from './atlas/maxRectsPacker.js';
import {
  buildBigAtlas, getTrimBoundsInPixels, loadImage, loadSpritesheet, markFrameTexels, orderAtlasByDeclaration, paintMapsPage,
  twinFormatFor,
} from './atlas/atlasBuild.js';

export { orderAtlasByDeclaration };

/**
 * SpriteSheetRegistry - Manages spritesheet metadata and animation lookups
 *
 * PERFORMANCE DESIGN:
 * - String lookups happen during initialization/setup (cold path)
 * - Game loop uses numeric indices directly (hot path - zero overhead)
 * - Metadata is shared with workers as plain objects (no class instances)
 *
 * USAGE:
 * 1. Main thread: Register spritesheets during asset loading
 * 2. Workers: Receive metadata as serialized objects
 * 3. Entities: Look up animation indices once during setup
 * 4. Game loop: Use numeric indices (no registry access)
 */
/**
 * bigAtlas's animations in sheets of 256 (VISUAL_EDITOR_PLAN.md ED-74): a static sprite is its bigAtlas animation in
 * SpriteRenderer's spritesheetId and animationState, and both are bytes, as are the pre-render emit's [sheet][state]
 * texture tables (wasm/preRenderEmit.c). An index past 255 drew another sprite (littleCity's houses go to 1,067). Each
 * further 256 of bigAtlas's animations is a proxy sheet of its own, bigAtlas@1, bigAtlas@2, …, mapping its local
 * index to the global one, so setSprite stores that sheet and an index under 256, and every table already reaches
 * them. bigAtlas itself holds the first 256.
 */
export const BIG_ATLAS_CHUNK = 256;

/** The proxy sheet of bigAtlas's animations k·256 … k·256 + 255 (k ≥ 1). */
export function bigAtlasChunkName(k) {
  return `bigAtlas@${k}`;
}

/**
 * Add bigAtlas's chunk sheets to a set of proxy sheets (the scene's, which the workers register too).
 * @param {{ animations?: Record<string, unknown> }} json - bigAtlas's JSON: its animations, in index order
 * @param {Record<string, object>} proxySheets
 * @returns {number} how many chunk sheets were added
 */
export function addBigAtlasChunks(json, proxySheets) {
  const names = Object.keys(json?.animations || {});
  let added = 0;
  for (let k = 1; k * BIG_ATLAS_CHUNK < names.length; k++) {
    const animations = {};
    const indexToName = {};
    for (let local = 0; local < BIG_ATLAS_CHUNK; local++) {
      const name = names[k * BIG_ATLAS_CHUNK + local];
      if (name === undefined) break;
      animations[name] = { originalName: name, prefixedName: name, index: local };
      indexToName[local] = name;
    }
    proxySheets[bigAtlasChunkName(k)] = { isProxy: true, targetSheet: 'bigAtlas', prefix: '', animations, indexToName };
    added++;
  }
  return added;
}

class SpriteSheetRegistry {
  // Main registry: Map<sheetName, metadata>
  static spritesheets = new Map();

  // Frame dimensions cache: Map<sheetName, Map<frameName, {w, h}>>
  // Used for zero-allocation dimension lookups
  static frameDimensions = new Map();

  // Spritesheet ID mapping for SharedArrayBuffer storage
  // We can't store strings in SharedArrayBuffer, so we use numeric IDs
  static spritesheetNames = ['']; // Index 0 = empty/default (use class spriteconfig)
  static spritesheetNameToId = new Map(); // Map<string, number>

  // Decal frame name → textureId mapping for stamping specific frames
  // Set by Scene.extractDecalTextures(), used by ParticleEmitter
  static decalFrameNameToId = null; // Map<string, number>

  /**
   * Register a spritesheet and build animation index
   * Called once per spritesheet during asset loading
   *
   * @param {string} name - Spritesheet identifier (e.g., "lpc", "enemy_sprites")
   * @param {Object} jsonData - Parsed spritesheet JSON with {frames, animations, meta}
   */
  static register(name, jsonData) {
    if (!jsonData.animations) {
      console.error(`❌ Invalid spritesheet "${name}": missing "animations" property`);
      return;
    }

    const animations = {};
    const indexToName = {};
    let currentIndex = 0;

    // Build bidirectional mapping: name ↔ index
    for (const [animName, frameNames] of Object.entries(jsonData.animations)) {
      animations[animName] = {
        index: currentIndex,
        frameCount: frameNames.length,
        frames: frameNames, // Frame IDs for renderer
      };

      indexToName[currentIndex] = animName;
      currentIndex++;
    }

    // Store frame dimensions for zero-allocation lookups
    if (jsonData.frames) {
      const frameDims = new Map();
      for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
        // Use sourceSize if available (original dimensions), otherwise use frame size
        const w = frameData.sourceSize?.w ?? frameData.frame?.w ?? 0;
        const h = frameData.sourceSize?.h ?? frameData.frame?.h ?? 0;
        frameDims.set(frameName, { w, h });
      }
      this.frameDimensions.set(name, frameDims);
    }

    const metadata = {
      name: name,
      animations: animations, // String → {index, frameCount, frames}
      indexToName: indexToName, // Number → String (for debugging)
      totalAnimations: currentIndex,
      meta: jsonData.meta, // Original metadata (image path, size, etc.)
    };

    this.spritesheets.set(name, metadata);

    // Auto-register spritesheet ID for per-instance switching
    this.registerSpritesheetId(name);

    debugWorkerLog(`✅ Registered spritesheet "${name}": ${currentIndex} animations`);
  }

  /**
   * Get animation index by name (for setup/initialization)
   * COLD PATH - Not called during game loop
   * Handles proxy sheets transparently
   *
   * @param {string} sheetName - Spritesheet name
   * @param {string} animName - Animation name (e.g., "walk_right")
   * @returns {number|undefined} Animation index or undefined if not found
   */
  static getAnimationIndex(sheetName, animName) {
    const sheet = this.spritesheets.get(sheetName);
    if (!sheet) {
      console.error(`❌ Spritesheet "${sheetName}" not found in registry`);
      return undefined;
    }

    // A proxy sheet's animations carry its own index (0, 1, 2, ...), not bigAtlas's: the same lookup either way.
    const anim = sheet.animations[animName];
    if (!anim) {
      // Provide helpful suggestions for typos
      const available = Object.keys(sheet.animations);
      const suggestions = this._findSimilar(animName, available).slice(0, 3);
      console.error(
        `❌ Animation "${animName}" not found in "${sheetName}"\n` +
        `   Available animations: ${available.length}\n` +
        (suggestions.length > 0 ? `   Did you mean: ${suggestions.join(', ')}?` : '')
      );
      return undefined;
    }

    return anim.index;
  }

  /**
   * Get animation name by index (for debugging)
   * Handles proxy sheets transparently
   *
   * @param {string} sheetName - Spritesheet name
   * @param {number} index - Animation index
   * @returns {string|undefined} Animation name or undefined if not found
   */
  static getAnimationName(sheetName, index) {
    const sheet = this.spritesheets.get(sheetName);
    if (!sheet) return undefined;

    if (sheet.isProxy) {
      // For proxy sheets, use the proxy's own indexToName mapping
      // Each proxy sheet has its own independent index space
      return sheet.indexToName?.[index];
    }

    return sheet.indexToName[index];
  }

  /**
   * Get animation metadata (frameCount, frames, etc.)
   * Works for both proxy and regular sheets
   *
   * @param {string} sheetName - Spritesheet name
   * @param {string} animName - Animation name
   * @returns {Object|undefined} Animation metadata or undefined
   */
  static getAnimationData(sheetName, animName) {
    const sheet = this.spritesheets.get(sheetName);
    return sheet?.animations[animName];
  }

  /**
   * Get all animation names for a spritesheet
   * Useful for UI, debugging, validation
   *
   * @param {string} sheetName - Spritesheet name
   * @returns {string[]} Array of animation names
   */
  static getAnimationNames(sheetName) {
    const sheet = this.spritesheets.get(sheetName);
    return sheet ? Object.keys(sheet.animations) : [];
  }

  /**
   * Check if an animation exists
   *
   * @param {string} sheetName - Spritesheet name
   * @param {string} animName - Animation name
   * @returns {boolean} True if animation exists
   */
  static hasAnimation(sheetName, animName) {
    const sheet = this.spritesheets.get(sheetName);
    return sheet ? animName in sheet.animations : false;
  }

  /**
   * Get frame dimensions for an animation (uses first frame)
   * Zero-allocation lookup - returns cached dimensions
   *
   * @param {string} sheetName - Spritesheet name (e.g., "bigAtlas", "civil1")
   * @param {string} animName - Animation name (e.g., "bunny", "walk_right")
   * @returns {{w: number, h: number} | null} Frame dimensions or null if not found
   */
  static getFrameDimensions(sheetName, animName) {
    const sheet = this.spritesheets.get(sheetName);
    if (!sheet) return null;

    // For proxy sheets, look up in bigAtlas with prefixed name
    let targetSheet = sheetName;
    let targetAnimName = animName;

    if (sheet.isProxy) {
      targetSheet = 'bigAtlas';
      // Its animation's bigAtlas name (a spritesheet's is prefixed; a bigAtlas chunk's is the name itself).
      targetAnimName = sheet.animations?.[animName]?.prefixedName ?? `${sheetName}_${animName}`;
    }

    // Get animation data to find first frame name
    const targetSheetData = this.spritesheets.get(targetSheet);
    if (!targetSheetData) return null;

    const animData = targetSheetData.animations[targetAnimName];
    if (!animData || !animData.frames || animData.frames.length === 0) return null;

    // Get dimensions of first frame
    const firstFrameName = animData.frames[0];
    const frameDims = this.frameDimensions.get(targetSheet);
    if (!frameDims) return null;

    return frameDims.get(firstFrameName) || null;
  }

  /**
   * Build frame dimension arrays for workers (Uint16Array indexed by textureId)
   * Called once during Scene initialization, transferred to workers
   *
   * @returns {{frameWidth: Uint16Array, frameHeight: Uint16Array, totalFrames: number} | null}
   */
  static buildFrameDimensionArrays() {
    const bigAtlas = this.spritesheets.get('bigAtlas');
    if (!bigAtlas) {
      console.warn('[SpriteSheetRegistry] bigAtlas not found, frame dimensions not built');
      return null;
    }

    const frameDims = this.frameDimensions.get('bigAtlas');
    if (!frameDims) {
      console.warn('[SpriteSheetRegistry] bigAtlas frame dimensions not found');
      return null;
    }

    // Count total frames
    const animCount = bigAtlas.totalAnimations;
    let totalFrames = 0;
    for (let animIdx = 0; animIdx < animCount; animIdx++) {
      const animName = bigAtlas.indexToName[animIdx];
      const animData = bigAtlas.animations[animName];
      totalFrames += animData ? animData.frameCount : 1;
    }

    // Allocate arrays (Uint16 - max 65535 pixels)
    const frameWidth = new Uint16Array(totalFrames);
    const frameHeight = new Uint16Array(totalFrames);

    // Populate dimensions for each frame
    let currentOffset = 0;
    for (let animIdx = 0; animIdx < animCount; animIdx++) {
      const animName = bigAtlas.indexToName[animIdx];
      const animData = bigAtlas.animations[animName];
      const frameCount = animData ? animData.frameCount : 1;

      if (animData && animData.frames) {
        for (let f = 0; f < animData.frames.length; f++) {
          const frameName = animData.frames[f];
          const dims = frameDims.get(frameName);
          if (dims) {
            frameWidth[currentOffset + f] = dims.w;
            frameHeight[currentOffset + f] = dims.h;
          }
        }
      }

      currentOffset += frameCount;
    }

    debugWorkerLog(`[SpriteSheetRegistry] Built frame dimension arrays: ${totalFrames} frames`);
    return { frameWidth, frameHeight, totalFrames };
  }

  /**
   * Get frame dimensions by spritesheet ID and animation index
   * Optimized for hot-path access from typed array data
   *
   * @param {number} spritesheetId - Spritesheet ID (from SpriteRenderer.spritesheetId)
   * @param {number} animIndex - Animation index (from SpriteRenderer.animationState)
   * @returns {{w: number, h: number} | null} Frame dimensions or null if not found
   */
  /** (spritesheetId, animIndex) → { w, h }; see frameSizeOf. */
  static _frameSizeCache = new Map();

  /**
   * First-frame size in px of an animation (or static sprite), the size the
   * renderer scales: drawn width = w × scaleX. Cached by a numeric key, so a
   * repeat call allocates nothing (getFrameDimensionsById builds a string
   * for proxy sheets). null when unknown; an unknown size is not cached.
   * @param {number} spritesheetId
   * @param {number} animIndex
   * @returns {{w: number, h: number} | null}
   */
  static frameSizeOf(spritesheetId, animIndex) {
    if (!(spritesheetId > 0)) return null;
    const key = spritesheetId * 65536 + (animIndex | 0);
    let dims = this._frameSizeCache.get(key);
    if (dims === undefined) {
      dims = this.getFrameDimensionsById(spritesheetId, animIndex);
      if (!dims) return null;
      this._frameSizeCache.set(key, dims);
    }
    return dims;
  }

  static getFrameDimensionsById(spritesheetId, animIndex) {
    const sheetName = this.getSpritesheetName(spritesheetId);
    if (!sheetName) return null;

    const sheet = this.spritesheets.get(sheetName);
    if (!sheet) return null;

    // Get animation name from index
    let animName;
    if (sheet.isProxy) {
      animName = sheet.indexToName?.[animIndex];
    } else {
      animName = sheet.indexToName[animIndex];
    }

    if (!animName) return null;

    return this.getFrameDimensions(sheetName, animName);
  }

  /**
   * Serialize registry for workers (convert to plain objects)
   * Workers can't use Map instances, so we convert to plain objects
   * NOTE: Proxy sheets are NOT serialized - they're reconstructed in workers
   *
   * @returns {Object} Serialized registry metadata
   */
  static serialize() {
    const serialized = {
      spritesheets: {},
      // Include spritesheet ID mappings for per-instance switching
      spritesheetNames: this.spritesheetNames,
      spritesheetNameToId: Object.fromEntries(this.spritesheetNameToId),
      // Include frame dimensions for zero-allocation lookups
      frameDimensions: {},
      // Include decal frame mapping for stamping specific frames
      decalFrameNameToId: this.decalFrameNameToId,
    };

    for (const [name, sheet] of this.spritesheets) {
      // Skip proxy sheets - they'll be registered separately in workers
      if (sheet.isProxy) continue;

      serialized.spritesheets[name] = {
        name: sheet.name,
        animations: sheet.animations,
        indexToName: sheet.indexToName,
        totalAnimations: sheet.totalAnimations,
        meta: sheet.meta,
      };
    }

    // Serialize frame dimensions (Map → Object)
    for (const [sheetName, frameDims] of this.frameDimensions) {
      serialized.frameDimensions[sheetName] = Object.fromEntries(frameDims);
    }

    return serialized;
  }

  /**
   * Deserialize registry metadata in workers
   * Reconstructs the registry from plain objects
   *
   * @param {Object} serialized - Serialized registry data
   */
  static deserialize(serialized) {
    this.spritesheets.clear();
    this.frameDimensions.clear();
    this._frameSizeCache.clear();

    // Restore spritesheet ID mappings
    if (serialized.spritesheetNames) {
      this.spritesheetNames = serialized.spritesheetNames;
    }
    if (serialized.spritesheetNameToId) {
      this.spritesheetNameToId = new Map(Object.entries(serialized.spritesheetNameToId));
    }

    // Restore spritesheets (strict serialized format)
    const sheets = serialized.spritesheets || {};
    for (const [name, sheet] of Object.entries(sheets)) {
      this.spritesheets.set(name, sheet);
    }

    // Restore frame dimensions (Object → Map)
    if (serialized.frameDimensions) {
      for (const [sheetName, dims] of Object.entries(serialized.frameDimensions)) {
        this.frameDimensions.set(sheetName, new Map(Object.entries(dims)));
      }
    }

    // Restore decal frame mapping for stamping specific frames
    if (serialized.decalFrameNameToId) {
      this.decalFrameNameToId = serialized.decalFrameNameToId;
    }

    debugWorkerLog(`✅ Deserialized ${this.spritesheets.size} spritesheets in worker`);
  }

  /**
   * Clear all spritesheet data (called when unloading a scene to prevent memory leaks)
   * The next scene will repopulate the registry during its asset loading
   */
  static clearForSceneUnload() {
    this.spritesheets.clear();
    this.frameDimensions.clear();
    this._frameSizeCache.clear();
    this.spritesheetNames = [''];
    this.spritesheetNameToId.clear();
    this.spritesheetNameToId.set('', 0);
    this.decalFrameNameToId = null;
  }

  /**
   * Get all registered spritesheet names
   *
   * @returns {string[]} Array of spritesheet names
   */
  static getSpritesheetNames() {
    return Array.from(this.spritesheets.keys());
  }

  /**
   * Find similar strings (for typo suggestions)
   * Simple Levenshtein-like similarity check
   *
   * @private
   * @param {string} target - String to match
   * @param {string[]} candidates - Possible matches
   * @returns {string[]} Sorted array of similar strings
   */
  static _findSimilar(target, candidates) {
    const scored = candidates.map((candidate) => ({
      name: candidate,
      score: this._similarity(target.toLowerCase(), candidate.toLowerCase()),
    }));

    return scored
      .filter((s) => s.score > 0.3) // Only reasonably similar
      .sort((a, b) => b.score - a.score)
      .map((s) => s.name);
  }

  /**
   * Simple string similarity score (0-1)
   *
   * @private
   * @param {string} a - First string
   * @param {string} b - Second string
   * @returns {number} Similarity score (0-1)
   */
  static _similarity(a, b) {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;

    if (longer.length === 0) return 1.0;

    // Count matching characters
    let matches = 0;
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) matches++;
    }

    return matches / longer.length;
  }

  /**
   * Validate entity spriteConfig against registry
   * Called during entity class registration
   *
   * @param {string} entityName - Entity class name (for error messages)
   * @param {Object} spriteConfig - Entity's static spriteConfig
   * @returns {boolean} True if valid
   */
  static validateSpriteConfig(entityName, spriteConfig) {
    if (!spriteConfig) {
      console.error(`❌ ${entityName}: Missing spriteConfig`);
      return false;
    }

    const { spritesheet, defaultAnimation } = spriteConfig;

    if (!spritesheet) {
      console.error(`❌ ${entityName}: spriteConfig missing "spritesheet" property`);
      return false;
    }

    if (!this.spritesheets.has(spritesheet)) {
      console.error(
        `❌ ${entityName}: Unknown spritesheet "${spritesheet}"\n` +
        `   Available: ${this.getSpritesheetNames().join(', ')}`
      );
      return false;
    }

    if (defaultAnimation && !this.hasAnimation(spritesheet, defaultAnimation)) {
      console.error(
        `❌ ${entityName}: Invalid defaultAnimation "${defaultAnimation}"\n` +
        `   Available: ${this.getAnimationNames(spritesheet).join(', ')}`
      );
      return false;
    }

    // Validate custom animation settings if provided
    if (spriteConfig.animations) {
      for (const animName of Object.keys(spriteConfig.animations)) {
        if (!this.hasAnimation(spritesheet, animName)) {
          console.warn(
            `⚠️ ${entityName}: Animation "${animName}" in spriteConfig.animations not found in spritesheet`
          );
        }
      }
    }

    return true;
  }

  /**
   * Register a spritesheet name in the ID mapping system
   * Called during asset loading to build the string → ID map
   *
   * @param {string} name - Spritesheet name to register
   * @returns {number} The assigned ID (1-255)
   */
  static registerSpritesheetId(name) {
    if (this.spritesheetNameToId.has(name)) {
      return this.spritesheetNameToId.get(name);
    }

    const id = this.spritesheetNames.length;
    if (id > 255) {
      console.error(`❌ Too many spritesheets (max 255). Cannot register "${name}"`);
      return 0;
    }

    this.spritesheetNames.push(name);
    this.spritesheetNameToId.set(name, id);

    return id;
  }

  /**
   * Get numeric ID for a spritesheet name
   * Used when setting per-instance spritesheet
   *
   * @param {string} name - Spritesheet name
   * @returns {number} Spritesheet ID (0 = not found/use default, 1-255 = valid)
   */
  static getSpritesheetId(name) {
    return this.spritesheetNameToId.get(name) || 0;
  }

  /**
   * DX-MAPCAMERA: the camera a sheet's pictures and maps were drawn for, `{ floorScaleY, heightScaleY }` (its json's
   * meta.artCamera or its assets entry's artCamera), or null: the scene's own. By sheet name or id, on every worker (the
   * proxies carry it).
   * @param {string|number} sheet
   * @returns {{ floorScaleY: number, heightScaleY: number } | null}
   */
  static artCameraOf(sheet) {
    const name = typeof sheet === 'number' ? this.getSpritesheetName(sheet) : sheet;
    const data = name ? this.spritesheets.get(name) : null;
    return data && data.artCamera ? data.artCamera : null;
  }

  /**
   * Get spritesheet name from numeric ID
   * Used by pixi worker to resolve spritesheet from SharedArrayBuffer
   *
   * @param {number} id - Spritesheet ID (1-255)
   * @returns {string|null} Spritesheet name or null if invalid
   */
  static getSpritesheetName(id) {
    if (id < 0 || id >= this.spritesheetNames.length) {
      return null;
    }
    return this.spritesheetNames[id] || null;
  }

  static MaxRectsPacker = MaxRectsPacker;

  /**
   * Create a unified BigAtlas from individual images and spritesheets, on this thread (the bake; a page without the atlas
   * worker): atlasBuild.js buildBigAtlas with the built-ins drawn here and the scene camera's heightScaleY, the individual
   * textures registered as spritesheet ids as the page does for a packed atlas.
   *
   * @param {Object} assetsConfig - Asset configuration: images by name, plus { spritesheets }
   * @param {Object} options - Packing options from config.assets (buildBigAtlas's), and:
   * @param {object} [options.camera] - DX-MAPCAMERA: the scene's camera (config.camera)
   * @param {boolean} [options.unshadedGlows] - DX-GLOWRADIUS: the glows' frames unshaded (configDefaults.js unshadedGlowsOf)
   * @returns {Promise<Object>} - buildBigAtlas's { canvas, mapsCanvas, mapsTexels, mapsSize, json, proxySheets, decals }
   *
   * @example
   * const bigAtlas = await SpriteSheetRegistry.createBigAtlas({
   *   bg: "/img/bg.jpg",
   *   bunny: "/img/bunny.png",
   *   spritesheets: {
   *     person: { json: "/img/person.json", png: "/img/person.png" },
   *     lpc: { json: "/img/lpc.json", png: "/img/lpc.png" }
   *   }
   * }, config.assets);
   */
  static async createBigAtlas(assetsConfig, options = {}) {
    const { camera = null, unshadedGlows = false, ...rest } = options;
    const builtins = drawBuiltinTextures({ unshadedGlows }).map((b) => ({ ...b, image: b.canvas }));
    const packed = await buildBigAtlas(assetsConfig, {
      ...rest,
      // DX-MAPCAMERA: the scene's heightScaleY, to which a sheet drawn for another camera has its heights scaled.
      sceneHeightScaleY: camera ? resolveHeightScaleY(camera) : NaN,
      builtins,
    });
    this.registerPackedAtlasIds(packed.json);
    return packed;
  }

  /**
   * A packed atlas's individual textures as spritesheet ids, before bigAtlas's own (Scene._installBigAtlas registers
   * bigAtlas, its proxies, then these again): the order a packed atlas has always given them, so a saved id names the same
   * sheet whether the atlas was packed here, in the atlas worker or loaded from the atlas cache.
   * @param {{ meta?: { individualTextures?: string[] } }} json
   */
  static registerPackedAtlasIds(json) {
    for (const name of json?.meta?.individualTextures || []) this.registerSpritesheetId(name);
  }

  /** atlasBuild.js paintMapsPage (tests). */
  static _paintMapsPage(imagesToPack, maxWidth, maxHeight, keep = false) {
    return paintMapsPage(imagesToPack, maxWidth, maxHeight, keep);
  }

  /** atlasBuild.js twinFormatFor (tests). */
  static _twinFormatFor(asked, imagesToPack) {
    return twinFormatFor(asked, imagesToPack);
  }

  /** atlasBuild.js markFrameTexels (tests). */
  static _markFrameTexels(frames, imagesToPack) {
    markFrameTexels(frames, imagesToPack);
  }

  /** atlasBuild.js getTrimBoundsInPixels (tests). */
  static _getTrimBoundsInPixels(pixels, fx, fy, width, height, alphaThreshold = 0) {
    return getTrimBoundsInPixels(pixels, fx, fy, width, height, alphaThreshold);
  }

  /** An image from its URL (atlasBuild.js loadImage): an <img> on the page, fetch and createImageBitmap in a worker. */
  static _loadImage(url) {
    return loadImage(url);
  }

  /** A spritesheet's JSON, image and maps (atlasBuild.js loadSpritesheet). */
  static _loadSpritesheet(name, config) {
    return loadSpritesheet(name, config);
  }

  /**
   * Register a proxy sheet (transparent redirection to bigAtlas)
   * @private
   */
  static registerProxy(sheetName, proxyData) {
    this.spritesheets.set(sheetName, proxyData);

    // Auto-register spritesheet ID for per-instance switching
    this.registerSpritesheetId(sheetName);

    debugWorkerLog(`  🔗 Registered proxy sheet: ${sheetName} → bigAtlas`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FRAME NAME RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // These methods help resolve human-readable identifiers to bigAtlas frame names.
  //
  // NAMING CONVENTION IN BIGATLAS:
  // - Static textures (from assets.textures): Keep original name
  //   e.g., "rock1", "blood", "smoke"
  //
  // - Spritesheet frames: Prefixed with spritesheet name
  //   e.g., "civil1_walk_down_0", "civil1_hurt_5", "fire_burn_3"
  //
  // - Spritesheet animations: Prefixed with spritesheet name
  //   e.g., "civil1_walk_down" (animation containing frames civil1_walk_down_0, _1, _2...)
  //
  // USAGE SCENARIOS:
  // 1. Static sprite: setSprite("rock1") → uses "rock1" animation (1 frame)
  // 2. Specific frame: setSprite("civil1", "hurt", -1) → resolves to "civil1_hurt_5"
  // 3. Decal stamp: Decal.stamp({ texture: "civil1_hurt_5" }) → stamps that exact frame
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the bigAtlas frame name for a specific animation frame.
   * This is the PRIMARY method for resolving (spritesheet, animation, frameIndex) to a frame name.
   *
   * HOW IT WORKS:
   * 1. Looks up the spritesheet (proxy or direct)
   * 2. Resolves the animation name to the prefixed bigAtlas animation name
   * 3. Gets the specific frame from that animation's frame list
   *
   * @param {string} sheetName - Spritesheet name (e.g., "civil1", "fire", "bigAtlas")
   * @param {string} animName - Animation name (e.g., "hurt", "walk_down", "burn")
   * @param {number} [frameIndex=0] - Frame index within animation (0 = first, -1 = last)
   * @returns {string|null} BigAtlas frame name (e.g., "civil1_hurt_5") or null if not found
   *
   * @example
   * // Get first frame of hurt animation
   * getFrameName("civil1", "hurt", 0)    // → "civil1_hurt_0"
   *
   * @example
   * // Get last frame of hurt animation (for death pose decal)
   * getFrameName("civil1", "hurt", -1)   // → "civil1_hurt_5"
   *
   * @example
   * // Get frame from a static texture "animation" (1 frame)
   * getFrameName("bigAtlas", "blood", 0) // → "blood"
   */
  static getFrameName(sheetName, animName, frameIndex = 0) {
    const bigAtlas = this.spritesheets.get('bigAtlas');

    // BigAtlas must be loaded for any frame lookups
    if (!bigAtlas) {
      console.warn(`getFrameName: bigAtlas not loaded yet`);
      return null;
    }

    // Step 1: Resolve the prefixed animation name in bigAtlas
    // The naming convention depends on whether it's a proxy sheet or bigAtlas itself
    const sheet = this.spritesheets.get(sheetName);
    let prefixedAnimName;

    if (sheetName === 'bigAtlas') {
      // For bigAtlas itself, animation names are not prefixed
      prefixedAnimName = animName;
    } else if (sheet?.isProxy) {
      // Proxy sheets store the prefixed name in their animation info
      const animInfo = sheet.animations[animName];
      if (!animInfo) {
        console.warn(
          `getFrameName: Animation "${animName}" not found in proxy sheet "${sheetName}"`
        );
        return null;
      }
      prefixedAnimName = animInfo.prefixedName;
    } else {
      // Sheet not found (common in workers where proxies aren't serialized)
      // Use the naming convention: {sheetName}_{animName}
      prefixedAnimName = `${sheetName}_${animName}`;
    }

    // Step 2: Look up the animation in bigAtlas
    const bigAtlasAnim = bigAtlas.animations[prefixedAnimName];
    if (!bigAtlasAnim || !bigAtlasAnim.frames || bigAtlasAnim.frames.length === 0) {
      console.warn(`getFrameName: Animation "${prefixedAnimName}" not found in bigAtlas`);
      return null;
    }

    // Step 3: Resolve frame index (supports negative indexing from end)
    const frames = bigAtlasAnim.frames;
    const actualIndex = frameIndex < 0 ? frames.length + frameIndex : frameIndex;

    if (actualIndex < 0 || actualIndex >= frames.length) {
      console.warn(
        `getFrameName: Frame index ${frameIndex} out of range for "${prefixedAnimName}" (has ${frames.length} frames)`
      );
      return null;
    }

    return frames[actualIndex];
  }

  /**
   * Get the bigAtlas animation name for a proxy spritesheet animation
   * Useful for particle/decal systems that need the prefixed name
   *
   * @param {string} sheetName - Spritesheet name (e.g., "civil1")
   * @param {string} animName - Animation name (e.g., "hurt")
   * @returns {string|null} BigAtlas animation name (e.g., "civil1_hurt") or null if not found
   *
   * @example
   * SpriteSheetRegistry.getBigAtlasAnimName("civil1", "hurt")
   * // Returns: "civil1_hurt"
   */
  static getBigAtlasAnimName(sheetName, animName) {
    const sheet = this.spritesheets.get(sheetName);
    const bigAtlas = this.spritesheets.get('bigAtlas');

    if (sheet?.isProxy) {
      const animInfo = sheet.animations[animName];
      return animInfo?.prefixedName || null;
    }

    // For bigAtlas itself, just return the animName
    if (sheetName === 'bigAtlas') {
      return bigAtlas?.animations[animName] ? animName : null;
    }

    // Sheet not found (likely in a worker) - use naming convention
    if (!sheet && bigAtlas) {
      const prefixedName = `${sheetName}_${animName}`;
      return bigAtlas.animations[prefixedName] ? prefixedName : null;
    }

    return null;
  }

  /**
   * Get frame count for an animation
   *
   * @param {string} sheetName - Spritesheet name
   * @param {string} animName - Animation name
   * @returns {number} Number of frames, or 0 if not found
   */
  static getAnimationFrameCount(sheetName, animName) {
    const sheet = this.spritesheets.get(sheetName);
    const bigAtlas = this.spritesheets.get('bigAtlas');

    if (sheet?.isProxy) {
      const animInfo = sheet.animations[animName];
      if (!animInfo) return 0;

      if (!bigAtlas) return 0;

      const bigAtlasAnim = bigAtlas.animations[animInfo.prefixedName];
      return bigAtlasAnim?.frames?.length || 0;
    }

    // Sheet not found (likely in a worker) - use naming convention
    if (!sheet && bigAtlas) {
      const prefixedName = `${sheetName}_${animName}`;
      const bigAtlasAnim = bigAtlas.animations[prefixedName];
      return bigAtlasAnim?.frames?.length || 0;
    }

    return sheet?.animations[animName]?.frameCount || 0;
  }

  /**
   * Set the decal frame name → textureId mapping
   * Called by Scene.extractDecalTextures() after building the mapping
   *
   * @param {Object} mapping - Object mapping frame names to textureIds
   */
  static setDecalFrameMapping(mapping) {
    this.decalFrameNameToId = mapping;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEXTURE ID RESOLUTION
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // The particle/decal system uses numeric textureIds internally for performance.
  // These methods convert human-readable names to those IDs.
  //
  // ID RANGES:
  // - 0 to (totalAnimations-1): Animation indices - work for BOTH particles AND decals
  // - totalAnimations and above: Individual frame IDs - work ONLY for decal stamping
  //
  // WHY THE DISTINCTION?
  // - Animated particles need animation indices (pixi_worker plays the animation)
  // - Decals can use specific frames (stamped once, no animation needed)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get textureId for a texture by name.
   * Supports animation names, prefixed animation names, and individual frame names.
   *
   * RESOLUTION ORDER:
   * 1. Check if it's a bigAtlas animation name (e.g., "blood", "civil1_hurt")
   *    → Returns animation index (works for particles AND decals)
   * 2. Check if it's a specific frame name (e.g., "civil1_hurt_5")
   *    → Returns frame-specific ID (works ONLY for decals)
   *
   * @param {string} textureName - Texture identifier. Can be:
   *   - Animation name: "blood", "smoke" (static textures)
   *   - Prefixed animation: "civil1_hurt", "fire_burn" (spritesheet animations)
   *   - Specific frame: "civil1_hurt_5" (individual frame from animation)
   * @returns {number} TextureId for the rendering system, or 0 if not found
   *
   * @example
   * // Static texture (1-frame animation)
   * getTextureId("blood")           // -> animation index for "blood"
   *
   * @example
   * // Spritesheet animation (first frame used)
   * getTextureId("civil1_hurt")     // -> animation index for "civil1_hurt"
   *
   * @example
   * // Specific frame (for decals only!)
   * getTextureId("civil1_hurt_5")   // -> frame-specific ID (decal stamping only)
   */
  static getTextureId(textureName) {
    const bigAtlas = this.spritesheets.get('bigAtlas');

    // Priority 1: Check animation names
    // Animation indices work for both particle rendering and decal stamping
    if (bigAtlas && bigAtlas.animations[textureName]) {
      return bigAtlas.animations[textureName].index;
    }

    // Priority 2: Check specific frame names
    // Frame IDs only work for decal stamping (not animated particles)
    if (this.decalFrameNameToId && this.decalFrameNameToId[textureName] !== undefined) {
      return this.decalFrameNameToId[textureName];
    }

    // Not found
    console.warn(`getTextureId: "${textureName}" not found in animations or frames`);
    return 0;
  }
}

// ES6 module export

export { SpriteSheetRegistry };
