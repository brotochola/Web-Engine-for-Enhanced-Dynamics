// SharedAtomicPool.js - Base class for thread-safe object pools
// Provides atomic free list operations shared by ParticleEmitter and DecorationPool
//
// THREAD SAFETY:
// - freeList and freeListTop are backed by SharedArrayBuffer
// - The free list is a lock-free Treiber stack (see atomicFreeList.js):
//   freeListTop[0] is the CAS-updated packed head, freeListTop[1] the free
//   count, and freeList holds the per-slot next links
// - Any worker or the main thread can safely acquire/return indices
//
// ARCHITECTURE:
// - LIFO linked stack for O(1) allocation and deallocation
// - Subclasses implement spawn() to set their specific component data

import {
  resetFreeList,
  popFreeIndex,
  pushFreeIndex,
  getFreeListCount,
} from './atomicFreeList.js';

/**
 * Base class for atomic object pools backed by SharedArrayBuffer.
 * Provides thread-safe index allocation and deallocation.
 *
 * Subclasses must:
 * - Call super methods for pool management
 * - Implement their own spawn() method to set component data
 * - Use acquireIndex() to get a free slot
 * - Use returnToPool() when items die/despawn
 */
export class SharedAtomicPool {
    // Pool size (set during initialization)
    static maxCount = 0;
    static initialized = false;

    // Free list for O(1) allocation (lock-free linked stack backed by SAB)
    // Shared between all workers and main thread
    static freeList = null; // Uint16Array - per-slot next links
    static freeListTop = null; // Int32Array[2] - [0]=packed head, [1]=free count

    // Pool name for logging (override in subclass)
    static poolName = 'SharedAtomicPool';

    static acquireSpinLock(lockView) {
        if (!lockView) return;
        while (Atomics.compareExchange(lockView, 0, 0, 1) !== 0) {
            // Constraint add/remove is rare, so a short spin lock is acceptable here.
        }
    }

    static releaseSpinLock(lockView) {
        if (!lockView) return;
        Atomics.store(lockView, 0, 0);
    }

    /**
     * Initialize the pool with max count
     * @param {number} maxCount - Maximum number of items in pool
     */
    static initialize(maxCount) {
        this.maxCount = maxCount;
        this.initialized = true;
        console.log(
            `${this.poolName}: Initialized with ${maxCount} items (indices 0-${maxCount - 1})`
        );
    }

    /**
     * Initialize the shared free list buffers
     * Called by workers to connect to the shared free list
     * @param {SharedArrayBuffer} freeListBuffer - Buffer for next links (Uint16Array)
     * @param {SharedArrayBuffer} freeListTopBuffer - Buffer for head + count (Int32Array[2])
     */
    static initializeFreeList(freeListBuffer, freeListTopBuffer) {
        this.freeList = new Uint16Array(freeListBuffer);
        this.freeListTop = new Int32Array(freeListTopBuffer);
        console.log(
            `${this.poolName}: Free list initialized (free: ${getFreeListCount(this.freeListTop)})`
        );
    }

    /**
     * Atomically acquire a free index from the pool
     * Thread-safe: lock-free CAS pop, safe against concurrent returns
     *
     * @returns {number} Free index (0 to maxCount-1), or -1 if pool exhausted
     */
    static acquireIndex() {
        if (!this.initialized || !this.freeList || !this.freeListTop) {
            return -1;
        }
        return popFreeIndex(this.freeListTop, this.freeList);
    }

    /**
     * Return an index to the free list (called when items die/despawn)
     * Thread-safe: lock-free CAS push, safe against concurrent acquires
     *
     * @param {number} index - Index to return to pool
     */
    static returnToPool(index) {
        if (!this.freeList || !this.freeListTop) return;
        if (index < 0 || index >= this.maxCount) return;
        pushFreeIndex(this.freeListTop, this.freeList, index);
    }

    /**
     * Get the number of active items (total - free)
     * Eventually consistent - for stats and heuristics only
     *
     * @returns {number} Count of active items
     */
    static getActiveCount() {
        if (!this.initialized || !this.freeListTop) return 0;
        return this.maxCount - getFreeListCount(this.freeListTop);
    }

    /**
     * Get the number of free slots available
     * Eventually consistent - for stats and heuristics only
     *
     * @returns {number} Count of free slots
     */
    static getFreeCount() {
        if (!this.freeListTop) return 0;
        return getFreeListCount(this.freeListTop);
    }

    /**
     * Check if the pool is fully exhausted
     * @returns {boolean} True if no free slots available
     */
    static isExhausted() {
        if (!this.freeListTop) return true;
        return getFreeListCount(this.freeListTop) <= 0;
    }

    /**
     * Check if the pool has available capacity
     * @returns {boolean} True if at least one slot is free
     */
    static hasCapacity() {
        if (!this.freeListTop) return false;
        return getFreeListCount(this.freeListTop) > 0;
    }

    /**
     * Reset the pool to uninitialized state
     * Called when switching scenes to clear stale static state
     */
    static reset() {
        this.maxCount = 0;
        this.initialized = false;
        this.freeList = null;
        this.freeListTop = null;
    }

    /**
     * Reset the free list to full with interleaved ordering
     * Used by despawnAll() to efficiently reset the pool
     *
     * INTERLEAVED SPAWNING: Scatter indices to reduce multi-core cache contention
     * Sequential [0,1,2,3...] causes workers to access adjacent memory, thrashing L3 cache
     * Interleaved [0,8,16,24...,1,9,17,25...] spreads access across cache lines
     *
     * NOT thread-safe: only call while no other thread spawns/despawns.
     *
     * @param {number} [interleaveFactor=8] - Stride between consecutive spawns
     */
    static resetFreeListInterleaved(interleaveFactor = 8) {
        if (!this.freeList || !this.freeListTop || this.maxCount === 0) return;
        resetFreeList(this.freeListTop, this.freeList, this.maxCount, interleaveFactor);
    }
}
