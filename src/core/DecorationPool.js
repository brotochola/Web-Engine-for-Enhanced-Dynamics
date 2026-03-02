// DecorationPool.js - Static API for spawning/despawning decorations
// Used by game code to place static visual elements (grass, rocks, bushes, etc.)
// Decorations are NOT GameObjects - they use DecorationComponent directly
//
// EXTENDS SharedAtomicPool for thread-safe free list management
//
// THREAD SAFETY:
// - freeList and freeListTop are backed by SharedArrayBuffer
// - Spawn/despawn use Atomics for lock-free concurrent access
// - Any worker or the main thread can safely spawn/despawn decorations

import { DecorationComponent } from '../components/DecorationComponent.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { SharedAtomicPool } from './SharedAtomicPool.js';
import { randomRange, convertRGBtoBGR } from './utils.js';

export class DecorationPool extends SharedAtomicPool {
  // Pool name for logging (used by base class)
  static poolName = 'DecorationPool';

  // Compact list of active decoration indices [count, idx0, idx1, ...]
  // Maintained incrementally by spawn/despawn, read by particle_worker
  static activeDecorationsData = null;

  // Alias for backwards compatibility
  static get maxDecorations() {
    return this.maxCount;
  }

  /**
   * Get count of active decorations from the compact list
   * @returns {number} Number of active decorations
   */
  static getActiveCount() {
    return this.activeDecorationsData ? this.activeDecorationsData[0] : 0;
  }

  /**
   * Initialize the decoration pool with max count
   * Called by AbstractWorker during init
   * @param {number} maxDecorations - Number of decorations in pool
   */
  static initialize(maxDecorations) {
    // Call base class initialize with the count
    super.initialize(maxDecorations);
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
    // Acquire free index from pool (inherited from SharedAtomicPool)
    const i = this.acquireIndex();
    if (i < 0) {
      console.warn('DecorationPool: No free slots available');
      return -1;
    }

    // Resolve texture name to textureId (frame index in bigAtlas)
    let textureId = 0;
    if (config.texture) {
      textureId = SpriteSheetRegistry.getAnimationIndex('bigAtlas', config.texture) ?? 0;
    }

    // Cache array references for performance (zero allocation - just reference copying)
    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const offsetX = DecorationComponent.offsetX;
    const offsetY = DecorationComponent.offsetY;
    const scaleX = DecorationComponent.scaleX;
    const scaleY = DecorationComponent.scaleY;
    const rotation = DecorationComponent.rotation;
    const baseRotation = DecorationComponent.baseRotation;
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

    baseRotation[i] = config.rotation ?? 0;
    rotation[i] = baseRotation[i];
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

    // Claim this slot (must be last - signals to other workers that this slot is in use)
    DecorationComponent.active[i] = 1;

    // Add to activeDecorationsData compact list (append at end - O(1), atomic count increment)
    if (this.activeDecorationsData) {
      const slot = Atomics.add(this.activeDecorationsData, 0, 1);
      this.activeDecorationsData[1 + slot] = i;
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
    if (!this.initialized || !this.freeList || !this.freeListTop) {
      console.warn('DecorationPool.despawn() called before initialization');
      return false;
    }

    if (index < 0 || index >= this.maxCount) {
      console.warn(`DecorationPool.despawn(): Invalid index ${index}`);
      return false;
    }

    if (DecorationComponent.active[index] === 0) {
      return false; // Already inactive
    }

    // Mark as inactive (must be first - signals to other workers)
    DecorationComponent.active[index] = 0;
    DecorationComponent.isItOnScreen[index] = 0;

    // Remove from activeDecorationsData compact list (swap-with-last - O(n) search, O(1) remove)
    // NOTE: scan + swap is not fully atomic across workers; concurrent despawns may leave
    // phantom entries. This is benign: readers skip inactive slots via DecorationComponent.active.
    if (this.activeDecorationsData) {
      const count = Atomics.load(this.activeDecorationsData, 0);
      for (let i = 0; i < count; i++) {
        if (this.activeDecorationsData[1 + i] === index) {
          const oldCount = Atomics.sub(this.activeDecorationsData, 0, 1);
          this.activeDecorationsData[1 + i] = this.activeDecorationsData[oldCount - 1];
          break;
        }
      }
    }

    // Return index to free list (inherited from SharedAtomicPool)
    this.returnToPool(index);

    return true;
  }

  /**
   * Despawn all decorations
   * WARNING: This is NOT thread-safe - only call from a single context when no other
   * workers are spawning/despawning decorations
   */
  static despawnAll() {
    if (!this.initialized || !this.freeList || !this.freeListTop) return;

    // Mark all as inactive
    const active = DecorationComponent.active;
    const isItOnScreen = DecorationComponent.isItOnScreen;
    for (let i = 0; i < this.maxCount; i++) {
      active[i] = 0;
      isItOnScreen[i] = 0;
    }

    // Clear activeDecorationsData compact list
    if (this.activeDecorationsData) {
      this.activeDecorationsData[0] = 0;
    }

    // Reset free list with interleaved ordering (reduces cache contention in multi-worker scenarios)
    this.resetFreeListInterleaved();
  }

  /**
   * Initialize activeDecorationsData from SharedArrayBuffer
   * Called by workers during initialization
   * @param {SharedArrayBuffer} buffer - The SAB for activeDecorationsData
   */
  static initializeActiveList(buffer) {
    if (buffer) {
      this.activeDecorationsData = new Uint16Array(buffer);
    }
  }

  /**
   * Reset all decoration pool state (extends parent reset)
   * Called when switching scenes to clear stale static state
   */
  static reset() {
    super.reset();
    this.activeDecorationsData = null;
  }
}
