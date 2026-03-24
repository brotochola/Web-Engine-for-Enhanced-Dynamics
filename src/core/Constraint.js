// Constraint.js - Distance Constraints for Position-Based Dynamics
// Thread-safe constraint pool backed by SharedArrayBuffer
// Extends SharedAtomicPool for atomic free list operations
//
// ARCHITECTURE:
// - Distance constraints maintain a target distance between two entities
// - Solved iteratively in physics worker substep loop (position-based)
// - Packed pair storage: (entityA << 16) | entityB for cache efficiency
// - All arrays backed by SharedArrayBuffer for cross-worker access
//
// THREAD SAFETY:
// - freeList and freeListTop use Atomics for lock-free allocation
// - Any worker or main thread can add/remove constraints safely

import { SharedAtomicPool } from './SharedAtomicPool.js';

/**
 * Static class for managing distance constraints between entities.
 * Extends SharedAtomicPool for thread-safe index allocation.
 */
export class Constraint extends SharedAtomicPool {
    static INVALID_INDEX = 0xFFFF;

    // Pool name for logging
    static poolName = 'Constraint';

    // ========================================
    // CONSTRAINT DATA ARRAYS (SharedArrayBuffer-backed)
    // ========================================

    // Packed entity pairs: (entityA << 16) | entityB
    // Using Uint32 allows entity indices up to 65535
    static pairs = null;        // Uint32Array

    // Target distance between entities (rest length)
    static restLength = null;   // Float32Array

    // Constraint stiffness: 0 = no effect, 1 = fully rigid
    static stiffness = null;    // Float32Array

    // Active flag: 1 = active, 0 = inactive (available for reuse)
    static active = null;       // Uint8Array

    // Dense active constraint tracking for hot iteration in physics/debug paths
    static activeIndices = null;        // Uint16Array
    static activeIndexPositions = null; // Uint16Array
    static activeMeta = null;           // Int32Array[2] => [count, lock]
    static activeCount = null;          // Int32Array[1]
    static activeListLock = null;       // Int32Array[1]

    // ========================================
    // BUFFER MANAGEMENT
    // ========================================

    /**
     * Calculate buffer size needed for constraint arrays
     * @param {number} maxConstraints - Maximum number of constraints
     * @returns {number} Total buffer size in bytes
     */
    static getBufferSize(maxConstraints) {
        // pairs: Uint32 (4 bytes per constraint)
        // restLength: Float32 (4 bytes per constraint)
        // stiffness: Float32 (4 bytes per constraint)
        // active: Uint8 (1 byte per constraint, aligned to 4)
        // activeIndices: Uint16 (2 bytes per constraint)
        // activeIndexPositions: Uint16 (2 bytes per constraint)
        // activeMeta: Int32[2] => count + lock
        const alignedActiveSize = Math.ceil(maxConstraints / 4) * 4;
        return maxConstraints * 4 +    // pairs
            maxConstraints * 4 +    // restLength
            maxConstraints * 4 +    // stiffness
            alignedActiveSize +     // active (aligned)
            maxConstraints * 2 +    // activeIndices
            maxConstraints * 2 +    // activeIndexPositions
            8;                      // activeMeta
    }

    /**
     * Initialize arrays from SharedArrayBuffer
     * @param {SharedArrayBuffer} buffer - The shared buffer
     * @param {number} maxConstraints - Maximum number of constraints
     */
    static initializeArrays(buffer, maxConstraints) {
        let offset = 0;

        // pairs: Uint32Array
        this.pairs = new Uint32Array(buffer, offset, maxConstraints);
        offset += maxConstraints * 4;

        // restLength: Float32Array
        this.restLength = new Float32Array(buffer, offset, maxConstraints);
        offset += maxConstraints * 4;

        // stiffness: Float32Array
        this.stiffness = new Float32Array(buffer, offset, maxConstraints);
        offset += maxConstraints * 4;

        // active: Uint8Array (remaining bytes)
        this.active = new Uint8Array(buffer, offset, maxConstraints);
        offset += Math.ceil(maxConstraints / 4) * 4;

        this.activeIndices = new Uint16Array(buffer, offset, maxConstraints);
        offset += maxConstraints * 2;

        this.activeIndexPositions = new Uint16Array(buffer, offset, maxConstraints);
        offset += maxConstraints * 2;

        this.activeMeta = new Int32Array(buffer, offset, 2);
        this.activeCount = new Int32Array(buffer, offset, 1);
        this.activeListLock = new Int32Array(buffer, offset + 4, 1);

        // Initialize all constraints as inactive
        this.active.fill(0);
        this.activeIndices.fill(this.INVALID_INDEX);
        this.activeIndexPositions.fill(this.INVALID_INDEX);
        this.activeMeta[0] = 0; // active count
        this.activeMeta[1] = 0; // spin lock
    }

    // ========================================
    // CONSTRAINT API
    // ========================================

