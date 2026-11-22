/**
 * QuerySystem - Entity query system with SharedArrayBuffer support
 *
 * Features:
 * - Bitmask-based component matching (up to 64 components via BigInt)
 * - Entity indices stored as Uint16 (max 65535 entities)
 * - Shared query results across all workers via SABs
 * - Pre-computed queries for engine components
 * - Lazy computation for developer-defined component queries
 *
 * Usage:
 *   const allLights = Query.query([LightEmitter]);                // All matching entity slots, active or inactive
 *   const activeLights = Query.queryActiveEntities([LightEmitter]); // Only active entities
 * Box2d.queryAABB is fixtures; Query.query is ECS.
 */

import { collectComponents } from '../util/utils.js';
import { debugWorkerLog } from '../util/debugLog.js';
import { Transform } from '../components/transform.js';
import { GameObject } from './gameObject.js';
import { EntityIdArray, entityIdBytes, entityIdWidth, maxEntitiesForWidth } from '../util/entityIdWidth.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum entity types (fits in BigUint64 bitmask) */
export const MAX_ENTITY_TYPES = 64;

/** Maximum components (fits in BigUint64 bitmask) */
export const MAX_COMPONENTS = 64;

/** Maximum entities (fits in Uint16) */
export const MAX_ENTITIES = 65535;

/** Complete snapshots per pre-computed active query (readers may lag without seeing torn writes) */
export const QUERY_SNAPSHOT_COUNT = 3;

/**
 * Int32 header per query: [publishedSnapshot, publishedCount, publishedFrame, publishSeq]. publishSeq counts the
 * publishes (stored after the index), so a reader that read it before the index knows its snapshot is no older than
 * that publish (E-217).
 */
const QUERY_RESULT_HEADER_INTS = 4;
const QUERY_RESULT_HEADER_BYTES = QUERY_RESULT_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;

/**
 * Uint16 entries per snapshot: [count, entity0, ...]
 * Sized to scene entity capacity (not always MAX_ENTITIES).
 * @param {number} entityCapacity
 */
export function getQuerySnapshotElements(entityCapacity) {
  const n = Math.max(0, Math.min(entityCapacity | 0, maxEntitiesForWidth()));
  return 1 + n;
}

/** Bytes for one complete snapshot at the given entity capacity. */
export function getQuerySnapshotBytes(entityCapacity) {
  return getQuerySnapshotElements(entityCapacity) * (entityIdBytes() === 4 ? 4 : 2);
}

/** Bytes per pre-computed query: atomic header + QUERY_SNAPSHOT_COUNT snapshots (4-byte aligned). */
export function calculateQueryResultBufferSize(entityCapacity) {
  const raw =
    QUERY_RESULT_HEADER_BYTES + QUERY_SNAPSHOT_COUNT * getQuerySnapshotBytes(entityCapacity);
  return (raw + 3) & ~3;
}

/** Bytes in the shared active-query version counter */
const QUERY_VERSION_BUFFER_SIZE = Int32Array.BYTES_PER_ELEMENT;

/** Reusable empty result view for query misses */
const EMPTY_QUERY_RESULT = new Uint16Array(0);
/** Result buffers query() and queryActiveEntitiesSlow() take in turn. */
const QUERY_BUFFER_POOL_SIZE = 4;

// E-265: query masks by the classes themselves, for a classes array the identity cache has not seen (a literal written
// in a tick, `Query.queryActiveEntities([SpriteRenderer])`, is a new array every call): one Map level per class, in
// the order given, the mask under MASK_LEAF at the end. No ids array, sort or string key per call (spawnStorm's logic
// built all three every call). Only arrays, and only masks whose classes all had an id (one registered later is
// looked up again).
const MASK_LEAF = Symbol('queryMask');

function maskFromTrie(trie, componentClasses) {
  if (!Array.isArray(componentClasses)) return undefined;
  let node = trie;
  const n = componentClasses.length;
  for (let k = 0; k < n; k++) {
    node = node.get(componentClasses[k]);
    if (node === undefined) return undefined;
  }
  return node.get(MASK_LEAF);
}

function maskIntoTrie(trie, componentClasses, mask) {
  if (!Array.isArray(componentClasses)) return;
  let node = trie;
  const n = componentClasses.length;
  for (let k = 0; k < n; k++) {
    const C = componentClasses[k];
    let next = node.get(C);
    if (next === undefined) {
      next = new Map();
      node.set(C, next);
    }
    node = next;
  }
  node.set(MASK_LEAF, mask);
}

// =============================================================================
// SAB LAYOUT HELPERS
// =============================================================================

