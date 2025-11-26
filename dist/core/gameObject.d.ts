import type { EntityConfig } from '../types/index.js';
/**
 * Base class for all game entities using Structure of Arrays pattern
 * All entity data is stored in SharedArrayBuffers for efficient multi-threaded access
 */
export declare class GameObject {
    static sharedBuffer: SharedArrayBuffer | null;
    static entityCount: number;
    static startIndex: number;
    static totalCount: number;
    static entityTypeId: number;
    static readonly ARRAY_SCHEMA: {
        readonly x: Float32ArrayConstructor;
        readonly y: Float32ArrayConstructor;
        readonly vx: Float32ArrayConstructor;
        readonly vy: Float32ArrayConstructor;
        readonly ax: Float32ArrayConstructor;
        readonly ay: Float32ArrayConstructor;
        readonly rotation: Float32ArrayConstructor;
        readonly velocityAngle: Float32ArrayConstructor;
        readonly speed: Float32ArrayConstructor;
        readonly px: Float32ArrayConstructor;
        readonly py: Float32ArrayConstructor;
        readonly maxVel: Float32ArrayConstructor;
        readonly maxAcc: Float32ArrayConstructor;
        readonly minSpeed: Float32ArrayConstructor;
        readonly friction: Float32ArrayConstructor;
        readonly radius: Float32ArrayConstructor;
        readonly collisionCount: Uint8ArrayConstructor;
        readonly visualRange: Float32ArrayConstructor;
        readonly active: Uint8ArrayConstructor;
        readonly entityType: Uint8ArrayConstructor;
        readonly isItOnScreen: Uint8ArrayConstructor;
    };
    static x: Float32Array;
    static y: Float32Array;
    static vx: Float32Array;
    static vy: Float32Array;
    static ax: Float32Array;
    static ay: Float32Array;
    static rotation: Float32Array;
    static velocityAngle: Float32Array;
    static speed: Float32Array;
    static px: Float32Array;
    static py: Float32Array;
    static maxVel: Float32Array;
    static maxAcc: Float32Array;
    static minSpeed: Float32Array;
    static friction: Float32Array;
    static radius: Float32Array;
    static collisionCount: Uint8Array;
    static visualRange: Float32Array;
    static active: Uint8Array;
    static entityType: Uint8Array;
    static isItOnScreen: Uint8Array;
    static neighborData: Int32Array | null;
    static distanceData: Float32Array | null;
    static instances: GameObject[];
    static freeList: Int32Array | null;
    static freeListTop: number;
    index: number;
    config: EntityConfig;
    logicWorker: Worker | null;
    neighborCount: number;
    neighbors: Int32Array | null;
    neighborDistances: Float32Array | null;
    x: number;
    y: number;
    vx: number;
    vy: number;
    ax: number;
    ay: number;
    rotation: number;
    velocityAngle: number;
    speed: number;
    px: number;
    py: number;
    maxVel: number;
    maxAcc: number;
    minSpeed: number;
    friction: number;
    radius: number;
    collisionCount: number;
    visualRange: number;
    active: number;
    entityType: number;
    isItOnScreen: number;
    /**
     * Initialize static arrays from SharedArrayBuffer
     * Called by GameEngine and by each worker
     *
     * This is a generic method that works for both GameObject and all subclasses
     * by using 'this' which refers to the class it's called on.
     *
     * @param buffer - The shared memory
     * @param count - Total number of entities
     * @param neighborBuffer - Optional neighbor data buffer
     * @param distanceBuffer - Optional distance data buffer
     */
    static initializeArrays(this: typeof GameObject, buffer: SharedArrayBuffer, count: number, neighborBuffer?: SharedArrayBuffer | null, distanceBuffer?: SharedArrayBuffer | null): void;
    /**
     * Calculate total buffer size needed
     * @param count - Number of entities
     * @returns Buffer size in bytes
     */
    static getBufferSize(this: typeof GameObject, count: number): number;
    /**
     * Constructor - stores the index and initializes instance
     * Subclasses should initialize their values in their constructors
     * @param index - Position in shared arrays
     * @param config - Configuration object from GameEngine
     * @param logicWorker - Reference to logic worker (if running in worker)
     */
    constructor(index: number, config?: EntityConfig, logicWorker?: Worker | null);
    /**
     * LIFECYCLE: Called when entity is first created (one-time initialization)
     * Override in subclasses for setup that should only happen once
     */
    start(): void;
    /**
     * LIFECYCLE: Called when entity becomes active (spawned from pool)
     * Override in subclasses to reset/initialize state for reuse
     */
    awake(): void;
    /**
     * LIFECYCLE: Called when entity becomes inactive (returned to pool)
     * Override in subclasses for cleanup, saving state, etc.
     */
    sleep(): void;
    /**
     * Despawn this entity (return it to the inactive pool)
     * This is the proper way to deactivate an entity
     */
    despawn(): void;
    /**
     * Update neighbor references for this entity
     * Called by logic worker before tick() each frame
     *
     * @param neighborData - Precomputed neighbors from spatial worker
     * @param distanceData - Precomputed squared distances from spatial worker
     */
    updateNeighbors(neighborData: Int32Array, distanceData?: Float32Array | null): void;
    /**
     * Main update method - called every frame by logic worker
     * Override this in subclasses to define entity behavior
     *
     * Note: this.neighbors and this.neighborCount are updated before this is called
     *
     * @param dtRatio - Delta time ratio (1.0 = 16.67ms frame)
     * @param inputData - Mouse and keyboard input
     */
    tick(dtRatio: number, inputData: Int32Array): void;
    /**
     * Unity-style collision callback: Called on the first frame when this entity collides with another
     * Override in subclasses to handle collision start events
     *
     * @param otherIndex - Index of the other entity in collision
     */
    onCollisionEnter(otherIndex: number): void;
    /**
     * Unity-style collision callback: Called every frame while this entity is colliding with another
     * Override in subclasses to handle continuous collision
     *
     * @param otherIndex - Index of the other entity in collision
     */
    onCollisionStay(otherIndex: number): void;
    /**
     * Unity-style collision callback: Called on the first frame when this entity stops colliding with another
     * Override in subclasses to handle collision end events
     *
     * @param otherIndex - Index of the other entity that was in collision
     */
    onCollisionExit(otherIndex: number): void;
    /**
     * Helper method to dynamically create getters/setters from ARRAY_SCHEMA
     * This is called in static initialization blocks by GameObject and all subclasses
     *
     * @param targetClass - The class to create properties for
     */
    static _createSchemaProperties(targetClass: typeof GameObject): void;
    /**
     * SPAWNING SYSTEM: Initialize free list for O(1) spawning
     * Must be called after registration and before any spawning
     * @param EntityClass - The entity class to initialize
     */
    static initializeFreeList(EntityClass: typeof GameObject): void;
    /**
     * SPAWNING SYSTEM: Spawn an entity from the pool (activate an inactive entity)
     *
     * @param EntityClass - The entity class to spawn (e.g., Prey, Predator)
     * @param spawnConfig - Initial configuration (position, velocity, etc.)
     * @returns The spawned entity instance, or null if pool exhausted
     *
     * @example
     * const prey = GameObject.spawn(Prey, { x: 500, y: 300, vx: 2, vy: -1 });
     */
    static spawn<T extends GameObject>(this: {
        new (index: number, config: EntityConfig, logicWorker?: Worker | null): T;
    } & typeof GameObject, EntityClass: typeof GameObject, spawnConfig?: EntityConfig): GameObject | null;
    /**
     * SPAWNING SYSTEM: Get pool statistics for an entity class
     *
     * @param EntityClass - The entity class to check
     * @returns { total, active, available }
     *
     * @example
     * const stats = GameObject.getPoolStats(Prey);
     * console.log(`Prey: ${stats.active}/${stats.total} active, ${stats.available} available`);
     */
    static getPoolStats(EntityClass: typeof GameObject): {
        total: number;
        active: number;
        available: number;
    };
    /**
     * SPAWNING SYSTEM: Despawn all entities of a specific type
     *
     * @param EntityClass - The entity class to despawn
     * @returns Number of entities despawned
     */
    static despawnAll(EntityClass: typeof GameObject): number;
}
//# sourceMappingURL=gameObject.d.ts.map