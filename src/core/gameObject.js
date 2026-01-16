// GameObject.js - Base class for all game entities using component composition
// Entities are composed of components (Transform, RigidBody, Collider, etc.)

import { Transform } from "../components/Transform.js";
import { RigidBody } from "../components/RigidBody.js";
import { Collider } from "../components/Collider.js";
import { SpriteRenderer } from "../components/SpriteRenderer.js";
import { LightEmitter } from "../components/LightEmitter.js";
import { ShadowCaster } from "../components/ShadowCaster.js";
import { SpriteSheetRegistry } from "./SpriteSheetRegistry.js";
import { Grid } from "./Grid.js";
import { collectComponents, cantorPair } from "./utils.js";
import Keyboard from "./Keyboard.js";
// Export Keyboard for easy access (Mouse imported separately to avoid circular dep)
// Note: SpriteSheetRegistry is registered globally in AbstractWorker.registerCoreClasses()
export { Keyboard, SpriteSheetRegistry };

export class GameObject {
  // Entity class metadata (for spawning system)
  static startIndex = 0; // Starting index in arrays for this entity type
  static poolSize = 0; // Allocated count for this entity type

  // Component composition - define which components this entity type has
  // Override in subclasses, e.g.: static components = [RigidBody, Collider, SpriteRenderer]
  static components = []; // By default, only Transform (added automatically)

  // Neighbor data (from spatial worker)
  static neighborData = null;
  static distanceData = null; // Squared distances for each neighbor

  // Camera data (shared with main thread)
  static cameraData = null; // Float32Array [zoom, x, y]

  // Entity type ID (auto-assigned during registration)
  // Note: entityType moved to Transform component for pure ECS architecture
  static entityType = null; // Numeric ID assigned by GameEngine

  static sharedBuffer = null; // For entity metadata (deprecated - kept for backward compat)
  static globalEntityCount = 0;

  static instances = [];

