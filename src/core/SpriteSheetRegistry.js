// SpriteSheetRegistry.js - Centralized spritesheet metadata management
// Provides string→index mapping for animations without runtime overhead
// String lookups happen ONCE at setup, game loop uses fast numeric indices

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

  /**
   * Register a spritesheet and build animation index
   * Called once per spritesheet during asset loading
   *
   * @param {string} name - Spritesheet identifier (e.g., "lpc", "enemy_sprites")
   * @param {Object} jsonData - Parsed spritesheet JSON with {frames, animations, meta}
   */
  static register(name, jsonData) {
    if (!jsonData.animations) {
      console.error(
        `❌ Invalid spritesheet "${name}": missing "animations" property`
      );
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

    const metadata = {
      name: name,
      animations: animations, // String → {index, frameCount, frames}
      indexToName: indexToName, // Number → String (for debugging)
      totalAnimations: currentIndex,
      meta: jsonData.meta, // Original metadata (image path, size, etc.)
    };

    this.spritesheets.set(name, metadata);

    console.log(
      `✅ Registered spritesheet "${name}": ${currentIndex} animations`
    );
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

    // Handle proxy sheets (redirect to bigAtlas with prefixed name)
    if (sheet.isProxy) {
      const prefixedAnimName = sheet.prefix + animName;
      const targetSheet = this.spritesheets.get(sheet.targetSheet);

      if (!targetSheet) {
        console.error(
          `❌ Proxy target "${sheet.targetSheet}" not found for sheet "${sheetName}"`
        );
        return undefined;
      }

      const anim = targetSheet.animations[prefixedAnimName];
      if (!anim) {
        // Provide helpful suggestions for typos
        const available = Object.keys(sheet.animations).map((name) =>
          name.replace(sheet.prefix, "")
        );
        const suggestions = this._findSimilar(animName, available).slice(0, 3);
        console.error(
          `❌ Animation "${animName}" not found in "${sheetName}"\n` +
            `   Available animations: ${available.length}\n` +
            (suggestions.length > 0
              ? `   Did you mean: ${suggestions.join(", ")}?`
              : "")
        );
        return undefined;
      }

      return anim.index;
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
          (suggestions.length > 0
            ? `   Did you mean: ${suggestions.join(", ")}?`
            : "")
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
      const targetSheet = this.spritesheets.get(sheet.targetSheet);
      if (!targetSheet) return undefined;

      const prefixedName = targetSheet.indexToName[index];
      // Strip prefix to return original name
      return prefixedName?.replace(sheet.prefix, "");
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
      const prefixedAnimName = sheet.prefix + animName;
      const targetSheet = this.spritesheets.get(sheet.targetSheet);
      return targetSheet?.animations[prefixedAnimName];
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
   * Serialize registry for workers (convert to plain objects)
   * Workers can't use Map instances, so we convert to plain objects
   * NOTE: Proxy sheets are NOT serialized - they're reconstructed in workers
   *
   * @returns {Object} Serialized registry metadata
   */
  static serialize() {
    const serialized = {};

    for (const [name, sheet] of this.spritesheets) {
      // Skip proxy sheets - they'll be registered separately in workers
      if (sheet.isProxy) continue;

      serialized[name] = {
        name: sheet.name,
        animations: sheet.animations,
        indexToName: sheet.indexToName,
        totalAnimations: sheet.totalAnimations,
        meta: sheet.meta,
      };
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

    for (const [name, sheet] of Object.entries(serialized)) {
      this.spritesheets.set(name, sheet);
    }

    console.log(
      `✅ Deserialized ${this.spritesheets.size} spritesheets in worker`
    );
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
      console.error(
        `❌ ${entityName}: spriteConfig missing "spritesheet" property`
      );
      return false;
    }

    if (!this.spritesheets.has(spritesheet)) {
      console.error(
        `❌ ${entityName}: Unknown spritesheet "${spritesheet}"\n` +
          `   Available: ${this.getSpritesheetNames().join(", ")}`
      );
      return false;
    }

    if (defaultAnimation && !this.hasAnimation(spritesheet, defaultAnimation)) {
      console.error(
        `❌ ${entityName}: Invalid defaultAnimation "${defaultAnimation}"\n` +
          `   Available: ${this.getAnimationNames(spritesheet).join(", ")}`
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

    insert(width, height, heuristic = "best-short-side") {
      width += this.padding * 2;
      height += this.padding * 2;

      let bestRect = null;
      let bestScore = Infinity;
      let bestSecondaryScore = Infinity;

      for (let freeRect of this.freeRects) {
        if (freeRect.width >= width && freeRect.height >= height) {
          let score, secondaryScore;

          if (heuristic === "best-short-side") {
            score = Math.min(freeRect.width - width, freeRect.height - height);
            secondaryScore = Math.max(
              freeRect.width - width,
              freeRect.height - height
            );
          } else if (heuristic === "best-long-side") {
            score = Math.max(freeRect.width - width, freeRect.height - height);
            secondaryScore = Math.min(
              freeRect.width - width,
              freeRect.height - height
            );
          } else if (heuristic === "best-area") {
            score = freeRect.width * freeRect.height - width * height;
            secondaryScore = Math.min(
              freeRect.width - width,
              freeRect.height - height
            );
          } else {
            // bottom-left
            score = freeRect.y;
            secondaryScore = freeRect.x;
          }

          if (
            score < bestScore ||
            (score === bestScore && secondaryScore < bestSecondaryScore)
          ) {
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

      if (
        usedNode.x < freeNode.x + freeNode.width &&
        usedNode.x + usedNode.width > freeNode.x
      ) {
        if (
          usedNode.y > freeNode.y &&
          usedNode.y < freeNode.y + freeNode.height
        ) {
          let newNode = { ...freeNode };
          newNode.height = usedNode.y - newNode.y;
          this.freeRects.push(newNode);
        }

        if (usedNode.y + usedNode.height < freeNode.y + freeNode.height) {
          let newNode = { ...freeNode };
          newNode.y = usedNode.y + usedNode.height;
          newNode.height =
            freeNode.y + freeNode.height - (usedNode.y + usedNode.height);
          this.freeRects.push(newNode);
        }
      }

      if (
        usedNode.y < freeNode.y + freeNode.height &&
        usedNode.y + usedNode.height > freeNode.y
      ) {
        if (
          usedNode.x > freeNode.x &&
          usedNode.x < freeNode.x + freeNode.width
        ) {
          let newNode = { ...freeNode };
          newNode.width = usedNode.x - newNode.x;
          this.freeRects.push(newNode);
        }

        if (usedNode.x + usedNode.width < freeNode.x + freeNode.width) {
          let newNode = { ...freeNode };
          newNode.x = usedNode.x + usedNode.width;
          newNode.width =
            freeNode.x + freeNode.width - (usedNode.x + usedNode.width);
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
      maxWidth: 2048,
      maxHeight: 2048,
      padding: 2,
      heuristic: "best-short-side",
    }
  ) {
    console.log("🎨 Creating BigAtlas from assets...");

    const { maxWidth, maxHeight, padding, heuristic } = options;
    const packer = new this.MaxRectsPacker(maxWidth, maxHeight, padding);

    const frames = {};
    const animations = {};
    const imagesToPack = [];
    const proxySheets = {}; // Track proxy sheet metadata

    // Load individual images (these become single-frame "animations")
    const individualImagePromises = [];
    for (const [name, url] of Object.entries(assetsConfig)) {
      if (name === "spritesheets" || typeof url !== "string") continue;

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

          console.log(
            `  ✅ Loaded image: ${name} (${img.width}x${img.height})`
          );
        })
      );
    }

    // Load spritesheets
    const spritesheetPromises = [];
    if (assetsConfig.spritesheets) {
      for (const [sheetName, config] of Object.entries(
        assetsConfig.spritesheets
      )) {
        spritesheetPromises.push(
          this._loadSpritesheet(sheetName, config).then((sheetData) => {
            const { img, jsonData } = sheetData;

            // Create proxy sheet entry
            proxySheets[sheetName] = {
              isProxy: true,
              targetSheet: "bigAtlas",
              prefix: `${sheetName}_`,
              animations: {},
            };

            // Extract frames from this spritesheet
            Object.entries(jsonData.frames).forEach(
              ([frameName, frameData]) => {
                const prefixedName = `${sheetName}_${frameName}`;
                const frame = frameData.frame;

                // Create canvas to extract this frame
                const frameCanvas = document.createElement("canvas");
                frameCanvas.width = frame.w;
                frameCanvas.height = frame.h;
                const frameCtx = frameCanvas.getContext("2d");

                frameCtx.drawImage(
                  img,
                  frame.x,
                  frame.y,
                  frame.w,
                  frame.h,
                  0,
                  0,
                  frame.w,
                  frame.h
                );

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
              }
            );

            // Map animations with prefixed names
            if (jsonData.animations) {
              Object.entries(jsonData.animations).forEach(
                ([animName, frameList]) => {
                  const prefixedAnimName = `${sheetName}_${animName}`;
                  animations[prefixedAnimName] = frameList.map(
                    (f) => `${sheetName}_${f}`
                  );

                  // Store in proxy for transparent lookup
                  proxySheets[sheetName].animations[animName] = {
                    originalName: animName,
                    prefixedName: prefixedAnimName,
                  };
                }
              );
            }

            console.log(
              `  ✅ Loaded spritesheet: ${sheetName} (${
                Object.keys(jsonData.frames).length
              } frames, ${
                Object.keys(jsonData.animations || {}).length
              } animations)`
            );
          })
        );
      }
    }

    // Wait for all assets to load
    await Promise.all([...individualImagePromises, ...spritesheetPromises]);

    // Sort images by size (largest first) for better packing
    imagesToPack.sort(
      (a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height)
    );

    // Wait for all frame images to be ready
    await Promise.all(
      imagesToPack.map(
        (imgData) =>
          new Promise((resolve) => {
            if (imgData.img.complete) {
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

    // Create canvas and draw packed atlas
    const canvas = document.createElement("canvas");
    canvas.width = actualWidth;
    canvas.height = actualHeight;
    const ctx = canvas.getContext("2d");

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
        image: "bigAtlas.png",
        format: "RGBA8888",
        size: { w: actualWidth, h: actualHeight },
        scale: 1,
      },
    };

    console.log(
      `✅ BigAtlas created: ${actualWidth}x${actualHeight} with ${
        Object.keys(frames).length
      } frames, ${Object.keys(animations).length} animations`
    );

    return {
      canvas: canvas,
      json: atlasJson,
      proxySheets: proxySheets,
    };
  }

  /**
   * Helper: Load an image from URL
   * @private
   */
  static async _loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
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
      throw new Error(
        `Invalid spritesheet config for "${name}": missing json or png`
      );
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
    console.log(`  🔗 Registered proxy sheet: ${sheetName} → bigAtlas`);
  }
}

// ES6 module export

export { SpriteSheetRegistry };
