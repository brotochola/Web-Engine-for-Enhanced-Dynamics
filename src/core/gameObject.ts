// GameObject.ts - Base class for all game entities with static shared arrays
// Provides transform, physics, and perception components via Structure of Arrays

import type {
  ArraySchema,
  EntityConfig,
  TypedArrayConstructor,
} from '../types/index.js';

/**
 * Base class for all game entities using Structure of Arrays pattern
 * All entity data is stored in SharedArrayBuffers for efficient multi-threaded access
 */
export class GameObject {
  // Shared memory buffer
  static sharedBuffer: SharedArrayBuffer | null = null;
  static entityCount: number = 0;

  // Entity class metadata (for spawning system)
  static startIndex: number = 0; // Starting index in arrays for this entity type
  static totalCount: number = 0; // Total allocated entities of this type
  static entityTypeId: number = 0; // Numeric type identifier for this class

  // Array schema - defines all shared arrays and their types
  // Order matters! Arrays are laid out in this exact order in memory
  // Properties are created dynamically in initializeArrays()
  static readonly ARRAY_SCHEMA = {
    // Transform
    x: Float32Array,
    y: Float32Array,
    vx: Float32Array,
    vy: Float32Array,
    ax: Float32Array,
    ay: Float32Array,
    rotation: Float32Array,
    velocityAngle: Float32Array,
    speed: Float32Array,
    // Verlet Integration (for alternative physics mode)
    px: Float32Array, // Previous X position
    py: Float32Array, // Previous Y position
    // Physics
    maxVel: Float32Array,
    maxAcc: Float32Array,
    minSpeed: Float32Array,
    friction: Float32Array,
    radius: Float32Array,
    collisionCount: Uint8Array, // Number of collisions this frame (for Verlet mode)
    // Perception
    visualRange: Float32Array,
    // State
    active: Uint8Array,
    entityType: Uint8Array, // 0=Boid, 1=Prey, 2=Predator
    isItOnScreen: Uint8Array,
  } as const;

  // Static typed arrays (populated by initializeArrays)
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

  // Neighbor data (from spatial worker)
  static neighborData: Int32Array | null = null;
  static distanceData: Float32Array | null = null; // Squared distances for each neighbor

  static instances: GameObject[] = [];

  // Spawning system
  static freeList: Int32Array | null = null;
  static freeListTop: number = -1;

  // Instance properties
  index: number;
  config: EntityConfig;
  logicWorker: Worker | null;
  neighborCount: number = 0;
  neighbors: Int32Array | null = null;
  neighborDistances: Float32Array | null = null;

  // Dynamic properties (created from ARRAY_SCHEMA)
  // These are defined via getters/setters in _createSchemaProperties
  declare x: number;
  declare y: number;
  declare vx: number;
  declare vy: number;
  declare ax: number;
  declare ay: number;
  declare rotation: number;
  declare velocityAngle: number;
  declare speed: number;
  declare px: number;
  declare py: number;
  declare maxVel: number;
  declare maxAcc: number;
  declare minSpeed: number;
  declare friction: number;
  declare radius: number;
  declare collisionCount: number;
  declare visualRange: number;
  declare active: number;
  declare entityType: number;
  declare isItOnScreen: number;

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
  static initializeArrays(
    this: typeof GameObject,
    buffer: SharedArrayBuffer,
    count: number,
    neighborBuffer: SharedArrayBuffer | null = null,
    distanceBuffer: SharedArrayBuffer | null = null
  ): void {
    this.sharedBuffer = buffer;
    this.entityCount = count;

    let offset = 0;

    // Create typed array views for each property defined in schema
    // 'this' refers to the class this method is called on (GameObject, subclass, etc.)
    for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;

      // Ensure proper alignment for this typed array
      const remainder = offset % bytesPerElement;
      if (remainder !== 0) {
        offset += bytesPerElement - remainder;
      }

      (this as any)[name] = new type(buffer, offset, count);
      offset += count * bytesPerElement;
    }

