// GameObject.js - Base class for all game entities using component composition
// Entities are composed of components (Transform, RigidBody, Collider, etc.)

import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";

class GameObject {
  // Entity class metadata (for spawning system)
  static startIndex = 0; // Starting index in arrays for this entity type
  static totalCount = 0; // Total allocated entities of this type

  // Component composition - define which components this entity type has
  // Override in subclasses, e.g.: static components = [RigidBody, Collider, SpriteRenderer]
  static components = []; // By default, only Transform (added automatically)

  // Neighbor data (from spatial worker)
  static neighborData = null;
  static distanceData = null; // Squared distances for each neighbor

  // Entity metadata (minimal - just entityType)
  static entityType = null; // Uint8Array

  static sharedBuffer = null; // For entity metadata
  static entityCount = 0;

  static instances = [];

  /**
   * Initialize entity metadata from SharedArrayBuffer
   * This only initializes minimal entity metadata (entityType)
   * Components (including Transform with 'active') are initialized separately
   *
   * @param {SharedArrayBuffer} buffer - The shared memory for entity metadata
   * @param {number} count - Total number of entities
   * @param {SharedArrayBuffer} [neighborBuffer] - Optional neighbor data buffer
   * @param {SharedArrayBuffer} [distanceBuffer] - Optional distance data buffer
   */
  static initializeArrays(
    buffer,
    count,
    neighborBuffer = null,
    distanceBuffer = null
  ) {
    this.sharedBuffer = buffer;
    this.entityCount = count;

    // Create entity metadata array (just entityType now)
    this.entityType = new Uint8Array(buffer, 0, count);

    // Initialize neighbor data if provided
    if (neighborBuffer) {
      this.neighborData = new Int32Array(neighborBuffer);
    }

    // Initialize distance data if provided
    if (distanceBuffer) {
      this.distanceData = new Float32Array(distanceBuffer);
    }
  }

  /**
   * Calculate buffer size needed for entity metadata
   * @param {number} count - Number of entities
   * @returns {number} Buffer size in bytes
   */
  static getBufferSize(count) {
    // 1 Uint8Array: entityType
    // Note: 'active' moved to Transform, 'isItOnScreen' moved to SpriteRenderer
    return count * 1;
  }

  /**
   * Collect all components from class hierarchy
   * Walks up the prototype chain and collects all unique components
   * @param {Class} EntityClass - The entity class to collect components from
   * @returns {Array<Component>} Array of unique component classes
   */
  static _collectComponents(EntityClass) {
    const components = new Set();
    let currentClass = EntityClass;

    // Walk up the prototype chain
    while (currentClass && currentClass !== Object) {
      if (currentClass.components && Array.isArray(currentClass.components)) {
        currentClass.components.forEach((c) => components.add(c));
      }
      currentClass = Object.getPrototypeOf(currentClass);
    }

    // Transform is always included
    components.add(Transform);

    return Array.from(components);
  }

  /**
   * Constructor - stores entity index and component indices
   * @param {number} index - Entity index
   * @param {Object} componentIndices - Map of component indices { transform: N, rigidBody: N, ... }
   * @param {Object} config - Configuration object from GameEngine
   * @param {Object} logicWorker - Logic worker reference
   */
  constructor(index, componentIndices = {}, config = {}, logicWorker = null) {
    this.index = index;
    this.config = config;
    this.logicWorker = logicWorker;

    // Store component indices
    this._componentIndices = componentIndices;

    // Set entityType metadata
    GameObject.entityType[index] = this.constructor.entityType || 0;

    // Set INACTIVE in Transform (entities start in pool, spawn() activates them)
    // Note: Transform is always present at entity index
    Transform.active[index] = 0;

    GameObject.instances.push(this);
    this.constructor.instances.push(this);

    // Neighbor properties (updated each frame before tick)
    this.neighborCount = 0;
    this.neighbors = null; // Will be a TypedArray subarray
    this.neighborDistances = null; // Will be a TypedArray subarray of squared distances

    // Create component accessor cache
    this._componentAccessors = {};
  }

