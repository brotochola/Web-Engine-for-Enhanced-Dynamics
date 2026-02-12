// GameObject.js - Base class for all game entities using component composition
// Entities are composed of components (Transform, RigidBody, Collider, etc.)

import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { Grid } from './Grid.js';
import { collectComponents, cantorPair, updateMassFromCircle, updateMassFromBox, distanceSq2D, convertRGBtoBGR, binarySearchInsertPoint, binarySearchFind } from './utils.js';
import Keyboard from './Keyboard.js';
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

  // Tick decimation - override in subclasses to reduce tick frequency
  // tickInterval = 10 means entity ticks every 10 frames (spread across frames via index offset)
  static tickInterval = 1; // Default: tick every frame (no decimation)

  // Neighbor data (from spatial worker)
  static neighborData = null;
  static distanceData = null; // Squared distances for each neighbor

  // Active entities list (built by particle_worker each frame)
  // Layout: [count, entityIdx0, entityIdx1, ...]
  static activeEntitiesData = null;

  // Tick decimation countdown (Uint8Array, one byte per entity)
  // Decremented each frame; entity ticks when it reaches 0, then resets to tickInterval
  static nextTick = null;

  // Camera data (shared with main thread)
  static cameraData = null; // Float32Array [zoom, x, y]

  // Entity type ID (auto-assigned during registration)
  // Note: entityType moved to Transform component for pure ECS architecture
  static entityType = null; // Numeric ID assigned by GameEngine

  static globalEntityCount = 0;

  static instances = [];

  static get(entityIndex) {
    return this.instances[entityIndex];
  }

  /**
   * Initialize GameObject static arrays and neighbor data buffers
   *
   * @param {SharedArrayBuffer} buffer - Unused (kept for API compatibility)
   * @param {number} count - Total number of entities
   * @param {SharedArrayBuffer} [neighborBuffer] - Neighbor data buffer from spatial worker
   * @param {SharedArrayBuffer} [distanceBuffer] - Distance data buffer from spatial worker
   * @param {SharedArrayBuffer} [nextTickBuffer] - Tick decimation countdown buffer (1 byte per entity)
   */
  static initializeArrays(
    buffer,
    count,
    neighborBuffer = null,
    distanceBuffer = null,
    nextTickBuffer = null
  ) {
    this.globalEntityCount = count;

    // Initialize neighbor data if provided
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    if (neighborBuffer) {
      this.neighborData = new Uint16Array(neighborBuffer);
    }

    // Initialize distance data if provided
    if (distanceBuffer) {
      this.distanceData = new Float32Array(distanceBuffer);
    }

    // Initialize tick decimation buffer if provided (staggeredUpdates enabled)
    if (nextTickBuffer) {
      this.nextTick = new Uint8Array(nextTickBuffer);
    }
  }

  /**
   * Calculate buffer size needed for GameObject metadata
   * @param {number} count - Number of entities
   * @returns {number} Buffer size in bytes (0 - no dedicated buffer needed)
   */
  static getBufferSize(count) {
    return 0;
  }

  // ===========================================================================
  // INCREMENTAL ACTIVE ENTITY MANAGEMENT
  // These methods maintain activeEntitiesData and query buffers incrementally
  // on spawn/despawn instead of rebuilding every frame
  // Lists are kept sorted by entity index for:
  // - Better cache locality during iteration (sequential memory access)
  // - O(log n) binary search for range queries
  // - Deterministic iteration order regardless of spawn order
  // ===========================================================================

  /**
   * Add an entity to activeEntitiesData (sorted insert)
   * Called from spawn() after entity activation
   * @param {number} entityIndex - The entity index to add
   */
  static _addToActiveEntities(entityIndex) {
    const data = this.activeEntitiesData;
    if (!data) return;

    const count = data[0];
    const insertPos = binarySearchInsertPoint(data, entityIndex, count);

    // Shift elements right to make room
    for (let i = count; i >= insertPos; i--) {
      data[i + 1] = data[i];
    }

    data[insertPos] = entityIndex;
    data[0] = count + 1;
  }

  /**
   * Remove an entity from activeEntitiesData (binary search + shift)
   * Called from despawn() before entity deactivation
   * @param {number} entityIndex - The entity index to remove
   */
  static _removeFromActiveEntities(entityIndex) {
    const data = this.activeEntitiesData;
    if (!data) return;

    const count = data[0];
    if (count === 0) return;

    const pos = binarySearchFind(data, entityIndex, count);
    if (pos === -1) return;

    // Shift elements left to fill gap
    for (let i = pos; i < count; i++) {
      data[i] = data[i + 1];
    }
    data[0] = count - 1;
  }

  /**
   * Batch remove entities from activeEntitiesData (single-pass compaction)
   * Much faster than individual removals when despawning many entities: O(n) vs O(k*n)
   * @param {Set<number>} indicesToRemove - Set of entity indices to remove
   */
  static _batchRemoveFromActiveEntities(indicesToRemove) {
    const data = this.activeEntitiesData;
    if (!data || indicesToRemove.size === 0) return;

    const count = data[0];
    if (count === 0) return;

    // Single-pass compaction: copy non-removed elements to front
    let writePos = 1;
    for (let readPos = 1; readPos <= count; readPos++) {
      const entityIndex = data[readPos];
      if (!indicesToRemove.has(entityIndex)) {
        data[writePos++] = entityIndex;
      }
    }
    data[0] = writePos - 1;
  }

  /**
   * Get the current worker context (works from any worker type)
   * @returns {Object|null} Worker instance with query system data, or null
   */
  static _getWorkerContext() {
    if (typeof self === 'undefined') return null;
    // Try different worker types - whichever is defined
    return self.logicWorker || self.particleWorker || self.pixiRenderer || self.physicsWorker || self.spatialWorker || null;
  }

  /**
   * Add an entity to all matching precomputed query buffers (sorted insert)
   * Called from spawn() after entity activation
   * @param {number} entityIndex - The entity index to add
   * @param {number} entityType - The entity's type ID
   */
  static _addToMatchingQueries(entityIndex, entityType) {
    // Access query system from worker context (works from any worker type)
    const worker = this._getWorkerContext();
    if (!worker || !worker._queryResultViews || !worker._precomputedQueries || !worker._queryEntityMetadata) {
      return;
    }

    const entityMeta = worker._queryEntityMetadata[entityType];
    if (!entityMeta) return;

    const componentMask = entityMeta.componentMask;

    // Check each precomputed query
    for (let q = 0; q < worker._precomputedQueries.length; q++) {
      const query = worker._precomputedQueries[q];

      // Entity matches query if it has ALL required components
      if ((componentMask & query.queryMask) === query.queryMask) {
        const resultView = worker._queryResultViews[q];
        const count = resultView[0];
        const insertPos = binarySearchInsertPoint(resultView, entityIndex, count);

        for (let i = count; i >= insertPos; i--) {
          resultView[i + 1] = resultView[i];
        }

        resultView[insertPos] = entityIndex;
        resultView[0] = count + 1;
      }
    }
  }

  /**
   * Remove an entity from all matching precomputed query buffers (binary search + shift)
   * Called from despawn() before entity deactivation
   * @param {number} entityIndex - The entity index to remove
   * @param {number} entityType - The entity's type ID
   */
  static _removeFromMatchingQueries(entityIndex, entityType) {
    // Access query system from worker context (works from any worker type)
    const worker = this._getWorkerContext();
    if (!worker || !worker._queryResultViews || !worker._precomputedQueries || !worker._queryEntityMetadata) {
      return;
    }

    const entityMeta = worker._queryEntityMetadata[entityType];
    if (!entityMeta) return;

    const componentMask = entityMeta.componentMask;

    // Check each precomputed query
    for (let q = 0; q < worker._precomputedQueries.length; q++) {
      const query = worker._precomputedQueries[q];

      // Entity matches query if it has ALL required components
      if ((componentMask & query.queryMask) === query.queryMask) {
        const resultView = worker._queryResultViews[q];
        const count = resultView[0];
        const pos = binarySearchFind(resultView, entityIndex, count);

        if (pos !== -1) {
          for (let i = pos; i < count; i++) {
            resultView[i] = resultView[i + 1];
          }
          resultView[0] = count - 1;
        }
      }
    }
  }

  /**
   * Remove an entity from its type's active list (binary search + shift)
   * Called from despawn() before entity deactivation
   * @param {Class} EntityClass - The entity's class
   * @param {number} entityIndex - The entity index to remove
   */
  static _removeFromTypeActiveList(EntityClass, entityIndex) {
    const typeList = EntityClass._activeList;
    if (!typeList) return;

    const count = typeList[0];
    if (count === 0) return;

    const pos = binarySearchFind(typeList, entityIndex, count);
    if (pos !== -1) {
      for (let i = pos; i < count; i++) {
        typeList[i] = typeList[i + 1];
      }
      typeList[0] = count - 1;
    }
  }

  /**
   * Clear an entity type's active list (O(1))
   * Used by despawnAll when removing ALL entities of a type
   * @param {Class} EntityClass - The entity's class
   */
  static _clearTypeActiveList(EntityClass) {
    const typeList = EntityClass._activeList;
    if (typeList) {
      typeList[0] = 0;
    }
  }

  /**
   * Batch remove entities from all matching query buffers (single-pass compaction)
   * Much faster than individual removals: O(n * queries) vs O(k * n * queries)
   * @param {Set<number>} indicesToRemove - Set of entity indices to remove
   * @param {number} entityType - The entity type ID (all indices must be same type)
   */
  static _batchRemoveFromMatchingQueries(indicesToRemove, entityType) {
    if (indicesToRemove.size === 0) return;

    const worker = this._getWorkerContext();
    if (!worker || !worker._queryResultViews || !worker._precomputedQueries || !worker._queryEntityMetadata) {
      return;
    }

    const entityMeta = worker._queryEntityMetadata[entityType];
    if (!entityMeta) return;

    const componentMask = entityMeta.componentMask;

    // For each matching query, do single-pass compaction
    for (let q = 0; q < worker._precomputedQueries.length; q++) {
      const query = worker._precomputedQueries[q];

      if ((componentMask & query.queryMask) === query.queryMask) {
        const resultView = worker._queryResultViews[q];
        const count = resultView[0];
        if (count === 0) continue;

        // Single-pass compaction
        let writePos = 1;
        for (let readPos = 1; readPos <= count; readPos++) {
          const entityIndex = resultView[readPos];
          if (!indicesToRemove.has(entityIndex)) {
            resultView[writePos++] = entityIndex;
          }
        }
        resultView[0] = writePos - 1;
      }
    }
  }

  /**
   * Add an entity to its type's active list (sorted insert)
   * Called from spawn() after entity activation
   * @param {Class} EntityClass - The entity's class
   * @param {number} entityIndex - The entity index to add
   */
  static _addToTypeActiveList(EntityClass, entityIndex) {
    const typeList = EntityClass._activeList;
    if (!typeList) return;

    const count = typeList[0];
    const insertPos = binarySearchInsertPoint(typeList, entityIndex, count);

    for (let i = count; i >= insertPos; i--) {
      typeList[i + 1] = typeList[i];
    }

    typeList[insertPos] = entityIndex;
    typeList[0] = count + 1;
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
    const entityComponents = collectComponents(this.constructor, GameObject, Transform);
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
    // this._neighbors = null; // REMOVED: Subarray allocation causes GC stutter
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
    if (this.prototype.hasOwnProperty('_componentAccessorsCreated')) {
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

      const ComponentClass = entityComponentMap[componentName] || coreComponents[componentName];

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
          instance.owner = this; // Store owner reference for instance methods
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

  // ═══════════════════════════════════════════════════════════════════════════
  // PROPERTY ACCESSORS (GETTERS & SETTERS)
  // Grouped by component: Transform → RigidBody → SpriteRenderer → Collider
  // ═══════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSFORM PROPERTIES
  // ─────────────────────────────────────────────────────────────────────────────

  /** Active state - whether entity is spawned and processing */
  get active() {
    return Transform.active[this.index];
  }
  set active(value) {
    Transform.active[this.index] = value;
  }

  /** Entity type ID (read-only, set during registration) */
  get entityType() {
    return Transform.entityType[this.index];
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
    if (this._hasComponents.RigidBody) {
      RigidBody.py[this.index] = value;
    }
  }

  /** Rotation in radians */
  get rotation() {
    return Transform.rotation[this.index];
  }
  set rotation(value) {
    Transform.rotation[this.index] = value;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RIGIDBODY PROPERTIES
  // ─────────────────────────────────────────────────────────────────────────────

  /** Velocity X - returns 0 if entity has no RigidBody */
  get vx() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.vx[this.index];
  }
  set vx(value) {
    if (this._hasComponents.RigidBody) {
      RigidBody.vx[this.index] = value;
      // Sync previous position for Verlet: physics computes velocity as (x - px)
      RigidBody.px[this.index] = Transform.x[this.index] - value;
    }
  }

  /** Velocity Y - returns 0 if entity has no RigidBody */
  get vy() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.vy[this.index];
  }
  set vy(value) {
    if (this._hasComponents.RigidBody) {
      RigidBody.vy[this.index] = value;
      // Sync previous position for Verlet: physics computes velocity as (y - py)
      RigidBody.py[this.index] = Transform.y[this.index] - value;
    }
  }

  /** Speed (magnitude of velocity) - read-only, computed by physics worker */
  get speed() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.speed[this.index];
  }

  /** Velocity angle in radians - read-only, computed by physics worker */
  get velocityAngle() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.velocityAngle[this.index];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SPRITERENDERER PROPERTIES
  // Setters mark dirty for re-rendering. Both setter and method provided.
  // ─────────────────────────────────────────────────────────────────────────────

  /** Alpha (opacity) 0-1 */
  get alpha() {
    if (!this._hasComponents.SpriteRenderer) return 1;
    return SpriteRenderer.alpha[this.index];
  }
  set alpha(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    if (SpriteRenderer.alpha[this.index] !== value) {
      SpriteRenderer.alpha[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Tint color (0xRRGGBB) */
  get tint() {
    if (!this._hasComponents.SpriteRenderer) return 0xffffff;
    return SpriteRenderer.baseTint[this.index]; // Return user-facing RGB value
  }
  set tint(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    SpriteRenderer.baseTint[this.index] = value; // Store RGB for lighting/user access
    const bgrValue = convertRGBtoBGR(value); // Convert RGB→BGR for PixiJS
    if (SpriteRenderer.tint[this.index] !== bgrValue) {
      SpriteRenderer.tint[this.index] = bgrValue;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Visibility flag */
  get visible() {
    if (!this._hasComponents.SpriteRenderer) return false;
    return SpriteRenderer.renderVisible[this.index] === 1;
  }
  set visible(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    const v = value ? 1 : 0;
    if (SpriteRenderer.renderVisible[this.index] !== v) {
      SpriteRenderer.renderVisible[this.index] = v;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Scale X */
  get scaleX() {
    if (!this._hasComponents.SpriteRenderer) return 1;
    return SpriteRenderer.scaleX[this.index];
  }
  set scaleX(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    if (SpriteRenderer.scaleX[this.index] !== value) {
      SpriteRenderer.scaleX[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Scale Y */
  get scaleY() {
    if (!this._hasComponents.SpriteRenderer) return 1;
    return SpriteRenderer.scaleY[this.index];
  }
  set scaleY(value) {
    if (!this._hasComponents.SpriteRenderer) return;
    if (SpriteRenderer.scaleY[this.index] !== value) {
      SpriteRenderer.scaleY[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Is entity currently on screen? Read-only, set by culling system */
  get isOnScreen() {
    if (!this._hasComponents.SpriteRenderer) return false;
    return SpriteRenderer.isItOnScreen[this.index] === 1;
  }

  /** Anchor X (0-1, 0.5 = center) - read-only, use setAnchor() */
  get anchorX() {
    if (!this._hasComponents.SpriteRenderer) return 0.5;
    return SpriteRenderer.anchorX[this.index];
  }

  /** Anchor Y (0-1, 1.0 = bottom) - read-only, use setAnchor() */
  get anchorY() {
    if (!this._hasComponents.SpriteRenderer) return 1.0;
    return SpriteRenderer.anchorY[this.index];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COLLIDER PROPERTIES
  // ─────────────────────────────────────────────────────────────────────────────

  /** Collision radius - also auto-computes mass from area (π * r²) */
  get radius() {
    if (!this._hasComponents.Collider) return 0;
    return Collider.radius[this.index];
  }

  set radius(value) {
    if (!this._hasComponents.Collider) return;
    Collider.radius[this.index] = value;
    if (this._hasComponents.RigidBody) {
      updateMassFromCircle(this.index, value, RigidBody);
    }
  }

  /** Collider width - also auto-computes mass from area (width * height) */
  get width() {
    if (!this._hasComponents.Collider) return 0;
    return Collider.width[this.index];
  }
  set width(value) {
    if (!this._hasComponents.Collider) return;
    Collider.width[this.index] = value;
    if (this._hasComponents.RigidBody) {
      const h = Collider.height[this.index] || 1;
      updateMassFromBox(this.index, value, h, RigidBody);
    }
  }

  /** Collider height - also auto-computes mass from area (width * height) */
  get height() {
    if (!this._hasComponents.Collider) return 0;
    return Collider.height[this.index];
  }
  set height(value) {
    if (!this._hasComponents.Collider) return;
    Collider.height[this.index] = value;
    if (this._hasComponents.RigidBody) {
      const w = Collider.width[this.index] || 1;
      updateMassFromBox(this.index, w, value, RigidBody);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METHODS - RENDERING (mark dirty)
  // Methods duplicate setter logic for zero-overhead when using method syntax
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Mark sprite as needing re-render
   */
  markDirty() {
    if (this._hasComponents.SpriteRenderer) {
      SpriteRenderer.renderDirty[this.index] = 1;
    }
  }

  /**
   * Set alpha (opacity)
   * @param {number} value - Alpha 0-1
   * @returns {this} For chaining
   */
  setAlpha(value) {
    if (!this._hasComponents.SpriteRenderer) return this;
    if (SpriteRenderer.alpha[this.index] !== value) {
      SpriteRenderer.alpha[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set tint color
   * @param {number} value - Color as 0xRRGGBB
   * @returns {this} For chaining
   */
  setTint(value) {
    if (!this._hasComponents.SpriteRenderer) return this;
    SpriteRenderer.baseTint[this.index] = value; // Store RGB for lighting/user access
    const bgrValue = convertRGBtoBGR(value); // Convert RGB→BGR for PixiJS
    if (SpriteRenderer.tint[this.index] !== bgrValue) {
      SpriteRenderer.tint[this.index] = bgrValue;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set visibility
   * @param {boolean} value - Visible or not
   * @returns {this} For chaining
   */
  setVisible(value) {
    if (!this._hasComponents.SpriteRenderer) return this;
    const v = value ? 1 : 0;
    if (SpriteRenderer.renderVisible[this.index] !== v) {
      SpriteRenderer.renderVisible[this.index] = v;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set scale (uniform or non-uniform)
   * @param {number} x - Scale X
   * @param {number} [y] - Scale Y (defaults to x for uniform scale)
   * @returns {this} For chaining
   */
  setScale(x, y) {
    if (!this._hasComponents.SpriteRenderer) return this;
    const yVal = y !== undefined ? y : x;
    let changed = false;
    if (SpriteRenderer.scaleX[this.index] !== x) {
      SpriteRenderer.scaleX[this.index] = x;
      changed = true;
    }
    if (SpriteRenderer.scaleY[this.index] !== yVal) {
      SpriteRenderer.scaleY[this.index] = yVal;
      changed = true;
    }
    if (changed) {
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set anchor point
   * @param {number} x - Anchor X (0-1)
   * @param {number} y - Anchor Y (0-1)
   * @returns {this} For chaining
   */
  setAnchor(x, y) {
    if (!this._hasComponents.SpriteRenderer) return this;
    SpriteRenderer.anchorX[this.index] = x;
    SpriteRenderer.anchorY[this.index] = y;
    SpriteRenderer.renderDirty[this.index] = 1;
    return this;
  }

  /**
   * Set animation state index
   * @param {number} state - Animation state index
   * @returns {this} For chaining
   */
  setAnimationState(state) {
    if (!this._hasComponents.SpriteRenderer) return this;
    if (SpriteRenderer.animationState[this.index] !== state) {
      SpriteRenderer.animationState[this.index] = state;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /**
   * Set animation speed multiplier
   * @param {number} speed - Animation speed (1.0 = normal)
   * @returns {this} For chaining
   */
  setAnimationSpeed(speed) {
    if (!this._hasComponents.SpriteRenderer) return this;
    if (SpriteRenderer.animationSpeed[this.index] !== speed) {
      SpriteRenderer.animationSpeed[this.index] = speed;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // METHODS - PHYSICS (batch operations)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set position (batch update, syncs previous position for Verlet)
   * @param {number} x - Position X
   * @param {number} y - Position Y
   * @returns {this} For chaining
   */
  setPosition(x, y) {
    Transform.x[this.index] = x;
    Transform.y[this.index] = y;
    if (this._hasComponents.RigidBody) {
      RigidBody.px[this.index] = x;
      RigidBody.py[this.index] = y;
    }
    return this;
  }

  /**
   * Set velocity (absolute)
   * Syncs previous position for Verlet integration (physics computes vel from x - px)
   * @param {number} vx - Velocity X
   * @param {number} vy - Velocity Y
   * @returns {this} For chaining
   */
  setVelocity(vx, vy) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      RigidBody.vx[i] = vx;
      RigidBody.vy[i] = vy;
      // Sync previous position for Verlet: physics computes velocity as (pos - prev)
      RigidBody.px[i] = Transform.x[i] - vx;
      RigidBody.py[i] = Transform.y[i] - vy;
    }
    return this;
  }

  accelerateTowards(x, y, acc) {
    if (!this._hasComponents.RigidBody) return this;
    const i = this.index;
    const dx = x - Transform.x[i];
    const dy = y - Transform.y[i];
    const distSq = dx * dx + dy * dy;
    // Guard: distSq must be > 1 to avoid division issues
    if (distSq > 1) {
      const factor = acc / Math.sqrt(distSq);
      return this.addAcceleration(dx * factor, dy * factor);
    }
    return this;
  }

  /**
   * Add to velocity (additive)
   * Syncs previous position for Verlet integration
   * @param {number} dvx - Velocity X to add
   * @param {number} dvy - Velocity Y to add
   * @returns {this} For chaining
   */
  addVelocity(dvx, dvy) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      const newVx = RigidBody.vx[i] + dvx;
      const newVy = RigidBody.vy[i] + dvy;
      RigidBody.vx[i] = newVx;
      RigidBody.vy[i] = newVy;
      // Sync previous position for Verlet
      RigidBody.px[i] = Transform.x[i] - newVx;
      RigidBody.py[i] = Transform.y[i] - newVy;
    }
    return this;
  }

  /**
   * Scale velocity (multiplicative) - useful for friction/drag
   * Syncs previous position for Verlet integration
   * @param {number} factor - Multiplier (0.95 = 5% friction)
   * @returns {this} For chaining
   */
  scaleVelocity(factor) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      const newVx = RigidBody.vx[i] * factor;
      const newVy = RigidBody.vy[i] * factor;
      RigidBody.vx[i] = newVx;
      RigidBody.vy[i] = newVy;
      // Sync previous position for Verlet
      RigidBody.px[i] = Transform.x[i] - newVx;
      RigidBody.py[i] = Transform.y[i] - newVy;
    }
    return this;
  }

  /**
   * Add acceleration (additive) - applied by physics integration
   * @param {number} x - Acceleration X
   * @param {number} y - Acceleration Y
   * @returns {this} For chaining
   */
  addAcceleration(x, y) {
    if (this._hasComponents.RigidBody) {
      RigidBody.ax[this.index] += x;
      RigidBody.ay[this.index] += y;
    }
    return this;
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
        `Available: ${Array.from(SpriteSheetRegistry.spritesheets.keys()).join(', ')}`
      );
      return;
    }

    // Store which spritesheet to use (proxy sheet like civil1, civil2, etc.)
    const spritesheetId = SpriteSheetRegistry.getSpritesheetId(spritesheetName);
    if (spritesheetId === 0) {
      console.error(`${this.constructor.name}: Spritesheet "${spritesheetName}" not registered`);
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
  setAnimation(animationName, loop = true) {
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
      console.error(`❌ ${this.constructor.name}: Invalid spritesheetId ${spritesheetId}`);
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
      animIndex = SpriteSheetRegistry.getAnimationIndex(spritesheet, animationName);

      if (animIndex === undefined) {
        // Animation not found
        const availableAnims = Object.keys(
          SpriteSheetRegistry.spritesheets.get(spritesheet)?.animations || {}
        );

        console.error(
          `❌ ${this.constructor.name}: Animation "${animationName}" not found in "${spritesheet}". ` +
          `Available: ${availableAnims.slice(0, 10).join(', ')}${availableAnims.length > 10 ? '...' : ''
          }`
        );
        return;
      }

      // Cache it globally
      GameObject._globalAnimationCache[cacheKey] = animIndex;
    }

    // Set the animation and loop flag
    this.setAnimationState(animIndex);
    SpriteRenderer.loop[this.index] = loop ? 1 : 0;
  }

  /**
   * Set animation loop behavior
   * @param {boolean} loop - Whether the animation should loop (true) or play once (false)
   * @returns {this} For chaining
   */
  setAnimationLoop(loop) {
    if (!this._hasComponents.SpriteRenderer) return this;
    SpriteRenderer.loop[this.index] = loop ? 1 : 0;
    return this;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATIC SPRITE METHODS
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Use setSprite() to display a STATIC (non-animated) texture on an entity.
  // This is different from setSpritesheet() + setAnimation() which is for animated sprites.
  //
  // WHAT CAN BE DISPLAYED:
  // 1. Static textures from assets.textures: "rock1", "blood", "smoke"
  // 2. Prefixed animation names: "civil1_hurt" (displays first frame)
  // 3. Specific animation frames: "civil1_hurt_5" (displays exact frame)
  // 4. Resolved frame names: Use helper params (spritesheet, animation, frameIndex)
  //
  // All of these are entries in the bigAtlas - they're treated uniformly.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set the sprite for this entity (for STATIC/non-animated display).
   *
   * USAGE PATTERNS:
   *
   * 1. Static texture (from assets.textures):
   *    ```js
   *    this.setSprite("rock1");
   *    this.setSprite("blood");
   *    ```
   *
   * 2. Specific frame by name (if you know the exact frame name):
   *    ```js
   *    this.setSprite("civil1_hurt_5");  // Last frame of hurt animation
   *    ```
   *
   * 3. Specific frame by parameters (recommended for animation frames):
   *    ```js
   *    this.setSprite("civil1", "hurt", -1);  // -1 = last frame
   *    this.setSprite("civil1", "walk_down", 0);  // 0 = first frame
   *    ```
   *
   * PERFORMANCE: Uses global cache to avoid repeated lookups.
   * String resolution happens ONCE per unique sprite, then cached.
   *
   * @param {string} spriteNameOrSheet - Sprite/frame name OR spritesheet name (if using params)
   * @param {string} [animation] - Animation name (only when using spritesheet param)
   * @param {number} [frameIndex=0] - Frame index within animation (0 = first, -1 = last)
   * @returns {this} For chaining
   *
   * @example
   * // Static texture
   * this.setSprite("rock1");
   *
   * @example
   * // Specific frame of an animation (for dead body decal, etc.)
   * this.setSprite("civil1", "hurt", -1);  // Last frame of hurt animation
   *
   * @example
   * // Direct frame name (if you already have it)
   * this.setSprite("civil1_hurt_5");
   */
  setSprite(spriteNameOrSheet, animation, frameIndex) {
    if (!this.spriteRenderer) return this;

    // Resolve the sprite name based on which parameters were provided
    let spriteName;

    if (animation !== undefined) {
      // Parameters provided: (spritesheet, animation, frameIndex)
      // Resolve to the actual frame name in bigAtlas
      spriteName = SpriteSheetRegistry.getFrameName(spriteNameOrSheet, animation, frameIndex ?? 0);

      if (!spriteName) {
        console.error(
          `❌ ${this.constructor.name}: Could not resolve frame for ` +
          `spritesheet="${spriteNameOrSheet}", animation="${animation}", frameIndex=${frameIndex ?? 0}`
        );
        return this;
      }
    } else {
      // Single parameter: direct sprite/frame name
      spriteName = spriteNameOrSheet;
    }

    // Static sprites use bigAtlas directly
    const sheetName = 'bigAtlas';

    // PERFORMANCE: Global cache keyed by "bigAtlas:spriteName"
    // Avoids repeated registry lookups for the same sprite
    if (!GameObject._globalAnimationCache) {
      GameObject._globalAnimationCache = {};
    }

    const cacheKey = `${sheetName}:${spriteName}`;
    let animIndex = GameObject._globalAnimationCache[cacheKey];

    if (animIndex === undefined) {
      // First time this sprite is used - look it up in bigAtlas
      animIndex = SpriteSheetRegistry.getAnimationIndex(sheetName, spriteName);

      if (animIndex === undefined) {
        // Sprite not found - provide helpful error message
        console.error(
          `❌ ${this.constructor.name}: Sprite "${spriteName}" not found in bigAtlas. ` +
          `Make sure it's included in your assets config (textures or spritesheets).`
        );
        return this;
      }

      // Cache it globally for future use
      GameObject._globalAnimationCache[cacheKey] = animIndex;
    }

    // Store which spritesheet to use (bigAtlas for static sprites)
    const bigAtlasId = SpriteSheetRegistry.getSpritesheetId('bigAtlas');
    if (bigAtlasId === 0) {
      console.error(`❌ ${this.constructor.name}: bigAtlas not loaded yet`);
      return this;
    }
    this.spriteRenderer.spritesheetId = bigAtlasId;

    // Mark as NOT animated (static sprite - displays single frame)
    this.spriteRenderer.isAnimated = 0;
    this.spriteRenderer.active = 1;
    this.spriteRenderer.renderVisible = 1;

    // Set the sprite (as a single-frame "animation")
    this.setAnimationState(animIndex); // This calls markDirty() internally

    return this;
  }
  /**
   * Helper method to send sprite property changes to renderer
   */
  setSpriteProp(prop, value) {
    if (this.logicWorker) {
      this.logicWorker.sendDataToWorker('renderer', {
        cmd: 'setProp',
        entityId: this.index,
        prop: prop,
        value: value,
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
    const otherIndex = typeof other === 'number' ? other : other.index;

    // Access collision tracking from logic worker context
    // self.logicWorker is the LogicWorker instance in logic_worker.js
    const logicWorker = typeof self !== 'undefined' ? self.logicWorker : null;
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
   *
   * ATOMIC DESPAWN: Any worker can despawn directly using atomic free list operations
   * No more worker-0 routing needed - freeList and freeListTop are SAB-backed
   */
  despawn() {
    // Prevent double-despawn which corrupts the free list
    if (Transform.active[this.index] === 0) return;

    const EntityClass = this.constructor;
    const entityType = EntityClass.entityType;

    // LIFECYCLE: Call onDespawned() BEFORE deactivating
    // This allows cleanup, saving state, triggering effects, etc.
    if (this.onDespawned) {
      this.onDespawned();
    }

    // INCREMENTAL UPDATE: Remove from query buffers and per-type list BEFORE deactivating
    // This replaces the O(N) per-frame rebuild with O(1) per-despawn updates
    GameObject._removeFromMatchingQueries(this.index, entityType);
    GameObject._removeFromActiveEntities(this.index);
    GameObject._removeFromTypeActiveList(EntityClass, this.index);

    // Deactivate all component active flags
    Transform.active[this.index] = 0;
    if (this.rigidBody) RigidBody.active[this.index] = 0;
    if (this.collider) Collider.active[this.index] = 0;
    if (this.spriteRenderer) SpriteRenderer.active[this.index] = 0;
    if (this.lightEmitter) LightEmitter.active[this.index] = 0;
    if (this.shadowCaster) ShadowCaster.active[this.index] = 0;

    // ATOMIC: Return to free list using atomic increment (thread-safe)
    // Atomics.add returns OLD value, then increments
    if (EntityClass.freeList && EntityClass.freeListTop) {
      const slot = Atomics.add(EntityClass.freeListTop, 0, 1);
      // Safety check - don't overflow the free list
      if (slot < EntityClass.poolSize) {
        // slot is the old count, so write at index slot
        EntityClass.freeList[slot] = this.index;
      } else {
        // Rollback - this shouldn't happen in normal operation
        Atomics.sub(EntityClass.freeListTop, 0, 1);
      }
    }
  }

  /**
   * Update neighbor references for this entity
   * Called by logic worker before tick() each frame
   *
   * OPTIMIZED: Uses Grid statics directly (neighborData and stride are the same for all entities).
   * Only updates per-instance offset and count. Zero redundant writes.
   * Lazy-inits this._neighbors view (once per entity lifetime).
   */
  updateNeighbors() {
    // Grid.neighborData and Grid._stride are static - same for all entities
    // Only _neighborOffset and neighborCount vary per instance
    this._neighborOffset = this.index * Grid._stride;
    this.neighborCount = Grid.neighborData[this._neighborOffset];

    // Lazy-init neighbors view (once per entity lifetime, zero-copy into SAB)
    // Fixed max length - use neighborCount to know how many are valid
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    if (!this._neighbors) {
      this._neighbors = new Uint16Array(
        Grid.neighborData.buffer,
        Grid.neighborData.byteOffset + (this._neighborOffset + 2) * 2, // Uint16 = 2 bytes
        Grid.maxNeighbors
      );
    }
  }

  /**
   * Get neighbor index at specific position
   * @param {number} i - Index (0 to this.neighborCount - 1)
   * @returns {number} Entity index of the neighbor
   */
  getNeighbor(i) {
    return this._neighbors[i];
  }

  /**
   * Get neighbor distance squared at specific position
   * Calculates distance on-the-fly from collider positions
   *
   * WARNING: This distance is calculated from COLLIDER positions (Transform + Collider.offset).
   * If you need to compute direction vectors (dx/dy), calculate distSq manually from the same
   * positions you use for dx/dy, otherwise the unit vector will be incorrect.
   *
   * @param {number} i - Index (0 to this.neighborCount - 1)
   * @returns {number} Squared distance to the neighbor (based on collider positions)
   */
  getNeighborDistanceSq(i) {
    const neighborIdx = this.getNeighbor(i);
    if (neighborIdx < 0) return 0;

    // Calculate distance on-the-fly (collider positions)
    const myX = Transform.x[this.index] + (Collider.offsetX[this.index] || 0);
    const myY = Transform.y[this.index] + (Collider.offsetY[this.index] || 0);
    const neighborX = Transform.x[neighborIdx] + (Collider.offsetX[neighborIdx] || 0);
    const neighborY = Transform.y[neighborIdx] + (Collider.offsetY[neighborIdx] || 0);
    return distanceSq2D(myX, myY, neighborX, neighborY);
  }

  /**
   * Get all neighbor IDs as an array
   * @returns {Int32Array} Typed array view of valid neighbor indices (zero-alloc subarray)
   */
  getAllNeighborIds() {
    return this._neighbors.subarray(0, this.neighborCount);
  }

  /**
   * Get all neighbor instances as an array
   * @returns {GameObject[]} Array of neighbor GameObject instances
   */
  getAllNeighborInstances() {
    const count = this.neighborCount;
    const result = new Array(count);
    const entities = GameObject.instances;
    const neighbors = this._neighbors;

    for (let i = 0; i < count; i++) {
      result[i] = entities[neighbors[i]];
    }

    return result;
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
    const neighbors = this._neighbors;

    for (let i = 0; i < count; i++) {
      const neighborIndex = neighbors[i];
      callback(instances[neighborIndex], 0, neighborIndex);
    }
  }

  /**
   * LIFECYCLE: Main update - called EVERY frame while entity is active
   * Override this in subclasses to define entity behavior
   * (AI, physics forces, animations, input handling, etc.)
   *
   * Note: this._neighbors and this.neighborCount are updated before this is called
   * Input is available via this.mouse and this.keyboard
   *
   * @param {number} dtRatio - Delta time ratio normalized to 60fps (1.0 = 16.67ms frame)
   * @param {number} deltaTime - Actual time since last frame in milliseconds
   * @param {number} accumulatedTime - Total time elapsed since game start in seconds
   * @param {number} frameNumber - Current frame number (starts at 1)
   *
   * Example:
   *   tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
   *     // Use dtRatio for frame-rate independent movement
   *     this.x += this.speed * dtRatio;
   *
   *     // Use deltaTime (ms) for precise timing calculations
   *     this.elapsedMs += deltaTime;
   *
   *     // Use accumulatedTime (seconds) for animations synced to game time
   *     this.alpha = Math.sin(accumulatedTime * 2) * 0.5 + 0.5;
   *
   *     // Use frameNumber for frame-based logic
   *     if (frameNumber % 60 === 0) this.doSomethingEverySecond();
   *   }
   */
  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
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
   * SPAWNING SYSTEM: Reset free list for an entity class (used by despawnAll)
   * Repopulates the SAB-backed free list with interleaved ordering
   *
   * NOTE: Free lists are now SAB-backed and initialized by Scene.js
   * This method is only called by despawnAll() to reset after bulk despawn
   *
   * Uses interleaved index ordering to reduce CPU cache contention between
   * logic workers. See inline comments for details.
   *
   * @param {Class} EntityClass - The entity class to reset
   */
  static initializeFreeList(EntityClass) {
    const count = EntityClass.poolSize;
    const startIndex = EntityClass.startIndex;

    // Free list should already exist (SAB-backed, created by Scene.js)
    if (!EntityClass.freeList || !EntityClass.freeListTop) {
      console.error(`Cannot reset free list for ${EntityClass.name}: SAB not initialized`);
      return;
    }

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
    for (let offset = 0; offset < interleaveFactor && writeIndex < count; offset++) {
      for (let i = offset; i < count && writeIndex < count; i += interleaveFactor) {
        EntityClass.freeList[writeIndex++] = startIndex + i;
      }
    }

    // Reset stack top to full (all slots free)
    EntityClass.freeListTop[0] = count;
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
    if (typeof EntityClassOrConfig === 'function') {
      // Traditional: GameObject.spawn(EntityClass, config)
      EntityClass = EntityClassOrConfig;
    } else {
      // New: Prey.spawn(config) - use `this` as the EntityClass
      EntityClass = this;
      spawnConfig = EntityClassOrConfig || {};
    }

    // Validate EntityClass has required metadata
    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      console.error(
        `Cannot spawn ${EntityClass.name}: missing startIndex/poolSize metadata. Was it registered with GameEngine?`
      );
      return null;
    }

    // ATOMIC SPAWN: Any worker can spawn directly using atomic free list operations
    // No more worker-0 routing needed - freeList and freeListTop are SAB-backed
    if (!EntityClass.freeList || !EntityClass.freeListTop) {
      console.error(
        `Cannot spawn ${EntityClass.name}: free list not initialized. Was scene properly initialized?`
      );
      return null;
    }

    // Atomic decrement to pop from free list (thread-safe)
    // Atomics.sub returns OLD value, then decrements
    const oldTop = Atomics.sub(EntityClass.freeListTop, 0, 1);

    // Check if pool is exhausted (oldTop was 0 or less before decrement)
    if (oldTop <= 0) {
      // Pool exhausted - restore counter and return failure
      Atomics.add(EntityClass.freeListTop, 0, 1);
      return null;
    }

    // Get index from free list
    // oldTop was the count, so valid indices are 0 to oldTop-1
    // We want the last item, at index oldTop-1
    const i = EntityClass.freeList[oldTop - 1];

    // Get the instance (already created during initialization)
    const instance = EntityClass.instances[i - EntityClass.startIndex];

    if (!instance) {
      console.error(`No instance found at index ${i} for ${EntityClass.name}`);
      return null;
    }

    // Reset component values to sensible defaults using direct array access (faster)
    // Check _hasComponents which is set in constructor based on entity's component list
    const has = instance._hasComponents;

    if (has.RigidBody) {
      RigidBody.active[i] = 1;
      RigidBody.ax[i] = 0;
      RigidBody.ay[i] = 0;
      RigidBody.vx[i] = 0;
      RigidBody.vy[i] = 0;
      RigidBody.speed[i] = 0;
      RigidBody.velocityAngle[i] = 0;
      RigidBody.px[i] = 0;
      RigidBody.py[i] = 0;
      // Reset sleeping state (entity must start awake for physics to work)
      RigidBody.sleeping[i] = 0;
      RigidBody.stillnessTime[i] = 0;
    }

    // Transform is always present
    Transform.x[i] = 0;
    Transform.y[i] = 0;
    Transform.rotation[i] = 0;

    if (has.Collider) {
      Collider.active[i] = 1;
    }

    if (has.LightEmitter) {
      LightEmitter.active[i] = 1;
    }

    if (has.ShadowCaster) {
      ShadowCaster.active[i] = 1;
    }

    if (has.SpriteRenderer) {
      SpriteRenderer.active[i] = 1;
      SpriteRenderer.tint[i] = 0xffffff;
      SpriteRenderer.baseTint[i] = 0xffffff;
      SpriteRenderer.alpha[i] = 1.0;
      SpriteRenderer.scaleX[i] = 1;
      SpriteRenderer.scaleY[i] = 1;
      SpriteRenderer.anchorX[i] = 0.5;
      SpriteRenderer.anchorY[i] = 1.0;
      SpriteRenderer.renderVisible[i] = 1;
      SpriteRenderer.isItOnScreen[i] = 0;
      SpriteRenderer.animationState[i] = -1;
      SpriteRenderer.spritesheetId[i] = 0;
      SpriteRenderer.loop[i] = 1; // Default: animations loop
      SpriteRenderer.renderDirty[i] = 1;
    }

    // Apply spawn config (x, y, vx, vy, rotation, etc.)
    for (const key in spawnConfig) {
      if (instance[key] !== undefined) {
        instance[key] = spawnConfig[key];
      }
    }

    // Initialize previous positions for Verlet integration
    if (has.RigidBody) {
      RigidBody.px[i] = Transform.x[i] - RigidBody.vx[i];
      RigidBody.py[i] = Transform.y[i] - RigidBody.vy[i];
    }

    // LIFECYCLE: Call setup() to restore TYPE-level config after defaults were applied
    // setup() defines "what this entity type IS" (physics params, collision, render config)
    if (instance.setup) {
      instance.setup();
    }

    // Ensure mass is calculated after setup() if it's still 0 and entity is not static
    // This handles cases where collider properties were set but mass wasn't calculated
    if (has.RigidBody && has.Collider && RigidBody.active[i] && Collider.active[i]) {
      const isStatic = RigidBody.static[i];
      const currentMass = RigidBody.mass[i];

      // If mass is 0 and entity is not static, recalculate from collider
      if (!isStatic && currentMass === 0) {
        const shapeType = Collider.shapeType[i];
        if (shapeType === 0) {
          // Circle
          const radius = Collider.radius[i];
          if (radius > 0) {
            updateMassFromCircle(i, radius, RigidBody);
          }
        } else if (shapeType === 1) {
          // Box
          const width = Collider.width[i];
          const height = Collider.height[i];
          if (width > 0 && height > 0) {
            updateMassFromBox(i, width, height, RigidBody);
          }
        }
      }
      // If static, ensure invMass is 0
      else if (isStatic) {
        RigidBody.invMass[i] = 0;
      }
    }

    // LIFECYCLE: Call onSpawned() for INSTANCE-level initialization
    // onSpawned() defines "this specific instance" (position, random variations, health)
    if (instance.onSpawned) {
      instance.onSpawned(spawnConfig);
    }

    // AUTOMATION: Automatically initialize any FSM components AFTER onSpawned()
    // This ensures FSM's onEnter() has access to fully configured entity state
    // Developers don't need to manually call initializeEntity() anymore
    const entityComponentMap = EntityClass._componentClassMap || {};
    for (const name in entityComponentMap) {
      const ComponentClass = entityComponentMap[name];
      if (ComponentClass && ComponentClass.isFSM) {
        ComponentClass.initializeEntity(i, instance);
      }
    }

    // Initialize tick decimation countdown (if staggeredUpdates enabled)
    // Stagger entities across frames using index offset: (index % tickInterval) + 1
    // This spreads the load so not all entities tick on the same frame
    if (GameObject.nextTick) {
      const tickInterval = EntityClass.tickInterval || 1;
      if (tickInterval > 1) {
        GameObject.nextTick[i] = (i % tickInterval) + 1;
      } else {
        GameObject.nextTick[i] = 1; // No decimation: always tick
      }
    }

    // NOW activate the entity
    Transform.active[i] = 1;

    // INCREMENTAL UPDATE: Add to activeEntitiesData, query buffers, and per-type list
    // This replaces the O(N) per-frame rebuild with O(1) per-spawn updates
    // When sortedActiveEntities is enabled, lists are kept sorted by index
    GameObject._addToActiveEntities(i);
    GameObject._addToMatchingQueries(i, EntityClass.entityType);
    GameObject._addToTypeActiveList(EntityClass, i);

    return instance;
  }

  /**
   * SPAWNING SYSTEM: Get pool statistics for an entity class
   *
   * @param {Class} EntityClass - The entity class to check
   * @returns {Object} - { total, active, available }
   */
  static getPoolStats(EntityClass) {
    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      return { total: 0, active: 0, available: 0 };
    }

    // If free list exists, use it for O(1) stats
    if (EntityClass.freeList && EntityClass.freeListTop) {
      const available = EntityClass.freeListTop[0]; // SAB-backed Int32Array
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
   * OPTIMIZED: Uses batch removal methods instead of individual despawn() calls
   * Complexity: O(N) instead of O(N²) for large pools
   *
   * @param {Class} EntityClass - The entity class to despawn
   * @returns {number} - Number of entities despawned
   */
  static despawnAll(EntityClass) {
    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      return 0;
    }

    const startIndex = EntityClass.startIndex;
    const endIndex = EntityClass.endIndex;
    const entityType = EntityClass.entityType;

    // Phase 1: Collect all active indices and call lifecycle hooks
    // Using Set for O(1) lookup in batch removal methods
    const indicesToDespawn = new Set();

    // Cache component active arrays for inner loop
    const transformActive = Transform.active;
    const rigidBodyActive = RigidBody.active;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;
    const lightEmitterActive = LightEmitter.active;
    const shadowCasterActive = ShadowCaster.active;

    for (let i = startIndex; i < endIndex; i++) {
      if (transformActive[i]) {
        const instance = EntityClass.instances[i - startIndex];

        // Call lifecycle hook (same as individual despawn)
        if (instance?.onDespawned) {
          instance.onDespawned();
        }

        indicesToDespawn.add(i);

        // Deactivate all component active flags
        transformActive[i] = 0;
        if (rigidBodyActive) rigidBodyActive[i] = 0;
        if (colliderActive) colliderActive[i] = 0;
        if (spriteRendererActive) spriteRendererActive[i] = 0;
        if (lightEmitterActive) lightEmitterActive[i] = 0;
        if (shadowCasterActive) shadowCasterActive[i] = 0;
      }
    }

    if (indicesToDespawn.size === 0) return 0;

    // Phase 2: Batch remove from active lists (O(N) instead of O(N²))
    GameObject._batchRemoveFromActiveEntities(indicesToDespawn);
    GameObject._batchRemoveFromMatchingQueries(indicesToDespawn, entityType);

    // Phase 3: Clear the per-type active list entirely (O(1))
    GameObject._clearTypeActiveList(EntityClass);

    // Phase 4: Reset free list with interleaved ordering (O(N) bulk reinit)
    if (EntityClass.freeList) {
      GameObject.initializeFreeList(EntityClass);
    }

    return indicesToDespawn.size;
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

  static getFirstActiveIndex() {
    const indices = this.entityIndices;
    if (!indices) return null;

    const active = Transform.active;
    const len = indices.length;

    for (let j = 0; j < len; j++) {
      const idx = indices[j];
      if (active[idx]) {
        return idx;
      }
    }
    return null;
  }

  static getFirstActiveInstance() {
    const index = this.getFirstActiveIndex();
    if (index === null) return null;
    return this.instances[index - this.startIndex];
  }

  /**
   * Get active entity indices for this entity type.
   *
   * When called on GameObject: returns ALL active entities from global list.
   * When called on a subclass (e.g., Prey.getAllActive()): returns per-type active list.
   *
   * @returns {Uint16Array} Active entity indices (view into SAB, do not modify)
   *
   * Performance: O(1) - returns subarray view into pre-maintained SAB
   */
  static getAllActive() {
    // If called on GameObject itself, return all active entities from global list
    if (this === GameObject) {
      const data = GameObject.activeEntitiesData;
      if (!data) return null;
      const totalCount = data[0];
      return data.subarray(1, 1 + totalCount);
    }

    // Called on a subclass - return per-type active list
    const typeList = this._activeList;
    const count = typeList[0];
    return typeList.subarray(1, 1 + count);
  }

  static getAllActiveInstances() {
    const indices = this.entityIndices;
    if (!indices) return;

    const active = Transform.active;
    const instances = this.instances;
    const len = indices.length;
    const activeInstances = [];
    for (let j = 0; j < len; j++) {
      const i = indices[j];
      if (active[i]) {
        activeInstances.push(instances ? instances[j] : undefined);
      }
    }
    return activeInstances;
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

    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      return 0;
    }

    // If free list exists, calculate from it (O(1))
    if (EntityClass.hasOwnProperty('freeList') && EntityClass.freeListTop) {
      return EntityClass.poolSize - EntityClass.freeListTop[0]; // SAB-backed Int32Array
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
