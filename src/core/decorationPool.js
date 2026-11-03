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

import { DecorationComponent } from '../components/decorationComponent.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { SharedAtomicPool } from './sharedAtomicPool.js';
import { randomRange } from '../util/utils.js';
import { Layer } from './layer.js';
import { evictDecorationFacade, clearAllDecorationFacades } from '../util/decorationFacades.js';
import { DECORATION_LIST_EPOCH, DECORATION_MOVE_EPOCH, DecorationSpatial } from './decorationSpatial.js';
import {
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
  PARTICLE_SORT_BIAS,
} from '../util/configDefaults.js';
import { entityIdNone } from '../util/entityIdWidth.js';
import { PoolSlotArray } from '../util/poolSlotWidth.js';
import { bucketFromSwayFrequency, swayFrequencyForBucket, SWAY_LOOP, SWAY_LOOP_SKEW } from '../util/decorationSway.js';

export {
  DECORATION_Y_SORT_SCALE,
  DECORATION_INNER_Z_MIN,
  DECORATION_INNER_Z_MAX,
  ENTITY_GLOW_SORT_BIAS,
  PARTICLE_SORT_BIAS,
};
/** Sentinel: decoration not parented. Width 16 = 0xffff; width 32 = 0xffffffff. */
export function decorationNoParent() {
  return entityIdNone;
}
/** @deprecated use decorationNoParent() — live sentinel follows entityIdWidth */
export const DECORATION_NO_PARENT = 0xffff;

export {
  SWAY_OFF,
  SWAY_LOOP,
  SWAY_LOOP_SKEW,
  SWAY_IMPULSE,
  SWAY_ANGLE_PER_MS,
  advanceImpulsePhase,
} from '../util/decorationSway.js';

/** The spawn config keys spawnMany also takes as arrays, one value per decoration. */
const PER_DECORATION_KEYS = Object.freeze(['x', 'y', 'texture', 'scaleX', 'scaleY', 'rotation', 'alpha', 'tint', 'sortOffsetY']);

const isValueList = (value) => Array.isArray(value) || ArrayBuffer.isView(value);

/** Whether a spawnMany config gives any key one value per decoration. */
function hasPerDecorationValues(config) {
  for (let k = 0; k < PER_DECORATION_KEYS.length; k++) if (isValueList(config[PER_DECORATION_KEYS[k]])) return true;
  return false;
}

export class DecorationPool extends SharedAtomicPool {
  // Pool name for logging (used by base class)
  static poolName = 'DecorationPool';
  // E-129: 32-bit slot ids past 65 535 decorations.
  static slotIdsFromMax = true;

  // Compact list of active decoration indices [count, idx0, idx1, ...]
  // Maintained incrementally by spawn/despawn, read by particle_worker
  // Uint16Array, or Uint32Array past 65 535 decorations (E-129), like the attachment table.
  static activeDecorationsData = null;
  static _activeListLock = null;

  // Entity -> attached decoration indices (SAB, not ECS). Row stride = _maxAttachedPerEntity.
  static _attachedDecorationCount = null; // Uint8Array length entityCount
  static _attachedDecorationIndices = null; // Uint16Array (Uint32Array past 65 535) length entityCount * maxAttached
  static _attachmentEntityCount = 0;
  static _maxAttachedPerEntity = 0;
  /** canAttach said once that an entity could take no more attached decorations. */
  static _attachRefusedWarned = false;

  /** From particle.swayFrequencyBuckets. >1 snaps spawn swayFrequency onto the 1..3 grid. */
  static swayFrequencyBuckets = 0;

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

  /** E-179c: one more change of the active list, under its lock (a reader that saw the old count copies it again). */
  static _countListChange() {
    const lock = this._activeListLock;
    if (lock !== null && lock.length > DECORATION_LIST_EPOCH) Atomics.add(lock, DECORATION_LIST_EPOCH, 1);
  }

  /** E-179c: how many times the active list has changed; -1 without the counters (a lock buffer with no room). */
  static listEpoch() {
    const lock = this._activeListLock;
    return lock !== null && lock.length > DECORATION_LIST_EPOCH ? Atomics.load(lock, DECORATION_LIST_EPOCH) : -1;
  }

  /** E-179c: how many times a world-owned decoration has moved; -1 without the counters. */
  static moveEpoch() {
    const lock = this._activeListLock;
    return lock !== null && lock.length > DECORATION_MOVE_EPOCH ? Atomics.load(lock, DECORATION_MOVE_EPOCH) : -1;
  }