  /**
   * Component accessor: Transform (always present)
   */
  get transform() {
    if (!this._componentAccessors.transform) {
      const index = this._componentIndices.transform;
      this._componentAccessors.transform = this._createComponentAccessor(
        Transform,
        index
      );
    }
    return this._componentAccessors.transform;
  }

  /**
   * Component accessor: RigidBody (if entity has it)
   */
  get rigidBody() {
    if (this._componentIndices.rigidBody === undefined) return null;

    if (!this._componentAccessors.rigidBody) {
      const index = this._componentIndices.rigidBody;
      this._componentAccessors.rigidBody = this._createComponentAccessor(
        RigidBody,
        index
      );
    }
    return this._componentAccessors.rigidBody;
  }

  /**
   * Component accessor: Collider (if entity has it)
   */
  get collider() {
    if (this._componentIndices.collider === undefined) return null;

    if (!this._componentAccessors.collider) {
      const index = this._componentIndices.collider;
      this._componentAccessors.collider = this._createComponentAccessor(
        Collider,
        index
      );
    }
    return this._componentAccessors.collider;
  }

  /**
   * Component accessor: SpriteRenderer (if entity has it)
   */
  get spriteRenderer() {
    if (this._componentIndices.spriteRenderer === undefined) return null;

    if (!this._componentAccessors.spriteRenderer) {
      const index = this._componentIndices.spriteRenderer;
      this._componentAccessors.spriteRenderer = this._createComponentAccessor(
        SpriteRenderer,
        index
      );
    }
    return this._componentAccessors.spriteRenderer;
  }

  /**
   * Create a component accessor object with getters/setters
   * @param {Component} ComponentClass - The component class
   * @param {number} index - Index in component arrays
   * @returns {Object} Accessor object
   */
  _createComponentAccessor(ComponentClass, index) {
    const accessor = {};

    Object.entries(ComponentClass.ARRAY_SCHEMA).forEach(([name, type]) => {
      Object.defineProperty(accessor, name, {
        get() {
          return ComponentClass[name][index];
        },
        set(value) {
          ComponentClass[name][index] =
            type === Uint8Array ? (value ? 1 : 0) : value;
        },
        enumerable: true,
        configurable: true,
      });
    });

    return accessor;
  }

  /**
   * Helper method for SpriteRenderer - mark as dirty
   */
  markDirty() {
    if (this.spriteRenderer) {
      this.spriteRenderer.renderDirty = 1;
    }
  }

  /**
   * Helper setters for SpriteRenderer compatibility
   */
  setTint(tint) {
    if (this.spriteRenderer && this.spriteRenderer.tint !== tint) {
      this.spriteRenderer.tint = tint;
      this.markDirty();
    }
  }

  setAlpha(alpha) {
    if (this.spriteRenderer && this.spriteRenderer.alpha !== alpha) {
      this.spriteRenderer.alpha = alpha;
      this.markDirty();
    }
  }

  setScale(scaleX, scaleY) {
    if (!this.spriteRenderer) return;

    let changed = false;
    if (this.spriteRenderer.scaleX !== scaleX) {
      this.spriteRenderer.scaleX = scaleX;
      changed = true;
    }
    if (scaleY !== undefined && this.spriteRenderer.scaleY !== scaleY) {
      this.spriteRenderer.scaleY = scaleY;
      changed = true;
    }
    if (changed) this.markDirty();
  }

  setVisible(visible) {
    if (
      this.spriteRenderer &&
      this.spriteRenderer.renderVisible !== (visible ? 1 : 0)
    ) {
      this.spriteRenderer.renderVisible = visible ? 1 : 0;
      this.markDirty();
    }
  }