  get active() {
    return Transform.active[this.index];
  }
  set active(value) {
    Transform.active[this.index] = value;
  }
  static get(entityIndex) {
    return this.instances[entityIndex];
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
    this.globalEntityCount = count;

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
    // this.neighbors = null; // REMOVED: Subarray allocation causes GC stutter
    // this.neighborDistances = null; // REMOVED: GC stutter
    this._neighborOffset = 0; // Pointer-like offset into shared buffer

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
    if (this.spriteRenderer) {
      // Always update baseTint (the original color for lighting calculations)
      this.spriteRenderer.baseTint = tint;
      // Only update tint and mark dirty if value actually changed
      if (this.spriteRenderer.tint !== tint) {
        this.spriteRenderer.tint = tint;
        this.markDirty();
      }
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
    this.spriteRenderer.active = 1;
    this.spriteRenderer.renderVisible = 1;

    // Set the sprite (as a single-frame "animation")
    this.setAnimationState(animIndex); // This calls markDirty() internally
  }
  setAnchor(anchorX, anchorY) {
    if (this.spriteRenderer) {
      this.spriteRenderer.anchorX = anchorX;
      this.spriteRenderer.anchorY = anchorY;
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
   * Add acceleration to the entity
   * @param {number} x - Acceleration in the x direction
   * @param {number} y - Acceleration in the y direction
   */
  addAcceleration(x, y) {
    if (!this._hasComponents.RigidBody) return;
    RigidBody.ax[this.index] += x;
    RigidBody.ay[this.index] += y;
  }

  /**
   * Check if this entity is currently colliding with another entity
   * Only works in logic worker context where collision tracking is available.
   *
   * @param {number|GameObject} other - Entity index or GameObject instance to check
   * @returns {boolean} True if currently colliding, false otherwise
   *
   * @example
   *   if (this.isCollidingWith(playerIndex)) {
   *     this.takeDamage(10);
   *   }
   *
   *   // Or with an instance:
   *   if (this.isCollidingWith(player)) {
   *     player.collectItem(this);
   *   }
   */
  isCollidingWith(other) {
    // Get the other entity's index
    const otherIndex = typeof other === "number" ? other : other.index;

    // Access collision tracking from logic worker context
    // self.logicWorker is the LogicWorker instance in logic_worker.js
    const logicWorker = typeof self !== "undefined" ? self.logicWorker : null;
    if (!logicWorker || !logicWorker.currentCollisions) {
      return false;
    }

    // Use Cantor pairing function to generate collision key
    // Note: Both directions (A,B) and (B,A) are stored in currentCollisions
    const key = cantorPair(this.index, otherIndex);

    return logicWorker.currentCollisions.has(key);
  }

  /**
   * Despawn this entity (return it to the inactive pool)
   * This is the proper way to deactivate an entity
   */
  despawn() {
    // Prevent double-despawn which corrupts the free list
    if (Transform.active[this.index] === 0) return;

    // WORKER ROUTING: If we're in a logic worker that's not worker 0,
    // route the despawn request to worker 0 to keep freeList synchronized
    if (typeof self !== "undefined" && self.logicWorker) {
      if (self.logicWorker.workerIndex !== 0) {
        // LIFECYCLE: Call onDespawned() BEFORE deactivating
        if (this.onDespawned) {
          this.onDespawned();
        }

        // Immediately deactivate so entity stops being processed
        // (the active flag is in SharedArrayBuffer, visible to all workers)
        Transform.active[this.index] = 0;
        if (this.rigidBody) RigidBody.active[this.index] = 0;
        if (this.collider) Collider.active[this.index] = 0;
        if (this.spriteRenderer) SpriteRenderer.active[this.index] = 0;
        if (this.lightEmitter) LightEmitter.active[this.index] = 0;
        if (this.shadowCaster) ShadowCaster.active[this.index] = 0;

        // Route to worker 0 to update the freeList
        self.logicWorker.sendDataToWorker("logic0", {
          msg: "despawnRequest",
          entityIndex: this.index,
          className: this.constructor.name,
        });
        return;
      }
    }

    // LIFECYCLE: Call onDespawned() BEFORE deactivating
    // This allows cleanup, saving state, triggering effects, etc.
    if (this.onDespawned) {
      this.onDespawned();
    }

    // Deactivate all component active flags
    Transform.active[this.index] = 0;
    if (this.rigidBody) RigidBody.active[this.index] = 0;
    if (this.collider) Collider.active[this.index] = 0;
    if (this.spriteRenderer) SpriteRenderer.active[this.index] = 0;
    if (this.lightEmitter) LightEmitter.active[this.index] = 0;
    if (this.shadowCaster) ShadowCaster.active[this.index] = 0;

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
   * @param {Int32Array} neighborData - Precomputed neighbors from spatial worker (deprecated, uses Grid)
   * @param {Float32Array} distanceData - Precomputed squared distances from spatial worker (deprecated, uses Grid)
   */
  /**
   * Update neighbor references for this entity
   * Called by logic worker before tick() each frame
   *
   * OPTIMIZED: Receives pre-cached arrays from caller to avoid property lookups
   * @param {Int32Array} neighborData - Cached Grid.neighborData
   * @param {Float32Array} distanceData - Cached Grid.distanceData
   * @param {number} stride - Cached Grid._stride
   */
  updateNeighbors(neighborData, distanceData, stride) {
    // Fast path: arrays passed directly from caller (logic_worker caches them once)
    if (neighborData) {
      this._neighborData = neighborData;
      this._distanceData = distanceData;
      this._neighborOffset = this.index * stride;
      this.neighborCount = neighborData[this._neighborOffset];
      return;
    }

    // Fallback to legacy static arrays if no params passed
    if (GameObject.neighborData) {
      this._neighborData = GameObject.neighborData;
      this._distanceData = GameObject.distanceData;
      const maxNeighbors =
        this.config.spatial?.maxNeighbors || this.config.maxNeighbors || 100;
      this._neighborOffset = this.index * (1 + maxNeighbors);
      this.neighborCount = this._neighborData[this._neighborOffset];
      return;
    }

    this._neighborData = null;
    this._distanceData = null;
    this.neighborCount = 0;
  }

  /**
   * Get neighbor index at specific position
   * Zero-allocation replacement for this.neighbors[i]
   * Uses direct array access for performance (Grid data cached in updateNeighbors)
   * @param {number} i - Index (0 to this.neighborCount - 1)
   * @returns {number} Entity index of the neighbor
   */
  getNeighbor(i) {
    // Direct array access using cached offset (no method call overhead)
    if (this._neighborData) {
      return this._neighborData[this._neighborOffset + 1 + i];
    }
    // Fallback to legacy static arrays
    if (GameObject.neighborData) {
      return GameObject.neighborData[this._neighborOffset + 1 + i];
    }
    return -1;
  }

  /**
   * Get neighbor distance squared at specific position
   * Zero-allocation replacement for this.neighborDistances[i]
   * Uses direct array access for performance (Grid data cached in updateNeighbors)
   * @param {number} i - Index (0 to this.neighborCount - 1)
   * @returns {number} Squared distance to the neighbor
   */
  getNeighborDistance(i) {
    // Direct array access using cached offset (no method call overhead)
    if (this._distanceData) {
      return this._distanceData[this._neighborOffset + 1 + i];
    }
    // Fallback to legacy static arrays
    if (GameObject.distanceData) {
      return GameObject.distanceData[this._neighborOffset + 1 + i];
    }
    return 0;
  }

  /**
   * Get all neighbor IDs as an array
   * @returns {Int32Array} Typed array of neighbor entity indices (view into internal buffer)
   *
   * NOTE: Uses Grid.neighborData (live getter) to always read from the current stable
   * read buffer. This is safe for debugging/inspection from Chrome console.
   * For hot-path access during tick(), use getNeighborId(i) which uses cached pointers.
   */
  getAllNeighborIds() {
    // Use Grid.neighborData getter (not cached this._neighborData) to get current read buffer
    // This ensures we always read stable data, even when called from Chrome console
    const neighborData = Grid.neighborData;
    if (!neighborData) {
      return new Int32Array(0);
    }

    const stride = Grid._stride;
    const neighborOffset = this.index * stride;
    const count = neighborData[neighborOffset]; // Read count from current read buffer

    // Return a typed array view (zero-copy slice of the neighbor buffer)
    // Note: Int32Array elements are 4 bytes each
    return new Int32Array(
      neighborData.buffer,
      neighborData.byteOffset + (neighborOffset + 1) * 4,
      count
    );
  }

  /**
   * Get all neighbor instances as an array
   * @returns {GameObject[]} Array of neighbor GameObject instances
   *
   * NOTE: Uses Grid.neighborData (live getter) to always read from the current stable
   * read buffer. This is safe for debugging/inspection from Chrome console.
   */
  getAllNeighborInstances() {
    // Use Grid.neighborData getter (not cached this._neighborData) to get current read buffer
    const neighborData = Grid.neighborData;
    if (!neighborData) {
      return [];
    }

    const stride = Grid._stride;
    const neighborOffset = this.index * stride;
    const count = neighborData[neighborOffset]; // Read count from current read buffer

    const neighbors = new Array(count);
    const entities = GameObject.instances;

    let validCount = 0;
    for (let i = 0; i < count; i++) {
      const neighborId = neighborData[neighborOffset + 1 + i];
      if (neighborId >= 0 && neighborId < entities.length) {
        neighbors[validCount++] = entities[neighborId];
      }
    }

    // Trim array if some neighbors were invalid
    if (validCount < count) {
      neighbors.length = validCount;
    }

    return neighbors;
  }

  /**
   * ITERATION: Iterate over all neighbors of this entity
   * ZERO ALLOCATIONS - uses getNeighbor/getNeighborDistance directly
   *
   * @param {Function} callback - callback(neighborInstance, distance, neighborIndex)
   *   - neighborInstance: The neighbor's GameObject instance (or undefined if not in logic worker)
   *   - distance: Squared distance to the neighbor
   *   - neighborIndex: Entity index of the neighbor
   *
   * @example
   *   this.forEachNeighbor((neighbor, dist, idx) => {
   *     if (dist < 10000) { // within 100 units
   *       neighbor.takeDamage(10);
   *     }
   *   });
   */
  forEachNeighbor(callback) {
    const count = this.neighborCount;
    const instances = GameObject.instances;
    const neighborData = GameObject.neighborData;
    const distanceData = GameObject.distanceData;
    const offset = this._neighborOffset;

    for (let i = 0; i < count; i++) {
      const neighborIndex = neighborData[offset + 1 + i];
      const distance = distanceData ? distanceData[offset + 1 + i] : 0;
      const neighbor = instances ? instances[neighborIndex] : undefined;

      callback(neighbor, distance, neighborIndex);
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
   *
   * Uses interleaved index ordering to reduce CPU cache contention between
   * logic workers. See inline comments for details.
   *
   * @param {Class} EntityClass - The entity class to initialize
   */
  static initializeFreeList(EntityClass) {
    const count = EntityClass.poolSize;
    const startIndex = EntityClass.startIndex;

    // Create free list stack (LIFO - last written index is first to spawn)
    EntityClass.freeList = new Int32Array(count);
    EntityClass.freeListTop = count - 1;

    // INTERLEAVED SPAWNING: Scatter entity indices to reduce multi-core cache contention
    //
    // Problem with sequential ordering [0,1,2,3,4,5...]:
    //   - First N spawns cluster at indices 0 to N-1
    //   - Multiple workers process adjacent memory regions simultaneously
    //   - Causes L3 cache thrashing and memory bus contention between cores
    //   - Benchmarked: ~10% FPS loss with 4 logic workers
    //
    // Solution - interleaved ordering [0,8,16,24..., 1,9,17,25..., 2,10,18,26...]:
    //   - Spawned entities scatter across the full index range
    //   - Workers access different cache lines, reducing contention
    //   - Each job's active entities are spread out in memory
    //
    // Note: This is counter to single-threaded cache locality intuition.
    // For multi-threaded workloads, scattered access patterns reduce
    // inter-core contention on shared L3 cache and memory controller.
    const interleaveFactor = 8;

    // Build interleaved free list:
    // First loop (offset=0): writes indices 0, 8, 16, 24...
    // Second loop (offset=1): writes indices 1, 9, 17, 25...
    // etc.
    // Result: popping from stack yields 7, 15, 23... then 6, 14, 22... etc.
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
   * @returns {GameObject|null} - The spawned entity instance, or null if pool exhausted or routed to worker 0
   */
  static spawn(EntityClassOrConfig, spawnConfig = {}) {
    // Support two calling conventions:
    // 1. GameObject.spawn(EntityClass, config) - for dynamic class spawning
    // 2. Prey.spawn(config) - cleaner API when calling on the class directly
    let EntityClass;
    if (typeof EntityClassOrConfig === "function") {
      // Traditional: GameObject.spawn(EntityClass, config)
      EntityClass = EntityClassOrConfig;
    } else {
      // New: Prey.spawn(config) - use `this` as the EntityClass
      EntityClass = this;
      spawnConfig = EntityClassOrConfig || {};
    }

    // Validate EntityClass has required metadata
    if (
      EntityClass.startIndex === undefined ||
      EntityClass.poolSize === undefined
    ) {
      console.error(
        `Cannot spawn ${EntityClass.name}: missing startIndex/poolSize metadata. Was it registered with GameEngine?`
      );
      return null;
    }

    // WORKER ROUTING: If we're in a logic worker that's not worker 0,
    // route the spawn request to worker 0 to keep freeList synchronized
    if (typeof self !== "undefined" && self.logicWorker) {
      if (self.logicWorker.workerIndex !== 0) {
        // Route to worker 0 via MessagePort
        self.logicWorker.sendDataToWorker("logic0", {
          msg: "spawnRequest",
          className: EntityClass.name,
          spawnConfig: spawnConfig,
        });
        return null; // Async spawn - no instance returned immediately
      }
    }

    // Initialize free list if not exists (lazy init)
    // BUGFIX: Use hasOwnProperty to prevent inheriting parent class's freeList
    // (e.g., Prey extends Boid - Prey should have its own freeList, not inherit Boid's)
    if (!EntityClass.hasOwnProperty("freeList")) {
      GameObject.initializeFreeList(EntityClass);
    }

    // Check if pool is exhausted
    if (EntityClass.freeListTop < 0) {
      // console.warn(
      //   `No inactive ${EntityClass.name} available in pool! All ${EntityClass.poolSize} entities are active.`
      // );
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

    // Reset component values and set component active flags
    if (instance.rigidBody) {
      instance.rigidBody.active = 1; // Mark component as active for this entity
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

    if (instance.collider) {
      instance.collider.active = 1; // Mark component as active for this entity
    }

    if (instance.lightEmitter) {
      instance.lightEmitter.active = 1; // Mark component as active for this entity
    }

    if (instance.shadowCaster) {
      instance.shadowCaster.active = 1; // Mark component as active for this entity
    }

    if (instance.spriteRenderer) {
      instance.spriteRenderer.active = 1; // Mark component as active for this entity
      // Initialize both tint and baseTint to white (for lighting system)
      instance.spriteRenderer.tint = 0xffffff;
      instance.spriteRenderer.baseTint = 0xffffff;
      instance.setAlpha(1.0);
      instance.setScale(1, 1); // Default scale to 1 (Float32Array defaults to 0, making sprite invisible)
      instance.spriteRenderer.anchorX = 0.5;
      instance.spriteRenderer.anchorY = 1.0;
      instance.setVisible(true);
      // OPTIMIZATION: Initialize isItOnScreen to 0 (off-screen) like decorations
      // The spatial/particle worker will update this properly based on camera culling
      // This prevents eagerly creating sprites for entities that aren't visible yet
      instance.spriteRenderer.isItOnScreen = 0;
      // BUGFIX: Reset animationState to -1 so renderer's change detection will trigger
      // The renderer tracks previousAnimStates[] and skips updates when the value matches.
      // Without this reset, respawning an entity with the same sprite would not update the texture.
      instance.spriteRenderer.animationState = -1;
      instance.spriteRenderer.spritesheetId = 0;
      instance.markDirty();
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

    // AUTOMATION: Automatically initialize any FSM components
    // This allows developers to skip manual initialization in onSpawned()
    const entityComponentMap = EntityClass._componentClassMap || {};
    for (const name in entityComponentMap) {
      const ComponentClass = entityComponentMap[name];
      if (ComponentClass && ComponentClass.isFSM) {
        ComponentClass.initializeEntity(i, instance);
      }
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
      EntityClass.poolSize === undefined
    ) {
      return { total: 0, active: 0, available: 0 };
    }

    // If free list exists, use it for O(1) stats
    if (EntityClass.freeList) {
      const available = EntityClass.freeListTop + 1;
      return {
        total: EntityClass.poolSize,
        active: EntityClass.poolSize - available,
        available: available,
      };
    }

    // Fallback to linear search if free list not initialized
    const startIndex = EntityClass.startIndex;
    const total = EntityClass.poolSize;
    let activeCount = 0;

    for (let i = startIndex; i < EntityClass.endIndex; i++) {
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
      EntityClass.poolSize === undefined
    ) {
      return 0;
    }

    const startIndex = EntityClass.startIndex;
    const endIndex = EntityClass.endIndex;
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

  /**
   * ITERATION: Iterate over all ACTIVE entities of this class (index only)
   * Called on the entity class itself: Prey.forEachActive(i => ...)
   *
   * This is the FASTEST iteration method - no instance lookup, no conditionals.
   * Uses pre-computed entityIndices typed array for cache-friendly access.
   *
   * @example
   *   Prey.forEachActive(i => {
   *     Transform.x[i] += RigidBody.vx[i];
   *   });
   *
   * @param {Function} callback - callback(index) called for each active entity
   */
  static forEachActive(callback) {
    const indices = this.entityIndices;
    if (!indices) return;

    const active = Transform.active;
    const len = indices.length;

    for (let j = 0; j < len; j++) {
      const i = indices[j];
      if (active[i]) callback(i);
    }
  }

  /**
   * ITERATION: Iterate over ALL entities of this class (active or not)
   * Called on the entity class itself: Prey.forEachAll(i => ...)
   *
   * Useful for reset/cleanup operations where you need to touch every slot.
   * No active check - iterates the entire pool.
   *
   * @example
   *   // Reset all entities of this type
   *   Prey.forEachAll(i => {
   *     Transform.x[i] = 0;
   *     Transform.y[i] = 0;
   *   });
   *
   * @param {Function} callback - callback(index) called for each entity
   */
  static forEachAll(callback) {
    const indices = this.entityIndices;
    if (!indices) return;

    const len = indices.length;
    for (let j = 0; j < len; j++) {
      callback(indices[j]);
    }
  }

  /**
   * ITERATION: Iterate over ACTIVE entities with instance access (LOGIC WORKER ONLY)
   * Called on the entity class itself: Prey.forEachInstanceActive((prey, i) => ...)
   *
   * NOTE: Instances only exist in logic_worker.js. Use forEachActive() in other contexts.
   * ZERO ALLOCATIONS - inline loop, no closures.
   *
   * @example
   *   Prey.forEachInstanceActive((prey, i) => {
   *     prey.flee();
   *   });
   *
   * @param {Function} callback - callback(instance, index) for each active entity
   */
  static forEachInstanceActive(callback) {
    const indices = this.entityIndices;
    if (!indices) return;

    const active = Transform.active;
    const instances = this.instances;
    const len = indices.length;

    for (let j = 0; j < len; j++) {
      const i = indices[j];
      if (active[i]) {
        callback(instances ? instances[j] : undefined, i);
      }
    }
  }

  /**
   * ITERATION: Iterate over ALL entities with instance access (LOGIC WORKER ONLY)
   * Called on the entity class itself: Prey.forEachInstanceAll((prey, i) => ...)
   *
   * Useful for reset/cleanup operations where you need instance access.
   * No active check - iterates the entire pool.
   *
   * NOTE: Instances only exist in logic_worker.js. Use forEachAll() in other contexts.
   * ZERO ALLOCATIONS - inline loop, no closures.
   *
   * @example
   *   Prey.forEachInstanceAll((prey, i) => {
   *     prey.reset();
   *   });
   *
   * @param {Function} callback - callback(instance, index) for each entity
   */
  static forEachInstanceAll(callback) {
    const indices = this.entityIndices;
    if (!indices) return;

    const instances = this.instances;
    const len = indices.length;

    for (let j = 0; j < len; j++) {
      callback(instances ? instances[j] : undefined, indices[j]);
    }
  }

  /**
   * ITERATION: Get count of active entities of this class
   * Called on the entity class itself: Prey.activeCount
   *
   * @returns {number} Number of currently active entities
   */
  static get activeCount() {
    const EntityClass = this;

    if (
      EntityClass.startIndex === undefined ||
      EntityClass.poolSize === undefined
    ) {
      return 0;
    }

    // If free list exists, calculate from it (O(1))
    if (EntityClass.hasOwnProperty("freeList")) {
      return EntityClass.poolSize - (EntityClass.freeListTop + 1);
    }

    // Fallback: count active entities (O(n))
    const startIndex = EntityClass.startIndex;
    const endIndex = EntityClass.endIndex;
    let count = 0;

    for (let i = startIndex; i < endIndex; i++) {
      if (Transform.active[i]) {
        count++;
      }
    }

    return count;
  }
}