/**
 * Calculate total size needed for queryResultsSAB
 * Layout:
 *   Per pre-computed query (calculateQueryResultBufferSize(entityCapacity) bytes each):
 *     [0-15]  Int32 header [publishedSnapshot, publishedCount, publishedFrame, publishSeq]
 *     [16+]   QUERY_SNAPSHOT_COUNT snapshots, each [count, entity indices...]
 *             snapshot length = 1 + min(entityCapacity, MAX_ENTITIES)
 *
 * @param {number} numQueries - Number of pre-computed queries
 * @param {number} [entityCapacity=MAX_ENTITIES] - Scene total entity slots
 * @returns {number} Buffer size in bytes
 */
export function calculateQueryResultsSABSize(numQueries, entityCapacity = MAX_ENTITIES) {
  return numQueries * calculateQueryResultBufferSize(entityCapacity);
}

function copyTypeActiveListToBuffer(typeActiveList, buffer, writeIndex) {
  const typeCount = typeActiveList[0];
  for (let i = 1; i <= typeCount; i++) {
    buffer[writeIndex++] = typeActiveList[i];
  }
  return writeIndex;
}

function copySortedRangeToBuffer(activeEntitiesData, start, end, buffer, writeIndex) {
  const totalCount = activeEntitiesData[0];
  if (totalCount === 0) {
    return writeIndex;
  }

  let lo = 1;
  let hi = 1 + totalCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (activeEntitiesData[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;

  hi = 1 + totalCount;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (activeEntitiesData[mid] < end) lo = mid + 1;
    else hi = mid;
  }

  for (let i = first; i < lo; i++) {
    buffer[writeIndex++] = activeEntitiesData[i];
  }

  return writeIndex;
}

/**
 * The entity type indices a type mask selects, lowest first: the order a walk of its bits visits
 * them. Computed once per mask; the walks below read this list, because walking the BigInt
 * itself allocated a BigInt per step (E-104: 199 KB/s in each Predator logic worker).
 */
function typeIndicesOf(typeMask) {
  const out = [];
  let m = typeMask;
  for (let i = 0; m !== 0n; i++, m >>= 1n) {
    if ((m & 1n) !== 0n) out.push(i);
  }
  return Int32Array.from(out);
}

/** A precomputed query's type indices (set when the query is built; computed once if not). */
function queryTypeIndices(query) {
  return query.typeIndices || (query.typeIndices = typeIndicesOf(query.typeMask));
}

function copyActiveMatchesToBuffer(
  typeIndices,
  entityMetadata,
  activeEntitiesData,
  buffer,
  getTypeActiveList,
  initialWriteIndex = 0
) {
  let writeIndex = initialWriteIndex;

  for (let t = 0; t < typeIndices.length; t++) {
    const typeIndex = typeIndices[t];
    const typeActiveList = getTypeActiveList ? getTypeActiveList(typeIndex) : null;

    if (typeActiveList) {
      writeIndex = copyTypeActiveListToBuffer(typeActiveList, buffer, writeIndex);
    } else if (activeEntitiesData) {
      const meta = entityMetadata[typeIndex];
      writeIndex = copySortedRangeToBuffer(
        activeEntitiesData,
        meta.startIndex,
        meta.endIndex,
        buffer,
        writeIndex
      );
    }
  }

  return writeIndex;
}

function createCachedQueryEntry(totalEntityCount) {
  return {
    version: -1,
    count: -1,
    buffer: new (EntityIdArray())(totalEntityCount),
    subarray: EMPTY_QUERY_RESULT,
  };
}

function updateCachedQueryEntry(entry, count, version) {
  entry.version = version;
  if (entry.count !== count) {
    entry.count = count;
    entry.subarray = count === 0 ? EMPTY_QUERY_RESULT : entry.buffer.subarray(0, count);
  }
  return entry.subarray;
}

function createQuerySnapshotViews(sab, queryIndex, entityCapacity) {
  const bufferSize = calculateQueryResultBufferSize(entityCapacity);
  const snapshotElements = getQuerySnapshotElements(entityCapacity);
  const snapshotBytes = getQuerySnapshotBytes(entityCapacity);
  const baseOffset = queryIndex * bufferSize;
  const header = new Int32Array(sab, baseOffset, QUERY_RESULT_HEADER_INTS);
  const snapshots = [];

  for (let i = 0; i < QUERY_SNAPSHOT_COUNT; i++) {
    const snapshotOffset = baseOffset + QUERY_RESULT_HEADER_BYTES + i * snapshotBytes;
    snapshots.push(new (EntityIdArray())(sab, snapshotOffset, snapshotElements));
  }

  return {
    header,
    snapshots,
    cachedSnapshot: -1,
    cachedCount: -1,
    cachedSeq: -1,
    subarray: null,
  };
}

function readPublishedQuerySnapshot(snapshotView) {
  // The publisher writes the snapshot payload, then the count, then the index
  // last. Reading index-then-count therefore lets a publish land between our two
  // loads and hands us the old index with the new count - old data, new length,
  // and the tail is stale entity ids from an earlier frame.
  //
  // Fix: accept the pair only when the count we read is the count that snapshot
  // actually holds. The per-snapshot count is written before the index is
  // published, so a matching pair means both loads saw the same publish. On a
  // mismatch, re-read. Bounded because the publisher always converges.
  //
  // E-217: the same view back means no publish since it was made, so a reader that copied it may keep its copy. The
  // publish sequence is read first: the publisher stores it after the index, so the snapshot read next is no older
  // than that publish, and a sequence that did not move means the contents did not either (the index alone comes
  // back round after QUERY_SNAPSHOT_COUNT publishes).
  const seq = Atomics.load(snapshotView.header, 3);
  for (let attempt = 0; attempt < 4; attempt++) {
    const snapshotIndex = Atomics.load(snapshotView.header, 0);
    const count = Atomics.load(snapshotView.header, 1);
    const snapshot = snapshotView.snapshots[snapshotIndex] || snapshotView.snapshots[0];
    if ((snapshot[0] | 0) !== (count | 0)) continue;

    if (
      snapshotView.cachedSnapshot === snapshotIndex &&
      snapshotView.cachedCount === count &&
      snapshotView.cachedSeq === seq &&
      snapshotView.subarray !== null
    ) {
      return snapshotView.subarray;
    }
    const subarray = count === 0 ? EMPTY_QUERY_RESULT : snapshot.subarray(1, 1 + count);
    snapshotView.cachedSnapshot = snapshotIndex;
    snapshotView.cachedCount = count;
    snapshotView.cachedSeq = seq;
    snapshotView.subarray = subarray;
    return subarray;
  }

  // Contended the whole way through. Trust the snapshot's own count header
  // rather than the shared one: it is the value that actually describes the
  // bytes we are about to hand out.
  const snapshotIndex = Atomics.load(snapshotView.header, 0);
  const snapshot = snapshotView.snapshots[snapshotIndex] || snapshotView.snapshots[0];
  const count = snapshot[0] | 0;
  const subarray = count === 0 ? EMPTY_QUERY_RESULT : snapshot.subarray(1, 1 + count);
  snapshotView.cachedSnapshot = snapshotIndex;
  snapshotView.cachedCount = count;
  snapshotView.cachedSeq = seq;
  snapshotView.subarray = subarray;
  return subarray;
}

function publishQuerySnapshot(snapshotView, count, frameNumber) {
  const currentSnapshot = Atomics.load(snapshotView.header, 0);
  const nextSnapshot = (currentSnapshot + 1) % QUERY_SNAPSHOT_COUNT;
  const snapshot = snapshotView.snapshots[nextSnapshot];

  snapshot[0] = count;
  Atomics.store(snapshotView.header, 1, count);
  Atomics.store(snapshotView.header, 2, frameNumber | 0);
  // Publish the index last so readers never observe the new buffer before its data/count.
  Atomics.store(snapshotView.header, 0, nextSnapshot);
  // E-217: then the sequence, which a reader loads before the index.
  Atomics.add(snapshotView.header, 3, 1);
}

function getQueryComponentNames(componentClasses) {
  return componentClasses.map((ComponentClass) => ComponentClass?.name || 'unknown').join(', ');
}

// =============================================================================
// QUERYSYSTEM CLASS
// =============================================================================

export class QuerySystem {
  constructor() {
    /**
     * Entity type metadata (populated during buildQueries)
     * Array of { entityType, className, entityClass, componentMask, startIndex, endIndex, poolSize }
     */
    this.entityMetadata = [];

    /**
     * Map from queryMask (BigInt) to typeMask (BigInt)
     * Cached locally for query() calls (all entities, no SAB needed)
     */
    this.queryToTypeMask = new Map();
    /** queryMask (BigInt) → its type indices (Int32Array), for the walks (E-104). */
    this.queryToTypeIndices = new Map();

    /**
     * Pre-computed query definitions
     * Array of { name, componentClasses, queryMask, typeMask, typeIndices, resultOffset }
     */
    this.precomputedQueries = [];

    /**
     * Map from queryMask (BigInt) to index in precomputedQueries
     * For quick lookup in queryActiveEntities()
     */
    this.queryMaskToIndex = new Map();

    // SAB references (set after createSharedBuffers)
    this.queryResultsSAB = null;
    this.queryVersionSAB = null;

    /** Entity slots used to size query result snapshots (≤ MAX_ENTITIES). */
    this.queryEntityCapacity = 0;

    /**
     * Cache for queryMask generation to avoid repeated BigInt allocations
     * Map: componentIds string (sorted, comma-joined) → queryMask (BigInt)
     */
    this.queryMaskCache = new Map();

    /**
     * Identity cache: stable componentClasses array → queryMask.
     * Hot callers hoist the array (`this._querySpriteRenderer`); skip ids/sort/join after first hit.
     * ponytail: do not mutate the array after the first query — WeakMap would go stale. Rebuild a new array instead.
     */
    this.queryMaskByClasses = new WeakMap();
    /** E-265: masks by the classes themselves (maskFromTrie), for arrays the identity cache has not seen. */
    this.queryMaskByTrie = new Map();

    // Typed array views into SABs
    this.entityMetadataView = null;
    this.queryCacheView = null;
    this.queryVersionData = null;
    this.queryResultViews = []; // Snapshot views, one per pre-computed query
    this._fallbackActiveQueryCache = new Map();
    // One closure for every copy, not one per query per publish.
    this._typeActiveListOf = (typeIndex) => this._getTypeActiveList(typeIndex);

    /**
     * Reusable buffers for query() and queryActiveEntitiesSlow() results, taken in turn (QUERY_BUFFER_POOL_SIZE: a few
     * queries in one tick keep their results). Made once entityMetadata is known (buildQueries, fromSerialized). A
     * result is a temporary view: consume it at once, do not store it.
     */
    this._queryResultBuffers = [];
    this._queryResultBufferIndex = 0;
    /** The active entity list the walks read; null: GameObject.activeEntitiesData (fromSerialized may give its own). */
    this.activeEntitiesData = null;
    /** Each type's active list, found once: its class's _activeList (a worker finds the class on its global scope). */
    this._typeActiveLists = [];
    /** Component classes already warned about (no componentId, or one past MAX_COMPONENTS): once each. */
    this._warnedComponents = new Set();
  }

  /**
   * N-303 CR-26: a worker's QuerySystem, from the page's serialize() and the shared buffers: the same class the page
   * runs, reading the published snapshots (queryActiveEntities), the type ranges (query) and the active list
   * (queryActiveEntitiesSlow, publishPrecomputedActiveQueries).
   * @param {Object} queryData - serialize()'s output
   * @param {{ queryResultsSAB: SharedArrayBuffer }} buffers
   * @param {Uint16Array|Uint32Array|null} activeEntitiesData - the active entity list (null: GameObject's)
   * @param {Int32Array|null} queryVersionData - the shared invalidation counter of the slow queries' caches
   * @returns {QuerySystem}
   */
  static fromSerialized(queryData, buffers, activeEntitiesData, queryVersionData = null) {
    const system = new QuerySystem();
    system.entityMetadata = queryData.metadata.map((m) => ({ ...m, componentMask: BigInt(m.componentMask) }));
    system.precomputedQueries = queryData.precomputedQueries.map((q) => ({
      ...q,
      queryMask: BigInt(q.queryMask),
      typeMask: BigInt(q.typeMask),
      typeIndices: typeIndicesOf(BigInt(q.typeMask)),
    }));
    for (let i = 0; i < system.precomputedQueries.length; i++) {
      const q = system.precomputedQueries[i];
      system.queryMaskToIndex.set(q.queryMask, i);
      system.queryToTypeIndices.set(q.queryMask, q.typeIndices);
    }
    system.queryEntityCapacity =
      queryData.queryEntityCapacity ?? system.entityMetadata.reduce((sum, m) => sum + (m.poolSize || 0), 0);
    system.queryResultsSAB = buffers.queryResultsSAB;
    system._initializeQueryResultViews();
    system.activeEntitiesData = activeEntitiesData || null;
    system.queryVersionData = queryVersionData;
    system._makeResultBuffers(system.entityMetadata.reduce((sum, m) => sum + m.poolSize, 0));
    return system;
  }

  /** The result buffers, each `totalEntities` long. @private */
  _makeResultBuffers(totalEntities) {
    this._queryResultBuffers = [];
    for (let i = 0; i < QUERY_BUFFER_POOL_SIZE; i++) this._queryResultBuffers.push(new (EntityIdArray())(totalEntities));
    this._queryResultBufferIndex = 0;
  }

  /** The next result buffer in turn, or null before they are made. @private */
  _nextResultBuffer() {
    const buffers = this._queryResultBuffers;
    if (buffers.length === 0) return null;
    const buffer = buffers[this._queryResultBufferIndex];
    this._queryResultBufferIndex = (this._queryResultBufferIndex + 1) % buffers.length;
    return buffer;
  }

  /** The active entity list the walks read. @private */
  _activeData() {
    return this.activeEntitiesData || GameObject.activeEntitiesData;
  }

  /** One warning per component class. @private */
  _warnComponent(ComponentClass, text) {
    if (this._warnedComponents.has(ComponentClass)) return;
    this._warnedComponents.add(ComponentClass);
    console.warn(text);
  }

  /**
   * Build metadata from registered classes and compute component masks
   * @param {Array} registeredClasses - Array of {class, count, startIndex, entityType}
   */
  buildQueries(registeredClasses) {
    debugWorkerLog('[QuerySystem] Building queries with bitmask optimization...');

    // Store metadata for each entity class with componentMask
    this.entityMetadata = registeredClasses.map(
      ({ class: EntityClass, count, startIndex, entityType }) => {
        // Collect all components including Transform
        const components = Array.from(collectComponents(EntityClass, GameObject, Transform));

        // Compute componentMask (BigInt bitmask)
        let componentMask = 0n;
        for (const ComponentClass of components) {
          const componentId = ComponentClass.componentId;
          // Check for null, undefined, or non-number
          if (componentId == null || typeof componentId !== 'number') {
            console.warn(
              `[QuerySystem] Component ${ComponentClass.name} has no componentId assigned (got: ${componentId})`
            );
            continue;
          }
          if (componentId >= MAX_COMPONENTS) {
            console.error(
              `[QuerySystem] Component ${ComponentClass.name} has componentId ${componentId} >= MAX_COMPONENTS (${MAX_COMPONENTS})`
            );
            continue;
          }
          componentMask |= 1n << BigInt(componentId);
        }

        return {
          entityType,
          className: EntityClass.name,
          entityClass: EntityClass,
          components,
          componentMask,
          startIndex,
          endIndex: startIndex + count,
          poolSize: count,
        };
      }
    );

    // Validate entity type count
    if (this.entityMetadata.length > MAX_ENTITY_TYPES) {
      console.error(
        `[QuerySystem] Too many entity types: ${this.entityMetadata.length} > MAX_ENTITY_TYPES (${MAX_ENTITY_TYPES})`
      );
    }

    // The reusable result buffers (max size = total entities)
    const totalEntities = this.entityMetadata.reduce((sum, meta) => sum + meta.poolSize, 0);
    this._makeResultBuffers(totalEntities);

    this._logStatistics();
  }

  /**
   * Define which queries to pre-compute for engine components
   * Call this after buildQueries() and before createSharedBuffers()
   *
   * @param {Object} componentClasses - Map of component names to classes
   */
  definePrecomputedQueries(componentClasses, sceneQueries = []) {
    const {
      Transform,
      RigidBody,
      Collider,
      SpriteRenderer,
      AdobeAnimComponent,
      LightEmitter,
      ShadowCaster,
      FlashComponent,
      LightOccluder,
      CameraInOutListener,
      CollisionListener,
      Grab,
    } = componentClasses;

    // Define single-component queries
    const singleComponentQueries = [
      { name: 'Transform', components: [Transform] },
      { name: 'RigidBody', components: [RigidBody] },
      { name: 'Collider', components: [Collider] },
      { name: 'SpriteRenderer', components: [SpriteRenderer] },
      { name: 'AdobeAnimComponent', components: [AdobeAnimComponent] },
      { name: 'LightEmitter', components: [LightEmitter] },
      { name: 'ShadowCaster', components: [ShadowCaster] },
      { name: 'FlashComponent', components: [FlashComponent] },
      { name: 'LightOccluder', components: [LightOccluder] },
      { name: 'CameraInOutListener', components: [CameraInOutListener] },
      { name: 'CollisionListener', components: [CollisionListener] },
      { name: 'Grab', components: [Grab] },
    ].filter((q) =>
      q.components.every((c) => c !== undefined && typeof c.componentId === 'number')
    );

    // Define common multi-component queries
    const multiComponentQueries = [
      { name: 'RigidBody+Collider', components: [RigidBody, Collider] },
      { name: 'LightEmitter+ShadowCaster', components: [LightEmitter, ShadowCaster] },
      { name: 'LightEmitter+FlashComponent', components: [LightEmitter, FlashComponent] },
      { name: 'SpriteRenderer+RigidBody', components: [SpriteRenderer, RigidBody] },
    ].filter((q) =>
      q.components.every((c) => c !== undefined && typeof c.componentId === 'number')
    );

    const customQueries = sceneQueries
      .filter((components) => Array.isArray(components) && components.length > 0)
      .map((components) => ({
        name: components.map((ComponentClass) => ComponentClass?.name || 'unknown').join('+'),
        components,
      }))
      .filter((q) =>
        q.components.every((c) => c !== undefined && typeof c.componentId === 'number')
      );

    const allQueries = [...singleComponentQueries, ...multiComponentQueries, ...customQueries];

    // Compute queryMask and typeMask for each
    this.precomputedQueries = [];
    this.queryMaskToIndex.clear();
    const entityCapacity = this.entityMetadata.reduce((sum, meta) => sum + (meta.poolSize || 0), 0);
    this.queryEntityCapacity = Math.min(entityCapacity, maxEntitiesForWidth());
    const resultBufferSize = calculateQueryResultBufferSize(this.queryEntityCapacity);
    let resultOffset = 0;
    const seenQueryMasks = new Set();

    for (const queryDef of allQueries) {
      const queryMask = this._generateQueryMask(queryDef.components);
      if (seenQueryMasks.has(queryMask)) continue;
      seenQueryMasks.add(queryMask);
      const typeMask = this._computeTypeMask(queryMask);

      this.precomputedQueries.push({
        name: queryDef.name,
        componentClasses: queryDef.components,
        queryMask,
        typeMask,
        typeIndices: typeIndicesOf(typeMask),
        resultOffset,
      });

      this.queryMaskToIndex.set(queryMask, this.precomputedQueries.length - 1);
      this.queryToTypeMask.set(queryMask, typeMask);

      resultOffset += resultBufferSize;
    }

    debugWorkerLog(`[QuerySystem] Defined ${this.precomputedQueries.length} pre-computed queries:`);
    for (const q of this.precomputedQueries) {
      const matchingTypes = this._getMatchingTypeNames(q.typeMask);
      debugWorkerLog(`  - ${q.name}: matches [${matchingTypes.join(', ')}]`);
    }
  }

  /**
   * Create SharedArrayBuffers for query system
   * Call this after definePrecomputedQueries()
   *
   * @returns {Object} - { queryResultsSAB, queryVersionSAB }
   */
  createSharedBuffers() {
    const numPrecomputed = this.precomputedQueries.length;

    // Create queryVersionSAB
    this.queryVersionSAB = new SharedArrayBuffer(QUERY_VERSION_BUFFER_SIZE);
    this.queryVersionData = new Int32Array(this.queryVersionSAB);
    this.queryVersionData[0] = 1;

    // Create queryResultsSAB (triple snapshots sized to scene entity capacity)
    if (!this.queryEntityCapacity) {
      this.queryEntityCapacity = Math.min(
        this.entityMetadata.reduce((sum, meta) => sum + (meta.poolSize || 0), 0),
        maxEntitiesForWidth()
      );
    }
    const queryResultsSize = calculateQueryResultsSABSize(
      numPrecomputed,
      this.queryEntityCapacity
    );
    this.queryResultsSAB = new SharedArrayBuffer(queryResultsSize);
    this._initializeQueryResultViews();

    debugWorkerLog(`[QuerySystem] Created SABs:`);
    debugWorkerLog(
      `  - queryResultsSAB: ${queryResultsSize} bytes (${numPrecomputed} result buffers × ${this.queryEntityCapacity} entity cap)`
    );
    debugWorkerLog(`  - queryVersionSAB: ${QUERY_VERSION_BUFFER_SIZE} bytes (shared invalidation counter)`);

    return {
      queryResultsSAB: this.queryResultsSAB,
      queryVersionSAB: this.queryVersionSAB,
    };
  }

  /**
   * Initialize query result views
   * @private
   */
  _initializeQueryResultViews() {
    this.queryResultViews = [];
    // Keep 0 when scene has no entity pools — do NOT fall back to MAX_ENTITIES
    // (SAB was sized with queryEntityCapacity; mismatch throws RangeError on Uint16Array).
    const capacity = this.queryEntityCapacity | 0;

    for (let i = 0; i < this.precomputedQueries.length; i++) {
      this.queryResultViews.push(
        createQuerySnapshotViews(this.queryResultsSAB, i, capacity)
      );
    }
  }

  /**
   * Generate queryMask (BigInt bitmask) from component classes
   * Uses caching to avoid repeated BigInt allocations in hot paths
   * @param {Array} componentClasses - Array of component classes
   * @returns {BigInt} - Bitmask representing the component combination
   */
  _generateQueryMask(componentClasses) {
    const identityHit = this.queryMaskByClasses.get(componentClasses);
    if (identityHit !== undefined) return identityHit;
    const trieHit = maskFromTrie(this.queryMaskByTrie, componentClasses);
    if (trieHit !== undefined) return trieHit;

    // Extract and validate component IDs (cheap number operations)
    const ids = [];
    for (const ComponentClass of componentClasses) {
      const componentId = ComponentClass.componentId;
      if (componentId == null || typeof componentId !== 'number') {
        this._warnComponent(
          ComponentClass,
          `[QuerySystem] Component ${ComponentClass?.name || 'unknown'} has no componentId (got: ${componentId}). Was it registered?`
        );
        continue;
      }
      if (componentId >= MAX_COMPONENTS) {
        this._warnComponent(
          ComponentClass,
          `[QuerySystem] Component ${ComponentClass.name} has componentId ${componentId} >= MAX_COMPONENTS (${MAX_COMPONENTS})`
        );
        continue;
      }
      ids.push(componentId);
    }

    // Generate cache key from sorted IDs (string ops are cheaper than BigInt)
    ids.sort((a, b) => a - b);
    const cacheKey = ids.join(',');

    // Check cache first
    const cached = this.queryMaskCache.get(cacheKey);
    if (cached !== undefined) {
      this.queryMaskByClasses.set(componentClasses, cached);
      if (ids.length === componentClasses.length) maskIntoTrie(this.queryMaskByTrie, componentClasses, cached);
      return cached;
    }

    // Compute mask (expensive BigInt operations - only done once per unique query)
    let mask = 0n;
    for (const id of ids) {
      mask |= 1n << BigInt(id);
    }

    // Cache and return
    this.queryMaskCache.set(cacheKey, mask);
    this.queryMaskByClasses.set(componentClasses, mask);
    if (ids.length === componentClasses.length) maskIntoTrie(this.queryMaskByTrie, componentClasses, mask);
    return mask;
  }

  /**
   * Compute typeMask (which entity types have all required components)
   * @param {BigInt} queryMask - Component bitmask
   * @returns {BigInt} - Entity type bitmask
   */
  _computeTypeMask(queryMask) {
    let typeMask = 0n;

    for (let i = 0; i < this.entityMetadata.length; i++) {
      const meta = this.entityMetadata[i];
      // Check if entity type has ALL required components
      if ((meta.componentMask & queryMask) === queryMask) {
        typeMask |= 1n << BigInt(i);
      }
    }

    return typeMask;
  }

  /**
   * Get entity type names that match a typeMask
   * @private
   */
  _getMatchingTypeNames(typeMask) {
    const names = [];
    for (let i = 0; i < this.entityMetadata.length; i++) {
      if ((typeMask & (1n << BigInt(i))) !== 0n) {
        names.push(this.entityMetadata[i].className);
      }
    }
    return names;
  }

  /**
   * Query for ALL entities with specified components (regardless of active state)
   * Returns cached static result - component composition never changes at runtime
   *
   * @param {Array} componentClasses - Array of component classes
   * @returns {Uint16Array} - Entity indices (may be shared, do not modify)
   */
  query(componentClasses) {
    const queryMask = this._generateQueryMask(componentClasses);

    // Check local cache
    // Build result from matching entity type ranges
    return this._buildQueryResult(this._typeIndicesForQuery(queryMask));
  }

  /** The type indices of a query mask, computed once (E-104). @private */
  _typeIndicesForQuery(queryMask) {
    let typeIndices = this.queryToTypeIndices.get(queryMask);
    if (typeIndices === undefined) {
      let typeMask = this.queryToTypeMask.get(queryMask);
      if (typeMask === undefined) {
        typeMask = this._computeTypeMask(queryMask);
        this.queryToTypeMask.set(queryMask, typeMask);
      }
      typeIndices = typeIndicesOf(typeMask);
      this.queryToTypeIndices.set(queryMask, typeIndices);
    }
    return typeIndices;
  }

  /**
   * Build query result array from typeMask
   * Uses reusable buffer to avoid GC pressure. Result is a temporary view - consume immediately, do not store.
   * @private
   */
  _buildQueryResult(typeIndices) {
    const buffer = this._nextResultBuffer();
    if (!buffer) return EMPTY_QUERY_RESULT;

    let writeIndex = 0;

    for (let t = 0; t < typeIndices.length; t++) {
      const meta = this.entityMetadata[typeIndices[t]];

      for (let i = meta.startIndex; i < meta.endIndex; i++) {
        buffer[writeIndex++] = i;
      }
    }

    return buffer.subarray(0, writeIndex);
  }

  /**
   * Query for ACTIVE entities with specified components
   * Requires a pre-computed query. Use queryActiveEntitiesSlow() for explicit ad hoc queries.
   *
   * @param {Array} componentClasses - Array of component classes
   * @returns {Uint16Array} - Active entity indices (view into SAB, do not modify)
   */
  queryActiveEntities(componentClasses) {
    const queryMask = this._generateQueryMask(componentClasses);

    // Check if this is a pre-computed query
    const queryIndex = this.queryMaskToIndex.get(queryMask);

    if (queryIndex !== undefined) {
      return readPublishedQuerySnapshot(this.queryResultViews[queryIndex]);
    }

    throw new Error(
      `[QuerySystem] queryActiveEntities([${getQueryComponentNames(componentClasses)}]) is not precomputed. ` +
      `Declare it as a scene query or call queryActiveEntitiesSlow() explicitly.`
    );
  }

  /** publishedFrame of a precomputed active query. -1 if that query is not precomputed. */
  queryPublishedFrame(componentClasses) {
    const queryMask = this._generateQueryMask(componentClasses);
    const queryIndex = this.queryMaskToIndex.get(queryMask);
    if (queryIndex === undefined) return -1;
    const header = this.queryResultViews[queryIndex]?.header;
    if (!header) return -1;
    return Atomics.load(header, 2);
  }

  /**
   * Explicit slow active query path for ad hoc component combinations.
   * Prefer GameObject/type APIs or precomputed scene queries in hot code.
   *
   * @param {Array} componentClasses - Array of component classes
   * @returns {Uint16Array} - Active entity indices
   */
  queryActiveEntitiesSlow(componentClasses) {
    const queryMask = this._generateQueryMask(componentClasses);
    return this._computeActiveQueryFromMask(queryMask);
  }

  /**
   * Compute active query result on-demand (fallback for non-precomputed queries)
   * @private
   */
  _computeActiveQueryFromMask(queryMask) {
    const typeIndices = this._typeIndicesForQuery(queryMask);

    const currentVersion = this.queryVersionData ? Atomics.load(this.queryVersionData, 0) : -1;
    let cachedEntry = currentVersion !== -1 ? this._fallbackActiveQueryCache.get(queryMask) : null;

    if (cachedEntry && cachedEntry.version === currentVersion) {
      return cachedEntry.subarray;
    }

    const activeData = this._activeData();
    if (currentVersion !== -1) {
      if (!cachedEntry) {
        cachedEntry = createCachedQueryEntry(this._queryResultBuffers.length > 0 ? this._queryResultBuffers[0].length : 0);
        this._fallbackActiveQueryCache.set(queryMask, cachedEntry);
      }
      if (activeData && activeData[0] === 0) {
        return updateCachedQueryEntry(cachedEntry, 0, currentVersion);
      }
      const count = copyActiveMatchesToBuffer(
        typeIndices,
        this.entityMetadata,
        activeData,
        cachedEntry.buffer,
        this._typeActiveListOf
      );
      return updateCachedQueryEntry(cachedEntry, count, currentVersion);
    }

    if (activeData && activeData[0] === 0) {
      return EMPTY_QUERY_RESULT;
    }
    const buffer = this._nextResultBuffer();
    if (!buffer) return EMPTY_QUERY_RESULT;

    const count = copyActiveMatchesToBuffer(
      typeIndices,
      this.entityMetadata,
      activeData,
      buffer,
      this._typeActiveListOf
    );

    return count === 0 ? EMPTY_QUERY_RESULT : buffer.subarray(0, count);
  }

  _getTypeActiveList(typeIndex) {
    const cached = this._typeActiveLists[typeIndex];
    if (cached) return cached;
    const meta = this.entityMetadata[typeIndex];
    if (!meta) return null;
    // The page's metadata holds the class; a worker's (serialized) names it, and the worker's scope has it.
    const EntityClass = meta.entityClass || globalThis[meta.className];
    const activeList = EntityClass?._activeList || null;
    if (activeList) this._typeActiveLists[typeIndex] = activeList;
    return activeList;
  }

  publishPrecomputedActiveQueries(frameNumber = 0) {
    const activeData = this._activeData();

    for (let q = 0; q < this.precomputedQueries.length; q++) {
      const query = this.precomputedQueries[q];
      const snapshotView = this.queryResultViews[q];
      const writeSnapshot =
        (Atomics.load(snapshotView.header, 0) + 1) % QUERY_SNAPSHOT_COUNT;
      const buffer = snapshotView.snapshots[writeSnapshot];
      const count =
        copyActiveMatchesToBuffer(
          queryTypeIndices(query),
          this.entityMetadata,
          activeData,
          buffer,
          this._typeActiveListOf,
          1
        ) - 1;
      publishQuerySnapshot(snapshotView, count, frameNumber);
    }
  }

  /**
   * Serialize for sending to workers via postMessage
   */
  serialize() {
    return {
      metadata: this.entityMetadata.map((meta) => ({
        entityType: meta.entityType,
        className: meta.className,
        componentMask: meta.componentMask.toString(), // BigInt → string for serialization
        startIndex: meta.startIndex,
        endIndex: meta.endIndex,
        poolSize: meta.poolSize,
      })),
      queryEntityCapacity: this.queryEntityCapacity | 0,
      precomputedQueries: this.precomputedQueries.map((q) => ({
        name: q.name,
        queryMask: q.queryMask.toString(),
        typeMask: q.typeMask.toString(),
        resultOffset: q.resultOffset,
      })),
    };
  }

  /**
   * Log statistics about entity metadata
   * @private
   */
  _logStatistics() {
    const totalEntities = this.entityMetadata.reduce((sum, meta) => sum + meta.poolSize, 0);
    debugWorkerLog(
      `[QuerySystem] Built metadata for ${this.entityMetadata.length} entity types (${totalEntities} total entities)`
    );

    for (const meta of this.entityMetadata) {
      const componentNames = meta.components.map((c) => c.name).join(', ');
      debugWorkerLog(
        `  - ${meta.className}: [${componentNames}] (mask: 0x${meta.componentMask.toString(16)})`
      );
    }
  }

  /**
   * Get number of pre-computed queries
   */
  getPrecomputedQueryCount() {
    return this.precomputedQueries.length;
  }
}
