// DecorationPool.js - Static API for spawning/despawning decorations
// Used by game code to place static visual elements (grass, rocks, bushes, etc.)
// Decorations are NOT GameObjects - they use DecorationComponent directly

import { DecorationComponent } from '../components/DecorationComponent.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { randomRange, convertRGBtoBGR } from './utils.js';

export class DecorationPool {
  // Pool size (set during initialization)
  static maxDecorations = 0;
  static initialized = false;

  // Free list for O(1) allocation (like GameObject spawning system)
  static freeList = null; // Int32Array - stack of free indices
  static freeListTop = -1; // Top of stack (-1 = empty)

  // Shared counter for active decorations (backed by SharedArrayBuffer)
  // Used for early-exit optimization in workers
  static activeCount = null; // Uint32Array[1]

  // Active indices list for O(1) iteration in workers (backed by SharedArrayBuffer)
  // Maintained on spawn/despawn using swap-remove for O(1) operations
  static activeIndices = null; // Uint16Array - compact list of active decoration indices
  static indexToActiveSlot = null; // Uint16Array - maps decoration index → slot in activeIndices (for O(1) removal)

  /**
   * Initialize the decoration pool
   * Called automatically by logic worker during init
   * @param {number} maxDecorations - Number of decorations in pool
   */
  static initialize(maxDecorations) {
    this.maxDecorations = maxDecorations;
    this.initialized = true;

    // Initialize free list with all indices (LIFO stack)
    this.freeList = new Uint16Array(maxDecorations);
    for (let i = 0; i < maxDecorations; i++) {
      this.freeList[i] = i;
    }
    this.freeListTop = maxDecorations - 1;

    console.log(
      `DecorationPool: Initialized with ${maxDecorations} decorations (indices 0-${maxDecorations - 1
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
   * Initialize the shared active indices buffers
   * Called by workers to connect to the shared list
   * @param {SharedArrayBuffer} activeIndicesBuffer - Buffer for active indices (Uint16Array)
   * @param {SharedArrayBuffer} indexToSlotBuffer - Buffer for index→slot mapping (Uint16Array)
   */
  static initializeActiveIndices(activeIndicesBuffer, indexToSlotBuffer) {
    this.activeIndices = new Uint16Array(activeIndicesBuffer);
    this.indexToActiveSlot = new Uint16Array(indexToSlotBuffer);
    console.log(`DecorationPool: Active indices initialized (count: ${this.activeCount ? this.activeCount[0] : 0})`);
  }

  /**
   * Spawn a decoration with the given configuration
   *
   * @param {Object} config - Decoration spawn configuration
   * @param {number|{min,max}} config.x - X position or range
   * @param {number|{min,max}} config.y - Y position or range
   * @param {string} config.texture - Texture name (from bigAtlas)
   * @param {number|{min,max}} [config.scaleX=1] - Scale X or range
   * @param {number|{min,max}} [config.scaleY=1] - Scale Y or range
   * @param {number} [config.rotation=0] - Rotation in radians
   * @param {number|{min,max}} [config.alpha=1] - Alpha (opacity) or range
   * @param {number} [config.tint=0xFFFFFF] - Color tint (0xRRGGBB)
   * @param {number} [config.anchorX=0.5] - Anchor X (0-1)
   * @param {number} [config.anchorY=0.5] - Anchor Y (0-1)
   * @param {number} [config.offsetX=0] - Offset X for depth sorting (sprite renders at x, sorts at x+offsetX)
   * @param {number} [config.offsetY=0] - Offset Y for depth sorting (sprite renders at y, sorts at y+offsetY)
   * @param {boolean} [config.sway=false] - Enable sway animation
   * @param {number} [config.swayAmplitude=0.025] - Sway rotation in radians (~1.4°)
   * @param {number} [config.swayFrequency=1.0] - Sway speed multiplier
   * @returns {number} - Index of spawned decoration, or -1 if pool is full
   *
   * @example
   * // Spawn grass at random position with bottom anchor
   * const index = DecorationPool.spawn({
   *   x: rng() * worldWidth,
   *   y: rng() * worldHeight,
   *   texture: "grass3",
   *   scaleX: { min: 0.8, max: 1.2 },
   *   scaleY: { min: 0.8, max: 1.2 },
   *   anchorX: 0.5,
   *   anchorY: 1.0,
   * });
   */
  static spawn(config) {
    if (!this.initialized) {
      console.warn('DecorationPool.spawn() called before initialization');
      return -1;
    }

    // Check if pool is exhausted (O(1) check)
    if (this.freeListTop < 0) {
      console.warn('DecorationPool: No free slots available');
      return -1;
    }

    // Pop index from free list (O(1))
    const i = this.freeList[this.freeListTop--];

    // Resolve texture name to textureId (frame index in bigAtlas)
    let textureId = 0;
    if (config.texture) {
      textureId = SpriteSheetRegistry.getAnimationIndex('bigAtlas', config.texture) ?? 0;
    }

    // Cache array references for performance
    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const offsetX = DecorationComponent.offsetX;
    const offsetY = DecorationComponent.offsetY;
    const scaleX = DecorationComponent.scaleX;
    const scaleY = DecorationComponent.scaleY;
    const rotation = DecorationComponent.rotation;
    const alpha = DecorationComponent.alpha;
    const tint = DecorationComponent.tint;
    const anchorX = DecorationComponent.anchorX;
    const anchorY = DecorationComponent.anchorY;
    const decorationTextureId = DecorationComponent.textureId;
    const isItOnScreen = DecorationComponent.isItOnScreen;
    const sway = DecorationComponent.sway;
    const swayAmplitude = DecorationComponent.swayAmplitude;
    const swayFrequency = DecorationComponent.swayFrequency;

    // Position
    x[i] = randomRange(config.x);
    y[i] = randomRange(config.y);

    // Offset for depth sorting (defaults to 0)
    offsetX[i] = config.offsetX ?? 0;
    offsetY[i] = config.offsetY ?? 0;

    // Visual properties
    scaleX[i] = randomRange(config.scaleX, 1);
    scaleY[i] = randomRange(config.scaleY, 1);

    rotation[i] = config.rotation ?? 0;
    alpha[i] = randomRange(config.alpha, 1);
    tint[i] = convertRGBtoBGR(config.tint ?? 0xffffff); // Convert RGB→BGR for PixiJS
    anchorX[i] = config.anchorX ?? 0.5;
    anchorY[i] = config.anchorY ?? 1;
    decorationTextureId[i] = textureId;

    // Sway animation
    sway[i] = config.sway ? 1 : 0;
    swayAmplitude[i] = config.swayAmplitude ?? 0.025;
    swayFrequency[i] = config.swayFrequency ?? 1.0;

    // Initially off-screen (will be updated by culling)
    isItOnScreen[i] = 0;

    // Claim this slot
    DecorationComponent.active[i] = 1;

    // Update active indices list (O(1) add to end)
    if (this.activeCount && this.activeIndices && this.indexToActiveSlot) {
      const slot = this.activeCount[0];
      this.activeIndices[slot] = i;
      this.indexToActiveSlot[i] = slot;
      this.activeCount[0]++;
    } else if (this.activeCount) {
      // Fallback: just increment count if indices not initialized
      this.activeCount[0]++;
    }

    return i;
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
      console.warn('DecorationPool.despawn() called before initialization');
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

    // Push index back to free list (O(1))
    this.freeList[++this.freeListTop] = index;

    // Update active indices list (O(1) swap-remove)
    if (this.activeCount && this.activeCount[0] > 0 && this.activeIndices && this.indexToActiveSlot) {
      const slot = this.indexToActiveSlot[index];
      const lastSlot = this.activeCount[0] - 1;

      if (slot !== lastSlot) {
        // Swap with last element
        const lastIndex = this.activeIndices[lastSlot];
        this.activeIndices[slot] = lastIndex;
        this.indexToActiveSlot[lastIndex] = slot;
      }
      this.activeCount[0]--;
    } else if (this.activeCount && this.activeCount[0] > 0) {
      // Fallback: just decrement count if indices not initialized
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

    // Reset free list to full (all indices available)
    for (let i = 0; i < this.maxDecorations; i++) {
      this.freeList[i] = i;
    }
    this.freeListTop = this.maxDecorations - 1;

    // Reset active count (also clears active indices implicitly since count=0)
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
