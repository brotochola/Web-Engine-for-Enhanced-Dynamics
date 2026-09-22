// GameObject.js - Base class for all game entities using component composition
// Entities are composed of components (Transform, RigidBody, Collider, etc.)

import { syncRotCSFromAngle } from '../box2d/box2dHotFields.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { Collider } from '../components/collider.js';
import { SpriteRenderer } from '../components/spriteRenderer.js';
import { MeshRenderer, MESH_NO_TEXTURE } from '../components/meshRenderer.js';
import { AdobeAnimComponent } from '../components/adobeAnimComponent.js';
import { LightEmitter } from '../components/lightEmitter.js';
import { ShadowCaster } from '../components/shadowCaster.js';
import { FlashComponent } from '../components/flashComponent.js';
import { LightOccluder } from '../components/lightOccluder.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { Layer } from './layer.js';
import { syncColliderFeed } from '../util/layerFeed.js';
import { Grid } from './grid.js';
import { Joint } from './joint.js';
import { ColliderFixture } from './colliderFixture.js';
import { ShapeType, SPRITE_TILE_MODE, LAYER_SUBSCRIBE_KIND, LAYER_FEEDER_KIND } from '../util/configDefaults.js';
import { collectComponents, collisionPairKey, distanceSq2D, debugWorkerLog } from '../util/utils.js';
import { entityIdBytes, EntityIdArray } from '../util/entityIdWidth.js';
import {
  resetEntity,
  popEntity,
  pushEntity,
  getFreeListCount,
} from '../util/atomicFreeList.js';
import { applyEntitySaveRestore } from './save/entitySaveSnapshot.js';
import {
  addToActiveEntities,
  removeFromActiveEntities,
  batchRemoveFromActiveEntities,
  getGameObjectWorkerContext,
  bumpActiveQueryVersion,
  removeFromTypeActiveList,
  clearTypeActiveList,
  addToTypeActiveList,
} from '../util/gameObjectActiveState.js';
import Keyboard from './keyboard.js';
import { DecorationPool } from './decorationPool.js';
import { Decoration } from './decoration.js';
import { AdobeAnimRegistry } from './adobeAnimRegistry.js';
import { SceneBridge } from './sceneBridge.js';
import {
  enqueueSetTransform,
  enqueueSetVelocity,
  enqueueSetRotCS,
  enqueueSetAngularVelocity,
  enqueueSetFixedRotation,
  enqueueSetAwake,
  isCommandRingBound,
} from '../box2d/box2dCommandRing.js';
import {
  bumpBodyGeneration,
  markBodyDirty,
  withBodyDirtyDeferred,
} from '../box2d/box2dBodySync.js';
import {
  FORCE_PROCESS_ON_LOGIC_WORKER_NONE,
  resolveForceProcessOnLogicWorker,
} from '../util/logicOwner.js';
import { isXyOnlySpawnConfig } from '../util/createSpawnBatch.js';
import { isSpawnCommandRingBound, tryPushSpawn } from '../util/spawnCommandRing.js';
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
  // 0 = logic workers never visit this type (unless CameraInOutListener)
  // 1 = every frame; >1 = every N frames when logic.staggeredUpdates is on
  static tickInterval = 1;

  /**
   * False if logic workers should skip this type's active list.
   * tickInterval 0, or tick still GameObject.prototype.tick.
   * CameraInOutListener still visits even when this is false.
   */
  static typeNeedsLogicTick(EntityClass) {
    const Type = EntityClass || this;
    if ((Type.tickInterval | 0) === 0) return false;
    return Type.prototype.tick !== GameObject.prototype.tick;
  }

  /**
   * Own static tickAll(list, count, dtRatio). Do not also override tick()
   * if the type should use this path.
   */
  static typeHasTickAll(EntityClass) {
    const Type = EntityClass || this;
    return typeof Type.tickAll === 'function';
  }

  /**
   * After initializeArrays: Int16 per entity. Worker index that must run this
   * entity’s logic. FORCE_PROCESS_ON_LOGIC_WORKER_NONE (−1) means do not force:
   * use stride activeListSlot % logicWorkerCount. Not the LogicWorker instance.
   */
  static forceProcessOnLogicWorker = null;

  /** 1 while any live instance of that entityType has a forced worker. */
  static entityTypeHasForcedLogicWorker = null;

  /** Uint16 live forced-instance count per entityType. Flag is count > 0. */
  static entityTypeForcedLogicWorkerCount = null;

  static ENTITY_TYPE_FORCE_PROCESS_FLAG_COUNT = 256;

  /**
   * Particle worker fills `RigidBody.speed` for this entityType when true.
   * Scene gate: if no registered type opts in, the hypot loop does not run.
   */
  static deriveSpeed = false;

  // Neighbor data (from spatial worker)
  static neighborData = null;

  // Active entity list, maintained incrementally on spawn/despawn (logic0 owns list updates)
  // Layout: [count, entityIdx0, entityIdx1, ...]
  static activeEntitiesData = null;

  // Tick decimation countdown (Uint8Array, one byte per entity)
  // Decremented each frame; entity ticks when it reaches 0, then resets to tickInterval
  static nextTick = null;

  // Camera data (shared with main thread)
  static cameraData = null; // Float32Array Camera.FLOAT_COUNT (zoom, x, y, follow, targetZoom, followEntity stamp)

  // Per-entity type id is Transform.entityType[i]; class id is EntityClass.entityType
  static entityType = null; // Numeric ID assigned by Scene during entity registration

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
   * @param {number} count - Total number of entities
   * @param {SharedArrayBuffer} [neighborBuffer] - Neighbor data buffer from spatial worker
   * @param {SharedArrayBuffer} [nextTickBuffer] - Tick decimation countdown buffer (1 byte per entity)
   * @param {SharedArrayBuffer} [forceProcessOnLogicWorkerBuffer] - Int16 per entity (−1 = not forced)
   * @param {SharedArrayBuffer} [entityTypeHasForcedLogicWorkerBuffer] - Uint8 per entityType
   * @param {SharedArrayBuffer} [entityTypeForcedLogicWorkerCountBuffer] - Uint16 per entityType
   */
  static initializeArrays(
    count,
    neighborBuffer = null,
    nextTickBuffer = null,
    forceProcessOnLogicWorkerBuffer = null,
    entityTypeHasForcedLogicWorkerBuffer = null,
    entityTypeForcedLogicWorkerCountBuffer = null
  ) {
    this.globalEntityCount = count;

    // Initialize neighbor data if provided
    // Uses Uint16 since max entities = 65535 (fits in 16 bits)
    this.neighborData = neighborBuffer ? new (EntityIdArray())(neighborBuffer) : null;

    // Initialize tick decimation buffer if provided (staggeredUpdates enabled)
    if (nextTickBuffer) {
      this.nextTick = new Uint8Array(nextTickBuffer);
    }

    this.forceProcessOnLogicWorker = forceProcessOnLogicWorkerBuffer
      ? new Int16Array(forceProcessOnLogicWorkerBuffer)
      : null;
    this.entityTypeHasForcedLogicWorker = entityTypeHasForcedLogicWorkerBuffer
      ? new Uint8Array(entityTypeHasForcedLogicWorkerBuffer)
      : null;
    this.entityTypeForcedLogicWorkerCount = entityTypeForcedLogicWorkerCountBuffer
      ? new Uint16Array(entityTypeForcedLogicWorkerCountBuffer)
      : null;
  }

  /**
   * @param {number} entityIndex
   * @param {number} entityType
   * @param {number} workerIndex FORCE_PROCESS_ON_LOGIC_WORKER_NONE or 0..logicWorkerCount-1
   */
  static writeForceProcessOnLogicWorker(entityIndex, entityType, workerIndex) {
    if (!this.forceProcessOnLogicWorker) return;
    const next = workerIndex | 0;
    const prev = this.forceProcessOnLogicWorker[entityIndex] | 0;
    if (prev === next) return;
    this.forceProcessOnLogicWorker[entityIndex] = next;

    const counts = this.entityTypeForcedLogicWorkerCount;
    const flags = this.entityTypeHasForcedLogicWorker;
    if (!counts || entityType < 0 || entityType >= counts.length) {
      if (next >= 0 && flags && entityType >= 0 && entityType < flags.length) {
        flags[entityType] = 1;
      }
      return;
    }
    if (prev >= 0 && counts[entityType] > 0) counts[entityType] = (counts[entityType] - 1) & 0xffff;
    // ponytail: Uint16 count; 65535 live forced instances of one type is the ceiling.
    if (next >= 0 && counts[entityType] < 0xffff) counts[entityType] = (counts[entityType] + 1) & 0xffff;
    if (flags && entityType < flags.length) flags[entityType] = counts[entityType] > 0 ? 1 : 0;
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

  static _publishPrecomputedActiveQueries() {
    const worker = this._getWorkerContext();
    if (typeof worker?._publishPrecomputedActiveQueries === 'function') {
      worker._publishPrecomputedActiveQueries(worker.frameNumber || 0);
    }
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
   * @param {Object} config - Spawn/view config for this entity slot
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
    // LogicWorker API object (postMessage, queues). Not forceProcessOnLogicWorker.
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

    // One flag object per class. Composition does not vary per instance.
    let flags = Ctor._sharedHasComponents;
    if (!flags) {
      flags = {};
      const entityComponents = collectComponents(Ctor, GameObject, Transform);
      for (let c = 0; c < entityComponents.length; c++) {
        const name = entityComponents[c].name;
        flags[name] = true;
        flags[name.charAt(0).toLowerCase() + name.slice(1)] = true;
      }
      Ctor._sharedHasComponents = flags;
    }
    this._hasComponents = flags;

    if (!view) {
      Transform.entityType[index] = Ctor.entityType || 0;
      Transform.active[index] = 0;
      GameObject.instances.push(this);
      Ctor.instances.push(this);
    }

    if (Grid._stride && Grid.neighborData) {
      this._neighborOffset = index * Grid._stride;
      this._neighbors = null;
    } else {
      this._neighborOffset = -1;
      this._neighbors = null;
    }

    this._componentCache = {};
    Ctor._ensureComponentAccessors();

    if (!view && this.setup) {
      withBodyDirtyDeferred(() => this.setup());
    }
  }

  /** Worker→Scene postMessage helper (`SceneBridge`). */
  get sceneBridge() {
    return SceneBridge;
  }

  /**
   * Post a message from this entity to Scene.onMessageFromGameObject on the main thread.
   * @param {*} data
   */
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

  /** True when this type has a Box2D body (RigidBody and/or Collider). */
  _hasBox2dBody() {
    return !!(this._hasComponents.RigidBody || this._hasComponents.Collider);
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
   */
  get x() {
    return Transform.x[this.index];
  }
  set x(value) {
    const i = this.index;
    if (Transform.x[i] === value) return;
    Transform.x[i] = value;
    if (isCommandRingBound() && this._hasBox2dBody()) {
      enqueueSetTransform(
        i,
        value,
        Transform.y[i],
        Transform.rotC ? Transform.rotC[i] : 1,
        Transform.rotS ? Transform.rotS[i] : 0,
      );
    }
  }

  /**
   * Position Y - forwards to Transform
   */
  get y() {
    return Transform.y[this.index];
  }
  set y(value) {
    const i = this.index;
    if (Transform.y[i] === value) return;
    Transform.y[i] = value;
    if (isCommandRingBound() && this._hasBox2dBody()) {
      enqueueSetTransform(
        i,
        Transform.x[i],
        value,
        Transform.rotC ? Transform.rotC[i] : 1,
        Transform.rotS ? Transform.rotS[i] : 0,
      );
    }
  }

  /** Rotation in radians (HEAP channel written by WASM via b2Atan2; set syncs CS + cmd). */
  get rotation() {
    return Transform.rotation[this.index];
  }
  set rotation(value) {
    const i = this.index;
    if (Transform.rotation && Transform.rotation[i] === value) return;
    if (Transform.rotation) Transform.rotation[i] = value;
    syncRotCSFromAngle(i, value);
    if (isCommandRingBound() && this._hasComponents.RigidBody) {
      enqueueSetRotCS(
        i,
        Transform.rotC ? Transform.rotC[i] : Math.cos(value),
        Transform.rotS ? Transform.rotS[i] : Math.sin(value),
      );
    }
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
      const i = this.index;
      if (RigidBody.vx[i] === value) return;
      RigidBody.vx[i] = value;
      if (isCommandRingBound()) {
        enqueueSetVelocity(i, value, RigidBody.vy[i]);
      }
    }
  }

  /** Velocity Y - returns 0 if entity has no RigidBody */
  get vy() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.vy[this.index];
  }
  set vy(value) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      if (RigidBody.vy[i] === value) return;
      RigidBody.vy[i] = value;
      if (isCommandRingBound()) {
        enqueueSetVelocity(i, RigidBody.vx[i], value);
      }
    }
  }

  /** Angular velocity (rad/s) */
  get angularVelocity() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.angularVelocity[this.index];
  }
  set angularVelocity(value) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      if (RigidBody.angularVelocity[i] === value) return;
      RigidBody.angularVelocity[i] = value;
      if (isCommandRingBound()) {
        enqueueSetAngularVelocity(i, value);
      }
    }
  }

  /**
   * Lock / unlock body rotation (Box2D motionLocks.angularZ).
   * Prefer this or setFixedRotation() over raw RigidBody.fixedRotation[i]
   * so the command ring updates Box2D when a body already exists.
   */
  get fixedRotation() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.fixedRotation[this.index];
  }
  set fixedRotation(value) {
    this.setFixedRotation(value);
  }

  /** Box2D body type. Prefer spawnConfig.isStatic or this property over raw SoA writes. */
  get isStatic() {
    if (!this._hasComponents.RigidBody) return false;
    return RigidBody.static[this.index] !== 0;
  }
  set isStatic(value) {
    if (this._hasComponents.RigidBody) {
      this.rigidBody.static = value;
    }
  }

  /**
   * Speed (px/s). Particle worker writes `RigidBody.speed` for types that set
   * `static deriveSpeed = true`. Other types in the same scene stay 0/stale.
   */
  get speed() {
    if (!this._hasComponents.RigidBody) return 0;
    return RigidBody.speed[this.index];
  }

  /**
   * Body heading unit X (from Transform.rotC / Box2D b2Rot).
   */
  get forwardX() {
    return Transform.rotC[this.index];
  }

  /** Body heading unit Y */
  get forwardY() {
    return Transform.rotS[this.index];
  }

  /** Right unit X (rotate forward by -90°) */
  get rightX() {
    return this.forwardY;
  }

  /** Right unit Y */
  get rightY() {
    return -this.forwardX;
  }

  /**
   * Fill out with heading axes for entity index (zero alloc if out reused).
   * @param {number} index
   * @param {{ angle?: number, frontX?: number, frontY?: number, rightX?: number, rightY?: number }} out
   * @returns {typeof out}
   */
  static getHeadingAxes(index, out) {
    const frontX = Transform.rotC[index];
    const frontY = Transform.rotS[index];
    out.frontX = frontX;
    out.frontY = frontY;
    out.rightX = frontY;
    out.rightY = -frontX;
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SPRITERENDERER PROPERTIES
  // Setters mark dirty for re-rendering. Both setter and method provided.
  // ─────────────────────────────────────────────────────────────────────────────

  /** Alpha (opacity) 0-1 */
  get alpha() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.alpha[this.index];
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.alpha[this.index];
    if (this._hasComponents.MeshRenderer) return MeshRenderer.alpha[this.index];
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
    if (this._hasComponents.MeshRenderer && MeshRenderer.alpha[this.index] !== value) {
      MeshRenderer.alpha[this.index] = value;
      MeshRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Tint color (0xRRGGBB) */
  get tint() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.baseTint[this.index]; // Return user-facing RGB value
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.tint[this.index];
    if (this._hasComponents.MeshRenderer) return MeshRenderer.tint[this.index] >>> 0;
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
    if (this._hasComponents.MeshRenderer && MeshRenderer.tint[this.index] !== (value >>> 0)) {
      MeshRenderer.tint[this.index] = value >>> 0;
      MeshRenderer.renderDirty[this.index] = 1;
    }
  }

  /** Visibility flag */
  get visible() {
    if (this._hasComponents.SpriteRenderer) return SpriteRenderer.renderVisible[this.index] === 1;
    if (this._hasComponents.adobeAnimComponent) return AdobeAnimComponent.renderVisible[this.index] === 1;
    if (this._hasComponents.MeshRenderer) return MeshRenderer.renderVisible[this.index] === 1;
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
    if (this._hasComponents.MeshRenderer && MeshRenderer.renderVisible[this.index] !== v) {
      MeshRenderer.renderVisible[this.index] = v;
      MeshRenderer.renderDirty[this.index] = 1;
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

  /** Collision radius - also syncs RigidBody mass from collider geometry */
  get radius() {
    if (!this._hasComponents.Collider) return 0;
    return Collider.radius[this.index];
  }

  set radius(value) {
    if (!this._hasComponents.Collider) return;
    // Delegate so Collider radius setter can set ShapeType.Circle
    if (this.collider) {
      this.collider.radius = value;
      return;
    }
    Collider.radius[this.index] = value;
    if (value > 0) Collider.shapeType[this.index] = ShapeType.Circle;
    if (this._hasComponents.RigidBody) {
      RigidBody.syncMassFromCollider(this.index);
    }
  }

  /** Collider width - also syncs RigidBody mass from collider geometry */
  get width() {
    if (!this._hasComponents.Collider) return 0;
    return Collider.width[this.index];
  }
  set width(value) {
    if (!this._hasComponents.Collider) return;
    if (this.collider) {
      this.collider.width = value;
      return;
    }
    Collider.width[this.index] = value;
    if (value > 0 && Collider.shapeType[this.index] !== ShapeType.Polygon) {
      Collider.shapeType[this.index] = ShapeType.Box;
    }
    if (this._hasComponents.RigidBody) {
      RigidBody.syncMassFromCollider(this.index);
    }
  }

  /** Collider height - also syncs RigidBody mass from collider geometry */
  get height() {
    if (!this._hasComponents.Collider) return 0;
    return Collider.height[this.index];
  }
  set height(value) {
    if (!this._hasComponents.Collider) return;
    if (this.collider) {
      this.collider.height = value;
      return;
    }
    Collider.height[this.index] = value;
    if (value > 0 && Collider.shapeType[this.index] !== ShapeType.Polygon) {
      Collider.shapeType[this.index] = ShapeType.Box;
    }
    if (this._hasComponents.RigidBody) {
      RigidBody.syncMassFromCollider(this.index);
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
    if (this._hasComponents.MeshRenderer && MeshRenderer.alpha[this.index] !== value) {
      MeshRenderer.alpha[this.index] = value;
      MeshRenderer.renderDirty[this.index] = 1;
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
    if (this._hasComponents.MeshRenderer && MeshRenderer.tint[this.index] !== (value >>> 0)) {
      MeshRenderer.tint[this.index] = value >>> 0;
      MeshRenderer.renderDirty[this.index] = 1;
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
    if (this._hasComponents.MeshRenderer && MeshRenderer.renderVisible[this.index] !== v) {
      MeshRenderer.renderVisible[this.index] = v;
      MeshRenderer.renderDirty[this.index] = 1;
    }
    return this;
  }

  /** First sprite-queue layer name in the subscription mask. */
  get layerName() {
    let mask = 0;
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.layerMask) {
      mask = SpriteRenderer.layerMask[this.index] | 0;
    } else if (this._hasComponents.adobeAnimComponent && AdobeAnimComponent.layerMask) {
      mask = AdobeAnimComponent.layerMask[this.index] | 0;
    } else if (this._hasComponents.MeshRenderer && MeshRenderer.layerMask) {
      mask = MeshRenderer.layerMask[this.index] | 0;
    }
    if (!mask) return Layer.getName(Layer.entitiesId);
    for (let id = 0; id < Layer.MAX_LAYERS; id++) {
      if (!(mask & (1 << id))) continue;
      if (Layer.feederKind(id) === LAYER_FEEDER_KIND.SPRITES) return Layer.getName(id);
    }
    return Layer.getName(Layer.entitiesId);
  }

  /**
   * Subscribe this entity to one layer. Same as setLayers([layerName]).
   * @param {string} layerName
   * @returns {this}
   */
  setLayer(layerName) {
    this._applyLayerMask(Layer.resolveOne(layerName, LAYER_SUBSCRIBE_KIND.GAME_OBJECT));
    return this;
  }

  /**
   * Subscribe this entity to layers (sprites, compute, density bits).
   * Compute-only lists keep the sprite on ENTITIES.
   * @param {Array<string|number>} names
   * @returns {this}
   */
  setLayers(names) {
    const mask = Layer.resolveSubscriptions({ layers: names || [] }, LAYER_SUBSCRIBE_KIND.GAME_OBJECT);
    this._applyLayerMask(mask);
    return this;
  }

  _applyLayerMask(mask) {
    const i = this.index;
    const m = mask & 0xffff;
    if (this._hasComponents.SpriteRenderer && SpriteRenderer.layerMask) {
      if (SpriteRenderer.layerMask[i] !== m) {
        SpriteRenderer.layerMask[i] = m;
        SpriteRenderer.renderDirty[i] = 1;
      }
    }
    if (this._hasComponents.adobeAnimComponent && AdobeAnimComponent.layerMask) {
      AdobeAnimComponent.layerMask[i] = m;
    }
    if (this._hasComponents.MeshRenderer && MeshRenderer.layerMask) {
      if (MeshRenderer.layerMask[i] !== m) {
        MeshRenderer.layerMask[i] = m;
        MeshRenderer.renderDirty[i] = 1;
      }
    }
    if (this._hasComponents.Collider && Collider.layerMask) {
      const old = Collider.layerMask[i] | 0;
      if (old !== m) {
        Collider.layerMask[i] = m;
        syncColliderFeed(i, old, m);
      }
    }
  }

  /**
   * Opaque compute flags packed into Body.flags (bit 1 reserved for static).
   * @param {number} bits
   * @returns {this}
   */
  setFeedBits(bits) {
    if (!this._hasComponents.Collider || !Collider.feedBits) return this;
    Collider.feedBits[this.index] = bits & 0xff;
    return this;
  }

  /** @returns {number} */
  getFeedBits() {
    if (!this._hasComponents.Collider || !Collider.feedBits) return 0;
    return Collider.feedBits[this.index] | 0;
  }

  /**
   * World-lock atlas tiling. `period` is world px per full texture repeat.
   * Optional `u0/v0` phase in 0..1 (parallax). Shader layers still tile in world
   * (internal screen upload reconstructs world XY).
   * @param {number} periodX
   * @param {number} [periodY]
   * @param {number} [u0=0]
   * @param {number} [v0=0]
   * @returns {this}
   */
  setTileWorld(periodX, periodY, u0 = 0, v0 = 0) {
    const i = this.index;
    const px = periodX | 0;
    const py = (periodY == null ? periodX : periodY) | 0;
    const rx = px < 0 ? 0 : px > 65535 ? 65535 : px;
    const ry = py < 0 ? 0 : py > 65535 ? 65535 : py;
    if (this._hasComponents.SpriteRenderer) {
      SpriteRenderer.repeatX[i] = rx;
      SpriteRenderer.repeatY[i] = ry;
      SpriteRenderer.tileMode[i] = SPRITE_TILE_MODE.WORLD;
      SpriteRenderer.tileOffsetU[i] = SpriteRenderer.packTileOffset01(u0);
      SpriteRenderer.tileOffsetV[i] = SpriteRenderer.packTileOffset01(v0);
      SpriteRenderer.renderDirty[i] = 1;
    }
    if (this._hasComponents.MeshRenderer) {
      MeshRenderer.repeatX[i] = rx;
      MeshRenderer.repeatY[i] = ry;
      MeshRenderer.tileMode[i] = SPRITE_TILE_MODE.WORLD;
      MeshRenderer.tileOffsetU[i] = MeshRenderer.packTileOffset01(u0);
      MeshRenderer.tileOffsetV[i] = MeshRenderer.packTileOffset01(v0);
      MeshRenderer.renderDirty[i] = 1;
    }
    return this;
  }

  /**
   * Local-lock atlas tiling. Crop travels and rotates with the quad.
   * @param {number} periodX - world px per full texture repeat along the sprite
   * @param {number} [periodY]
   * @param {number} [u0=0] - UV offset 0..1
   * @param {number} [v0=0]
   * @returns {this}
   */
  setTileLocal(periodX, periodY, u0 = 0, v0 = 0) {
    const i = this.index;
    const px = periodX | 0;
    const py = (periodY == null ? periodX : periodY) | 0;
    const rx = px < 0 ? 0 : px > 65535 ? 65535 : px;
    const ry = py < 0 ? 0 : py > 65535 ? 65535 : py;
    if (this._hasComponents.SpriteRenderer) {
      SpriteRenderer.repeatX[i] = rx;
      SpriteRenderer.repeatY[i] = ry;
      SpriteRenderer.tileMode[i] = SPRITE_TILE_MODE.LOCAL;
      SpriteRenderer.tileOffsetU[i] = SpriteRenderer.packTileOffset01(u0);
      SpriteRenderer.tileOffsetV[i] = SpriteRenderer.packTileOffset01(v0);
      SpriteRenderer.renderDirty[i] = 1;
    }
    if (this._hasComponents.MeshRenderer) {
      MeshRenderer.repeatX[i] = rx;
      MeshRenderer.repeatY[i] = ry;
      MeshRenderer.tileMode[i] = SPRITE_TILE_MODE.LOCAL;
      MeshRenderer.tileOffsetU[i] = MeshRenderer.packTileOffset01(u0);
      MeshRenderer.tileOffsetV[i] = MeshRenderer.packTileOffset01(v0);
      MeshRenderer.renderDirty[i] = 1;
    }
    return this;
  }

  /** Stretch UV across the quad / mesh (default). */
  clearTile() {
    const i = this.index;
    if (this._hasComponents.SpriteRenderer) {
      SpriteRenderer.repeatX[i] = 0;
      SpriteRenderer.repeatY[i] = 0;
      SpriteRenderer.tileMode[i] = SPRITE_TILE_MODE.STRETCH;
      SpriteRenderer.tileOffsetU[i] = 0;
      SpriteRenderer.tileOffsetV[i] = 0;
      SpriteRenderer.renderDirty[i] = 1;
    }
    if (this._hasComponents.MeshRenderer) {
      MeshRenderer.repeatX[i] = 0;
      MeshRenderer.repeatY[i] = 0;
      MeshRenderer.tileMode[i] = SPRITE_TILE_MODE.STRETCH;
      MeshRenderer.tileOffsetU[i] = 0;
      MeshRenderer.tileOffsetV[i] = 0;
      MeshRenderer.renderDirty[i] = 1;
    }
    return this;
  }

  /**
   * Freeze current world-locked crop onto the quad (LOCAL). Use when a
   * world-tiled sprite becomes dynamic so rotation does not swim UVs.
   * @returns {this}
   */
  bakeWorldTileToLocal() {
    const i = this.index;
    if (this._hasComponents.SpriteRenderer) {
      const px = SpriteRenderer.repeatX[i];
      const py = SpriteRenderer.repeatY[i];
      if (px > 0 || py > 0) {
        const visX = SpriteRenderer.boundsHalfW[i] * 2;
        const visY = SpriteRenderer.boundsHalfH[i] * 2;
        SpriteRenderer.tileMode[i] = SPRITE_TILE_MODE.LOCAL;
        if (px > 0) {
          SpriteRenderer.tileOffsetU[i] = SpriteRenderer.packTileOffset01(
            SpriteRenderer.bakeLocalOffsetFromWorld(this.x, px, visX)
          );
        }
        if (py > 0) {
          SpriteRenderer.tileOffsetV[i] = SpriteRenderer.packTileOffset01(
            SpriteRenderer.bakeLocalOffsetFromWorld(this.y, py, visY)
          );
        }
        SpriteRenderer.renderDirty[i] = 1;
      }
    }
    if (this._hasComponents.MeshRenderer) {
      const px = MeshRenderer.repeatX[i];
      const py = MeshRenderer.repeatY[i];
      if (px > 0 || py > 0) {
        const visX = Collider.width ? Collider.width[i] : 1;
        const visY = Collider.height ? Collider.height[i] : 1;
        MeshRenderer.tileMode[i] = SPRITE_TILE_MODE.LOCAL;
        if (px > 0) {
          MeshRenderer.tileOffsetU[i] = MeshRenderer.packTileOffset01(
            SpriteRenderer.bakeLocalOffsetFromWorld(this.x, px, visX || 1)
          );
        }
        if (py > 0) {
          MeshRenderer.tileOffsetV[i] = MeshRenderer.packTileOffset01(
            SpriteRenderer.bakeLocalOffsetFromWorld(this.y, py, visY || 1)
          );
        }
        MeshRenderer.renderDirty[i] = 1;
      }
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
   * Set position (writes SoA + enqueues Box2D SET_TRANSFORM).
   * @param {number} x - Position X
   * @param {number} y - Position Y
   * @returns {this} For chaining
   */
  setPosition(x, y) {
    const i = this.index;
    if (Transform.x[i] === x && Transform.y[i] === y) return this;
    Transform.x[i] = x;
    Transform.y[i] = y;
    if (isCommandRingBound() && this._hasBox2dBody()) {
      enqueueSetTransform(
        i,
        x,
        y,
        Transform.rotC ? Transform.rotC[i] : 1,
        Transform.rotS ? Transform.rotS[i] : 0,
      );
    }
    return this;
  }

  /**
   * Set velocity (absolute). Writes SoA + enqueues Box2D SET_VELOCITY.
   * @param {number} vx - Velocity X (px/s)
   * @param {number} vy - Velocity Y (px/s)
   * @returns {this} For chaining
   */
  setVelocity(vx, vy) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      if (RigidBody.vx[i] === vx && RigidBody.vy[i] === vy) return this;
      RigidBody.vx[i] = vx;
      RigidBody.vy[i] = vy;
      if (isCommandRingBound()) {
        enqueueSetVelocity(i, vx, vy);
      }
    }
    return this;
  }

  /**
   * Set fixedRotation (writes SoA + enqueues Box2D SET_FIXED_ROTATION).
   * Direct SoA poke RigidBody.fixedRotation[i] skips Box2D after body create.
   * @param {number|boolean} flag - 0/false free, 1/true locked
   * @returns {this}
   */
  setFixedRotation(flag) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      const v = flag ? 1 : 0;
      RigidBody.fixedRotation[i] = v;
      if (isCommandRingBound()) {
        enqueueSetFixedRotation(i, v);
      }
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
   * @param {number} dvx - Velocity X to add (px/s)
   * @param {number} dvy - Velocity Y to add (px/s)
   * @returns {this} For chaining
   */
  addVelocity(dvx, dvy) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      RigidBody.vx[i] += dvx;
      RigidBody.vy[i] += dvy;
      if (isCommandRingBound()) {
        enqueueSetVelocity(i, RigidBody.vx[i], RigidBody.vy[i]);
      }
    }
    return this;
  }

  /**
   * Scale velocity (multiplicative) - useful for linearDamping-style slowdown
   * @param {number} factor - Multiplier (0.95 = 5% slowdown)
   * @returns {this} For chaining
   */
  scaleVelocity(factor) {
    if (this._hasComponents.RigidBody) {
      const i = this.index;
      RigidBody.vx[i] *= factor;
      RigidBody.vy[i] *= factor;
      if (isCommandRingBound()) {
        enqueueSetVelocity(i, RigidBody.vx[i], RigidBody.vy[i]);
      }
    }
    return this;
  }

  /**
   * Add acceleration (px/s²). Logic zeros ax/ay at the start of this entity's
   * next tick; physics applies the current value every Box2D step until then.
   * One-shot kicks (shots, explosions) should use addVelocity, not this.
   * @param {number} x - Acceleration X (px/s²)
   * @param {number} y - Acceleration Y (px/s²)
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
   * Wake or sleep the Box2D body (command ring → body_set_awake).
   * Writing RigidBody.sleeping alone does not change the solver.
   * @param {boolean} [awake=true]
   * @returns {this}
   */
  setAwake(awake = true) {
    if (!this._hasComponents.RigidBody) return this;
    const i = this.index;
    const on = awake ? 1 : 0;
    if (RigidBody.sleeping) RigidBody.sleeping[i] = on ? 0 : 1;
    if (isCommandRingBound()) enqueueSetAwake(i, on);
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

    const loopFlag = loop ? 1 : 0;
    if (
      SpriteRenderer.animationState[this.index] === animIndex &&
      SpriteRenderer.loop[this.index] === loopFlag
    ) {
      return;
    }

    // Set the animation and loop flag
    this.setAnimationState(animIndex);
    SpriteRenderer.loop[this.index] = loopFlag;
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
   *     this.x = spawnConfig.x ?? rng() * 800;
   *     this.y = spawnConfig.y ?? rng() * 600;
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
    if (!logicWorker || !logicWorker.frameCollisions) {
      return false;
    }

    // Collision keys are stored ONCE per pair, normalized as (min, max).
    const a = this.index;
    const minE = a < otherIndex ? a : otherIndex;
    const maxE = a < otherIndex ? otherIndex : a;
    const key = collisionPairKey(minE, maxE);

    // frameCollisions always points at the latest completed frame's pair set
    return logicWorker.frameCollisions.has(key);
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
    // 0 = inactive, 1 = active. During spawn, onSpawned may reject before activate.
    if (activeState === 0) {
      this._spawnAborted = true;
      return;
    }

    const EntityClass = this.constructor;
    const entityType = EntityClass.entityType;
    const hadPhysicsBody =
      !!(RigidBody.active?.[i] || Collider.active?.[i]);

    // ========================================
    // LIFECYCLE HOOKS (SAFE - local call)
    // ========================================
    // LIFECYCLE: Call onDespawned() BEFORE deactivating
    // This allows cleanup, saving state, triggering effects, etc.
    if (this.onDespawned) {
      this.onDespawned();
    }

    if (this._hasComponents?.Collider && Collider.layerMask) {
      const old = Collider.layerMask[i] | 0;
      Collider.layerMask[i] = 0;
      if (old) syncColliderFeed(i, old, 0);
    }

    DecorationPool.clearAttachedAndDespawnAll(i);
    ColliderFixture.removeAllForEntity(i);

    // ========================================
    // COMPONENT DEACTIVATION (SAFE - unique index)
    // ========================================
    // Deactivate all component active flags
    Transform.active[i] = 0;
    if (this.rigidBody) {
      RigidBody.active[i] = 0;
      // HEAP slot hygiene — destroy is markBodyDirty. Do not setAwake.
      RigidBody.sleeping[i] = 0;
    }
    if (this.collider) Collider.active[i] = 0;
    if (this.spriteRenderer) SpriteRenderer.active[i] = 0;
    if (this.meshRenderer) MeshRenderer.active[i] = 0;
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
      FlashComponent.castShadows[i] = 0;
    }
    if (this.lightOccluder) LightOccluder.active[i] = 0;
    if (hadPhysicsBody) markBodyDirty(i);

    // ========================================
    // FREE LIST PUSH (ATOMIC - any thread)
    // ========================================
    // Lock-free CAS push (Treiber stack) - safe against concurrent
    // spawns/despawns from any worker or the main thread
    GameObject.writeForceProcessOnLogicWorker(i, entityType, FORCE_PROCESS_ON_LOGIC_WORKER_NONE);

    if (EntityClass.freeList && EntityClass.freeListTop) {
      pushEntity(EntityClass.freeListTop, EntityClass.freeList, i, EntityClass.startIndex);
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
    return Grid.neighborData && this._neighborOffset >= 0 ? Grid.neighborData[this._neighborOffset] : 0;
  }

  /** Typed view into the neighbor SAB. Created on first read, not at bind. */
  _neighborView() {
    if (this._neighbors) return this._neighbors;
    if (this._neighborOffset < 0 || !Grid.neighborData) return null;
    this._neighbors = new (EntityIdArray())(
      Grid.neighborData.buffer,
      Grid.neighborData.byteOffset + (this._neighborOffset + 1) * entityIdBytes(),
      Grid.maxNeighbors
    );
    return this._neighbors;
  }

  getNeighbor(i) {
    return this._neighborView()[i];
  }

  getAllNeighborIds() {
    return this._neighborView().subarray(0, this.neighborCount);
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
    const neighbors = this._neighborView();

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
    const neighbors = this._neighborView();

    for (let i = 0; i < count; i++) {
      out[i] = entities[neighbors[i]];
    }
    out.length = count;
    return out;
  }

  getJointCount() {
    return Joint.getJointCount(this.index);
  }

  getJoint(i) {
    return Joint.getJoint(this.index, i);
  }

  getJoints() {
    const n = this.getJointCount();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.getJoint(i);
    return out;
  }

  /**
   * LIFECYCLE: Main update — called every frame while this type is on a tick list.
   * Omit the override (or set tickInterval = 0) so logic workers skip the type.
   * Do not write an empty tick(){}. Do not assign this.tick on an instance.
   *
   * Note: this._neighbors and this.neighborCount are updated before this is called
   * Input is available via this.mouse and this.keyboard
   *
   * @param {number} dtRatio - Delta time ratio normalized to 60fps (1.0 = 16.67ms frame)
   * @param {number} deltaTime - Actual time since last frame in milliseconds
   * @param {number} accumulatedTime - Total time elapsed since worker start (ms)
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
   *     // Use accumulatedTime (ms) for animations synced to game time
   *     this.alpha = Math.sin(accumulatedTime * 0.002) * 0.5 + 0.5;
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
   * Box2D contact-hit callback: Called when a hard impact occurs above the world
   * hit-event threshold. Opt-in via Collider.enableHitEvents. Override in subclasses.
   *
   * @param {number} otherIndex - Index of the other entity in the impact
   * @param {number} px - Contact point X (world space)
   * @param {number} py - Contact point Y (world space)
   * @param {number} nx - Contact normal X (points away from this entity)
   * @param {number} ny - Contact normal Y (points away from this entity)
   * @param {number} approachSpeed - Relative approach speed at impact
   */
  onCollisionHit(otherIndex, px, py, nx, ny, approachSpeed) {
    // Override in subclasses
  }

  /**
   * Box2D joint-break callback: Called when a joint on this entity exceeds its
   * force/torque threshold (Joint.addX opts.forceThreshold / torqueThreshold) and
   * is destroyed. Requires JointBreakListener on this entity type.
   *
   * @param {number} jointIndex - Weed Joint pool index that broke
   * @param {number} entityA - First entity of the broken joint
   * @param {number} entityB - Second entity of the broken joint
   */
  onJointBreak(jointIndex, entityA, entityB) {
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
   * SAB free lists are created in Scene buffer setup; this only resets after despawnAll.
   *
   * Uses interleaved index ordering to reduce CPU cache contention between
   * logic workers. See inline comments for details.
   *
   * @param {Class} EntityClass - The entity class to reset
   */
  static initializeFreeList(EntityClass) {
    const count = EntityClass.poolSize;

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

    // Rebuild the lock-free linked free list (all slots free, interleaved
    // pop order). Links store LOCAL slot indices; pops translate to global
    // via EntityClass.startIndex.
    resetEntity(EntityClass.freeListTop, EntityClass.freeList, count, interleaveFactor);
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
    // 2. Ball.spawn(config) - `this` is the EntityClass
    let EntityClass;
    if (typeof EntityClassOrConfig === 'function') {
      // GameObject.spawn(EntityClass, config)
      EntityClass = EntityClassOrConfig;
    } else {
      // Ball.spawn(config) — `this` is the EntityClass
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

      // Lock-free CAS pop (Treiber stack) - safe against concurrent
      // spawns/despawns from any worker or the main thread
      i = popEntity(EntityClass.freeListTop, EntityClass.freeList, EntityClass.startIndex);

      if (i < 0) {
        // Pool exhausted
        return null;
      }
    }

    // Get the instance (already created during initialization)
    const instance = EntityClass.instances[i - EntityClass.startIndex];

    if (!instance) {
      console.error(`No instance found at index ${i} for ${EntityClass.name}`);
      return null;
    }

    instance._spawnAborted = false;

    const requestedForceProcessOnLogicWorker =
      spawnConfig && typeof spawnConfig.forceProcessOnLogicWorker === 'number'
        ? spawnConfig.forceProcessOnLogicWorker
        : typeof EntityClass.forceProcessOnLogicWorker === 'number'
          ? EntityClass.forceProcessOnLogicWorker
          : FORCE_PROCESS_ON_LOGIC_WORKER_NONE;
    const logicWorkerCtx = typeof self !== 'undefined' ? self.logicWorker : null;
    const totalLogic = logicWorkerCtx ? logicWorkerCtx.totalLogicWorkers : 1;
    const forcedLogicWorker = resolveForceProcessOnLogicWorker(
      requestedForceProcessOnLogicWorker,
      totalLogic,
    );
    GameObject.writeForceProcessOnLogicWorker(i, EntityClass.entityType, forcedLogicWorker);

    if (
      forcedLogicWorker >= 0 &&
      logicWorkerCtx &&
      logicWorkerCtx.workerIndex !== forcedLogicWorker &&
      typeof logicWorkerCtx.sendDataToWorker === 'function'
    ) {
      const sx = spawnConfig.x ?? 0;
      const sy = spawnConfig.y ?? 0;
      if (
        !logicWorkerCtx._drainingSpawnRing &&
        isXyOnlySpawnConfig(spawnConfig) &&
        isSpawnCommandRingBound() &&
        tryPushSpawn(EntityClass.entityType | 0, i, sx, sy)
      ) {
        return null;
      }
      const sent = logicWorkerCtx.sendDataToWorker(`logic${forcedLogicWorker}`, {
        msg: 'spawn',
        className: EntityClass.name,
        spawnConfig,
        entityIndex: i,
      });
      if (sent) {
        debugWorkerLog(
          `GameObject.spawn: forwarded ${EntityClass.name}[${i}] to logic${forcedLogicWorker}; caller must not use a half-built instance`,
        );
        return null;
      }
    }

    // ========================================
    // COMPONENT DATA SETUP (SAFE - unique index)
    // ========================================
    // Reset component values to sensible defaults using direct array access (faster)
    // Check _hasComponents which is set in constructor based on entity's component list
    const has = instance._hasComponents;

    if (has.RigidBody) {
      RigidBody.active[i] = 1;
      RigidBody.static[i] = 0;
      RigidBody.ax[i] = 0;
      RigidBody.ay[i] = 0;
      RigidBody.vx[i] = 0;
      RigidBody.vy[i] = 0;
      RigidBody.angularVelocity[i] = 0;
      RigidBody.angularAccel[i] = 0;
      RigidBody.mass[i] = 0;
      RigidBody.invMass[i] = 0;
      RigidBody.inertia[i] = 0;
      RigidBody.invInertia[i] = 0;
      RigidBody.linearDamping[i] = 0;
      RigidBody.angularDamping[i] = 0;
      RigidBody.speed[i] = 0;
      RigidBody.fixedRotation[i] = 0;
      // Reset sleeping state (entity must start awake for physics to work)
      RigidBody.sleeping[i] = 0;
      RigidBody.sleepThreshold[i] = 0;
    }

    // Transform is always present. Stay inactive until geometry exists so
    // physics cannot createBody on Box 0×0 mid-setup.
    Transform.active[i] = 0;
    Transform.x[i] = 0;
    Transform.y[i] = 0;
    Transform.rotation[i] = 0;
    if (Transform.rotC) Transform.rotC[i] = 1;
    if (Transform.rotS) Transform.rotS[i] = 0;

    if (has.Collider) {
      Collider.active[i] = 1;
      Collider.shapeType[i] = ShapeType.Box;
      Collider.offsetX[i] = 0;
      Collider.offsetY[i] = 0;
      Collider.radius[i] = 0;
      Collider.width[i] = 0;
      Collider.height[i] = 0;
      Collider.isTrigger[i] = 0;
      Collider.collisionLayer[i] = 0;
      Collider.collisionMask[i] = 0xFFFFFFFF;
      Collider.collisionGroupIndex[i] = 0;
      Collider.friction[i] = 0;
      Collider.restitution[i] = 0;
      Collider.enableHitEvents[i] = 0;
      Collider.visualRange[i] = 0;
      Collider.polyCount[i] = 0;
      Collider.polyCentroidX[i] = 0;
      Collider.polyCentroidY[i] = 0;
      if (Collider.layerMask) {
        const old = Collider.layerMask[i] | 0;
        Collider.layerMask[i] = 0;
        if (old) syncColliderFeed(i, old, 0);
      }
      if (Collider.feedBits) Collider.feedBits[i] = 0;
      if (Collider.fixtureCount) Collider.fixtureCount[i] = 0;
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
      FlashComponent.castShadows[i] = 1; // default on; Flash.onSpawned may override
    }

    if (has.LightOccluder) {
      LightOccluder.active[i] = 1;
      LightOccluder.maskMode[i] = 0; // LIGHT_OCCLUDER_MASK_COLLIDER
      LightOccluder.block[i] = 1;
    }

    if (has.MeshRenderer) {
      MeshRenderer.active[i] = 0;
      MeshRenderer.tint[i] = 0xffffff;
      MeshRenderer.alpha[i] = 1;
      MeshRenderer.renderVisible[i] = 1;
      MeshRenderer.layerMask[i] = 0;
      MeshRenderer.textureId[i] = MESH_NO_TEXTURE;
      MeshRenderer.tileMode[i] = 0;
      MeshRenderer.repeatX[i] = 0;
      MeshRenderer.repeatY[i] = 0;
      MeshRenderer.tileOffsetU[i] = 0;
      MeshRenderer.tileOffsetV[i] = 0;
      MeshRenderer.visualOutset[i] = 0;
      MeshRenderer.renderDirty[i] = 1;
      if (MeshRenderer.paintEpoch) {
        MeshRenderer.paintEpoch[0] = (MeshRenderer.paintEpoch[0] + 1) >>> 0;
      }
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
      SpriteRenderer.inheritTransformRotation[i] = 1;
      SpriteRenderer.spriteRotC[i] = 1;
      SpriteRenderer.spriteRotS[i] = 0;
      SpriteRenderer.repeatX[i] = 0;
      SpriteRenderer.repeatY[i] = 0;
      SpriteRenderer.tileMode[i] = 0;
      SpriteRenderer.tileOffsetU[i] = 0;
      SpriteRenderer.tileOffsetV[i] = 0;
      SpriteRenderer.renderVisible[i] = 1;
      SpriteRenderer.isItOnScreen[i] = 0;
      SpriteRenderer.animationState[i] = -1;
      SpriteRenderer.spritesheetId[i] = 0;
      SpriteRenderer.loop[i] = 1; // Default: animations loop
      SpriteRenderer.renderDirty[i] = 1;
      SpriteRenderer.layerMask[i] = 0;
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
      AdobeAnimComponent.rotC[i] = 1;
      AdobeAnimComponent.rotS[i] = 0;
      AdobeAnimComponent.alpha[i] = 1;
      AdobeAnimComponent.tint[i] = 0xffffff;
      AdobeAnimComponent.layerMask[i] = 0;
      AdobeAnimComponent.renderVisible[i] = 1;
      AdobeAnimComponent.isItOnScreen[i] = 0;
      AdobeAnimComponent.boundsHalfW[i] = 0;
      AdobeAnimComponent.boundsHalfH[i] = 0;
      AdobeAnimComponent.screenX[i] = 0;
      AdobeAnimComponent.screenY[i] = 0;
    }

    // Save markBodyDirty from setters/setup/onSpawned. Physics must not
    // see want=1 with spawn-reset Box 0×0. bumpBodyGeneration after activate
    // publishes the saved marks so a child spawn from parent onSpawned gets
    // a body with the real shape.
    withBodyDirtyDeferred(() => {
      // Size before other spawnConfig keys (and before setup damping/static).
      // Skip active — Transform.active stays 0 until the bump below.
      if (has.Collider) {
        if (spawnConfig.radius != null) instance.radius = spawnConfig.radius;
        if (spawnConfig.width != null) instance.width = spawnConfig.width;
        if (spawnConfig.height != null) instance.height = spawnConfig.height;
      }
      for (const key in spawnConfig) {
        if (
          key === 'active' ||
          key === 'width' ||
          key === 'height' ||
          key === 'radius' ||
          key === 'layer' ||
          key === 'layers' ||
          key === 'forceProcessOnLogicWorker'
        ) {
          continue;
        }
        if (instance[key] !== undefined && typeof instance[key] !== 'function') {
          instance[key] = spawnConfig[key];
        }
      }

      if (spawnConfig.layers) {
        instance.setLayers(spawnConfig.layers);
      } else if (spawnConfig.layer != null) {
        instance.setLayer(spawnConfig.layer);
      }

      if (instance.setup) {
        instance.setup();
      }

      if (has.RigidBody && RigidBody.active[i]) {
        RigidBody.syncMassFromCollider(i);
      }

      if (instance.onSpawned) {
        instance.onSpawned(spawnConfig);
      }
      if (spawnConfig.layers) {
        instance.setLayers(spawnConfig.layers);
      } else if (spawnConfig.layer != null) {
        instance.setLayer(spawnConfig.layer);
      }

      const entityComponentMap = EntityClass._componentClassMap || {};
      for (const name in entityComponentMap) {
        const ComponentClass = entityComponentMap[name];
        if (ComponentClass && ComponentClass.isFSM) {
          ComponentClass.initializeEntity(i, instance);
        }
      }

      if (spawnConfig && spawnConfig._saveRestore) {
        applyEntitySaveRestore(i, EntityClass, spawnConfig._saveRestore);
      }
    });

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

    if (instance._spawnAborted) {
      instance._spawnAborted = false;
      ColliderFixture.removeAllForEntity(i);
      Transform.active[i] = 0;
      if (has.RigidBody) {
        RigidBody.active[i] = 0;
        RigidBody.sleeping[i] = 0;
      }
      if (has.Collider) Collider.active[i] = 0;
      if (has.MeshRenderer) MeshRenderer.active[i] = 0;
      if (has.SpriteRenderer) SpriteRenderer.active[i] = 0;
      GameObject.writeForceProcessOnLogicWorker(i, EntityClass.entityType, FORCE_PROCESS_ON_LOGIC_WORKER_NONE);
      if (EntityClass.freeList && EntityClass.freeListTop) {
        pushEntity(EntityClass.freeListTop, EntityClass.freeList, i, EntityClass.startIndex);
      }
      return null;
    }

    // Activate the entity - this enables spatial_worker to add it to Grid
    // and physics to process it. Must happen AFTER component setup.
    Transform.active[i] = 1;
    if (has.MeshRenderer) MeshRenderer.active[i] = 1;
    if (has.RigidBody || has.Collider) {
      bumpBodyGeneration(i);
    }

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
      const available = getFreeListCount(EntityClass.freeListTop); // SAB-backed
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

    // Phase 1: Collect all active indices and call lifecycle hooks
    // Using Set for O(1) lookup in batch removal methods
    // Reuse static buffer to avoid allocation per call
    const indicesToDespawn = GameObject._despawnAllBuffer;
    indicesToDespawn.clear();

    // Cache component active arrays for inner loop
    const transformActive = Transform.active;
    const rigidBodyActive = RigidBody.active;
    const rigidBodySleeping = RigidBody.sleeping;
    const colliderActive = Collider.active;
    const spriteRendererActive = SpriteRenderer.active;
    const meshRendererActive = MeshRenderer.active;
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
    const flashCastShadows = FlashComponent.castShadows;
    const lightOccluderActive = LightOccluder.active;

    for (let i = startIndex; i < endIndex; i++) {
      // Robust clear: treat any active component flag as "active entity".
      // This recovers from partial/corrupted states where Transform.active got out of sync.
      const isAnyComponentActive =
        transformActive[i] ||
        (rigidBodyActive && rigidBodyActive[i]) ||
        (colliderActive && colliderActive[i]) ||
        (spriteRendererActive && spriteRendererActive[i]) ||
        (meshRendererActive && meshRendererActive[i]) ||
        (adobeAnimActive && adobeAnimActive[i]) ||
        (lightEmitterActive && lightEmitterActive[i]) ||
        (shadowCasterActive && shadowCasterActive[i]) ||
        (flashActive && flashActive[i]) ||
        (lightOccluderActive && lightOccluderActive[i]);

      if (isAnyComponentActive) {
        const hadPhysicsBody =
          !!(rigidBodyActive?.[i] || colliderActive?.[i]);
        const instance = EntityClass.instances[i - startIndex];

        // Call lifecycle hook (same as individual despawn)
        if (instance?.onDespawned) {
          instance.onDespawned();
        }

        DecorationPool.clearAttachedAndDespawnAll(i);
        indicesToDespawn.add(i);

        // Deactivate all component active flags
        transformActive[i] = 0;
        GameObject.writeForceProcessOnLogicWorker(i, EntityClass.entityType, FORCE_PROCESS_ON_LOGIC_WORKER_NONE);
        if (rigidBodyActive) rigidBodyActive[i] = 0;
        if (rigidBodySleeping) rigidBodySleeping[i] = 0;
        if (colliderActive) colliderActive[i] = 0;
        if (spriteRendererActive) spriteRendererActive[i] = 0;
        if (meshRendererActive) meshRendererActive[i] = 0;
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
        if (flashCastShadows) flashCastShadows[i] = 0;
        if (lightOccluderActive) lightOccluderActive[i] = 0;
        if (hadPhysicsBody) markBodyDirty(i);
      }
    }

    if (indicesToDespawn.size === 0) return 0;

    // Phase 2: Batch remove from active lists (O(N) instead of O(N²))
    GameObject._batchRemoveFromActiveEntities(indicesToDespawn);

    // Phase 3: Clear the per-type active list entirely (O(1))
    GameObject._clearTypeActiveList(EntityClass);

    // This path mutates active/query lists immediately instead of routing through
    // logic0's queued list-update pipeline, so it must invalidate fallback caches directly.
    GameObject._bumpActiveQueryVersion();
    GameObject._publishPrecomputedActiveQueries();

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
   * When called on a subclass (e.g., Ball.getAllActive()): returns per-type active list.
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
