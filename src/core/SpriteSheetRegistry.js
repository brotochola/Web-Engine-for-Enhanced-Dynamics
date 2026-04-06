// SpriteSheetRegistry.js - Centralized spritesheet metadata management
// Provides string->index mapping for animations without runtime overhead
// String lookups happen ONCE at setup, game loop uses fast numeric indices

import { createCircularGradientCanvas, createBulletTrailCanvas } from './utils.js';

/**
 * MaxRectsPacker - Rectangle packing algorithm for texture atlas generation
 * Port of the MaxRects algorithm for efficient sprite packing
 * @private
 */
class MaxRectsPacker {
  constructor(width, height, padding = 0) {
    this.width = width;
    this.height = height;
    this.padding = padding;
    this.freeRects = [{ x: 0, y: 0, width, height }];
  }

  insert(width, height, heuristic = 'best-short-side') {
    width += this.padding * 2;
    height += this.padding * 2;

    let bestRect = null;
    let bestScore = Infinity;
    let bestSecondaryScore = Infinity;

    for (let freeRect of this.freeRects) {
      if (freeRect.width >= width && freeRect.height >= height) {
        let score, secondaryScore;

        if (heuristic === 'best-short-side') {
          score = Math.min(freeRect.width - width, freeRect.height - height);
          secondaryScore = Math.max(freeRect.width - width, freeRect.height - height);
        } else if (heuristic === 'best-long-side') {
          score = Math.max(freeRect.width - width, freeRect.height - height);
          secondaryScore = Math.min(freeRect.width - width, freeRect.height - height);
        } else if (heuristic === 'best-area') {
          score = freeRect.width * freeRect.height - width * height;
          secondaryScore = Math.min(freeRect.width - width, freeRect.height - height);
        } else {
          // bottom-left
          score = freeRect.y;
          secondaryScore = freeRect.x;
        }

        if (score < bestScore || (score === bestScore && secondaryScore < bestSecondaryScore)) {
          bestRect = { x: freeRect.x, y: freeRect.y, width, height };
          bestScore = score;
          bestSecondaryScore = secondaryScore;
        }
      }
    }

    if (bestRect) {
      this.placeRect(bestRect);
      return {
        x: bestRect.x + this.padding,
        y: bestRect.y + this.padding,
        width: width - this.padding * 2,
        height: height - this.padding * 2,
      };
    }

    return null;
  }

  placeRect(rect) {
    // Mark rects for removal instead of splicing in loop (avoids O(n²) splices)
    const toKeep = [];
    for (let i = 0; i < this.freeRects.length; i++) {
      if (!this.splitFreeNode(this.freeRects[i], rect)) {
        toKeep.push(this.freeRects[i]);
      }
    }
    this.freeRects = toKeep;
    this.pruneFreeList();
  }

  splitFreeNode(freeNode, usedNode) {
    if (
      usedNode.x >= freeNode.x + freeNode.width ||
      usedNode.x + usedNode.width <= freeNode.x ||
      usedNode.y >= freeNode.y + freeNode.height ||
      usedNode.y + usedNode.height <= freeNode.y
    ) {
      return false;
    }

    if (usedNode.x < freeNode.x + freeNode.width && usedNode.x + usedNode.width > freeNode.x) {
      if (usedNode.y > freeNode.y && usedNode.y < freeNode.y + freeNode.height) {
        let newNode = { ...freeNode };
        newNode.height = usedNode.y - newNode.y;
        this.freeRects.push(newNode);
      }

      if (usedNode.y + usedNode.height < freeNode.y + freeNode.height) {
        let newNode = { ...freeNode };
        newNode.y = usedNode.y + usedNode.height;
        newNode.height = freeNode.y + freeNode.height - (usedNode.y + usedNode.height);
        this.freeRects.push(newNode);
      }
    }

    if (usedNode.y < freeNode.y + freeNode.height && usedNode.y + usedNode.height > freeNode.y) {
      if (usedNode.x > freeNode.x && usedNode.x < freeNode.x + freeNode.width) {
        let newNode = { ...freeNode };
        newNode.width = usedNode.x - newNode.x;
        this.freeRects.push(newNode);
      }

      if (usedNode.x + usedNode.width < freeNode.x + freeNode.width) {
        let newNode = { ...freeNode };
        newNode.x = usedNode.x + usedNode.width;
        newNode.width = freeNode.x + freeNode.width - (usedNode.x + usedNode.width);
        this.freeRects.push(newNode);
      }
    }

    return true;
  }

