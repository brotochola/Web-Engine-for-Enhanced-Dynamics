// SharedAtomicPool.js - Base class for thread-safe object pools
// Provides atomic free list operations shared by ParticleEmitter and DecorationPool
//
// THREAD SAFETY:
// - freeList and freeListTop are backed by SharedArrayBuffer
// - All operations use Atomics for lock-free concurrent access
// - Any worker or the main thread can safely acquire/return indices
//
// ARCHITECTURE:
// - LIFO stack for O(1) allocation and deallocation
// - Atomic operations prevent race conditions between workers
// - Subclasses implement spawn() to set their specific component data

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

    // Free list for O(1) allocation (LIFO stack backed by SharedArrayBuffer)
    // Shared between all workers and main thread
    static freeList = null; // Uint16Array - stack of free indices
    static freeListTop = null; // Int32Array[1] - atomic counter for stack top

    // Pool name for logging (override in subclass)
    static poolName = 'SharedAtomicPool';

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
     * @param {SharedArrayBuffer} freeListBuffer - Buffer for free indices (Uint16Array)
     * @param {SharedArrayBuffer} freeListTopBuffer - Buffer for stack top (Int32Array[1])
     */
    static initializeFreeList(freeListBuffer, freeListTopBuffer) {
        this.freeList = new Uint16Array(freeListBuffer);
        this.freeListTop = new Int32Array(freeListTopBuffer);
        console.log(
            `${this.poolName}: Free list initialized (top: ${this.freeListTop[0]})`
        );
    }

    /**
     * Atomically acquire a free index from the pool
     * Thread-safe: uses Atomics for concurrent access
     *
     * @returns {number} Free index (0 to maxCount-1), or -1 if pool exhausted
     */
    static acquireIndex() {
        if (!this.initialized || !this.freeList || !this.freeListTop) {
            return -1;
        }

        // Atomic decrement to pop from free list
        // Atomics.sub returns the OLD value, then decrements
        const oldTop = Atomics.sub(this.freeListTop, 0, 1);

        if (oldTop <= 0) {
            // Pool exhausted - restore counter and return failure
            Atomics.add(this.freeListTop, 0, 1);
            return -1;
        }

        // Return the index from the free list
        // oldTop was the count, so valid indices are 0 to oldTop-1
        // We want the last item at index oldTop-1
        return this.freeList[oldTop - 1];
    }

    /**
     * Return an index to the free list (called when items die/despawn)
     * Thread-safe: uses Atomics for concurrent access
     *
     * @param {number} index - Index to return to pool
     */
    static returnToPool(index) {
        if (!this.freeList || !this.freeListTop) return;

        // Atomic increment and get previous value (this is our write slot)
        // Atomics.add returns the OLD value, then increments
        const slot = Atomics.add(this.freeListTop, 0, 1);

        // Safety check - don't overflow the free list
        if (slot >= this.maxCount) {
            // Rollback - this shouldn't happen in normal operation
            Atomics.sub(this.freeListTop, 0, 1);
            return;
        }

        // Write the index to the free list at the old top position
        this.freeList[slot] = index;
    }

    /**
     * Get the number of active items (total - free)
     * Thread-safe: reads atomic counter
     *
     * @returns {number} Count of active items
     */
    static getActiveCount() {
        if (!this.initialized || !this.freeListTop) return 0;
        return this.maxCount - this.freeListTop[0];
    }

    /**
     * Get the number of free slots available
     * Thread-safe: reads atomic counter
     *
     * @returns {number} Count of free slots
     */
    static getFreeCount() {
        if (!this.freeListTop) return 0;
        return this.freeListTop[0];
    }

    /**
     * Check if the pool is fully exhausted
     * @returns {boolean} True if no free slots available
     */
    static isExhausted() {
        if (!this.freeListTop) return true;
        return this.freeListTop[0] <= 0;
    }

    /**
     * Check if the pool has available capacity
     * @returns {boolean} True if at least one slot is free
     */
    static hasCapacity() {
        if (!this.freeListTop) return false;
        return this.freeListTop[0] > 0;
    }

    /**
     * Reset the free list to full with interleaved ordering
     * Used by despawnAll() to efficiently reset the pool
     *
     * INTERLEAVED SPAWNING: Scatter indices to reduce multi-core cache contention
     * Sequential [0,1,2,3...] causes workers to access adjacent memory, thrashing L3 cache
     * Interleaved [0,8,16,24...,1,9,17,25...] spreads access across cache lines
     *
     * @param {number} [interleaveFactor=8] - Stride between consecutive spawns
     */
    static resetFreeListInterleaved(interleaveFactor = 8) {
        if (!this.freeList || !this.freeListTop || this.maxCount === 0) return;

        const count = this.maxCount;

        // Build interleaved free list
        let writeIndex = 0;
        for (let offset = 0; offset < interleaveFactor && writeIndex < count; offset++) {
            for (let i = offset; i < count && writeIndex < count; i += interleaveFactor) {
                this.freeList[writeIndex++] = i;
            }
        }

        // Reset stack top to full (all slots free)
        this.freeListTop[0] = count;
    }
}
