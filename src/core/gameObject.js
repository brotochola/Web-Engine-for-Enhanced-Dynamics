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
   * @param {number} index - Entity index (unique across all entities)
   * @param {Object} componentIndices - Map of component indices { transform: N, rigidBody: N, ... }
   * @param {Object} config - Configuration object from GameEngine
   * @param {Object} logicWorker - Logic worker reference
   *
   * SPARSE COMPONENT ALLOCATION:
   * Component indices may differ from entity indices when entity types have different components.
   * Example: If 100 Balls (all components) are followed by 50 StaticWalls (no RigidBody),
   * then 50 Predators, the Predators' RigidBody indices start at 100, not 150.
   * This saves memory by only allocating space for components that entities actually use.
   */
  constructor(index, componentIndices = {}, config = {}, logicWorker = null) {
    this.index = index;
    this.config = config;
    this.logicWorker = logicWorker;

    // Store component indices for sparse allocation
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

    // Component instance cache (lazy-loaded on first access)
    this._componentCache = {};

    // Ensure component accessors are defined on prototype (done once per class)
    this.constructor._ensureComponentAccessors();
  }

  /**
   * Ensure component accessors are defined on the class prototype (called once per class)
   * This makes both core and custom components accessible via this.componentName
   */
  static _ensureComponentAccessors() {
    // Skip if already created for this class
    if (this.prototype._componentAccessorsCreated) {
      return;
    }

    // Core component class map
    const coreComponents = {
      transform: Transform,
      rigidBody: RigidBody,
      collider: Collider,
      spriteRenderer: SpriteRenderer,
    };

    // Get component class map from entity class (set during registration)
    const entityComponentMap = this._componentClassMap || {};

    // Define getters for all components this entity class uses
    for (const componentName of Object.keys(entityComponentMap)) {
      // Skip if getter already exists
      if (Object.getOwnPropertyDescriptor(this.prototype, componentName)) {
        continue;
      }

      const ComponentClass =
        entityComponentMap[componentName] || coreComponents[componentName];

      if (!ComponentClass) {
        continue;
      }

      // Define getter on prototype (shared by all instances)
      Object.defineProperty(this.prototype, componentName, {
        get: function () {
          // Return cached instance if exists
          if (this._componentCache[componentName]) {
            return this._componentCache[componentName];
          }

          // Get component index for this specific entity instance
          const componentIndex = this._componentIndices[componentName];
          if (componentIndex === undefined) {
            return null;
          }

          // Create and cache the component instance
          const instance = new ComponentClass(componentIndex);
          this._componentCache[componentName] = instance;
          return instance;
        },
        enumerable: true,
        configurable: true,
      });
    }

    // Mark as created
    this.prototype._componentAccessorsCreated = true;
  }

  // ========================================================================
  // ERGONOMIC API: Direct property access (forwards to components)
  // These provide convenient shortcuts while maintaining the component system
  // Note: Component accessors (this.transform, this.rigidBody, etc.) are now
  // dynamically created in _createComponentAccessors() for all components
  // ========================================================================

  /**
   * Position X - forwards to Transform
   * NOTE: Setting position also updates RigidBody.px to prevent Verlet velocity
   */
  get x() {
    return Transform.x[this.index];
  }

  set x(value) {
    Transform.x[this.index] = value;
    // Sync previous position for Verlet integration (prevents unwanted velocity)
    if (this._componentIndices.rigidBody !== undefined) {
      RigidBody.px[this._componentIndices.rigidBody] = value;
    }
  }

  /**
   * Position Y - forwards to Transform
   * NOTE: Setting position also updates RigidBody.py to prevent Verlet velocity
   */
  get y() {
    return Transform.y[this.index];
  }

  set y(value) {
    Transform.y[this.index] = value;
    // Sync previous position for Verlet integration (prevents unwanted velocity)
    if (this._componentIndices.rigidBody !== undefined) {
      RigidBody.py[this._componentIndices.rigidBody] = value;
    }
  }

  /**
   * Rotation - forwards to Transform
   */
  get rotation() {
    return Transform.rotation[this.index];
  }

  set rotation(value) {
    Transform.rotation[this.index] = value;
  }

  /**
   * Velocity X - forwards to RigidBody (if entity has one)
   */
  get vx() {
    if (this._componentIndices.rigidBody === undefined) return 0;
    return RigidBody.vx[this._componentIndices.rigidBody];
  }

  set vx(value) {
    if (this._componentIndices.rigidBody !== undefined) {
      RigidBody.vx[this._componentIndices.rigidBody] = value;
    }
  }

  /**
   * Velocity Y - forwards to RigidBody (if entity has one)
   */
  get vy() {
    if (this._componentIndices.rigidBody === undefined) return 0;
    return RigidBody.vy[this._componentIndices.rigidBody];
  }

  set vy(value) {
    if (this._componentIndices.rigidBody !== undefined) {
      RigidBody.vy[this._componentIndices.rigidBody] = value;
    }
  }

  // Component accessors are now dynamically created in _createComponentAccessors()
  // No need for hardcoded getters - works for both core and custom components!

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