  pruneFreeList() {
    // Mark contained rects for removal (avoids O(n²) splice operations)
    const len = this.freeRects.length;
    const keep = new Array(len).fill(true);

    for (let i = 0; i < len; i++) {
      if (!keep[i]) continue;
      for (let j = i + 1; j < len; j++) {
        if (!keep[j]) continue;
        if (this.isContainedIn(this.freeRects[i], this.freeRects[j])) {
          keep[i] = false;
          break;
        }
        if (this.isContainedIn(this.freeRects[j], this.freeRects[i])) {
          keep[j] = false;
        }
      }
    }

    // Single pass to rebuild array
    const newFreeRects = [];
    for (let i = 0; i < len; i++) {
      if (keep[i]) newFreeRects.push(this.freeRects[i]);
    }
    this.freeRects = newFreeRects;
  }

  isContainedIn(a, b) {
    return (
      a.x >= b.x &&
      a.y >= b.y &&
      a.x + a.width <= b.x + b.width &&
      a.y + a.height <= b.y + b.height
    );
  }
}

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

    console.log(`✅ Registered spritesheet "${name}": ${currentIndex} animations`);
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

    // Handle proxy sheets - return proxy-specific index, not global bigAtlas index
    if (sheet.isProxy) {
      const animInfo = sheet.animations[animName];
      if (!animInfo) {
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

      // Return the proxy-specific index (0, 1, 2, ...) not the global bigAtlas index
      return animInfo.index;
    }

    // Regular sheet lookup
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
      targetAnimName = `${sheetName}_${animName}`;
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

    console.log(`[SpriteSheetRegistry] Built frame dimension arrays: ${totalFrames} frames`);
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

    console.log(`✅ Deserialized ${this.spritesheets.size} spritesheets in worker`);
  }

  /**
   * Clear all spritesheet data (called when unloading a scene to prevent memory leaks)
   * The next scene will repopulate the registry during its asset loading
   */
  static clearForSceneUnload() {
    this.spritesheets.clear();
    this.frameDimensions.clear();
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
   * @returns {Promise<Object>} - { canvas, json, proxySheets }
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
  static async createBigAtlas(
    assetsConfig,
    options = {}
  ) {
    // Merge with defaults
    const {
      maxAtlasWidth = 4096,
      maxAtlasHeight = 4096,
      atlasPadding = 2,
      trimImages = true,
      trimAlphaThreshold = 0,
      heuristic = 'best-short-side',
    } = options;

    console.log('🎨 Creating BigAtlas from assets...');
    if (trimImages) {
      console.log(`  📐 Trimming enabled (alpha threshold: ${trimAlphaThreshold})`);
    }

    const maxWidth = maxAtlasWidth;
    const maxHeight = maxAtlasHeight;
    const padding = atlasPadding;
    const packer = new this.MaxRectsPacker(maxWidth, maxHeight, padding);

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
        this._loadImage(url).then((img) => {
          let sourceImg = img;
          let width = img.width;
          let height = img.height;
          let trimInfo = null;

          // Apply trimming to individual images (not spritesheet frames)
          if (trimImages) {
            const trimResult = this._trimImage(img, trimAlphaThreshold);
            if (trimResult) {
              if (trimResult.wasTrimmed) {
                sourceImg = trimResult.canvas;
                width = trimResult.bounds.width;
                height = trimResult.bounds.height;
                trimInfo = trimResult.bounds;
                console.log(
                  `  ✅ Loaded image: ${name} (${img.width}x${img.height} → ${width}x${height} trimmed)`
                );
              } else {
                console.log(`  ✅ Loaded image: ${name} (${img.width}x${img.height})`);
              }
            } else {
              // Fully transparent image - still add it but warn
              console.warn(`  ⚠️ Image "${name}" is fully transparent`);
            }
          } else {
            console.log(`  ✅ Loaded image: ${name} (${img.width}x${img.height})`);
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
          this._loadSpritesheet(sheetName, config).then((sheetData) => {
            const { img, jsonData } = sheetData;
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

            // Reusable canvas for frame extraction (sized to max frame)
            let maxW = 0, maxH = 0;
            for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
              if (!requiredFrames.has(frameName)) continue;
              maxW = Math.max(maxW, frameData.frame.w);
              maxH = Math.max(maxH, frameData.frame.h);
            }
            const extractCanvas = document.createElement('canvas');
            extractCanvas.width = maxW;
            extractCanvas.height = maxH;
            const extractCtx = extractCanvas.getContext('2d', { willReadFrequently: true });

            // Stats for logging
            let trimmedCount = 0;
            let savedPixels = 0;

            // 2. Extract and optionally trim each frame
            for (const [frameName, frameData] of Object.entries(jsonData.frames)) {
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
              let trimmedCanvas = null;

              if (trimImages) {
                // Extract frame to canvas for trimming analysis
                extractCtx.clearRect(0, 0, originalW, originalH);
                extractCtx.drawImage(img, frame.x, frame.y, originalW, originalH, 0, 0, originalW, originalH);

                // Get trim bounds within this frame
                const trimBounds = this._getTrimBoundsFromCanvas(extractCtx, originalW, originalH, trimAlphaThreshold);

                if (trimBounds && (trimBounds.width < originalW || trimBounds.height < originalH)) {
                  // Frame can be trimmed!
                  packedWidth = trimBounds.width;
                  packedHeight = trimBounds.height;
                  trimOffsetX = trimBounds.x;
                  trimOffsetY = trimBounds.y;

                  // Create trimmed canvas for this frame
                  trimmedCanvas = document.createElement('canvas');
                  trimmedCanvas.width = packedWidth;
                  trimmedCanvas.height = packedHeight;
                  const trimmedCtx = trimmedCanvas.getContext('2d');
                  trimmedCtx.drawImage(
                    extractCanvas,
                    trimOffsetX, trimOffsetY, packedWidth, packedHeight,
                    0, 0, packedWidth, packedHeight
                  );

                  trimmedCount++;
                  savedPixels += (originalW * originalH) - (packedWidth * packedHeight);
                }
              }

              imagesToPack.push({
                name: prefixedName,
                // For trimmed frames: use trimmed canvas; otherwise draw from source
                sourceImg: trimmedCanvas || img,
                sourceRect: trimmedCanvas ? null : frame,  // null = use entire sourceImg
                width: packedWidth,
                height: packedHeight,
                // PixiJS trim metadata: offset within original frame
                sourceX: trimOffsetX,
                sourceY: trimOffsetY,
                sourceWidth: originalW,   // Original frame size (for anchor calculations)
                sourceHeight: originalH,
                pivot: frameData.pivot,
                isSpritesheetFrame: true,
                isTrimmed: trimmedCanvas !== null,
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
              console.log(
                `  ✅ Loaded spritesheet: ${sheetName} (${totalFrames} frames, ${trimmedCount} trimmed, ~${savedKB}KB saved)`
              );
            } else {
              console.log(
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

    // ========================================
    // INJECT BUILT-IN TEXTURES
    // ========================================
    // Empty transparent pixel - reserved as animation index 0 so accidental
    // textureId=0 fallbacks render invisibly instead of showing a real asset.
    const emptyCanvas = document.createElement('canvas');
    emptyCanvas.width = 1;
    emptyCanvas.height = 1;
    const emptyCtx = emptyCanvas.getContext('2d');
    emptyCtx.clearRect(0, 0, 1, 1);
    imagesToPack.push({
      name: '_empty',
      sourceImg: emptyCanvas,
      sourceRect: null,
      width: 1,
      height: 1,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 1,
      sourceHeight: 1,
      isSpritesheetFrame: false,
    });
    console.log(`  ✅ Generated built-in: _empty (1x1 transparent)`);

    // Light glow gradient (200px diameter white radial gradient)
    const lightGradientCanvas = createCircularGradientCanvas(100, 0xffffff);
    imagesToPack.push({
      name: '_lightGradient',
      sourceImg: lightGradientCanvas,
      sourceRect: null,
      width: lightGradientCanvas.width,
      height: lightGradientCanvas.height,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: lightGradientCanvas.width,
      sourceHeight: lightGradientCanvas.height,
      isSpritesheetFrame: false,
    });
    animations['_lightGradient'] = ['_lightGradient'];
    console.log(
      `  ✅ Generated built-in: _lightGradient (${lightGradientCanvas.width}x${lightGradientCanvas.height})`
    );

    // Bullet trail line (10x1 white with gradient alpha: prev→curr)
    const bulletTrailCanvas = createBulletTrailCanvas(10, 1, 0xffffff);
    imagesToPack.push({
      name: '_bulletTrail',
      sourceImg: bulletTrailCanvas,
      sourceRect: null,
      width: bulletTrailCanvas.width,
      height: bulletTrailCanvas.height,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: bulletTrailCanvas.width,
      sourceHeight: bulletTrailCanvas.height,
      isSpritesheetFrame: false,
    });
    animations['_bulletTrail'] = ['_bulletTrail'];
    console.log(
      `  ✅ Generated built-in: _bulletTrail (${bulletTrailCanvas.width}x${bulletTrailCanvas.height})`
    );

    // White square (8x8 solid white - used as default/background texture)
    const whiteSquareCanvas = document.createElement('canvas');
    whiteSquareCanvas.width = 8;
    whiteSquareCanvas.height = 8;
    const whiteCtx = whiteSquareCanvas.getContext('2d');
    whiteCtx.fillStyle = '#ffffff';
    whiteCtx.fillRect(0, 0, 8, 8);
    imagesToPack.push({
      name: '_white',
      sourceImg: whiteSquareCanvas,
      sourceRect: null,
      width: 8,
      height: 8,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 8,
      sourceHeight: 8,
      isSpritesheetFrame: false,
    });
    animations['_white'] = ['_white'];
    console.log(`  ✅ Generated built-in: _white (8x8)`);

    // White circle (radius 4px - used for particles, bullets, etc.)
    const whiteCircleCanvas = document.createElement('canvas');
    whiteCircleCanvas.width = 8;
    whiteCircleCanvas.height = 8;
    const whiteCircleCtx = whiteCircleCanvas.getContext('2d');
    whiteCircleCtx.fillStyle = '#ffffff';
    whiteCircleCtx.beginPath();
    whiteCircleCtx.arc(4, 4, 4, 0, Math.PI * 2);
    whiteCircleCtx.fill();
    imagesToPack.push({
      name: '_whiteCircle',
      sourceImg: whiteCircleCanvas,
      sourceRect: null,
      width: 8,
      height: 8,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 8,
      sourceHeight: 8,
      isSpritesheetFrame: false,
    });
    animations['_whiteCircle'] = ['_whiteCircle'];

    console.log(`  ✅ Generated built-in: _whiteCircle (8x8, radius 4px)`);

    /// bigger white circle:

    // White circle filling the 64x64 frame (used when a larger centered circle is needed)
    const biggerwhiteCircleCanvas = document.createElement('canvas');
    biggerwhiteCircleCanvas.width = 64;
    biggerwhiteCircleCanvas.height = 64;
    const biggerwhiteCircleCtx = biggerwhiteCircleCanvas.getContext('2d');
    biggerwhiteCircleCtx.fillStyle = '#ffffff';
    biggerwhiteCircleCtx.beginPath();
    biggerwhiteCircleCtx.arc(32, 32, 32, 0, Math.PI * 2);
    biggerwhiteCircleCtx.fill();
    imagesToPack.push({
      name: '_whiteCircle_64x64',
      sourceImg: biggerwhiteCircleCanvas,
      sourceRect: null,
      width: 64,
      height: 64,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 64,
      sourceHeight: 64,
      isSpritesheetFrame: false,
    });
    animations['_whiteCircle_64x64'] = ['_whiteCircle_64x64'];

    // Sort images by size (largest first) for better packing
    imagesToPack.sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height));

    // No need to wait for intermediate images anymore!
    // We now store references to source images and draw directly to final atlas.

    console.log(`🎨 Packing ${imagesToPack.length} images into atlas...`);

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

    // Warn if atlas is too large for many mobile devices/GPUs
    if (actualWidth > 4096 || actualHeight > 4096) {
      console.warn(
        `⚠️ BigAtlas dimensions (${actualWidth}x${actualHeight}) exceed 4096x4096. ` +
        `This may cause performance issues or fail to render on some mobile devices or older GPUs.`
      );
    }

    // Create canvas and draw packed atlas
    const canvas = document.createElement('canvas');
    canvas.width = actualWidth;
    canvas.height = actualHeight;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, actualWidth, actualHeight);

    // Draw all images to atlas
    for (const imgData of imagesToPack) {
      if (!imgData.rect) continue;

      if (imgData.sourceRect) {
        // Spritesheet frame: draw from source rect
        const sr = imgData.sourceRect;
        ctx.drawImage(
          imgData.sourceImg,
          sr.x, sr.y, sr.w, sr.h,             // Source rect in spritesheet
          imgData.rect.x, imgData.rect.y,     // Destination in atlas
          imgData.rect.width, imgData.rect.height
        );
      } else {
        // Individual image or canvas: draw entire source
        ctx.drawImage(
          imgData.sourceImg,
          imgData.rect.x,
          imgData.rect.y,
          imgData.rect.width,
          imgData.rect.height
        );
      }
    }

    const atlasJson = {
      frames: frames,
      animations: animations,
      meta: {
        image: 'bigAtlas.png',
        format: 'RGBA8888',
        size: { w: actualWidth, h: actualHeight },
        scale: 1,
      },
    };

    // Register individual texture names as spritesheet IDs
    // This allows setSpritesheet("ball") to work for static textures
    const individualTextures = [];
    for (const [name, url] of Object.entries(assetsConfig)) {
      if (name === 'spritesheets' || typeof url !== 'string') continue;
      this.registerSpritesheetId(name);
      individualTextures.push(name);
    }

    // Log creation summary with trim stats
    const frameCount = Object.keys(frames).length;
    const animCount = Object.keys(animations).length;
    const savedKB = Math.round(totalPixelsSaved * 4 / 1024); // 4 bytes per RGBA pixel

    if (trimImages && totalTrimmed > 0) {
      console.log(
        `✅ BigAtlas created: ${actualWidth}x${actualHeight} with ${frameCount} frames, ${animCount} animations\n` +
        `   📐 Trimming: ${totalTrimmed}/${frameCount} frames trimmed, ~${savedKB}KB saved`
      );
    } else {
      console.log(
        `✅ BigAtlas created: ${actualWidth}x${actualHeight} with ${frameCount} frames, ${animCount} animations`
      );
    }

    return {
      canvas: canvas,
      json: atlasJson,
      proxySheets: proxySheets,
      individualTextures: individualTextures, // For reference
    };
  }

  /**
   * Helper: Load an image from URL
   * @private
   */
  static async _loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
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
  static _getTrimBounds(img, alphaThreshold = 0) {
    // Draw image to canvas to read pixel data
    const w = img.width;
    const h = img.height;
    if (w === 0 || h === 0) return null;

    // Reuse trim canvas if available
    if (!this._trimCanvas) {
      this._trimCanvas = document.createElement('canvas');
      this._trimCtx = this._trimCanvas.getContext('2d', { willReadFrequently: true });
    }
    const canvas = this._trimCanvas;
    const ctx = this._trimCtx;

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

    // Scan for non-transparent pixels
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const alpha = data[(y * w + x) * 4 + 3];
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
  static _getTrimBoundsFromCanvas(ctx, width, height, alphaThreshold = 0) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    let minX = width, minY = height, maxX = -1, maxY = -1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha > alphaThreshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < 0 || maxY < 0) return null; // Fully transparent

    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  }

  /**
   * Helper: Trim transparent pixels from an image
   * Returns a new canvas with trimmed content and the trim bounds
   * @private
   * @param {HTMLImageElement|HTMLCanvasElement} img - Image to trim
   * @param {number} alphaThreshold - Pixels with alpha <= this are trimmed
   * @returns {{canvas: HTMLCanvasElement, bounds: {x, y, width, height}} | null}
   */
  static _trimImage(img, alphaThreshold = 0) {
    const bounds = this._getTrimBounds(img, alphaThreshold);
    if (!bounds) return null; // Fully transparent

    // If no trimming needed (bounds = full image), return original
    if (bounds.x === 0 && bounds.y === 0 &&
      bounds.width === img.width && bounds.height === img.height) {
      return { canvas: img, bounds, wasTrimmed: false };
    }

    // Create trimmed canvas
    const trimmedCanvas = document.createElement('canvas');
    trimmedCanvas.width = bounds.width;
    trimmedCanvas.height = bounds.height;
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
  static async _loadSpritesheet(name, config) {
    if (config.jsonData && config.img) {
      return { img: config.img, jsonData: config.jsonData };
    }

    if (!config.json || !config.png) {
      throw new Error(`Invalid spritesheet config for "${name}": missing json or png`);
    }

    const jsonResponse = await fetch(config.json);
    const jsonData = await jsonResponse.json();
    const img = await this._loadImage(config.png);

    return { img, jsonData };
  }

  /**
   * Register a proxy sheet (transparent redirection to bigAtlas)
   * @private
   */
  static registerProxy(sheetName, proxyData) {
    this.spritesheets.set(sheetName, proxyData);

    // Auto-register spritesheet ID for per-instance switching
    this.registerSpritesheetId(sheetName);

    console.log(`  🔗 Registered proxy sheet: ${sheetName} → bigAtlas`);
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
  // 3. Decal stamp: stampDecal({ texture: "civil1_hurt_5" }) → stamps that exact frame
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