  setAnimationState(state) {
    if (this.spriteRenderer && this.spriteRenderer.animationState !== state) {
      this.spriteRenderer.animationState = state;
      this.markDirty();
    }
  }

  setAnimationSpeed(speed) {
    if (this.spriteRenderer && this.spriteRenderer.animationSpeed !== speed) {
      this.spriteRenderer.animationSpeed = speed;
      this.markDirty();
    }
  }

  /**
   * Helper method to send sprite property changes to renderer
   */
  setSpriteProp(prop, value) {
    if (this.logicWorker) {
      this.logicWorker.sendDataToWorker("renderer", {
        cmd: "setProp",
        entityId: this.index,
        prop: prop,
        value: value,
      });
    }
  }

  /**
   * Helper method to call sprite methods
   */
  callSpriteMethod(method, args = []) {
    if (this.logicWorker) {
      this.logicWorker.sendDataToWorker("renderer", {
        cmd: "callMethod",
        entityId: this.index,
        method: method,
        args: args,
      });
    }
  }

  /**
   * Helper method to batch multiple sprite updates
   */
  updateSprite(updates) {
    if (this.logicWorker) {
      this.logicWorker.sendDataToWorker("renderer", {
        cmd: "batchUpdate",
        entityId: this.index,
        ...updates,
      });
    }
  }

  /**
   * LIFECYCLE: Called when entity is first created (one-time initialization)
   * Override in subclasses for setup that should only happen once
   */
  start() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity becomes active (spawned from pool)
   * Override in subclasses to reset/initialize state for reuse
   */
  awake() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity becomes inactive (returned to pool)
   * Override in subclasses for cleanup, saving state, etc.
   */
  sleep() {
    // Override in subclasses
  }

