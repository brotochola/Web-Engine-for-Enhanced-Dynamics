// GameObject.js - Base class for all game entities using component composition
// Entities are composed of components (Transform, RigidBody, Collider, etc.)

import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import { collectComponents } from "./utils.js";
import Keyboard from "./Keyboard.js";
self.SpriteSheetRegistry = SpriteSheetRegistry;
// Export Keyboard for easy access (Mouse imported separately to avoid circular dep)
export { Keyboard };

export class GameObject {
  // Entity class metadata (for spawning system)
  static startIndex = 0; // Starting index in arrays for this entity type
  static totalCount = 0; // Total allocated entities of this type

  // Component composition - define which components this entity type has
  // Override in subclasses, e.g.: static components = [RigidBody, Collider, SpriteRenderer]
  static components = []; // By default, only Transform (added automatically)

  // Neighbor data (from spatial worker)
  static neighborData = null;
  static distanceData = null; // Squared distances for each neighbor

  // Entity type ID (auto-assigned during registration)
  // Note: entityType moved to Transform component for pure ECS architecture
  static entityType = null; // Numeric ID assigned by GameEngine

  static sharedBuffer = null; // For entity metadata (deprecated - kept for backward compat)
  static entityCount = 0;

  static instances = [];

  static getByIndex(index) {
    return this.instances[index];
  }

  /**
   * Initialize entity metadata from SharedArrayBuffer
   * DEPRECATED: Entity metadata now stored in components (Transform.entityType)
   * Kept for backward compatibility with neighbor data initialization
   *
   * @param {SharedArrayBuffer} buffer - Unused (deprecated)
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

    // NOTE: entityType moved to Transform component - no longer using this buffer
    // Kept for backward compatibility with neighbor data initialization

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
   * DEPRECATED: Returns 0 since metadata moved to components
   * @param {number} count - Number of entities
   * @returns {number} Buffer size in bytes (always 0 now)
   */
  static getBufferSize(count) {
    // Entity metadata moved to components (Transform.entityType)
    // No separate buffer needed anymore
    return 0;
  }

  /**
   * Collect all components from class hierarchy (delegates to utils.js)
   * Walks up the prototype chain and collects all unique components
   * @param {Class} EntityClass - The entity class to collect components from
   * @returns {Array<Component>} Array of unique component classes
   */
  static _collectComponents(EntityClass) {
    return collectComponents(EntityClass, GameObject, Transform);
  }

  /**
   * Constructor - stores entity index
   * @param {number} index - Entity index (unique across all entities)
   * @param {Object} config - Configuration object from GameEngine
   * @param {Object} logicWorker - Logic worker reference
   *
   * DENSE COMPONENT ALLOCATION:
   * All components are allocated for all entities. Entity index === component index.
   * This simplifies code: just use SpriteRenderer.property[entityIndex] directly.
   * Unused slots have default values (0/false).
   */
  constructor(index, config = {}, logicWorker = null) {
    this.index = index;
    this.config = config;
    this.logicWorker = logicWorker;

    // DENSE ALLOCATION: entityIndex === componentIndex for all components
    // Store which components this entity TYPE has (for validation)
    // Keys are stored in BOTH PascalCase and camelCase for easy lookup
    this._hasComponents = {};
    const entityComponents = collectComponents(
      this.constructor,
      GameObject,
      Transform
    );
    for (const ComponentClass of entityComponents) {
      const name = ComponentClass.name;
      const camelCaseName = name.charAt(0).toLowerCase() + name.slice(1);
      this._hasComponents[name] = true; // PascalCase: "RigidBody"
      this._hasComponents[camelCaseName] = true; // camelCase: "rigidBody"
    }

    // Set entityType in Transform component (auto-assigned during registration)
    Transform.entityType[index] = this.constructor.entityType || 0;

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

    // LIFECYCLE: Call setup() at the end of constructor
    // This allows subclasses to configure entity type properties
    // All components are now initialized and accessible
    if (this.setup) {
      this.setup();
    }
  }