    /**
     * Add a distance constraint between two entities
     * Thread-safe: uses atomic operations for allocation
     *
     * @param {number} entityA - First entity index
     * @param {number} entityB - Second entity index
     * @param {number} distance - Target distance (rest length)
     * @param {number} stiff - Stiffness (0-1), default 1.0
     * @returns {number} Constraint index, or -1 if pool exhausted
     */
    static add(entityA, entityB, distance, stiff = 1.0) {
        // Acquire a free index atomically
        const idx = this.acquireIndex();
        if (idx === -1) {
            console.warn('Constraint: Pool exhausted, cannot add constraint');
            return -1;
        }

        // Pack entity pair: entityA in high 16 bits, entityB in low 16 bits
        this.pairs[idx] = (entityA << 16) | (entityB & 0xFFFF);
        this.restLength[idx] = distance;
        this.stiffness[idx] = Math.max(0, Math.min(1, stiff)); // Clamp to [0,1]

        this.acquireSpinLock(this.activeListLock);
        try {
            const slot = this.activeCount ? Atomics.load(this.activeCount, 0) : 0;
            this.activeIndices[slot] = idx;
            this.activeIndexPositions[idx] = slot;
            this.active[idx] = 1;
            if (this.activeCount) {
                Atomics.store(this.activeCount, 0, slot + 1);
            }
        } finally {
            this.releaseSpinLock(this.activeListLock);
        }

        return idx;
    }

    /**
     * Remove a constraint by index
     * Thread-safe: uses atomic operations for deallocation
     *
     * @param {number} idx - Constraint index to remove
     */
    static remove(idx) {
        if (idx < 0 || idx >= this.maxCount) return;
        if (!this.active[idx]) return; // Already inactive

        this.acquireSpinLock(this.activeListLock);
        try {
            if (!this.active[idx]) return;

            const count = this.activeCount ? Atomics.load(this.activeCount, 0) : 0;
            const slot = this.activeIndexPositions[idx];
            const lastSlot = count - 1;

            this.active[idx] = 0;

            if (slot !== this.INVALID_INDEX && lastSlot >= 0) {
                const lastIdx = this.activeIndices[lastSlot];
                if (slot !== lastSlot) {
                    this.activeIndices[slot] = lastIdx;
                    this.activeIndexPositions[lastIdx] = slot;
                }
                this.activeIndices[lastSlot] = this.INVALID_INDEX;
                this.activeIndexPositions[idx] = this.INVALID_INDEX;
                if (this.activeCount) {
                    Atomics.store(this.activeCount, 0, lastSlot);
                }
            }
        } finally {
            this.releaseSpinLock(this.activeListLock);
        }

        // Return index to free list
        this.returnToPool(idx);
    }

    /**
     * Get entity indices from a packed pair
     * @param {number} idx - Constraint index
     * @returns {{entityA: number, entityB: number}} Entity indices
     */
    static getEntities(idx) {
        const packed = this.pairs[idx];
        return {
            entityA: packed >>> 16,
            entityB: packed & 0xFFFF
        };
    }

    /**
     * Update constraint properties
     * @param {number} idx - Constraint index
     * @param {Object} props - Properties to update {distance?, stiffness?}
     */
    static update(idx, props) {
        if (idx < 0 || idx >= this.maxCount || !this.active[idx]) return;

        if (props.distance !== undefined) {
            this.restLength[idx] = props.distance;
        }
        if (props.stiffness !== undefined) {
            this.stiffness[idx] = Math.max(0, Math.min(1, props.stiffness));
        }
    }

    /**
     * Check if a constraint is active
     * @param {number} idx - Constraint index
     * @returns {boolean} True if constraint is active
     */
    static isActive(idx) {
        return idx >= 0 && idx < this.maxCount && this.active[idx] === 1;
    }

    /**
     * Remove all constraints involving a specific entity
     * Call this when an entity is despawned
     * @param {number} entityIdx - Entity index to remove constraints for
     */
    static removeAllForEntity(entityIdx) {
        const activeCount = this.getDenseActiveCount();
        for (let slot = activeCount - 1; slot >= 0; slot--) {
            const idx = this.activeIndices[slot];
            if (idx === this.INVALID_INDEX || !this.active[idx]) continue;

            const packed = this.pairs[idx];
            const a = packed >>> 16;
            const b = packed & 0xFFFF;
            if (a === entityIdx || b === entityIdx) {
                this.remove(idx);
            }
        }
    }

    static getDenseActiveCount() {
        if (!this.activeCount) return 0;
        return Atomics.load(this.activeCount, 0);
    }

    /**
     * Debug: Get all active constraints as an array
     * @returns {Array<{idx: number, entityA: number, entityB: number, distance: number, stiffness: number}>}
     */
    static getAllActive() {
        const result = [];
        const activeCount = this.getDenseActiveCount();
        for (let slot = 0; slot < activeCount; slot++) {
            const idx = this.activeIndices[slot];
            if (idx === this.INVALID_INDEX || !this.active[idx]) continue;

            const packed = this.pairs[idx];
            result.push({
                idx,
                entityA: packed >>> 16,
                entityB: packed & 0xFFFF,
                distance: this.restLength[idx],
                stiffness: this.stiffness[idx]
            });
        }
        return result;
    }

    /**
     * Reset all constraint state (extends parent reset)
     * Called when switching scenes to clear stale static state
     */
    static reset() {
        super.reset();
        this.pairs = null;
        this.restLength = null;
        this.stiffness = null;
        this.active = null;
        this.activeIndices = null;
        this.activeIndexPositions = null;
        this.activeMeta = null;
        this.activeCount = null;
        this.activeListLock = null;
    }
}