  /**
   * Despawn this entity (return it to the inactive pool)
   * This is the proper way to deactivate an entity
   */
  despawn() {
    // Prevent double-despawn which corrupts the free list
    if (Transform.active[this.index] === 0) return;

    Transform.active[this.index] = 0;

    // Return to free list if exists (O(1))
    const EntityClass = this.constructor;
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
   * @param {Int32Array} neighborData - Precomputed neighbors from spatial worker
   * @param {Float32Array} distanceData - Precomputed squared distances from spatial worker
   */
  updateNeighbors(neighborData, distanceData = null) {
    // Handle both nested (main thread) and flat (worker) config structures
    const maxNeighbors =
      this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;

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
    );

    // Parse distance data buffer (same structure as neighborData)
    if (distanceData) {
      this.neighborDistances = distanceData.subarray(
        offset + 1,
        offset + 1 + this.neighborCount
      );
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
   * @param {number} dtRatio - Delta time ratio (1.0 = 16.67ms frame)
   * @param {Int32Array} inputData - Mouse and keyboard input
   */
  tick(dtRatio, inputData) {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called on the first frame when this entity collides with another
   * Override in subclasses to handle collision start events
   *
   * @param {number} otherIndex - Index of the other entity in collision
   */
  onCollisionEnter(otherIndex) {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called every frame while this entity is colliding with another
   * Override in subclasses to handle continuous collision
   *
   * @param {number} otherIndex - Index of the other entity in collision
   */
  onCollisionStay(otherIndex) {
    // Override in subclasses
  }

  /**
   * Unity-style collision callback: Called on the first frame when this entity stops colliding with another
   * Override in subclasses to handle collision end events
   *
   * @param {number} otherIndex - Index of the other entity that was in collision
   */
  onCollisionExit(otherIndex) {
    // Override in subclasses
  }

  /**
   * SPAWNING SYSTEM: Initialize free list for O(1) spawning
   * Must be called after registration and before any spawning
   * @param {Class} EntityClass - The entity class to initialize
   */
  static initializeFreeList(EntityClass) {
    const count = EntityClass.totalCount;
    const startIndex = EntityClass.startIndex;

    // Create free list stack
    EntityClass.freeList = new Int32Array(count);
    EntityClass.freeListTop = count - 1;

    // Fill with all indices (initially all are free)
    for (let i = 0; i < count; i++) {
      EntityClass.freeList[i] = startIndex + i;
    }
  }

  /**
   * SPAWNING SYSTEM: Spawn an entity from the pool (activate an inactive entity)
   *
   * @param {Class} EntityClass - The entity class to spawn (e.g., Ball, Car)
   * @param {Object} spawnConfig - Initial configuration (position, velocity, etc.)
   * @returns {GameObject|null} - The spawned entity instance, or null if pool exhausted
   */
  static spawn(EntityClass, spawnConfig = {}) {
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
    const i = EntityClass.freeList[EntityClass.freeListTop--];

    // Get the instance (already created during initialization)
    const instance = EntityClass.instances[i - EntityClass.startIndex];

    if (!instance) {
      console.error(`No instance found at index ${i} for ${EntityClass.name}`);
      return null;
    }

    // Reset component values
    if (instance.rigidBody) {
      instance.rigidBody.ax = 0;
      instance.rigidBody.ay = 0;
      instance.rigidBody.vx = 0;
      instance.rigidBody.vy = 0;
      instance.rigidBody.speed = 0;
      instance.rigidBody.velocityAngle = 0;
      instance.rigidBody.px = 0;
      instance.rigidBody.py = 0;
    }

    if (instance.transform) {
      instance.transform.x = 0;
      instance.transform.y = 0;
      instance.transform.rotation = 0;
    }

    if (instance.spriteRenderer) {
      instance.setTint(0xffffff);
      instance.setAlpha(1.0);
      instance.setVisible(true);
    }

    // Apply spawn config BEFORE activating
    Object.keys(spawnConfig).forEach((key) => {
      // Handle component properties
      if (key.includes(".")) {
        const [compName, propName] = key.split(".");
        const comp = instance[compName];
        if (comp && comp[propName] !== undefined) {
          comp[propName] = spawnConfig[key];
        }
      } else if (instance[key] !== undefined) {
        instance[key] = spawnConfig[key];
      }
    });

    // Initialize previous positions for Verlet integration
    if (instance.rigidBody && instance.transform) {
      instance.rigidBody.px = instance.transform.x - instance.rigidBody.vx;
      instance.rigidBody.py = instance.transform.y - instance.rigidBody.vy;
    }

    // Call lifecycle method BEFORE activating
    if (instance.awake) {
      // console.log(`GameObject.spawn: Calling awake() for ${EntityClass.name} index ${i}`);
      instance.awake();
      // console.log(`GameObject.spawn: Finished awake() for ${EntityClass.name} index ${i}`);
    } else {
      // console.log(`GameObject.spawn: No awake() method for ${EntityClass.name} index ${i}`);
    }

    // NOW activate the entity
    Transform.active[i] = 1;

    return instance;
  }

  /**
   * SPAWNING SYSTEM: Get pool statistics for an entity class
   *
   * @param {Class} EntityClass - The entity class to check
   * @returns {Object} - { total, active, available }
   */
  static getPoolStats(EntityClass) {
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
      if (Transform.active[i]) {
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
   * @param {Class} EntityClass - The entity class to despawn
   * @returns {number} - Number of entities despawned
   */
  static despawnAll(EntityClass) {
    if (
      EntityClass.startIndex === undefined ||
      EntityClass.totalCount === undefined
    ) {
      return 0;
    }

    const startIndex = EntityClass.startIndex;
    const endIndex = startIndex + EntityClass.totalCount;
    let despawnedCount = 0;

    for (let i = startIndex; i < endIndex; i++) {
      if (Transform.active[i]) {
        const instance = EntityClass.instances[i - startIndex];
        if (instance && instance.despawn) {
          instance.despawn();
          despawnedCount++;
        } else {
          // Manual despawn if instance missing
          Transform.active[i] = 0;

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
}

// ES6 module export
export { GameObject };
