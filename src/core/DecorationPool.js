// DecorationPool.js - Static API for spawning/despawning decorations
// Used by game code to place static visual elements (grass, rocks, bushes, etc.)
// Decorations are NOT GameObjects - they use DecorationComponent directly
//
// EXTENDS SharedAtomicPool for thread-safe free list management
//
// THREAD SAFETY:
// - freeList and freeListTop are backed by SharedArrayBuffer
// - Spawn/despawn use Atomics for lock-free concurrent access
// - activeDecorationsData compact-list mutation is protected by a tiny SAB lock
// - Any worker or the main thread can safely spawn/despawn decorations

import { DecorationComponent } from '../components/DecorationComponent.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { SharedAtomicPool } from './SharedAtomicPool.js';
import { randomRange } from './utils.js';
import { evictDecorationFacade, clearAllDecorationFacades } from './decorationFacades.js';
import {
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
} from './ConfigDefaults.js';

export {
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
};
/** Uint16 sentinel: decoration not parented to any entity (entity index 0 is valid) */
export const DECORATION_NO_PARENT = 0xffff;

export class DecorationPool extends SharedAtomicPool {
  // Pool name for logging (used by base class)
  static poolName = 'DecorationPool';

  // Compact list of active decoration indices [count, idx0, idx1, ...]
  // Maintained incrementally by spawn/despawn, read by particle_worker
  static activeDecorationsData = null;
  static _activeListLock = null;

  // Entity -> attached decoration indices (SAB, not ECS). Row stride = _maxAttachedPerEntity.
  static _attachedDecorationCount = null; // Uint8Array length entityCount
  static _attachedDecorationIndices = null; // Uint16Array length entityCount * maxAttached
  static _attachmentEntityCount = 0;
  static _maxAttachedPerEntity = 0;

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

