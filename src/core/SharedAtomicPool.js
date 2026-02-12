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
    const newTop = Atomics.sub(this.freeListTop, 0, 1) - 1;

    if (newTop < 0) {
      // Pool exhausted - restore counter and return failure
      Atomics.add(this.freeListTop, 0, 1);
      return -1;
    }

    // Return the index from the free list
    // +1 offset because freeListTop counts from 0 but array is 0-indexed
    return this.freeList[newTop + 1];
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
    const slot = Atomics.add(this.freeListTop, 0, 1);

    // Safety check - don't overflow the free list
    if (slot >= this.maxCount) {
      // Rollback - this shouldn't happen in normal operation
      Atomics.sub(this.freeListTop, 0, 1);
      return;
    }

    // Write the index to the free list
    // +1 offset because slot is 0-indexed but we write after the count
    this.freeList[slot + 1] = index;
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
}
