// GameObject.js - Base class for all game entities using component composition
// Entities are composed of components (Transform, RigidBody, Collider, etc.)

import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { AdobeAnimComponent } from '../components/AdobeAnimComponent.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { LightOccluder } from '../components/LightOccluder.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { Layer } from './Layer.js';
import { Grid } from './Grid.js';
import { collectComponents, cantorPair, updateMassFromCircle, updateMassFromBox, distanceSq2D } from './utils.js';
import {
  addToActiveEntities,
  removeFromActiveEntities,
  batchRemoveFromActiveEntities,
  getGameObjectWorkerContext,
  bumpActiveQueryVersion,
  addToMatchingQueries,
  removeFromMatchingQueries,
  batchRemoveFromMatchingQueries,
  removeFromTypeActiveList,
  clearTypeActiveList,
  addToTypeActiveList,
} from './gameObjectActiveState.js';
import Keyboard from './Keyboard.js';
import { DecorationPool } from './DecorationPool.js';
import { Decoration } from './Decoration.js';
import { AdobeAnimRegistry } from './AdobeAnimRegistry.js';
import { SceneBridge } from './SceneBridge.js';
// Export Keyboard for easy access (Mouse imported separately to avoid circular dep)
// Note: SpriteSheetRegistry is registered globally in AbstractWorker.registerCoreClasses()
export { Keyboard, SpriteSheetRegistry, SceneBridge };

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

  /**
   * Main thread only: current `Scene` reference, set in `Scene.exposeGlobalReferences()`.
   * Stays `null` in workers so `GameObject.get` keeps using the dense pool array there.
   * @type {Object|null}
   */
  static scene = null;

  /** @internal Reused by despawnAll to avoid Set allocation per call */
  static _despawnAllBuffer = new Set();

  /**
   * Worker: pooled instance at global index. Main thread (after scene init): lazy entity view over SABs.
   * From DevTools: `GameObject.get(12)` once `exposeGlobalReferences` has run.
   */
  static get(entityIndex) {
    const scene = GameObject.scene;
    if (scene && typeof scene.getEntityView === 'function') {
      return scene.getEntityView(entityIndex);
    }
    return GameObject.instances[entityIndex];
  }

  /**
   * Main-thread handle for an entity slot (same SABs as workers). Requires `window.scene`.
   * Engine callbacks (`tick`, collisions, etc.) still run only on logic workers.
   *
   * @param {number} entityIndex
   * @param {Object} [options] - cache=true reuses one instance per index until releaseEntityView
   * @param {boolean} [options.cache]
   * @returns {GameObject}
   */
  static getEntityView(entityIndex, options = {}) {
    const scene =
      GameObject.scene ||
      (typeof globalThis !== 'undefined' && globalThis.window && globalThis.window.scene) ||
      null;
    if (!scene || typeof scene.getEntityView !== 'function') {
      throw new Error(
        'GameObject.getEntityView: no active Scene (set GameObject.scene / window.scene via Scene.exposeGlobalReferences)'
      );
    }
    return scene.getEntityView(entityIndex, options);
  }

  /**
   * Initialize GameObject static arrays and neighbor data buffers
   *
   * @param {SharedArrayBuffer} buffer - Unused (kept for API compatibility)
   * @param {number} count - Total number of entities
   * @param {SharedArrayBuffer} [neighborBuffer] - Neighbor data buffer from spatial worker
   * @param {SharedArrayBuffer} [nextTickBuffer] - Tick decimation countdown buffer (1 byte per entity)
   */
  static initializeArrays(
    buffer,
    count,
    neighborBuffer = null,
    nextTickBuffer = null
  ) {
    this.globalEntityCount = count;

    // Initialize neighbor data if provided
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    if (neighborBuffer) {
      this.neighborData = new Uint16Array(neighborBuffer);
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
    addToActiveEntities(this.activeEntitiesData, entityIndex);
  }

  /**
   * Remove an entity from activeEntitiesData (binary search + shift)
   * Called from despawn() before entity deactivation
   * @param {number} entityIndex - The entity index to remove
   */
  static _removeFromActiveEntities(entityIndex) {
    removeFromActiveEntities(this.activeEntitiesData, entityIndex);
  }

  /**
   * Batch remove entities from activeEntitiesData (single-pass compaction)
   * Much faster than individual removals when despawning many entities: O(n) vs O(k*n)
   * @param {Set<number>} indicesToRemove - Set of entity indices to remove
   */
  static _batchRemoveFromActiveEntities(indicesToRemove) {
    batchRemoveFromActiveEntities(this.activeEntitiesData, indicesToRemove);
  }

  /**
   * Get the current worker context (works from any worker type)
   * @returns {Object|null} Worker instance with query system data, or null
   */
  static _getWorkerContext() {
    return getGameObjectWorkerContext();
  }

  static _bumpActiveQueryVersion() {
    bumpActiveQueryVersion(this._getWorkerContext());
  }

  static _forwardDespawnAllToLogic0(EntityClass) {
    if (typeof self === 'undefined') return null;

    const logicWorker = self.logicWorker;
    if (!logicWorker || logicWorker.workerIndex === 0) {
      return null;
    }

    if (typeof logicWorker.sendDataToWorker !== 'function') {
      console.warn(
        `Cannot forward ${EntityClass.name}.despawnAll() to logic0: worker messaging is unavailable`
      );
      return false;
    }

    return logicWorker.sendDataToWorker('logic0', {
      msg: 'despawnAll',
      className: EntityClass.name,
    });
  }

  /**
   * Add an entity to all matching precomputed query buffers (sorted insert)
   * Called from spawn() after entity activation
   * @param {number} entityIndex - The entity index to add
   * @param {number} entityType - The entity's type ID
   */
  static _addToMatchingQueries(entityIndex, entityType) {
    addToMatchingQueries(entityIndex, entityType, this._getWorkerContext());
  }

  /**
   * Remove an entity from all matching precomputed query buffers (binary search + shift)
   * Called from despawn() before entity deactivation
   * @param {number} entityIndex - The entity index to remove
   * @param {number} entityType - The entity's type ID
   */
  static _removeFromMatchingQueries(entityIndex, entityType) {
    removeFromMatchingQueries(entityIndex, entityType, this._getWorkerContext());
  }

  /**
   * Remove an entity from its type's active list (binary search + shift)
   * Called from despawn() before entity deactivation
   * @param {Class} EntityClass - The entity's class
   * @param {number} entityIndex - The entity index to remove
   */
  static _removeFromTypeActiveList(EntityClass, entityIndex) {
    removeFromTypeActiveList(EntityClass._activeList, entityIndex);
  }

  /**
   * Clear an entity type's active list (O(1))
   * Used by despawnAll when removing ALL entities of a type
   * @param {Class} EntityClass - The entity's class
   */
  static _clearTypeActiveList(EntityClass) {
    clearTypeActiveList(EntityClass._activeList);
  }

  /**
   * Batch remove entities from all matching query buffers (single-pass compaction)
   * Much faster than individual removals: O(n * queries) vs O(k * n * queries)
   * @param {Set<number>} indicesToRemove - Set of entity indices to remove
   * @param {number} entityType - The entity type ID (all indices must be same type)
   */
  static _batchRemoveFromMatchingQueries(indicesToRemove, entityType) {
    batchRemoveFromMatchingQueries(indicesToRemove, entityType, this._getWorkerContext());
  }

  /**
   * Add an entity to its type's active list (sorted insert)
   * Called from spawn() after entity activation
   * @param {Class} EntityClass - The entity's class
   * @param {number} entityIndex - The entity index to add
   */
  static _addToTypeActiveList(EntityClass, entityIndex) {
    addToTypeActiveList(EntityClass._activeList, entityIndex);
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
   * Build camelCase component name → class map (same layout logic_worker uses).
   * Called from Scene registration and logic worker pool creation so main-thread
   * entity views get working `this.rigidBody`-style accessors.
   * @param {Class} EntityClass
   */
  static _assignComponentClassMap(EntityClass) {
    const componentClassMap = {};
    const components = GameObject._collectComponents(EntityClass);
    for (const ComponentClass of components) {
      const componentName = ComponentClass.name;
      const camelCaseName = componentName.charAt(0).toLowerCase() + componentName.slice(1);
      componentClassMap[camelCaseName] = ComponentClass;
    }
    EntityClass._componentClassMap = componentClassMap;
  }

  /**
   * Constructor - stores entity index
   * @param {number} index - Entity index (unique across all entities)
   * @param {Object} config - Configuration object from GameEngine
   * @param {Object} logicWorker - Logic worker reference
   * @param {Object} [options]
   * @param {boolean} [options.view] - Main-thread view: do not touch pool Transform.active / instances / setup()
   *
   * DENSE COMPONENT ALLOCATION:
   * All components are allocated for all entities. Entity index === component index.
   * This simplifies code: just use SpriteRenderer.property[entityIndex] directly.
   * Unused slots have default values (0/false).
   */
  constructor(index, config = {}, logicWorker = null, options = {}) {
    this.index = index;
    this.config = config;
    this.logicWorker = logicWorker;
    this.bindToEntitySlot({ view: options.view === true });
  }

  /**
   * Wire this instance to its dense entity index: component flags, optional pool registration,
   * neighbor slice, accessors, and default setup().
   *
   * @param {Object} opts
   * @param {boolean} [opts.view=false] - When true (main-thread view): only attach read/write
   *   facades over existing SAB data — do not reset Transform, push into pools, or run setup().
   */
  bindToEntitySlot({ view = false } = {}) {
    const index = this.index;
    const Ctor = this.constructor;

    this._isEntityView = view;

    // DENSE ALLOCATION: entityIndex === componentIndex for all components
    this._hasComponents = {};
    const entityComponents = collectComponents(Ctor, GameObject, Transform);
    for (const ComponentClass of entityComponents) {
      const name = ComponentClass.name;
      const camelCaseName = name.charAt(0).toLowerCase() + name.slice(1);
      this._hasComponents[name] = true;
      this._hasComponents[camelCaseName] = true;
    }

    if (!view) {
      Transform.entityType[index] = Ctor.entityType || 0;
      Transform.active[index] = 0;
      GameObject.instances.push(this);
      Ctor.instances.push(this);
    }

    if (Grid._stride && Grid.neighborData) {
      this._neighborOffset = index * Grid._stride;
      this._neighbors = new Uint16Array(
        Grid.neighborData.buffer,
        Grid.neighborData.byteOffset + (this._neighborOffset + 2) * 2,
        Grid.maxNeighbors
      );
    } else {
      this._neighborOffset = -1;
      this._neighbors = null;
    }

    this._componentCache = {};
    Ctor._ensureComponentAccessors();

    if (!view && this.setup) {
      this.setup();
    }
  }

  get sceneBridge() {
    return SceneBridge;
  }

  sendMessageToScene(data) {
    return SceneBridge.sendMessageToScene(data, this);
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
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.alpha[this.index];
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.alpha[this.index];
    return 1;
  }
  set alpha(value) {
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.alpha[this.index] !== value) {
      SpriteRenderer.alpha[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    if (this._hasComponents.adobeAnimComponent) {
      AdobeAnimComponent.alpha[this.index] = value;
    }
  }

  /** Tint color (0xRRGGBB) */
  get tint() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.baseTint[this.index]; // Return user-facing RGB value
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.tint[this.index];
    return 0xffffff;
  }
  set tint(value) {
    if (this._hasComponents.SpriteRenderer) {
      SpriteRenderer.baseTint[this.index] = value;
      if (SpriteRenderer.tint[this.index] !== value) {
        SpriteRenderer.tint[this.index] = value;
        SpriteRenderer.renderDirty[this.index] = 1;
      }
    }
    if (this._hasComponents.adobeAnimComponent) {
      AdobeAnimComponent.tint[this.index] = value;
    }
  }

  /** Visibility flag */
  get visible() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.renderVisible[this.index] === 1;
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.renderVisible[this.index] === 1;
    return false;
  }
  set visible(value) {
    const v = value ? 1 : 0;
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.renderVisible[this.index] !== v) {
      SpriteRenderer.renderVisible[this.index] = v;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    if (this._hasComponents.adobeAnimComponent) {
      AdobeAnimComponent.renderVisible[this.index] = v;
    }
  }

  /** Scale X */
  get scaleX() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.scaleX[this.index];
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.scaleX[this.index];
    return 1;
  }
  set scaleX(value) {
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.scaleX[this.index] !== value) {
      SpriteRenderer.scaleX[this.index] = value;
      SpriteRenderer.updateBounds(this.index);
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    if (this._hasComponents.adobeAnimComponent && AdobeAnimComponent.scaleX[this.index] !== value) {
      AdobeAnimComponent.scaleX[this.index] = value;
      AdobeAnimComponent.applyClipBounds(this.index);
    }
  }

  /** Scale Y */
  get scaleY() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.scaleY[this.index];
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.scaleY[this.index];
    return 1;
  }
  set scaleY(value) {
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.scaleY[this.index] !== value) {
      SpriteRenderer.scaleY[this.index] = value;
      SpriteRenderer.updateBounds(this.index);
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    if (this._hasComponents.adobeAnimComponent && AdobeAnimComponent.scaleY[this.index] !== value) {
      AdobeAnimComponent.scaleY[this.index] = value;
      AdobeAnimComponent.applyClipBounds(this.index);
    }
  }

  /** Is entity currently on screen? Read-only, set by culling system */
  get isOnScreen() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.isItOnScreen[this.index] === 1;
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.isItOnScreen[this.index] === 1;
    return false;
  }

  /** Anchor X (0-1, 0.5 = center) - read-only, use setAnchor() */
  get anchorX() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.anchorX[this.index];
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.anchorX[this.index];
    return 0.5;
  }

  /** Anchor Y (0-1, 1.0 = bottom) - read-only, use setAnchor() */
  get anchorY() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.anchorY[this.index];
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.anchorY[this.index];
    return 1.0;
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
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.alpha[this.index] !== value) {
      SpriteRenderer.alpha[this.index] = value;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    if (this._hasComponents.adobeAnimComponent && AdobeAnimComponent.alpha[this.index] !== value) {
      AdobeAnimComponent.alpha[this.index] = value;
    }
    return this;
  }

  /**
   * Set tint color
   * @param {number} value - Color as 0xRRGGBB
   * @returns {this} For chaining
   */
  setTint(value) {
    if (this._hasComponents.SpriteRenderer) {
      SpriteRenderer.baseTint[this.index] = value;
      if (SpriteRenderer.tint[this.index] !== value) {
        SpriteRenderer.tint[this.index] = value;
        SpriteRenderer.renderDirty[this.index] = 1;
      }
    }
    if (this._hasComponents.adobeAnimComponent) {
      AdobeAnimComponent.tint[this.index] = value;
    }
    return this;
  }

  /**
   * Set visibility
   * @param {boolean} value - Visible or not
   * @returns {this} For chaining
   */
  setVisible(value) {
    const v = value ? 1 : 0;
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.renderVisible[this.index] !== v) {
      SpriteRenderer.renderVisible[this.index] = v;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    if (this._hasComponents.adobeAnimComponent) {
      AdobeAnimComponent.renderVisible[this.index] = v;
    }
    return this;
  }

  /** Current rendering layer name (read-only) */
  get layerName() {
    if (this._hasComponents.SpriteRenderer) return Layer.getName(SpriteRenderer.layerId[this.index]);
    if (this._hasComponents.adobeAnimComponent) return Layer.getName(AdobeAnimComponent.layerId[this.index]);
    return null;
  }

  /**
   * Set rendering layer for this entity
   * Entities in different layers are rendered into separate ParticleContainers
   * and can have custom shaders applied (e.g., metaball water effect).
   * @param {string} layerName - Layer name (e.g., 'water') or 'ENTITIES' for default
   * @returns {this} For chaining
   */
  setLayer(layerName) {
    const id = Layer.getId(layerName);
    if (id === -1) {
      console.warn(`setLayer: Layer "${layerName}" not found`);
      return this;
    }
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.layerId[this.index] !== id) {
      SpriteRenderer.layerId[this.index] = id;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    if (this._hasComponents.adobeAnimComponent && AdobeAnimComponent.layerId[this.index] !== id) {
      AdobeAnimComponent.layerId[this.index] = id;
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
    const yVal = y !== undefined ? y : x;
    let changed = false;
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.scaleX[this.index] !== x) {
      SpriteRenderer.scaleX[this.index] = x;
      changed = true;
    }
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.scaleY[this.index] !== yVal) {
      SpriteRenderer.scaleY[this.index] = yVal;
      changed = true;
    }
    if (this._hasComponents.SpriteRenderer && changed) {
      SpriteRenderer.updateBounds(this.index);
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    if (this._hasComponents.adobeAnimComponent) {
      AdobeAnimComponent.scaleX[this.index] = x;
      AdobeAnimComponent.scaleY[this.index] = yVal;
      AdobeAnimComponent.applyClipBounds(this.index);
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
    if (this._hasComponents.SpriteRenderer) {
      SpriteRenderer.anchorX[this.index] = x;
      SpriteRenderer.anchorY[this.index] = y;
      SpriteRenderer.renderDirty[this.index] = 1;
    }
    if (this._hasComponents.adobeAnimComponent) {
      AdobeAnimComponent.anchorX[this.index] = x;
      AdobeAnimComponent.anchorY[this.index] = y;
      AdobeAnimComponent.applyClipBounds(this.index);
    }
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
      SpriteRenderer.updateBounds(this.index);
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
      RigidBody.sleeping[this.index] = 0;
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

    SpriteRenderer.updateBounds(this.index);
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
   * Attach a visual-only decoration to this entity (DecorationPool; resolved in particle_worker).
   * @param {string} texture - bigAtlas texture name
   * @param {number} localX
   * @param {number} localY
   * @param {number} scaleX
   * @param {number} scaleY
   * @param {number} zIndex - signed inner sort (DECORATION_INNER_Z_MIN..DECORATION_INNER_Z_MAX); negative draws behind entity sprite (body is 0)
   * @param {Object} [extra] - optional DecorationPool.spawn fields
   * @returns {number} decoration index or -1
   */
  addDecoration(texture, localX, localY, scaleX, scaleY, zIndex, extra = {}) {
    const decoIndex = DecorationPool.spawn({
      parent: this.index,
      localX,
      localY,
      scaleX,
      scaleY,
      innerZ: zIndex,
      texture,
      ...extra,
    });
    if (decoIndex < 0) return -1;
    if (!DecorationPool.pushAttached(this.index, decoIndex)) {
      DecorationPool.despawn(decoIndex);
      return -1;
    }
    Decoration.ensureForParented(decoIndex);
    return decoIndex;
  }

  /**
   * Number of decorations attached to this entity (see addDecoration).
   * Uses the shared attachment table; no instance fields required.
   * @returns {number}
   */
  getAttachedDecorationCount() {
    return DecorationPool.getAttachedCount(this.index);
  }

  /**
   * Decoration pool index at attachment slot `slot` (0 .. getAttachedDecorationCount() - 1).
   * @param {number} slot
   * @returns {number} pool index, or -1
   */
  getAttachedDecorationIndex(slot) {
    return DecorationPool.getAttachedDecorationIndex(this.index, slot);
  }

  /**
   * Lazy facade for an attached decoration at `slot` (same as Decoration.get(poolIndex)).
   * @param {number} slot
   * @returns {Decoration | null}
   */
  getAttachedDecoration(slot) {
    const poolIndex = this.getAttachedDecorationIndex(slot);
    if (poolIndex < 0) return null;
    return Decoration.get(poolIndex);
  }

  /**
   * Despawn this entity (return to pool)
   *
   * THREAD-SAFE ARCHITECTURE:
   * - Any thread can call lifecycle hooks (onDespawned)
   * - Any thread can deactivate components (unique index)
   * - Any thread can do atomic freeList push
   * - List updates (activeEntities, perTypeActive, queries) are QUEUED
   * - Only logic0 processes list updates (at start of each frame)
   */
  despawn() {
    const i = this.index;
    const activeState = Transform.active[i];
    // Prevent double-despawn which corrupts the free list
    // 0 = inactive, 1 = active
    if (activeState === 0) return;

    const EntityClass = this.constructor;
    const entityType = EntityClass.entityType;

    // ========================================
    // LIFECYCLE HOOKS (SAFE - local call)
    // ========================================
    // LIFECYCLE: Call onDespawned() BEFORE deactivating
    // This allows cleanup, saving state, triggering effects, etc.
    if (this.onDespawned) {
      this.onDespawned();
    }

    DecorationPool.clearAttachedAndDespawnAll(i);

    // ========================================
    // COMPONENT DEACTIVATION (SAFE - unique index)
    // ========================================
    // Deactivate all component active flags
    Transform.active[i] = 0;
    if (this.rigidBody) {
      RigidBody.active[i] = 0;
      RigidBody.sleeping[i] = 0;
      RigidBody.stillnessTime[i] = 0;
    }
    if (this.collider) Collider.active[i] = 0;
    if (this.spriteRenderer) SpriteRenderer.active[i] = 0;
    if (this.adobeAnimComponent) AdobeAnimComponent.active[i] = 0;
    if (this.lightEmitter) {
      LightEmitter.active[i] = 0;
      LightEmitter.lightColor[i] = 0xffffff;
      LightEmitter.lightIntensity[i] = 0;
      LightEmitter.sqrtLightIntensity[i] = 0;
      LightEmitter.height[i] = 0;
      LightEmitter.glowHeightOffset[i] = 0;
      LightEmitter.hasGlowSprite[i] = 1;
      LightEmitter.layerIdOfGlowSprite[i] = 0;
    }
    if (this.shadowCaster) ShadowCaster.active[i] = 0;
    if (this.flashComponent) {
      FlashComponent.active[i] = 0;
      FlashComponent.lifespan[i] = 0;
      FlashComponent.currentLife[i] = 0;
      FlashComponent.initialIntensity[i] = 0;
    }
    if (this.lightOccluder) LightOccluder.active[i] = 0;

    // ========================================
    // FREE LIST PUSH (ATOMIC - any thread)
    // ========================================
    // ATOMIC: Return to free list using atomic increment (thread-safe)
    // Atomics.add returns OLD value, then increments
    if (EntityClass.freeList && EntityClass.freeListTop) {
      const slot = Atomics.add(EntityClass.freeListTop, 0, 1);
      // Safety check - don't overflow the free list
      if (slot < EntityClass.poolSize) {
        // slot is the old count, so write at index slot
        EntityClass.freeList[slot] = i;
      } else {
        // Rollback - this shouldn't happen in normal operation
        Atomics.sub(EntityClass.freeListTop, 0, 1);
      }
    }

    // ========================================
    // LIST UPDATES (QUEUED - processed by logic0)
    // ========================================
    // Queue list removal for logic0 to process at start of next frame
    // This avoids race conditions in sorted list operations
    const logicWorker = typeof self !== 'undefined' ? self.logicWorker : null;
    if (logicWorker) {
      logicWorker.queueDespawnListUpdate(i, entityType, EntityClass);
    }
  }

  /**
   * Get count of neighbors for this entity
   * Reads directly from spatial worker's SAB - always current
   * @returns {number} Number of neighbors
   */
  get neighborCount() {
    return Grid.neighborData[this._neighborOffset];
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
   * Get all neighbor IDs as an array
   * @returns {Uint16Array} Typed array view of valid neighbor indices (zero-alloc subarray)
   */
  getAllNeighborIds() {
    return this._neighbors.subarray(0, this.neighborCount);
  }

  /**
   * Get all neighbor instances as an array.
   * Allocates a new array each call - avoid in hot paths (e.g. per-entity tick).
   * Prefer getAllNeighborIds() + manual loop, or getAllNeighborInstancesMut(out) for zero-alloc.
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
   * Fill a provided array with neighbor instances (zero-alloc).
   * Caller provides the array; it is cleared and filled. Use for hot paths.
   * @param {GameObject[]} out - Array to fill (will be resized to neighborCount)
   * @returns {GameObject[]} The same array, filled with neighbor instances
   */
  getAllNeighborInstancesMut(out) {
    const count = this.neighborCount;
    const entities = GameObject.instances;
    const neighbors = this._neighbors;

    for (let i = 0; i < count; i++) {
      out[i] = entities[neighbors[i]];
    }
    out.length = count;
    return out;
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
   * LIFECYCLE: Called when this entity is hit by a bullet (raycast impact)
   * Override in subclasses to apply damage, spawn effects, etc.
   *
   * @param {number} damage - Damage amount
   * @param {number} hitX - Impact X in world space
   * @param {number} hitY - Impact Y in world space
   * @param {number} ownerId - Shooter entity index
   * @param {number} shooterEntityType - Shooter's entity type (for team/friendly fire)
   */
  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {
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
   * Works from BOTH main thread and logic workers with the same syntax:
   *   Ball.spawn({ x: 100, y: 200 })
   *
   * THREAD-SAFE ARCHITECTURE:
   * - Any thread can do atomic freeList pop and get index IMMEDIATELY
   * - Any thread can set component data and call lifecycle hooks
   * - List updates (activeEntities, perTypeActive, queries) are QUEUED
   * - Only logic0 processes list updates (at start of each frame)
   *
   * @param {Class|Object} EntityClassOrConfig - Entity class OR spawn config (when called as Ball.spawn(config))
   * @param {Object} spawnConfig - Initial configuration (position, velocity, etc.)
   * @param {number} [preAssignedIndex] - Optional pre-assigned entity index (from main thread)
   * @returns {GameObject|{index:number}|null} - Instance (worker) or {index} (main thread), null if pool exhausted
   */
  static spawn(EntityClassOrConfig, spawnConfig = {}, preAssignedIndex = -1) {
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

    // ========================================
    // CONTEXT DETECTION: Main thread vs Worker
    // ========================================
    // Main thread: delegate to Scene.spawnEntity (handles messaging to workers)
    // Worker: execute spawn directly with atomic operations
    const isMainThread = typeof window !== 'undefined' && typeof self.logicWorker === 'undefined';

    if (isMainThread && typeof window.scene?.spawnEntity === 'function') {
      // Main thread - delegate to Scene which handles worker messaging
      return window.scene.spawnEntity(EntityClass, spawnConfig);
    }

    // Validate EntityClass has required metadata
    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      console.error(
        `Cannot spawn ${EntityClass.name}: missing startIndex/poolSize metadata. Was it registered with GameEngine?`
      );
      return null;
    }

    let i;

    // ========================================
    // INDEX ACQUISITION (ATOMIC - any thread)
    // ========================================
    if (preAssignedIndex >= 0) {
      // Use pre-assigned index from main thread (already acquired atomically there)
      // Skip freeList operations - index was already removed from freeList
      i = preAssignedIndex;
    } else {
      // ATOMIC SPAWN: Any worker can spawn directly using atomic free list operations
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
      i = EntityClass.freeList[oldTop - 1];
    }

    // Get the instance (already created during initialization)
    const instance = EntityClass.instances[i - EntityClass.startIndex];

    if (!instance) {
      console.error(`No instance found at index ${i} for ${EntityClass.name}`);
      return null;
    }

    // ========================================
    // COMPONENT DATA SETUP (SAFE - unique index)
    // ========================================
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
      Collider.collisionLayer[i] = 0;
      Collider.collisionMask[i] = 0xFFFFFFFF;
    }

    if (has.LightEmitter) {
      LightEmitter.active[i] = 1;
      LightEmitter.lightColor[i] = 0xffffff;
      LightEmitter.lightIntensity[i] = 0;
      LightEmitter.sqrtLightIntensity[i] = 0;
      LightEmitter.height[i] = 0;
      LightEmitter.glowHeightOffset[i] = 0;
      LightEmitter.hasGlowSprite[i] = 1;
      LightEmitter.layerIdOfGlowSprite[i] = 0;
    }

    if (has.ShadowCaster) {
      ShadowCaster.active[i] = 1;
      ShadowCaster.heightMultiplier[i] = 1; // Default: normal shadow (0 = no shadow)
    }

    if (has.FlashComponent) {
      FlashComponent.active[i] = 1;
      FlashComponent.lifespan[i] = 0;
      FlashComponent.currentLife[i] = 0;
      FlashComponent.initialIntensity[i] = 0;
    }

    if (has.LightOccluder) {
      LightOccluder.active[i] = 1;
      LightOccluder.opacity[i] = 1;
    }

    if (has.SpriteRenderer) {
      SpriteRenderer.active[i] = 1;
      SpriteRenderer.tint[i] = 0xffffff;
      SpriteRenderer.baseTint[i] = 0xffffff;
      SpriteRenderer.alpha[i] = 1.0;
      SpriteRenderer.scaleX[i] = 1;
      SpriteRenderer.scaleY[i] = 1;
      SpriteRenderer.boundsHalfW[i] = 0;
      SpriteRenderer.boundsHalfH[i] = 0;
      SpriteRenderer.anchorX[i] = 0.5;
      SpriteRenderer.anchorY[i] = 1.0;
      SpriteRenderer.renderVisible[i] = 1;
      SpriteRenderer.isItOnScreen[i] = 0;
      SpriteRenderer.animationState[i] = -1;
      SpriteRenderer.spritesheetId[i] = 0;
      SpriteRenderer.loop[i] = 1; // Default: animations loop
      SpriteRenderer.renderDirty[i] = 1;
    }

    if (has.adobeAnimComponent) {
      AdobeAnimComponent.active[i] = 1;
      AdobeAnimComponent.assetId[i] = 0;
      AdobeAnimComponent.clipId[i] = 0;
      AdobeAnimComponent.time[i] = 0;
      AdobeAnimComponent.playbackRate[i] = 1;
      AdobeAnimComponent.loop[i] = 1;
      AdobeAnimComponent.playing[i] = 1;
      AdobeAnimComponent.scaleX[i] = 1;
      AdobeAnimComponent.scaleY[i] = 1;
      AdobeAnimComponent.anchorX[i] = Number.NaN;
      AdobeAnimComponent.anchorY[i] = Number.NaN;
      AdobeAnimComponent.rotation[i] = 0;
      AdobeAnimComponent.alpha[i] = 1;
      AdobeAnimComponent.tint[i] = 0xffffff;
      AdobeAnimComponent.layerId[i] = 0;
      AdobeAnimComponent.renderVisible[i] = 1;
      AdobeAnimComponent.isItOnScreen[i] = 0;
      AdobeAnimComponent.boundsHalfW[i] = 0;
      AdobeAnimComponent.boundsHalfH[i] = 0;
      AdobeAnimComponent.screenX[i] = 0;
      AdobeAnimComponent.screenY[i] = 0;
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

    // ========================================
    // LIFECYCLE HOOKS (SAFE - local call)
    // ========================================
    // LIFECYCLE: Call setup() to restore TYPE-level config after defaults were applied
    // setup() defines "what this entity type IS" (physics params, collision, render config)
    if (instance.setup) {
      instance.setup();
    }

    // Ensure mass is initialized after setup().
    // Dynamic bodies with no valid collider-derived mass fall back to unit mass once here,
    // instead of paying `invMass || 1` in physics hot loops every frame.
    if (has.RigidBody && RigidBody.active[i]) {
      const isStatic = RigidBody.static[i];

      if (isStatic) {
        RigidBody.invMass[i] = 0;
      } else if (RigidBody.mass[i] === 0) {
        let massInitialized = false;

        if (has.Collider && Collider.active[i]) {
          const shapeType = Collider.shapeType[i];
          if (shapeType === 0) {
            // Circle
            const radius = Collider.radius[i];
            if (radius > 0) {
              updateMassFromCircle(i, radius, RigidBody);
              massInitialized = true;
            }
          } else if (shapeType === 1) {
            // Box
            const width = Collider.width[i];
            const height = Collider.height[i];
            if (width > 0 && height > 0) {
              updateMassFromBox(i, width, height, RigidBody);
              massInitialized = true;
            }
          }
        }

        if (!massInitialized) {
          RigidBody.mass[i] = 1;
          RigidBody.invMass[i] = 1;
        }
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

    // Activate the entity - this enables spatial_worker to add it to Grid
    // and physics to process it. Must happen AFTER component setup.
    Transform.active[i] = 1;

    // ========================================
    // LIST UPDATES (QUEUED - processed by logic0)
    // ========================================
    // Queue list update for logic0 to process at start of next frame
    // This avoids race conditions in sorted list operations
    const logicWorker = typeof self !== 'undefined' ? self.logicWorker : null;
    if (logicWorker) {
      logicWorker.queueSpawnListUpdate(i, EntityClass.entityType, EntityClass);
    }

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
   * Works from BOTH main thread and logic workers with the same syntax:
   *   Ball.despawnAll()
   *
   * OPTIMIZED: logic0 uses batch removal methods instead of individual despawn() calls.
   * Non-logic0 logic workers forward the request to logic0 so all shared list/query
   * mutations still happen in the same place as normal spawn/despawn list updates.
   * Complexity: O(N) instead of O(N²) for large pools
   *
   * @param {Class} [EntityClass] - The entity class to despawn (optional when called as Ball.despawnAll())
   * @returns {number|undefined} - Number of entities despawned when executed locally
   */
  static despawnAll(EntityClass) {
    // Support calling as Ball.despawnAll() without passing the class
    if (!EntityClass || EntityClass === GameObject) {
      EntityClass = this;
    }

    // ========================================
    // CONTEXT DETECTION: Main thread vs Worker
    // ========================================
    const isMainThread = typeof window !== 'undefined' && typeof self.logicWorker === 'undefined';

    if (isMainThread && typeof window.scene?.despawnAllEntities === 'function') {
      // Main thread - delegate to Scene which handles worker messaging
      window.scene.despawnAllEntities(EntityClass.name);
      return; // Main thread doesn't know the count (async)
    }

    const forwardedToLogic0 = GameObject._forwardDespawnAllToLogic0(EntityClass);
    if (forwardedToLogic0 === true) {
      return; // Non-logic0 worker doesn't know the count yet (async)
    }
    if (forwardedToLogic0 === false) {
      return 0; // Keep list ownership with logic0; do not mutate shared lists locally.
    }

    if (EntityClass.startIndex === undefined || EntityClass.poolSize === undefined) {
      return 0;
    }

    const startIndex = EntityClass.startIndex;
    const endIndex = (EntityClass.endIndex !== undefined)
      ? EntityClass.endIndex
      : (startIndex + EntityClass.poolSize);
    const entityType = EntityClass.entityType;

    // Phase 1: Collect all active indices and call lifecycle hooks
    // Using Set for O(1) lookup in batch removal methods
    // Reuse static buffer to avoid allocation per call
    const indicesToDespawn = GameObject._despawnAllBuffer;
    indicesToDespawn.clear();

    // Cache component active arrays for inner loop
    const transformActive = Transform.active;
    const rigidBodyActive = RigidBody.active;
    const rigidBodySleeping = RigidBody.sleeping;
    const rigidBodyStillnessTime = RigidBody.stillnessTime;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;
    const adobeAnimActive = AdobeAnimComponent.active;
    const lightEmitterActive = LightEmitter.active;
    const lightEmitterColor = LightEmitter.lightColor;
    const lightEmitterIntensity = LightEmitter.lightIntensity;
    const lightEmitterSqrtIntensity = LightEmitter.sqrtLightIntensity;
    const lightEmitterHeight = LightEmitter.height;
    const lightEmitterGlowHeightOffset = LightEmitter.glowHeightOffset;
    const lightEmitterHasGlowSprite = LightEmitter.hasGlowSprite;
    const lightEmitterGlowLayerId = LightEmitter.layerIdOfGlowSprite;
    const shadowCasterActive = ShadowCaster.active;
    const flashActive = FlashComponent.active;
    const flashLifespan = FlashComponent.lifespan;
    const flashCurrentLife = FlashComponent.currentLife;
    const flashInitialIntensity = FlashComponent.initialIntensity;
    const lightOccluderActive = LightOccluder.active;

    for (let i = startIndex; i < endIndex; i++) {
      // Robust clear: treat any active component flag as "active entity".
      // This recovers from partial/corrupted states where Transform.active got out of sync.
      const isAnyComponentActive =
        transformActive[i] ||
        (rigidBodyActive && rigidBodyActive[i]) ||
        (colliderActive && colliderActive[i]) ||
        (spriteRendererActive && spriteRendererActive[i]) ||
        (adobeAnimActive && adobeAnimActive[i]) ||
        (lightEmitterActive && lightEmitterActive[i]) ||
        (shadowCasterActive && shadowCasterActive[i]) ||
        (flashActive && flashActive[i]) ||
        (lightOccluderActive && lightOccluderActive[i]);

      if (isAnyComponentActive) {
        const instance = EntityClass.instances[i - startIndex];

        // Call lifecycle hook (same as individual despawn)
        if (instance?.onDespawned) {
          instance.onDespawned();
        }

        DecorationPool.clearAttachedAndDespawnAll(i);
        indicesToDespawn.add(i);

        // Deactivate all component active flags
        transformActive[i] = 0;
        if (rigidBodyActive) rigidBodyActive[i] = 0;
        if (rigidBodySleeping) rigidBodySleeping[i] = 0;
        if (rigidBodyStillnessTime) rigidBodyStillnessTime[i] = 0;
        if (colliderActive) colliderActive[i] = 0;
        if (spriteRendererActive) spriteRendererActive[i] = 0;
        if (adobeAnimActive) adobeAnimActive[i] = 0;
        if (lightEmitterActive) lightEmitterActive[i] = 0;
        if (lightEmitterColor) lightEmitterColor[i] = 0xffffff;
        if (lightEmitterIntensity) lightEmitterIntensity[i] = 0;
        if (lightEmitterSqrtIntensity) lightEmitterSqrtIntensity[i] = 0;
        if (lightEmitterHeight) lightEmitterHeight[i] = 0;
        if (lightEmitterGlowHeightOffset) lightEmitterGlowHeightOffset[i] = 0;
        if (lightEmitterHasGlowSprite) lightEmitterHasGlowSprite[i] = 1;
        if (lightEmitterGlowLayerId) lightEmitterGlowLayerId[i] = 0;
        if (shadowCasterActive) shadowCasterActive[i] = 0;
        if (flashActive) flashActive[i] = 0;
        if (flashLifespan) flashLifespan[i] = 0;
        if (flashCurrentLife) flashCurrentLife[i] = 0;
        if (flashInitialIntensity) flashInitialIntensity[i] = 0;
        if (lightOccluderActive) lightOccluderActive[i] = 0;
      }
    }

    if (indicesToDespawn.size === 0) return 0;

    // Phase 2: Batch remove from active lists (O(N) instead of O(N²))
    GameObject._batchRemoveFromActiveEntities(indicesToDespawn);
    GameObject._batchRemoveFromMatchingQueries(indicesToDespawn, entityType);

    // Phase 3: Clear the per-type active list entirely (O(1))
    GameObject._clearTypeActiveList(EntityClass);

    // This path mutates active/query lists immediately instead of routing through
    // logic0's queued list-update pipeline, so it must invalidate fallback caches directly.
    GameObject._bumpActiveQueryVersion();

    // Phase 4: Reset free list with interleaved ordering (O(N) bulk reinit)
    if (EntityClass.freeList) {
      GameObject.initializeFreeList(EntityClass);
    }

    return indicesToDespawn.size;
  }

  /**
   * Get the first active entity index for this class
   * Performance: O(1) - reads from pre-maintained SAB
   *
   * @returns {number|null} First active entity index, or null if none active
   */
  static getFirstActiveIndex() {
    const activeList = this._activeList;
    return (activeList && activeList[0] > 0) ? activeList[1] : null;
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

  /**
   * Get instances of all active entities of this type (LOGIC WORKER ONLY)
   * NOTE: Allocates an array - prefer getAllActive() + manual loop for hot paths
   *
   * @returns {Array} Array of active entity instances
   */
  static getAllActiveInstances() {
    const activeIndices = this.getAllActive();
    if (!activeIndices) return [];

    const instances = this.instances;
    const startIndex = this.startIndex;
    const result = [];

    for (let i = 0; i < activeIndices.length; i++) {
      const entityIndex = activeIndices[i];
      result.push(instances[entityIndex - startIndex]);
    }
    return result;
  }

  /**
   * Get count of active entities of this class
   * Performance: O(1) - reads from pre-maintained SAB
   *
   * @returns {number} Number of currently active entities
   */
  static get activeCount() {
    const activeList = this._activeList;
    return activeList ? activeList[0] : 0;
  }
}
