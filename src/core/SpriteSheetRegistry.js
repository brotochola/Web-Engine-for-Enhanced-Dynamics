// SpriteSheetRegistry.js - Centralized spritesheet metadata management
// Provides string→index mapping for animations without runtime overhead
// String lookups happen ONCE at setup, game loop uses fast numeric indices

import { createCircularGradientCanvas } from './utils.js';

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
   * Handles proxy sheets transparently
   *
   * @param {string} sheetName - Spritesheet name
   * @param {string} animName - Animation name
   * @returns {Object|undefined} Animation metadata or undefined
   */
  static getAnimationData(sheetName, animName) {
    const sheet = this.spritesheets.get(sheetName);
    if (!sheet) return undefined;

    if (sheet.isProxy) {
      // Return proxy's own animation data (includes proxy-specific index)
      return sheet.animations[animName];
    }

    return sheet.animations[animName];
  }

  /**
   * Get all animation names for a spritesheet
   * Useful for UI, debugging, validation
   * Handles proxy sheets transparently (returns unprefixed names)
   *
   * @param {string} sheetName - Spritesheet name
   * @returns {string[]} Array of animation names
   */
  static getAnimationNames(sheetName) {
    const sheet = this.spritesheets.get(sheetName);
    if (!sheet) return [];

    if (sheet.isProxy) {
      // Return unprefixed animation names for developer convenience
      return Object.keys(sheet.animations);
    }

    return Object.keys(sheet.animations);
  }

  /**
   * Check if an animation exists
   * Handles proxy sheets transparently
   *
   * @param {string} sheetName - Spritesheet name
   * @param {string} animName - Animation name
   * @returns {boolean} True if animation exists
   */
  static hasAnimation(sheetName, animName) {
    const sheet = this.spritesheets.get(sheetName);
    if (!sheet) return false;

    if (sheet.isProxy) {
      return animName in sheet.animations;
    }

    return animName in sheet.animations;
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

    // Restore spritesheets
    const sheets = serialized.spritesheets || serialized;
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

  /**
   * MaxRectsPacker - Rectangle packing algorithm for texture atlas generation
   * Port of the MaxRects algorithm for efficient sprite packing
   * @private
   */
  static MaxRectsPacker = class {
    constructor(width, height, padding = 0) {
      this.width = width;
      this.height = height;
      this.padding = padding;
      this.freeRects = [{ x: 0, y: 0, width, height }];
      this.usedRects = [];
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
      let numRectsToProcess = this.freeRects.length;
      for (let i = 0; i < numRectsToProcess; i++) {
        if (this.splitFreeNode(this.freeRects[i], rect)) {
          this.freeRects.splice(i, 1);
          i--;
          numRectsToProcess--;
        }
      }

      this.pruneFreeList();
      this.usedRects.push(rect);
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
      for (let i = 0; i < this.freeRects.length; i++) {
        for (let j = i + 1; j < this.freeRects.length; j++) {
          if (this.isContainedIn(this.freeRects[i], this.freeRects[j])) {
            this.freeRects.splice(i, 1);
            i--;
            break;
          }
          if (this.isContainedIn(this.freeRects[j], this.freeRects[i])) {
            this.freeRects.splice(j, 1);
            j--;
          }
        }
      }
    }

    isContainedIn(a, b) {
      return (
        a.x >= b.x &&
        a.y >= b.y &&
        a.x + a.width <= b.x + b.width &&
        a.y + a.height <= b.y + b.height
      );
    }
  };

  /**
   * Create a unified BigAtlas from individual images and spritesheets
   * This combines all textures into a single atlas for optimal rendering performance
   *
   * @param {Object} assetsConfig - Asset configuration
   * @param {Object} options - Packing options { maxWidth, maxHeight, padding, heuristic }
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
   * });
   */
  static async createBigAtlas(
    assetsConfig,
    options = {
      maxWidth: 4096,
      maxHeight: 4096,
      padding: 2,
      heuristic: 'best-short-side',
    }
  ) {
    console.log('🎨 Creating BigAtlas from assets...');

    const { maxWidth, maxHeight, padding, heuristic } = options;
    const packer = new this.MaxRectsPacker(maxWidth, maxHeight, padding);

    const frames = {};
    const animations = {};
    const imagesToPack = [];
    const proxySheets = {}; // Track proxy sheet metadata

    // Load individual images (these become single-frame "animations")
    const individualImagePromises = [];
    for (const [name, url] of Object.entries(assetsConfig)) {
      if (name === 'spritesheets' || typeof url !== 'string') continue;

      individualImagePromises.push(
        this._loadImage(url).then((img) => {
          imagesToPack.push({
            name: name,
            img: img,
            width: img.width,
            height: img.height,
            sourceX: 0,
            sourceY: 0,
            sourceWidth: img.width,
            sourceHeight: img.height,
          });

          // Create a single-frame "animation" for this image
          // This allows static textures to be referenced consistently
          animations[name] = [name];

          console.log(`  ✅ Loaded image: ${name} (${img.width}x${img.height})`);
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
              Object.entries(jsonData.animations).forEach(([animName, frameList]) => {
                if (excluded.includes(animName)) return;

                animationsToProcess.push({ animName, frameList });
                frameList.forEach((f) => requiredFrames.add(f));
              });
            } else {
              // If no animations defined, keep all frames
              Object.keys(jsonData.frames).forEach((f) => requiredFrames.add(f));
            }

            // Create proxy sheet entry with its own index space
            proxySheets[sheetName] = {
              isProxy: true,
              targetSheet: 'bigAtlas',
              prefix: `${sheetName}_`,
              animations: {},
              indexToName: {}, // Each proxy has its own animation index space
            };

            // 2. Extract ONLY required frames from this spritesheet
            Object.entries(jsonData.frames).forEach(([frameName, frameData]) => {
              // Skip if this frame isn't used by any included animation
              if (!requiredFrames.has(frameName)) return;

              const prefixedName = `${sheetName}_${frameName}`;
              const frame = frameData.frame;

              // Create canvas to extract this frame
              const frameCanvas = document.createElement('canvas');
              frameCanvas.width = frame.w;
              frameCanvas.height = frame.h;
              const frameCtx = frameCanvas.getContext('2d');

              frameCtx.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);

              // Convert to image for packing
              const frameImg = new Image();
              frameImg.src = frameCanvas.toDataURL();

              imagesToPack.push({
                name: prefixedName,
                img: frameImg,
                width: frame.w,
                height: frame.h,
                sourceX: frameData.spriteSourceSize?.x || 0,
                sourceY: frameData.spriteSourceSize?.y || 0,
                sourceWidth: frameData.sourceSize?.w || frame.w,
                sourceHeight: frameData.sourceSize?.h || frame.h,
                pivot: frameData.pivot,
              });
            });

            // 3. Map included animations with prefixed names
            let proxyIndex = 0; // Each proxy sheet has its own index space starting at 0
            animationsToProcess.forEach(({ animName, frameList }) => {
              const prefixedAnimName = `${sheetName}_${animName}`;
              animations[prefixedAnimName] = frameList.map((f) => `${sheetName}_${f}`);

              // Store in proxy for transparent lookup
              proxySheets[sheetName].animations[animName] = {
                originalName: animName,
                prefixedName: prefixedAnimName,
                index: proxyIndex, // Proxy-specific index
              };

              // Build proxy's own indexToName mapping
              proxySheets[sheetName].indexToName[proxyIndex] = animName;
              proxyIndex++;
            });

            console.log(
              `  ✅ Loaded spritesheet: ${sheetName} (${requiredFrames.size}/${
                Object.keys(jsonData.frames).length
              } frames, ${animationsToProcess.length}/${
                Object.keys(jsonData.animations || {}).length
              } animations)`
            );
          })
        );
      }
    }

    // Wait for all assets to load
    await Promise.all([...individualImagePromises, ...spritesheetPromises]);

    // ========================================
    // INJECT BUILT-IN TEXTURES
    // ========================================
    // Light glow gradient (200px diameter white radial gradient)
    const lightGradientCanvas = createCircularGradientCanvas(100, 0xffffff);
    imagesToPack.push({
      name: '_lightGradient',
      img: lightGradientCanvas,
      width: lightGradientCanvas.width,
      height: lightGradientCanvas.height,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: lightGradientCanvas.width,
      sourceHeight: lightGradientCanvas.height,
    });
    animations['_lightGradient'] = ['_lightGradient'];
    console.log(
      `  ✅ Generated built-in: _lightGradient (${lightGradientCanvas.width}x${lightGradientCanvas.height})`
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
      img: whiteSquareCanvas,
      width: 8,
      height: 8,
      sourceX: 0,
      sourceY: 0,
      sourceWidth: 8,
      sourceHeight: 8,
    });
    animations['_white'] = ['_white'];
    console.log(`  ✅ Generated built-in: _white (8x8)`);

    // Sort images by size (largest first) for better packing
    imagesToPack.sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height));

    // Wait for all frame images to be ready
    // Note: Canvas elements are always "complete" (no loading needed)
    await Promise.all(
      imagesToPack.map(
        (imgData) =>
          new Promise((resolve) => {
            // Canvas elements don't need loading - they're ready immediately
            if (imgData.img instanceof HTMLCanvasElement) {
              resolve();
            } else if (imgData.img.complete) {
              resolve();
            } else {
              imgData.img.onload = resolve;
            }
          })
      )
    );

    console.log(`🎨 Packing ${imagesToPack.length} images into atlas...`);

    // Pack all images
    let actualWidth = 0;
    let actualHeight = 0;

    for (const imgData of imagesToPack) {
      const rect = packer.insert(imgData.width, imgData.height, heuristic);

      if (!rect) {
        throw new Error(
          `Could not fit "${imgData.name}" into atlas. Try increasing maxWidth/maxHeight.`
        );
      }

      frames[imgData.name] = {
        frame: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        rotated: false,
        trimmed: false,
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

    for (const imgData of imagesToPack) {
      if (imgData.rect) {
        ctx.drawImage(
          imgData.img,
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

    console.log('#### frames', frames);

    // Register individual texture names as spritesheet IDs
    // This allows setSpritesheet("ball") to work for static textures
    const individualTextures = [];
    for (const [name, url] of Object.entries(assetsConfig)) {
      if (name === 'spritesheets' || typeof url !== 'string') continue;
      this.registerSpritesheetId(name);
      individualTextures.push(name);
    }

    console.log(
      `✅ BigAtlas created: ${actualWidth}x${actualHeight} with ${
        Object.keys(frames).length
      } frames, ${Object.keys(animations).length} animations`
    );

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
   * Helper: Load a spritesheet (JSON + PNG)
   * @private
   */
  static async _loadSpritesheet(name, config) {
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
   * getTextureId("blood")           // → animation index for "blood"
   *
   * @example
   * // Spritesheet animation (first frame used)
   * getTextureId("civil1_hurt")     // → animation index for "civil1_hurt"
   *
   * @example
   * // Specific frame (for decals only!)
   * getTextureId("civil1_hurt_5")   // → frame-specific ID (decal stamping only)
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