  static _lockActiveList() {
    const lock = this._activeListLock;
    if (!lock) return;
    while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
      // Keep the critical section tiny (count + one swap/append). This lock is
      // only for decoration list metadata, not for particle/render hot loops.
    }
  }

  static _unlockActiveList() {
    if (this._activeListLock) Atomics.store(this._activeListLock, 0, 0);
  }

  static copyActiveSnapshot(out) {
    const data = this.activeDecorationsData;
    if (!data || !out) return 0;

    this._lockActiveList();
    try {
      const count = Math.min(data[0], out.length);
      for (let i = 0; i < count; i++) {
        out[i] = data[1 + i];
      }
      return count;
    } finally {
      this._unlockActiveList();
    }
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
   * SharedArrayBuffers for entity→decoration attachment list (engine bookkeeping, not ECS).
   * @param {SharedArrayBuffer|null} sabCount - Uint8Array, length entityCount
   * @param {SharedArrayBuffer|null} sabIndices - Uint16Array, length entityCount * maxAttached
   * @param {number} entityCount
   * @param {number} maxAttachedPerEntity - 1..255
   */
  static initializeAttachmentSlots(sabCount, sabIndices, entityCount, maxAttachedPerEntity) {
    if (!sabCount || !sabIndices || entityCount <= 0 || maxAttachedPerEntity <= 0) {
      this._attachedDecorationCount = null;
      this._attachedDecorationIndices = null;
      this._attachmentEntityCount = 0;
      this._maxAttachedPerEntity = 0;
      return;
    }
    this._attachedDecorationCount = new Uint8Array(sabCount);
    this._attachedDecorationIndices = new Uint16Array(sabIndices);
    this._attachmentEntityCount = entityCount;
    this._maxAttachedPerEntity = maxAttachedPerEntity;
  }

  /**
   * How many decorations are attached to this entity (attachment table slot count).
   * @param {number} entityIdx
   * @returns {number}
   */
  static getAttachedCount(entityIdx) {
    const countArr = this._attachedDecorationCount;
    if (!countArr || entityIdx < 0 || entityIdx >= this._attachmentEntityCount) return 0;
    return countArr[entityIdx];
  }

  /**
   * Pool index of the decoration at attachment slot `slot` (0 .. getAttachedCount-1).
   * @param {number} entityIdx
   * @param {number} slot
   * @returns {number} decoration index, or -1 if invalid
   */
  static getAttachedDecorationIndex(entityIdx, slot) {
    const countArr = this._attachedDecorationCount;
    const idxArr = this._attachedDecorationIndices;
    const maxA = this._maxAttachedPerEntity;
    if (!countArr || !idxArr || maxA <= 0) return -1;
    if (entityIdx < 0 || entityIdx >= this._attachmentEntityCount) return -1;
    const c = countArr[entityIdx];
    if (slot < 0 || slot >= c) return -1;
    return idxArr[entityIdx * maxA + slot];
  }

  static pushAttached(entityIdx, decoIdx) {
    const countArr = this._attachedDecorationCount;
    const idxArr = this._attachedDecorationIndices;
    const maxA = this._maxAttachedPerEntity;
    if (!countArr || !idxArr || maxA <= 0) return false;
    if (entityIdx < 0 || entityIdx >= this._attachmentEntityCount) return false;
    const c = countArr[entityIdx];
    if (c >= maxA) return false;
    idxArr[entityIdx * maxA + c] = decoIdx;
    countArr[entityIdx] = c + 1;
    return true;
  }

  static removeAttached(entityIdx, decoIdx) {
    const countArr = this._attachedDecorationCount;
    const idxArr = this._attachedDecorationIndices;
    const maxA = this._maxAttachedPerEntity;
    if (!countArr || !idxArr || maxA <= 0) return;
    if (entityIdx < 0 || entityIdx >= this._attachmentEntityCount) return;
    const row = entityIdx * maxA;
    let c = countArr[entityIdx];
    for (let k = 0; k < c; k++) {
      if (idxArr[row + k] === decoIdx) {
        idxArr[row + k] = idxArr[row + c - 1];
        idxArr[row + c - 1] = 0;
        countArr[entityIdx] = c - 1;
        return;
      }
    }
  }

  /**
   * Despawn every decoration attached to this entity (after onDespawned).
   * @param {number} entityIdx
   */
  static clearAttachedAndDespawnAll(entityIdx) {
    const countArr = this._attachedDecorationCount;
    const idxArr = this._attachedDecorationIndices;
    const maxA = this._maxAttachedPerEntity;
    if (!countArr || !idxArr || maxA <= 0) return;
    if (entityIdx < 0 || entityIdx >= this._attachmentEntityCount) return;
    const row = entityIdx * maxA;
    const n = countArr[entityIdx];
    countArr[entityIdx] = 0;
    for (let k = 0; k < n; k++) {
      const d = idxArr[row + k];
      idxArr[row + k] = 0;
      DecorationComponent.parentEntityIndex[d] = DECORATION_NO_PARENT;
      this._despawnDecorationCore(d);
    }
  }

  /**
   * Core despawn: inactive + compact list + free list. Does not touch attachment table.
   * @param {number} index
   * @returns {boolean}
   */
  static _despawnDecorationCore(index) {
    if (!this.initialized || !this.freeList || !this.freeListTop) {
      return false;
    }
    if (index < 0 || index >= this.maxCount) {
      return false;
    }
    if (DecorationComponent.active[index] === 0) {
      return false;
    }
    evictDecorationFacade(index);
    DecorationComponent.active[index] = 0;
    DecorationComponent.isItOnScreen[index] = 0;

    if (this.activeDecorationsData) {
      this._lockActiveList();
      try {
        const count = this.activeDecorationsData[0];
        for (let i = 0; i < count; i++) {
          if (this.activeDecorationsData[1 + i] === index) {
            const last = count - 1;
            this.activeDecorationsData[1 + i] = this.activeDecorationsData[1 + last];
            this.activeDecorationsData[1 + last] = 0;
            this.activeDecorationsData[0] = last;
            break;
          }
        }
      } finally {
        this._unlockActiveList();
      }
    }
    this.returnToPool(index);
    return true;
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
   * @param {number} [config.layerId=0] - Layer ID for rendering (0 = default ENTITIES layer, non-zero = custom layer)
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
    const generation = DecorationComponent.generation;
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

    const parentEntityIndex = DecorationComponent.parentEntityIndex;
    const localX = DecorationComponent.localX;
    const localY = DecorationComponent.localY;
    const inheritParentRotation = DecorationComponent.inheritParentRotation;
    const innerZArr = DecorationComponent.innerZ;

    const rawInner = config.innerZ ?? config.zIndex ?? 0;
    const z = rawInner | 0;
    const innerZClamped =
      z < DECORATION_INNER_Z_MIN
        ? DECORATION_INNER_Z_MIN
        : z > DECORATION_INNER_Z_MAX
          ? DECORATION_INNER_Z_MAX
          : z;

    const hasParent =
      config.parent != null &&
      typeof config.parent === 'number' &&
      config.parent >= 0 &&
      Number.isFinite(config.parent);
    if (hasParent) {
      const parent = config.parent | 0;
      parentEntityIndex[i] = parent;
      localX[i] = config.localX ?? 0;
      localY[i] = config.localY ?? 0;
      inheritParentRotation[i] = config.inheritParentRotation === false ? 0 : 1;
      innerZArr[i] = innerZClamped;
      x[i] = 0;
      y[i] = 0;
    } else {
      parentEntityIndex[i] = DECORATION_NO_PARENT;
      localX[i] = 0;
      localY[i] = 0;
      inheritParentRotation[i] = 0;
      innerZArr[i] = innerZClamped;
      x[i] = randomRange(config.x);
      y[i] = randomRange(config.y);
    }

    // New generation invalidates stale Decoration facades held across despawn/reuse.
    generation[i] = (generation[i] + 1) >>> 0;

    // Offset for depth sorting (defaults to 0)
    offsetX[i] = config.offsetX ?? 0;
    offsetY[i] = config.offsetY ?? 0;

    // Visual properties
    scaleX[i] = randomRange(config.scaleX, 1);
    scaleY[i] = randomRange(config.scaleY, 1);

    baseRotation[i] = config.rotation ?? 0;
    rotation[i] = baseRotation[i];
    alpha[i] = randomRange(config.alpha, 1);
    tint[i] = config.tint ?? 0xffffff;
    anchorX[i] = config.anchorX ?? 0.5;
    anchorY[i] = config.anchorY ?? 1;
    decorationTextureId[i] = textureId;

    // Sway animation
    sway[i] = config.sway ? 1 : 0;
    swayAmplitude[i] = config.swayAmplitude ?? 0.025;
    swayFrequency[i] = config.swayFrequency ?? 1.0;

    // Layer routing: 0 = default ENTITIES layer
    DecorationComponent.layerId[i] = config.layerId ?? 0;

    // Initially off-screen (will be updated by culling)
    isItOnScreen[i] = 0;

    // Claim this slot (must be last - signals to other workers that this slot is in use)
    DecorationComponent.active[i] = 1;

    // Add to activeDecorationsData compact list (append at end - O(1), atomic count increment)
    if (this.activeDecorationsData) {
      this._lockActiveList();
      try {
        const slot = this.activeDecorationsData[0];
        this.activeDecorationsData[1 + slot] = i;
        this.activeDecorationsData[0] = slot + 1;
      } finally {
        this._unlockActiveList();
      }
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

    const p = DecorationComponent.parentEntityIndex[index];
    if (p !== DECORATION_NO_PARENT) {
      this.removeAttached(p, index);
    }
    DecorationComponent.parentEntityIndex[index] = DECORATION_NO_PARENT;

    return this._despawnDecorationCore(index);
  }

  /**
   * Despawn all decorations
   * WARNING: This is NOT thread-safe - only call from a single context when no other
   * workers are spawning/despawning decorations
   */
  static despawnAll() {
    if (!this.initialized || !this.freeList || !this.freeListTop) return;

    clearAllDecorationFacades();

    if (this._attachedDecorationCount) {
      this._attachedDecorationCount.fill(0);
    }
    if (this._attachedDecorationIndices) {
      this._attachedDecorationIndices.fill(0);
    }

    // Mark all as inactive
    const active = DecorationComponent.active;
    const isItOnScreen = DecorationComponent.isItOnScreen;
    const parentEntityIndex = DecorationComponent.parentEntityIndex;
    for (let i = 0; i < this.maxCount; i++) {
      active[i] = 0;
      isItOnScreen[i] = 0;
      parentEntityIndex[i] = DECORATION_NO_PARENT;
    }

    // Clear activeDecorationsData compact list
    if (this.activeDecorationsData) {
      this._lockActiveList();
      try {
        this.activeDecorationsData[0] = 0;
      } finally {
        this._unlockActiveList();
      }
    }

    // Reset free list with interleaved ordering (reduces cache contention in multi-worker scenarios)
    this.resetFreeListInterleaved();
  }

  /**
   * Initialize activeDecorationsData from SharedArrayBuffer
   * Called by workers during initialization
   * @param {SharedArrayBuffer} buffer - The SAB for activeDecorationsData
   */
  static initializeActiveList(buffer, lockBuffer = null) {
    if (buffer) {
      this.activeDecorationsData = new Uint16Array(buffer);
    }
    this._activeListLock = lockBuffer ? new Int32Array(lockBuffer) : null;
  }

  /**
   * Reset all decoration pool state (extends parent reset)
   * Called when switching scenes to clear stale static state
   */
  static reset() {
    super.reset();
    this.activeDecorationsData = null;
    this._activeListLock = null;
    clearAllDecorationFacades();
    this._attachedDecorationCount = null;
    this._attachedDecorationIndices = null;
    this._attachmentEntityCount = 0;
    this._maxAttachedPerEntity = 0;
  }
}