    // Initialize neighbor data if provided (only for GameObject)
    if (neighborBuffer && this === GameObject) {
      this.neighborData = new Int32Array(neighborBuffer);
    }

    // Initialize distance data if provided (only for GameObject)
    if (distanceBuffer && this === GameObject) {
      this.distanceData = new Float32Array(distanceBuffer);
    }
  }

  /**
   * Calculate total buffer size needed
   * @param count - Number of entities
   * @returns Buffer size in bytes
   */
  static getBufferSize(this: typeof GameObject, count: number): number {
    let offset = 0;

    for (const type of Object.values(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;

      // Add alignment padding
      const remainder = offset % bytesPerElement;
      if (remainder !== 0) {
        offset += bytesPerElement - remainder;
      }

      offset += count * bytesPerElement;
    }

    return offset;
  }

  /**
   * Constructor - stores the index and initializes instance
   * Subclasses should initialize their values in their constructors
   * @param index - Position in shared arrays
   * @param config - Configuration object from GameEngine
   * @param logicWorker - Reference to logic worker (if running in worker)
   */
  constructor(index: number, config: EntityConfig = {}, logicWorker: Worker | null = null) {
    this.index = index;
    this.config = config; // Store config for instance access
    this.logicWorker = logicWorker;
    GameObject.active[index] = 1; // Set active in shared array (1 = true, 0 = false)
    // Take the entity type from the class
    GameObject.entityType[index] = (this.constructor as typeof GameObject).entityTypeId;
    GameObject.instances.push(this);
    (this.constructor as typeof GameObject).instances.push(this);

    // Neighbor properties (updated each frame before tick)
    this.neighborCount = 0;
    this.neighbors = null; // Will be a TypedArray subarray
    this.neighborDistances = null; // Will be a TypedArray subarray of squared distances
  }

  /**
   * LIFECYCLE: Called when entity is first created (one-time initialization)
   * Override in subclasses for setup that should only happen once
   */
  start(): void {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity becomes active (spawned from pool)
   * Override in subclasses to reset/initialize state for reuse
   */
  awake(): void {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity becomes inactive (returned to pool)
   * Override in subclasses for cleanup, saving state, etc.
   */
  sleep(): void {
    // Override in subclasses
  }

  /**
   * Despawn this entity (return it to the inactive pool)
   * This is the proper way to deactivate an entity
   */
  despawn(): void {
    // Prevent double-despawn which corrupts the free list
    if (GameObject.active[this.index] === 0) return;

    GameObject.active[this.index] = 0;

    // Return to free list if exists (O(1))
    const EntityClass = this.constructor as typeof GameObject;
    if (EntityClass.freeList) {
      EntityClass.freeList[++EntityClass.freeListTop] = this.index;
    }

    // Call lifecycle callback
    if (this.sleep) {
      this.sleep();
    }
  }

  /**
   * Update neighbor references for this entity
   * Called by logic worker before tick() each frame
   *
   * @param neighborData - Precomputed neighbors from spatial worker
   * @param distanceData - Precomputed squared distances from spatial worker
   */
  updateNeighbors(neighborData: Int32Array, distanceData: Float32Array | null = null): void {
    // Handle both nested (main thread) and flat (worker) config structures
    const maxNeighbors =
      (this.config as any).spatial?.maxNeighbors || (this.config as any).maxNeighbors || 100;

    if (!neighborData || !maxNeighbors) {
      this.neighborCount = 0;
      this.neighbors = null;
      this.neighborDistances = null;
      return;
    }

    // Parse neighbor data buffer: [count, id1, id2, ..., id_MAX]
    const offset = this.index * (1 + maxNeighbors);
    this.neighborCount = neighborData[offset];
    this.neighbors = neighborData.subarray(
      offset + 1,
      offset + 1 + this.neighborCount
    ) as Int32Array;

    // Parse distance data buffer (same structure as neighborData)
    if (distanceData) {
      this.neighborDistances = distanceData.subarray(
        offset + 1,
        offset + 1 + this.neighborCount
      ) as Float32Array;
    } else {
      this.neighborDistances = null;
    }
  }

  /**
   * Main update method - called every frame by logic worker
   * Override this in subclasses to define entity behavior
   *
   * Note: this.neighbors and this.neighborCount are updated before this is called
   *
   * @param dtRatio - Delta time ratio (1.0 = 16.67ms frame)
   * @param inputData - Mouse and keyboard input
   */
  tick(dtRatio: number, inputData: Int32Array): void {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called on the first frame when this entity collides with another
   * Override in subclasses to handle collision start events
   *
   * @param otherIndex - Index of the other entity in collision
   */
  onCollisionEnter(otherIndex: number): void {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called every frame while this entity is colliding with another
   * Override in subclasses to handle continuous collision
   *
   * @param otherIndex - Index of the other entity in collision
   */
  onCollisionStay(otherIndex: number): void {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called on the first frame when this entity stops colliding with another
   * Override in subclasses to handle collision end events
   *
   * @param otherIndex - Index of the other entity that was in collision
   */
  onCollisionExit(otherIndex: number): void {
    // Override in subclasses
  }

  /**
   * Helper method to dynamically create getters/setters from ARRAY_SCHEMA
   * This is called in static initialization blocks by GameObject and all subclasses
   *
   * @param targetClass - The class to create properties for
   */
  static _createSchemaProperties(targetClass: typeof GameObject): void {
    Object.entries(targetClass.ARRAY_SCHEMA).forEach(([name, type]) => {
      Object.defineProperty(targetClass.prototype, name, {
        get(this: GameObject) {
          return (targetClass as any)[name][this.index];
        },
        // Special handling for Uint8Array to convert boolean to 0/1
        set(this: GameObject, value: number | boolean) {
          (targetClass as any)[name][this.index] =
            type === Uint8Array ? (value ? 1 : 0) : value;
        },
        enumerable: true,
        configurable: true,
      });

      // Special handling for x and y to also update px and py (Verlet integration)
      Object.defineProperty(targetClass.prototype, 'x', {
        get(this: GameObject) {
          return targetClass.x[this.index];
        },
        set(this: GameObject, value: number) {
          targetClass.x[this.index] = value;
          targetClass.px[this.index] = value;
        },
        enumerable: true,
        configurable: true,
      });

      Object.defineProperty(targetClass.prototype, 'y', {
        get(this: GameObject) {
          return targetClass.y[this.index];
        },
        set(this: GameObject, value: number) {
          targetClass.y[this.index] = value;
          targetClass.py[this.index] = value;
        },
        enumerable: true,
        configurable: true,
      });
    });
  }

  /**
   * SPAWNING SYSTEM: Initialize free list for O(1) spawning
   * Must be called after registration and before any spawning
   * @param EntityClass - The entity class to initialize
   */
  static initializeFreeList(EntityClass: typeof GameObject): void {
    const count = EntityClass.totalCount;
    const startIndex = EntityClass.startIndex;

    // Create free list stack
    EntityClass.freeList = new Int32Array(count);
    EntityClass.freeListTop = count - 1;

    // Fill with all indices (initially all are free)
    // We fill in reverse order so that we pop from the beginning first (optional)
    for (let i = 0; i < count; i++) {
      EntityClass.freeList[i] = startIndex + i;
    }
  }

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
  static spawn<T extends GameObject>(
    this: { new(index: number, config: EntityConfig, logicWorker?: Worker | null): T } & typeof GameObject,
    EntityClass: typeof GameObject,
    spawnConfig: EntityConfig = {}
  ): GameObject | null {
    // Validate EntityClass has required metadata
    if (
      EntityClass.startIndex === undefined ||
      EntityClass.totalCount === undefined
    ) {
      console.error(
        `Cannot spawn ${EntityClass.name}: missing startIndex/totalCount metadata. Was it registered with GameEngine?`
      );
      return null;
    }

    // Initialize free list if not exists (lazy init)
    if (!EntityClass.freeList) {
      GameObject.initializeFreeList(EntityClass);
    }

    // Check if pool is exhausted
    if (EntityClass.freeListTop < 0) {
      console.warn(
        `No inactive ${EntityClass.name} available in pool! All ${EntityClass.totalCount} entities are active.`
      );
      return null;
    }

    // Pop index from free list (O(1))
    const i = EntityClass.freeList![EntityClass.freeListTop--];

    // Get the instance (already created during initialization)
    const instance = EntityClass.instances[i - EntityClass.startIndex];

    if (!instance) {
      console.error(
        `No instance found at index ${i} for ${EntityClass.name}`
      );
      return null;
    }

    instance.ax = 0;
    instance.ay = 0;
    instance.vx = 0;
    instance.vy = 0;

    instance.speed = 0;
    instance.velocityAngle = 0;
    instance.x = 0;
    instance.y = 0;
    instance.px = 0;
    instance.py = 0;
    instance.rotation = 0;

    // Check if setTint and setAlpha exist (for RenderableGameObject subclasses)
    if ('setTint' in instance && typeof (instance as any).setTint === 'function') {
      (instance as any).setTint(0xffffff); // White when healthy
    }
    if ('setAlpha' in instance && typeof (instance as any).setAlpha === 'function') {
      (instance as any).setAlpha(1.0); // Fully visible
    }

    // IMPORTANT: Apply spawn config BEFORE activating to prevent race condition
    // If entity is active, it can start ticking immediately on next frame
    Object.keys(spawnConfig).forEach((key) => {
      if ((instance as any)[key] !== undefined) {
        (instance as any)[key] = spawnConfig[key];
      }
    });

    // Initialize previous positions for Verlet integration
    // Set px/py based on current velocity to give initial momentum
    instance.px = instance.x - instance.vx;
    instance.py = instance.y - instance.vy;

    // Call lifecycle method BEFORE activating
    if (instance.awake) {
      instance.awake();
    }

    // NOW activate the entity (after config and awake are done)
    GameObject.active[i] = 1;

    return instance;
  }

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
  } {
    if (
      EntityClass.startIndex === undefined ||
      EntityClass.totalCount === undefined
    ) {
      return { total: 0, active: 0, available: 0 };
    }

    // If free list exists, use it for O(1) stats
    if (EntityClass.freeList) {
      const available = EntityClass.freeListTop + 1;
      return {
        total: EntityClass.totalCount,
        active: EntityClass.totalCount - available,
        available: available,
      };
    }

    // Fallback to linear search if free list not initialized
    const startIndex = EntityClass.startIndex;
    const total = EntityClass.totalCount;
    let activeCount = 0;

    for (let i = startIndex; i < startIndex + total; i++) {
      if (GameObject.active[i]) {
        activeCount++;
      }
    }

    return {
      total: total,
      active: activeCount,
      available: total - activeCount,
    };
  }

  /**
   * SPAWNING SYSTEM: Despawn all entities of a specific type
   *
   * @param EntityClass - The entity class to despawn
   * @returns Number of entities despawned
   */
  static despawnAll(EntityClass: typeof GameObject): number {
    if (
      EntityClass.startIndex === undefined ||
      EntityClass.totalCount === undefined
    ) {
      return 0;
    }

    const startIndex = EntityClass.startIndex;
    const endIndex = startIndex + EntityClass.totalCount;
    let despawnedCount = 0;

    // Iterate all entities to find active ones
    // We could optimize this by tracking active entities, but despawnAll is rare
    for (let i = startIndex; i < endIndex; i++) {
      if (GameObject.active[i]) {
        const instance = EntityClass.instances[i - startIndex];
        if (instance && instance.despawn) {
          instance.despawn();
          despawnedCount++;
        } else {
          // Manual despawn if instance missing (shouldn't happen)
          GameObject.active[i] = 0;

          // Return to free list if exists
          if (EntityClass.freeList) {
            EntityClass.freeList[++EntityClass.freeListTop] = i;
          }

          despawnedCount++;
        }
      }
    }

    return despawnedCount;
  }

  // Static initialization block - dynamically create getters/setters from ARRAY_SCHEMA
  static {
    GameObject._createSchemaProperties(GameObject);
  }
}