  /**
   * Ensure component accessors are defined on the class prototype (called once per class)
   * This makes both core and custom components accessible via this.componentName
   */
  static _ensureComponentAccessors() {
    // Skip if already created for THIS SPECIFIC class (not inherited from parent)
    if (this.prototype.hasOwnProperty("_componentAccessorsCreated")) {
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

          // Check if this entity TYPE has this component
          if (!this._hasComponents[componentName]) {
            return null;
          }

          // DENSE ALLOCATION: entityIndex === componentIndex
          // Create and cache the component instance using entity index directly
          const instance = new ComponentClass(this.index);
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
    // DENSE: use this.index directly for all component access
    if (this._hasComponents.RigidBody) {
      RigidBody.px[this.index] = value;
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
    // DENSE: use this.index directly for all component access
    if (this._hasComponents.RigidBody) {
      RigidBody.py[this.index] = value;
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
   * DENSE: use this.index directly for component access
   */
  get vx() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.vx[this.index];
  }

  set vx(value) {
    if (this._hasComponents.RigidBody) {
      RigidBody.vx[this.index] = value;
    }
  }

  /**
   * Velocity Y - forwards to RigidBody (if entity has one)
   * DENSE: use this.index directly for component access
   */
  get vy() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.vy[this.index];
  }

  set vy(value) {
    if (this._hasComponents.RigidBody) {
      RigidBody.vy[this.index] = value;
    }
  }

  get entityType() {
    return Transform.entityType[this.index];
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

  /**
   * Set the spritesheet for this entity (for ANIMATED sprites)
   * After calling this, use setAnimation() to switch between animations
   *
   * @param {string} spritesheetName - Spritesheet name (e.g., "civil1", "civil2")
   *
   * @example
   * this.setSpritesheet("civil1");
   * this.setAnimation("walk_right");  // Uses civil1's walk_right animation
   * this.setAnimation("idle_down");   // Uses civil1's idle_down animation
   */
  setSpritesheet(spritesheetName) {
    if (!this.spriteRenderer) return;

    // Verify the spritesheet exists
    if (!SpriteSheetRegistry.spritesheets.has(spritesheetName)) {
      console.error(
        `❌ ${this.constructor.name}: Spritesheet "${spritesheetName}" not found. ` +
          `Available: ${Array.from(
            SpriteSheetRegistry.spritesheets.keys()
          ).join(", ")}`
      );
      return;
    }

    // Store which spritesheet to use (proxy sheet like civil1, civil2, etc.)
    const spritesheetId = SpriteSheetRegistry.getSpritesheetId(spritesheetName);
    if (spritesheetId === 0) {
      console.error(
        `${this.constructor.name}: Spritesheet "${spritesheetName}" not registered`
      );
      return;
    }
    this.spriteRenderer.spritesheetId = spritesheetId;

    // Mark as animated
    this.spriteRenderer.isAnimated = 1;

    this.markDirty();
  }

  /**
   * Set animation within the current spritesheet
   * Must call setSpritesheet() first to set the spritesheet
   *
   * PERFORMANCE: Uses global cache to avoid repeated lookups
   *
   * @param {string} animationName - Animation name (e.g., "walk_right", "idle_down")
   *
   * @example
   * this.setSpritesheet("civil1");
   * this.setAnimation("walk_right");  // Uses civil1's walk_right animation
   */
  setAnimation(animationName) {
    if (!this.spriteRenderer) return;

    // Get which spritesheet is currently set
    const spritesheetId = this.spriteRenderer.spritesheetId;
    if (!spritesheetId || spritesheetId === 0) {
      console.error(
        `❌ ${this.constructor.name}: Call setSpritesheet() before setAnimation(). ` +
          `Or use setSprite() for static sprites.`
      );
      return;
    }

    const spritesheet = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
    if (!spritesheet) {
      console.error(
        `❌ ${this.constructor.name}: Invalid spritesheetId ${spritesheetId}`
      );
      return;
    }

    // PERFORMANCE: Global cache keyed by "sheet:animName"
    if (!GameObject._globalAnimationCache) {
      GameObject._globalAnimationCache = {};
    }

    const cacheKey = `${spritesheet}:${animationName}`;
    let animIndex = GameObject._globalAnimationCache[cacheKey];

    if (animIndex === undefined) {
      // First time this animation is used - look it up via proxy
      animIndex = SpriteSheetRegistry.getAnimationIndex(
        spritesheet,
        animationName
      );

      if (animIndex === undefined) {
        // Animation not found
        const availableAnims = Object.keys(
          SpriteSheetRegistry.spritesheets.get(spritesheet)?.animations || {}
        );

        console.error(
          `❌ ${this.constructor.name}: Animation "${animationName}" not found in "${spritesheet}". ` +
            `Available: ${availableAnims.slice(0, 10).join(", ")}${
              availableAnims.length > 10 ? "..." : ""
            }`
        );
        return;
      }

      // Cache it globally
      GameObject._globalAnimationCache[cacheKey] = animIndex;
    }

    // Set the animation
    this.setAnimationState(animIndex);
  }

  /**
   * Set a STATIC sprite (single frame, non-animated)
   * Searches in bigAtlas.frames
   *
   * PERFORMANCE: Uses global cache to avoid repeated lookups
   *
   * @param {string} spriteName - Sprite/frame name (e.g., "bunny", "bg")
   *
   * @example
   * this.setSprite("bunny");  // For static sprites
   */
  setSprite(spriteName) {
    if (!this.spriteRenderer) return;

    // Static sprites use bigAtlas directly
    const sheetName = "bigAtlas";

    // PERFORMANCE: Global cache keyed by "bigAtlas:spriteName"
    if (!GameObject._globalAnimationCache) {
      GameObject._globalAnimationCache = {};
    }

    const cacheKey = `${sheetName}:${spriteName}`;
    let animIndex = GameObject._globalAnimationCache[cacheKey];

    if (animIndex === undefined) {
      // First time this sprite is used - look it up in bigAtlas
      animIndex = SpriteSheetRegistry.getAnimationIndex(sheetName, spriteName);

      if (animIndex === undefined) {
        // Sprite not found
        console.error(
          `❌ ${this.constructor.name}: Sprite "${spriteName}" not found in bigAtlas. ` +
            `Make sure it's included in your assets config.`
        );
        return;
      }

      // Cache it globally
      GameObject._globalAnimationCache[cacheKey] = animIndex;
    }

    // Store which spritesheet to use (bigAtlas for static sprites)
    const bigAtlasId = SpriteSheetRegistry.getSpritesheetId("bigAtlas");
    if (bigAtlasId === 0) {
      console.error(`❌ ${this.constructor.name}: bigAtlas not loaded yet`);
      return;
    }
    this.spriteRenderer.spritesheetId = bigAtlasId;

    // Mark as NOT animated (static sprite)
    this.spriteRenderer.isAnimated = 0;

    // Set the sprite (as a single-frame "animation")
    this.setAnimationState(animIndex); // This calls markDirty() internally
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
   * LIFECYCLE: Called at the END of constructor - runs ONCE per entity lifetime
   * Override in subclasses to configure entity TYPE properties
   * (physics params, flocking behavior, collision settings, sprite config, etc.)
   * All components are guaranteed to be initialized at this point
   *
   * Example:
   *   setup() {
   *     this.rigidBody.maxVel = 10;
   *     this.collider.radius = 15;
   *     this.flocking.centeringFactor = 0.001;
   *   }
   */
  setup() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called EVERY time entity is spawned from pool (or first spawn)
   * Override in subclasses to reset/initialize instance-specific state
   * (position, velocity, health, etc.)
   *
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   *
   * Example:
   *   onSpawned(spawnConfig) {
   *     this.x = spawnConfig.x ?? Math.random() * 800;
   *     this.y = spawnConfig.y ?? Math.random() * 600;
   *     this.health = 100;
   *     this.rigidBody.vx = 0;
   *     this.rigidBody.vy = 0;
   *   }
   */
  onSpawned(spawnConfig = {}) {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity is despawned (returned to pool)
   * Override in subclasses for cleanup, saving state, triggering effects, etc.
   *
   * Example:
   *   onDespawned() {
   *     this.saveStats();
   *     this.playDeathEffect();
   *     this.clearReferences();
   *   }
   */
  onDespawned() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity enters screen (becomes visible)
   * Override in subclasses to enable expensive behaviors only for visible entities
   *
   * Example:
   *   onScreenEnter() {
   *     this.enableParticles();
   *     this.startAnimations();
   *   }
   */
  onScreenEnter() {
    // Override in subclasses
  }

  /**
   * LIFECYCLE: Called when entity exits screen (becomes invisible)
   * Override in subclasses to disable expensive calculations for off-screen entities
   *
   * Example:
   *   onScreenExit() {
   *     this.disableParticles();
   *     this.pauseAnimations();
   *   }
   */
  onScreenExit() {
    // Override in subclasses
  }

  /**
   * Despawn this entity (return it to the inactive pool)
   * This is the proper way to deactivate an entity
   */
  despawn() {
    // Prevent double-despawn which corrupts the free list
    if (Transform.active[this.index] === 0) return;

    // LIFECYCLE: Call onDespawned() BEFORE deactivating
    // This allows cleanup, saving state, triggering effects, etc.
    if (this.onDespawned) {
      this.onDespawned();
    }

    Transform.active[this.index] = 0;

    // Return to free list if exists (O(1))
    const EntityClass = this.constructor;
    if (EntityClass.freeList) {
      EntityClass.freeList[++EntityClass.freeListTop] = this.index;
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
   * LIFECYCLE: Main update - called EVERY frame while entity is active
   * Override this in subclasses to define entity behavior
   * (AI, physics forces, animations, input handling, etc.)
   *
   * Note: this.neighbors and this.neighborCount are updated before this is called
   * Input is available via this.mouse and this.keyboard
   *
   * @param {number} dtRatio - Delta time ratio (1.0 = 16.67ms frame)
   *
   * Example:
   *   tick(dtRatio) {
   *     if (this.mouse.isDown) {
   *       this.runAwayFromMouse();
   *     }
   *     if (this.keyboard.w) {
   *       this.moveUp();
   *     }
   *   }
   */
  tick(dtRatio) {
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
   * Shuffles indices to distribute spawns evenly across worker ranges
   * @param {Class} EntityClass - The entity class to initialize
   */
  static initializeFreeList(EntityClass) {
    const count = EntityClass.totalCount;
    const startIndex = EntityClass.startIndex;

    // Create free list stack
    EntityClass.freeList = new Int32Array(count);
    EntityClass.freeListTop = count - 1;

    // CRITICAL: Interleave indices to distribute spawns evenly across logic workers
    // Instead of sequential [0,1,2,3,4,5,6,7,...] which fills last worker first,
    // Use round-robin distribution [0,8,16,...,1,9,17,...] to cycle through workers
    // This ensures first N spawns go to N different workers (perfect load balancing)

    // Assume 8 workers as a reasonable default for interleaving
    // (This works well regardless of actual worker count - just distributes more evenly)
    const interleaveFactor = 8;

    let writeIndex = 0;
    for (let offset = 0; offset < interleaveFactor; offset++) {
      for (let i = offset; i < count; i += interleaveFactor) {
        EntityClass.freeList[writeIndex++] = startIndex + i;
      }
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
    // BUGFIX: Use hasOwnProperty to prevent inheriting parent class's freeList
    // (e.g., Prey extends Boid - Prey should have its own freeList, not inherit Boid's)
    if (!EntityClass.hasOwnProperty("freeList")) {
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
      // CRITICAL: Initialize isItOnScreen to 1 so entity is visible immediately
      // The spatial worker will update this properly on its next frame
      instance.spriteRenderer.isItOnScreen = 1;
      // Reset sprite state to allow onSpawned() to set it fresh
      // NOTE: Don't reset spritesheetId/animationState here - let onSpawned() handle it
    }

    // Apply spawn config BEFORE activating
    // Uses clean property names: x, y, vx, vy, rotation, etc.
    for (const key in spawnConfig) {
      if (instance[key] !== undefined) {
        instance[key] = spawnConfig[key];
      }
    }

    // Initialize previous positions for Verlet integration
    if (instance.rigidBody && instance.transform) {
      instance.rigidBody.px = instance.transform.x - instance.rigidBody.vx;
      instance.rigidBody.py = instance.transform.y - instance.rigidBody.vy;
    }

    // LIFECYCLE: Call onSpawned() BEFORE activating
    // This allows entity to initialize instance state based on spawn config
    if (instance.onSpawned) {
      instance.onSpawned(spawnConfig);
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