  static copyActiveSnapshot(out) {
    const data = this.activeDecorationsData;
    if (!data || !out) return 0;

    this._lockActiveList();
    const count = Math.min(data[0], out.length);
    for (let i = 0; i < count; i++) {
      out[i] = data[1 + i];
    }
    this._unlockActiveList();
    return count;
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
   * @param {SharedArrayBuffer|null} sabIndices - Uint16Array (Uint32Array past 65 535 decorations), length entityCount * maxAttached
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
    this._attachedDecorationIndices = new (PoolSlotArray(this.maxCount))(sabIndices);
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

  /**
   * Whether entity `entityIdx` can take one more attached decoration. When it cannot (its row holds
   * maxAttachedDecorationsPerEntity already, or the scene has no attachment table) it says why, once per worker.
   * @param {number} entityIdx
   * @param {string} [who] - the entity's class, for the message
   * @returns {boolean}
   */
  static canAttach(entityIdx, who = 'entity') {
    const countArr = this._attachedDecorationCount;
    const maxA = this._maxAttachedPerEntity;
    if (countArr && maxA > 0 && entityIdx >= 0 && entityIdx < this._attachmentEntityCount) {
      if (countArr[entityIdx] < maxA) return true;
      this._warnAttachRefused(
        who,
        `entity ${entityIdx} has ${maxA} attached decorations, as many as decoration.maxAttachedDecorationsPerEntity allows (raise it, up to 255)`
      );
      return false;
    }
    this._warnAttachRefused(who, `entity ${entityIdx} has no attachment row here (decoration.maxDecorations is 0?)`);
    return false;
  }

  static _warnAttachRefused(who, why) {
    if (this._attachRefusedWarned) return;
    this._attachRefusedWarned = true;
    console.warn(`WeedJS: ${who}.addDecoration returned -1: ${why}.`);
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
      DecorationComponent.parentEntityIndex[d] = decorationNoParent();
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
    DecorationSpatial.remove(index);
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
            this._countListChange();
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
   * @param {number} [config.anchorY=1] - Anchor Y (0-1)
   * @param {number} [config.offsetX=0] - Draw offset X: the sprite draws at x + offsetX; it sorts and culls at x
   * @param {number} [config.offsetY=0] - Draw offset Y: the sprite draws at y + offsetY; it sorts and culls at y
   * @param {number} [config.sortOffsetY=0] - World px added to the y it sorts at (its y, or its parent's sort line
   *   when attached), not to the y it draws or culls at, and not turned with the parent: a tall piece sorts at its foot
   * @param {boolean} [config.sway=false] - Enable sway animation
   * @param {boolean} [config.swaySkew=false] - Shear the sway instead of rotating it
   * @param {number} [config.swayAmplitude=0.025] - Sway rotation in radians (~1.4°)
   * @param {number} [config.swayFrequency=1.0] - Sway speed multiplier. Snapped onto the 1..3 grid when swayFrequencyBuckets > 1
   * @param {string|number} [config.layer] - Subscribe to one layer (same as layers: [layer])
   * @param {Array<string|number>} [config.layers] - Subscription list; omit = ENTITIES
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
    const rotC = DecorationComponent.rotC;
    const rotS = DecorationComponent.rotS;
    const baseRotC = DecorationComponent.baseRotC;
    const baseRotS = DecorationComponent.baseRotS;
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
      parentEntityIndex[i] = decorationNoParent();
      localX[i] = 0;
      localY[i] = 0;
      inheritParentRotation[i] = 0;
      innerZArr[i] = innerZClamped;
      x[i] = randomRange(config.x);
      y[i] = randomRange(config.y);
    }

    // New generation invalidates stale Decoration facades held across despawn/reuse.
    generation[i] = (generation[i] + 1) >>> 0;

    // Draw offset (defaults to 0): moves the sprite, not the point it sorts or culls at
    offsetX[i] = config.offsetX ?? 0;
    offsetY[i] = config.offsetY ?? 0;
    // Sort offset (defaults to 0): moves the point it sorts at, not the sprite or the point it culls at
    DecorationComponent.sortOffsetY[i] = config.sortOffsetY ?? 0;

    // Visual properties
    scaleX[i] = randomRange(config.scaleX, 1);
    scaleY[i] = randomRange(config.scaleY, 1);

    {
      // H-11a. `config.rotation` is undefined for the overwhelming majority of
      // spawns, so `a` is 0 and both transcendentals are spent producing values
      // that are already exact constants.
      //
      // The guard is `Object.is(a, 0)` and NOT `a === 0` or `a !== 0`, because
      // this was wrong the first time it was written. `-0 !== 0` is false, so an
      // `a !== 0` guard sends -0 down the FAST path and returns +0 where
      // `Math.sin(-0)` is -0. `Object.is` is true for +0 only, so -0 falls
      // through to the transcendentals and keeps its sign.
      //
      // That sign is not observable in rotation composition (+0 and -0 compare
      // and multiply identically there), but the claim being made here is
      // BIT-IDENTICAL, and that claim has to survive -0 or it has to be
      // withdrawn. `rotationParity.test.js` pins the whole domain.
      const a = config.rotation ?? 0;
      const isPlusZero = Object.is(a, 0);
      const c = isPlusZero ? 1 : Math.cos(a);
      const s = isPlusZero ? 0 : Math.sin(a);
      baseRotC[i] = c;
      baseRotS[i] = s;
      rotC[i] = c;
      rotS[i] = s;
    }
    alpha[i] = randomRange(config.alpha, 1);
    tint[i] = config.tint ?? 0xffffff;
    anchorX[i] = config.anchorX ?? 0.5;
    anchorY[i] = config.anchorY ?? 1;
    decorationTextureId[i] = textureId;

    // Sway animation. Buckets > 1: store the grid frequency the particle worker already uses.
    sway[i] = config.swaySkew ? SWAY_LOOP_SKEW : config.sway ? SWAY_LOOP : 0;
    swayAmplitude[i] = config.swayAmplitude ?? 0.025;
    {
      const freq = config.swayFrequency ?? 1.0;
      const k = this.swayFrequencyBuckets | 0;
      swayFrequency[i] =
        k > 1 ? swayFrequencyForBucket(bucketFromSwayFrequency(freq, k), k) : freq;
    }
    DecorationComponent.swayPhase[i] = 0;

    DecorationComponent.layerMask[i] = Layer.resolveSubscriptions(config);

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
        this._countListChange();
      } finally {
        this._unlockActiveList();
      }
    }

    // World-owned only — parented decorations are resolved every frame and stay out of the hash
    if (!hasParent) {
      DecorationSpatial.insert(i);
    }

    return i;
  }

  /**
   * Spawn multiple decorations at once (batch spawn)
   *
   * Any of x, y, texture, scaleX, scaleY, rotation, alpha, tint and sortOffsetY may be an array or a typed array instead: one
   * value per decoration, decoration i taking element i (a scene file's decorations load this way, one call per
   * class). count then defaults to the first such array's length, and `out`, when given, receives each decoration's
   * pool index (the first `spawned` of its entries).
   *
   * @param {Object} config - Same as spawn(), but spawns multiple
   * @param {number} [config.count=1] - Number of decorations to spawn
   * @param {Int32Array|Uint32Array|number[]} [config.out] - With per-decoration arrays: their pool indices, in order
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
   *
   * // Three, where they were placed
   * DecorationPool.spawnMany({ x: [10, 50, 90], y: [40, 42, 40], scaleX: [1, 1.2, 0.9], texture: "rock1" });
   */
  static spawnMany(config) {
    if (hasPerDecorationValues(config)) return this._spawnManyPerDecoration(config);
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

  /** spawnMany with per-decoration arrays: its own loop, so the plain one keeps no branch for them. */
  static _spawnManyPerDecoration(config) {
    const keys = [];
    const lists = [];
    for (let k = 0; k < PER_DECORATION_KEYS.length; k++) {
      const value = config[PER_DECORATION_KEYS[k]];
      if (isValueList(value)) {
        keys.push(PER_DECORATION_KEYS[k]);
        lists.push(value);
      }
    }
    const count = config.count ?? lists[0].length;
    const out = config.out;
    // One config for every decoration, its per-decoration keys written before each spawn.
    const one = Object.assign({}, config);
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < keys.length; k++) one[keys[k]] = lists[k][i];
      const index = this.spawn(one);
      if (index < 0) break; // Pool is full
      if (out) out[spawned] = index;
      spawned++;
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
    if (p !== decorationNoParent()) {
      this.removeAttached(p, index);
    }
    DecorationComponent.parentEntityIndex[index] = decorationNoParent();

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
      parentEntityIndex[i] = decorationNoParent();
    }

    // Clear activeDecorationsData compact list
    if (this.activeDecorationsData) {
      this._lockActiveList();
      try {
        this.activeDecorationsData[0] = 0;
        this._countListChange();
      } finally {
        this._unlockActiveList();
      }
    }

    DecorationSpatial.clear();

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
      this.activeDecorationsData = new (PoolSlotArray(this.maxCount))(buffer);
    }
    this._activeListLock = lockBuffer ? new Int32Array(lockBuffer) : null;
    // E-179c: moves count in the same header, when it has room for them.
    const lock = this._activeListLock;
    DecorationSpatial._epochs = lock !== null && lock.length > DECORATION_MOVE_EPOCH ? lock : null;
  }

  /**
   * Reset all decoration pool state (extends parent reset)
   * Called when switching scenes to clear stale static state
   */
  static reset() {
    super.reset();
    this.activeDecorationsData = null;
    this._activeListLock = null;
    DecorationSpatial._epochs = null;
    clearAllDecorationFacades();
    this._attachedDecorationCount = null;
    this._attachedDecorationIndices = null;
    this._attachmentEntityCount = 0;
    this._maxAttachedPerEntity = 0;
    this._attachRefusedWarned = false;
    this.swayFrequencyBuckets = 0;
    DecorationSpatial.reset();
  }
}
