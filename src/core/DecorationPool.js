// DecorationPool.js - Static API for spawning/despawning decorations
// Used by game code to place static visual elements (grass, rocks, bushes, etc.)
// Decorations are NOT GameObjects - they use DecorationComponent directly

import { DecorationComponent } from "../components/DecorationComponent.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import { randomRange } from "./utils.js";

export class DecorationPool {
  // Pool size (set during initialization)
  static maxDecorations = 0;
  static initialized = false;

  // Shared counter for active decorations (backed by SharedArrayBuffer)
  // Used for early-exit optimization in workers
  static activeCount = null; // Uint32Array[1]

  /**
   * Initialize the decoration pool
   * Called automatically by logic worker during init
   * @param {number} maxDecorations - Number of decorations in pool
   */
  static initialize(maxDecorations) {
    this.maxDecorations = maxDecorations;
    this.initialized = true;
    console.log(
      `DecorationPool: Initialized with ${maxDecorations} decorations (indices 0-${
        maxDecorations - 1
      })`
    );
  }

  /**
   * Initialize the shared active count buffer
   * Called by workers to connect to the shared counter
   * @param {SharedArrayBuffer} buffer - 4-byte buffer for active count
   */
  static initializeActiveCount(buffer) {
    this.activeCount = new Uint32Array(buffer);
  }

  /**
   * Spawn a decoration with the given configuration
   *
   * @param {Object} config - Decoration spawn configuration
   * @param {number|{min,max}} config.x - X position or range
   * @param {number|{min,max}} config.y - Y position or range
   * @param {string} config.texture - Texture name (from bigAtlas)
   * @param {number|{min,max}} [config.scale=1] - Scale or range
   * @param {number|{min,max}} [config.alpha=1] - Alpha (opacity) or range
   * @param {number} [config.tint=0xFFFFFF] - Color tint (0xRRGGBB)
   * @param {number} [config.anchorX=0.5] - Anchor X (0-1)
   * @param {number} [config.anchorY=0.5] - Anchor Y (0-1)
   * @returns {number} - Index of spawned decoration, or -1 if pool is full
   *
   * @example
   * // Spawn grass at random position with bottom anchor
   * const index = DecorationPool.spawn({
   *   x: rng() * worldWidth,
   *   y: rng() * worldHeight,
   *   texture: "grass3",
   *   scale: { min: 0.8, max: 1.2 },
   *   anchorX: 0.5,
   *   anchorY: 1.0,
   * });
   */
  static spawn(config) {
    if (!this.initialized) {
      console.warn("DecorationPool.spawn() called before initialization");
      return -1;
    }

    // Resolve texture name to textureId (frame index in bigAtlas)
    let textureId = 0;
    if (config.texture) {
      textureId =
        SpriteSheetRegistry.getAnimationIndex("bigAtlas", config.texture) ?? 0;
    }

    // Cache array references for performance
    const active = DecorationComponent.active;
    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const scale = DecorationComponent.scale;
    const alpha = DecorationComponent.alpha;
    const tint = DecorationComponent.tint;
    const anchorX = DecorationComponent.anchorX;
    const anchorY = DecorationComponent.anchorY;
    const decorationTextureId = DecorationComponent.textureId;
    const isItOnScreen = DecorationComponent.isItOnScreen;

    // Scan for inactive decoration slot
    for (let i = 0; i < this.maxDecorations; i++) {
      if (active[i] === 0) {
        // Position
        x[i] = randomRange(config.x);
        y[i] = randomRange(config.y);

        // Visual properties
        scale[i] = randomRange(config.scale, 1);
        alpha[i] = randomRange(config.alpha, 1);
        tint[i] = config.tint ?? 0xffffff;
        anchorX[i] = config.anchorX ?? 0.5;
        anchorY[i] = config.anchorY ?? 1;
        decorationTextureId[i] = textureId;

        // Initially off-screen (will be updated by culling)
        isItOnScreen[i] = 0;

        // Claim this slot
        active[i] = 1;

        // Increment active count (for early-exit optimization in workers)
        if (this.activeCount) {
          this.activeCount[0]++;
        }

        return i;
      }
    }

    // Pool is full
    console.warn("DecorationPool: No free slots available");
    return -1;
  }

  /**
   * Spawn multiple decorations at once (batch spawn)
   *
   * @param {Object} config - Same as spawn(), but spawns multiple
   * @param {number} [config.count=1] - Number of decorations to spawn
   * @returns {number} - Number of decorations actually spawned
   *
   * @example
   * // Spawn 100 grass decorations
   * DecorationPool.spawnMany({
   *   count: 100,
   *   x: { min: 0, max: worldWidth },
   *   y: { min: 0, max: worldHeight },
   *   texture: "grass1",
   *   anchorY: 1.0,
   * });
   */
  static spawnMany(config) {
    const count = config.count ?? 1;
    let spawned = 0;

    for (let i = 0; i < count; i++) {
      const index = this.spawn(config);
      if (index >= 0) {
        spawned++;
      } else {
        break; // Pool is full
      }
    }

    return spawned;
  }

  /**
   * Despawn a decoration by index
   *
   * @param {number} index - The decoration index to despawn
   * @returns {boolean} - True if despawned, false if invalid index or already inactive
   */
  static despawn(index) {
    if (!this.initialized) {
      console.warn("DecorationPool.despawn() called before initialization");
      return false;
    }

    if (index < 0 || index >= this.maxDecorations) {
      console.warn(`DecorationPool.despawn(): Invalid index ${index}`);
      return false;
    }

    if (DecorationComponent.active[index] === 0) {
      return false; // Already inactive
    }

    // Mark as inactive
    DecorationComponent.active[index] = 0;
    DecorationComponent.isItOnScreen[index] = 0;

    // Decrement active count
    if (this.activeCount && this.activeCount[0] > 0) {
      this.activeCount[0]--;
    }

    return true;
  }

  /**
   * Despawn all decorations
   */
  static despawnAll() {
    if (!this.initialized) return;

    for (let i = 0; i < this.maxDecorations; i++) {
      DecorationComponent.active[i] = 0;
      DecorationComponent.isItOnScreen[i] = 0;
    }

    // Reset active count
    if (this.activeCount) {
      this.activeCount[0] = 0;
    }
  }

  /**
   * Get the number of active decorations
   * @returns {number} - Count of active decorations
   */
  static getActiveCount() {
    if (!this.initialized) return 0;

    let count = 0;
    const active = DecorationComponent.active;
    for (let i = 0; i < this.maxDecorations; i++) {
      if (active[i]) count++;
    }
    return count;
  }
}
