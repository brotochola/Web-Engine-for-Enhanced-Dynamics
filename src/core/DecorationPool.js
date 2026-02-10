// DecorationPool.js - Static API for spawning/despawning decorations
// Used by game code to place static visual elements (grass, rocks, bushes, etc.)
// Decorations are NOT GameObjects - they use DecorationComponent directly
//
// THREAD SAFETY:
// - freeList and freeListTop are backed by SharedArrayBuffer
// - Spawn/despawn use Atomics for lock-free concurrent access
// - Any worker or the main thread can safely spawn/despawn decorations
// - Pattern matches ParticleEmitter for consistency

import { DecorationComponent } from '../components/DecorationComponent.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { randomRange, convertRGBtoBGR } from './utils.js';

export class DecorationPool {
  // Pool size (set during initialization)
  static maxDecorations = 0;
  static initialized = false;

  // Free list for O(1) allocation (LIFO stack backed by SharedArrayBuffer)
  // Shared between all workers and main thread
  static freeList = null; // Uint16Array - stack of free indices
  static freeListTop = null; // Int32Array[1] - atomic counter for stack top

  /**
   * Initialize the decoration pool with max count
   * Called by AbstractWorker during init
   * @param {number} maxDecorations - Number of decorations in pool
   */
  static initialize(maxDecorations) {
    this.maxDecorations = maxDecorations;
    this.initialized = true;
    console.log(
      `DecorationPool: Initialized with ${maxDecorations} decorations (indices 0-${maxDecorations - 1})`
    );
  }

  /**
   * Initialize the shared free list buffers
   * Called by workers to connect to the shared free list
   * @param {SharedArrayBuffer} freeListBuffer - Buffer for free indices (Uint16Array)
   * @param {SharedArrayBuffer} freeListTopBuffer - Buffer for stack top (Int32Array[1])
   */
  static initializeFreeList(freeListBuffer, freeListTopBuffer) {
    this.freeList = new Uint16Array(freeListBuffer);
    this.freeListTop = new Int32Array(freeListTopBuffer);
    console.log(
      `DecorationPool: Free list initialized (top: ${this.freeListTop[0]})`
    );
  }

  /**
   * Return a decoration index to the free list (called when despawning)
   * Uses atomic operations for thread-safe access
   * @param {number} index - Decoration index to return
   */
  static returnToPool(index) {
    if (!this.freeList || !this.freeListTop) return;

    // Atomic increment and get previous value (this is our write slot)
    const slot = Atomics.add(this.freeListTop, 0, 1);

    // Safety check - don't overflow the free list
    if (slot >= this.maxDecorations) {
      // Rollback - this shouldn't happen in normal operation
      Atomics.sub(this.freeListTop, 0, 1);
      return;
    }

    this.freeList[slot + 1] = index; // +1 because freeListTop is 0-indexed
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
    if (!this.initialized || !this.freeList || !this.freeListTop) {
      console.warn('DecorationPool.spawn() called before initialization');
      return -1;
    }

    // Atomic decrement to pop from free list
    const newTop = Atomics.sub(this.freeListTop, 0, 1) - 1;
    if (newTop < 0) {
      // Pool exhausted - restore and return
      Atomics.add(this.freeListTop, 0, 1);
      console.warn('DecorationPool: No free slots available');
      return -1;
    }

    // Get the index from the free list
    const i = this.freeList[newTop + 1]; // +1 because array is 0-indexed but top counts from 0

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

    if (index < 0 || index >= this.maxDecorations) {
      console.warn(`DecorationPool.despawn(): Invalid index ${index}`);
      return false;
    }

    if (DecorationComponent.active[index] === 0) {
      return false; // Already inactive
    }

    // Mark as inactive (must be first - signals to other workers)
    DecorationComponent.active[index] = 0;
    DecorationComponent.isItOnScreen[index] = 0;

    // Return index to free list using atomic operation
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
    for (let i = 0; i < this.maxDecorations; i++) {
      DecorationComponent.active[i] = 0;
      DecorationComponent.isItOnScreen[i] = 0;
    }

    // Reset free list to full (all indices available)
    for (let i = 0; i < this.maxDecorations; i++) {
      this.freeList[i] = i;
    }

    // Reset stack top to maxDecorations (all slots free)
    this.freeListTop[0] = this.maxDecorations;
  }

  /**
   * Get the number of active decorations (derived from free list)
   * Thread-safe: reads atomic counter
   * @returns {number} - Count of active decorations
   */
  static getActiveCount() {
    if (!this.initialized || !this.freeListTop) return 0;
    // Active = total - free slots available
    return this.maxDecorations - this.freeListTop[0];
  }

  /**
   * Get the number of free slots available
   * Thread-safe: reads atomic counter
   * @returns {number} - Count of free decoration slots
   */
  static getFreeCount() {
    if (!this.freeListTop) return 0;
    return this.freeListTop[0];
  }
}
