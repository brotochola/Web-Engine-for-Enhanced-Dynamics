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
 *   const allLights = query([LightEmitter]);                // All matching entity slots, active or inactive
 *   const activeLights = queryActiveEntities([LightEmitter]); // Only active entities
 */

import { collectComponents, countTrailingZeros } from './utils.js';
import { Transform } from '../components/Transform.js';
import { GameObject } from './gameObject.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum entity types (fits in BigUint64 bitmask) */
export const MAX_ENTITY_TYPES = 64;

/** Maximum components (fits in BigUint64 bitmask) */
export const MAX_COMPONENTS = 64;

/** Maximum entities (fits in Uint16) */
export const MAX_ENTITIES = 65535;

/** Maximum pre-computed queries */
export const MAX_PRECOMPUTED_QUERIES = 64;

/** Complete snapshots per pre-computed active query (readers may lag without seeing torn writes) */
const QUERY_SNAPSHOT_COUNT = 3;

/** Bytes per entity type metadata entry (aligned to 16 bytes) */
const ENTITY_TYPE_ENTRY_SIZE = 16;

/** Bytes per query cache entry */
const QUERY_CACHE_ENTRY_SIZE = 16;

/** Int32 header per query: [publishedSnapshot, publishedCount, publishedFrame, reserved] */
const QUERY_RESULT_HEADER_INTS = 4;
const QUERY_RESULT_HEADER_BYTES = QUERY_RESULT_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT;

/** Uint16 entries per snapshot: [count, entity0, entity1, ...] */
const QUERY_RESULT_SNAPSHOT_ELEMENTS = 1 + MAX_ENTITIES;
const QUERY_RESULT_SNAPSHOT_BYTES = QUERY_RESULT_SNAPSHOT_ELEMENTS * Uint16Array.BYTES_PER_ELEMENT;

/** Bytes per pre-computed query: atomic header + complete active-list snapshots */
const QUERY_RESULT_BUFFER_SIZE =
  QUERY_RESULT_HEADER_BYTES + QUERY_SNAPSHOT_COUNT * QUERY_RESULT_SNAPSHOT_BYTES;

/** Bytes in the shared active-query version counter */
const QUERY_VERSION_BUFFER_SIZE = Int32Array.BYTES_PER_ELEMENT;

/** Reusable empty result view for query misses */
const EMPTY_QUERY_RESULT = new Uint16Array(0);

// =============================================================================
// SAB LAYOUT HELPERS
// =============================================================================

/**
 * Calculate total size needed for entityMetadataSAB
 * Layout:
 *   [0-1]   numTypes (Uint16)
 *   [2-15]  padding (14 bytes for alignment)
 *   [16+]   Per-type entries (16 bytes each):
 *           [0-7]   componentMask (BigUint64)
 *           [8-9]   startIndex (Uint16)
 *           [10-11] endIndex (Uint16)
 *           [12-15] padding (4 bytes)
 *
 * @param {number} numTypes - Number of entity types
 * @returns {number} Buffer size in bytes
 */
export function calculateEntityMetadataSABSize(numTypes) {
  return 16 + numTypes * ENTITY_TYPE_ENTRY_SIZE;
}

/**
 * Calculate total size needed for queryCacheSAB
 * Layout:
 *   [0-1]   numQueries (Uint16)
 *   [2-3]   maxQueries (Uint16)
 *   [4-7]   padding (4 bytes)
 *   [8+]    Per-query entries (16 bytes each):
 *           [0-7]   queryMask (BigUint64) - component combination
 *           [8-15]  typeMask (BigUint64) - matching entity types
 *
 * @param {number} maxQueries - Maximum number of cached queries
 * @returns {number} Buffer size in bytes
 */
export function calculateQueryCacheSABSize(maxQueries) {
  return 8 + maxQueries * QUERY_CACHE_ENTRY_SIZE;
}

/**
 * Calculate total size needed for queryResultsSAB
 * Layout:
 *   Per pre-computed query (QUERY_RESULT_BUFFER_SIZE bytes each):
 *     [0-15]  Int32 header [publishedSnapshot, publishedCount, publishedFrame, reserved]
 *     [16+]   QUERY_SNAPSHOT_COUNT snapshots, each [count, entity indices...]
 *
 * @param {number} numQueries - Number of pre-computed queries
 * @returns {number} Buffer size in bytes
 */
export function calculateQueryResultsSABSize(numQueries) {
  return numQueries * QUERY_RESULT_BUFFER_SIZE;
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

function copyActiveMatchesToBuffer(
  typeMask,
  entityMetadata,
  activeEntitiesData,
  buffer,
  getTypeActiveList,
  initialWriteIndex = 0
) {
  let writeIndex = initialWriteIndex;
  let mask = typeMask;

  while (mask !== 0n) {
    const typeIndex = countTrailingZeros(mask);
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

    mask &= mask - 1n;
  }

  return writeIndex;
}

function createCachedQueryEntry(totalEntityCount) {
  return {
    version: -1,
    count: -1,
    buffer: new Uint16Array(totalEntityCount),
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

function createQuerySnapshotViews(sab, queryIndex) {
  const baseOffset = queryIndex * QUERY_RESULT_BUFFER_SIZE;
  const header = new Int32Array(sab, baseOffset, QUERY_RESULT_HEADER_INTS);
  const snapshots = [];

  for (let i = 0; i < QUERY_SNAPSHOT_COUNT; i++) {
    const snapshotOffset =
      baseOffset + QUERY_RESULT_HEADER_BYTES + i * QUERY_RESULT_SNAPSHOT_BYTES;
    snapshots.push(new Uint16Array(sab, snapshotOffset, QUERY_RESULT_SNAPSHOT_ELEMENTS));
  }

  return {
    header,
    snapshots,
    cachedSnapshot: -1,
    cachedCount: -1,
    subarray: null,
  };
}

function readPublishedQuerySnapshot(snapshotView) {
  const snapshotIndex = Atomics.load(snapshotView.header, 0);
  const count = Atomics.load(snapshotView.header, 1);

  if (
    snapshotView.cachedSnapshot === snapshotIndex &&
    snapshotView.cachedCount === count &&
    snapshotView.subarray !== null
  ) {
    return snapshotView.subarray;
  }

  const snapshot = snapshotView.snapshots[snapshotIndex] || snapshotView.snapshots[0];
  const subarray = count === 0 ? EMPTY_QUERY_RESULT : snapshot.subarray(1, 1 + count);
  snapshotView.cachedSnapshot = snapshotIndex;
  snapshotView.cachedCount = count;
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

    /**
     * Pre-computed query definitions
     * Array of { name, componentClasses, queryMask, typeMask, resultOffset }
     */
    this.precomputedQueries = [];

    /**
     * Map from queryMask (BigInt) to index in precomputedQueries
     * For quick lookup in queryActiveEntities()
     */
    this.queryMaskToIndex = new Map();

    // SAB references (set after createSharedBuffers)
    this.entityMetadataSAB = null;
    this.queryCacheSAB = null;
    this.queryResultsSAB = null;
    this.queryVersionSAB = null;

    /**
     * Cache for queryMask generation to avoid repeated BigInt allocations
     * Map: componentIds string (sorted, comma-joined) → queryMask (BigInt)
     */
    this.queryMaskCache = new Map();

    // Typed array views into SABs
    this.entityMetadataView = null;
    this.queryCacheView = null;
    this.queryVersionData = null;
    this.queryResultViews = []; // Array of Uint16Array views, one per pre-computed query
    this._cachedPrecomputedSubarrayViews = [];
    this._fallbackActiveQueryCache = new Map();

    /**
     * Reusable buffer for query() results - avoids GC pressure from repeated allocations.
     * Initialized in buildQueries() when entityMetadata is known.
     * Result is a temporary view - consume immediately, do not store.
     */
    this._queryResultBuffer = null;
  }

  /**
   * Build metadata from registered classes and compute component masks
   * @param {Array} registeredClasses - Array of {class, count, startIndex, entityType}
   */
  buildQueries(registeredClasses) {
    console.log('[QuerySystem] Building queries with bitmask optimization...');

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

    // Initialize reusable buffer for query() results (max size = total entities)
    const totalEntities = this.entityMetadata.reduce((sum, meta) => sum + meta.poolSize, 0);
    this._queryResultBuffer = new Uint16Array(totalEntities);

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
    ].filter((q) => q.components.every((c) => c !== undefined));

    // Define common multi-component queries
    const multiComponentQueries = [
      { name: 'RigidBody+Collider', components: [RigidBody, Collider] },
      { name: 'LightEmitter+ShadowCaster', components: [LightEmitter, ShadowCaster] },
      { name: 'LightEmitter+FlashComponent', components: [LightEmitter, FlashComponent] },
      { name: 'SpriteRenderer+RigidBody', components: [SpriteRenderer, RigidBody] },
    ].filter((q) => q.components.every((c) => c !== undefined));

    const customQueries = sceneQueries
      .filter((components) => Array.isArray(components) && components.length > 0)
      .map((components) => ({
        name: components.map((ComponentClass) => ComponentClass?.name || 'unknown').join('+'),
        components,
      }))
      .filter((q) => q.components.every((c) => c !== undefined));

    const allQueries = [...singleComponentQueries, ...multiComponentQueries, ...customQueries];

    // Compute queryMask and typeMask for each
    this.precomputedQueries = [];
    this.queryMaskToIndex.clear();
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
        resultOffset,
      });

      this.queryMaskToIndex.set(queryMask, this.precomputedQueries.length - 1);
      this.queryToTypeMask.set(queryMask, typeMask);

      resultOffset += QUERY_RESULT_BUFFER_SIZE;
    }

    console.log(`[QuerySystem] Defined ${this.precomputedQueries.length} pre-computed queries:`);
    for (const q of this.precomputedQueries) {
      const matchingTypes = this._getMatchingTypeNames(q.typeMask);
      console.log(`  - ${q.name}: matches [${matchingTypes.join(', ')}]`);
    }
  }

  /**
   * Create SharedArrayBuffers for query system
   * Call this after definePrecomputedQueries()
   *
   * @returns {Object} - { entityMetadataSAB, queryCacheSAB, queryResultsSAB }
   */
  createSharedBuffers() {
    const numTypes = this.entityMetadata.length;
    const numPrecomputed = this.precomputedQueries.length;

    // Create entityMetadataSAB
    const entityMetadataSize = calculateEntityMetadataSABSize(numTypes);
    this.entityMetadataSAB = new SharedArrayBuffer(entityMetadataSize);
    this._writeEntityMetadataToSAB();

    // Create queryCacheSAB
    const queryCacheSize = calculateQueryCacheSABSize(MAX_PRECOMPUTED_QUERIES);
    this.queryCacheSAB = new SharedArrayBuffer(queryCacheSize);
    this._writeQueryCacheToSAB();

    // Create queryVersionSAB
    this.queryVersionSAB = new SharedArrayBuffer(QUERY_VERSION_BUFFER_SIZE);
    this.queryVersionData = new Int32Array(this.queryVersionSAB);
    this.queryVersionData[0] = 1;

    // Create queryResultsSAB
    const queryResultsSize = calculateQueryResultsSABSize(numPrecomputed);
    this.queryResultsSAB = new SharedArrayBuffer(queryResultsSize);
    this._initializeQueryResultViews();

    console.log(`[QuerySystem] Created SABs:`);
    console.log(`  - entityMetadataSAB: ${entityMetadataSize} bytes (${numTypes} types)`);
    console.log(
      `  - queryCacheSAB: ${queryCacheSize} bytes (${numPrecomputed}/${MAX_PRECOMPUTED_QUERIES} queries)`
    );
    console.log(
      `  - queryResultsSAB: ${queryResultsSize} bytes (${numPrecomputed} result buffers)`
    );
    console.log(`  - queryVersionSAB: ${QUERY_VERSION_BUFFER_SIZE} bytes (shared invalidation counter)`);

    return {
      entityMetadataSAB: this.entityMetadataSAB,
      queryCacheSAB: this.queryCacheSAB,
      queryResultsSAB: this.queryResultsSAB,
      queryVersionSAB: this.queryVersionSAB,
    };
  }

  /**
   * Write entity metadata to SAB
   * @private
   */
  _writeEntityMetadataToSAB() {
    const buffer = this.entityMetadataSAB;
    const numTypes = this.entityMetadata.length;

    // Write header
    const headerView = new Uint16Array(buffer, 0, 1);
    headerView[0] = numTypes;

    // Write per-type entries
    for (let i = 0; i < numTypes; i++) {
      const meta = this.entityMetadata[i];
      const entryOffset = 16 + i * ENTITY_TYPE_ENTRY_SIZE;

      // componentMask (BigUint64 at offset 0)
      const maskView = new BigUint64Array(buffer, entryOffset, 1);
      maskView[0] = meta.componentMask;

      // startIndex and endIndex (Uint16 at offset 8 and 10)
      const indexView = new Uint16Array(buffer, entryOffset + 8, 2);
      indexView[0] = meta.startIndex;
      indexView[1] = meta.endIndex;
    }
  }

  /**
   * Write query cache to SAB
   * @private
   */
  _writeQueryCacheToSAB() {
    const buffer = this.queryCacheSAB;
    const numQueries = this.precomputedQueries.length;

    // Write header
    const headerView = new Uint16Array(buffer, 0, 2);
    headerView[0] = numQueries;
    headerView[1] = MAX_PRECOMPUTED_QUERIES;

    // Write per-query entries
    for (let i = 0; i < numQueries; i++) {
      const query = this.precomputedQueries[i];
      const entryOffset = 8 + i * QUERY_CACHE_ENTRY_SIZE;

      // queryMask (BigUint64 at offset 0)
      const maskView = new BigUint64Array(buffer, entryOffset, 2);
      maskView[0] = query.queryMask;
      maskView[1] = query.typeMask;
    }
  }

  /**
   * Initialize query result views
   * @private
   */
  _initializeQueryResultViews() {
    this.queryResultViews = [];
    this._cachedPrecomputedSubarrayViews = [];

    for (let i = 0; i < this.precomputedQueries.length; i++) {
      this.queryResultViews.push(createQuerySnapshotViews(this.queryResultsSAB, i));
    }
  }

  /**
   * Generate queryMask (BigInt bitmask) from component classes
   * Uses caching to avoid repeated BigInt allocations in hot paths
   * @param {Array} componentClasses - Array of component classes
   * @returns {BigInt} - Bitmask representing the component combination
   */
  _generateQueryMask(componentClasses) {
    // Extract and validate component IDs (cheap number operations)
    const ids = [];
    for (const ComponentClass of componentClasses) {
      const componentId = ComponentClass.componentId;
      if (componentId == null || typeof componentId !== 'number') {
        console.warn(
          `[QuerySystem] Component ${ComponentClass?.name || 'unknown'} has no componentId (got: ${componentId}). Was it registered?`
        );
        continue;
      }
      if (componentId >= MAX_COMPONENTS) {
        console.warn(
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
      return cached;
    }

    // Compute mask (expensive BigInt operations - only done once per unique query)
    let mask = 0n;
    for (const id of ids) {
      mask |= 1n << BigInt(id);
    }

    // Cache and return
    this.queryMaskCache.set(cacheKey, mask);
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
    let typeMask = this.queryToTypeMask.get(queryMask);
    if (typeMask === undefined) {
      // Compute and cache
      typeMask = this._computeTypeMask(queryMask);
      this.queryToTypeMask.set(queryMask, typeMask);
    }

    // Build result from matching entity type ranges
    return this._buildQueryResult(typeMask);
  }

  /**
   * Build query result array from typeMask
   * Uses reusable buffer to avoid GC pressure. Result is a temporary view - consume immediately, do not store.
   * @private
   */
  _buildQueryResult(typeMask) {
    const buffer = this._queryResultBuffer;
    if (!buffer) return new Uint16Array(0);

    let writeIndex = 0;
    let mask = typeMask;

    while (mask !== 0n) {
      const typeIndex = countTrailingZeros(mask);
      const meta = this.entityMetadata[typeIndex];

      for (let i = meta.startIndex; i < meta.endIndex; i++) {
        buffer[writeIndex++] = i;
      }

      mask &= mask - 1n;
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
    let typeMask = this.queryToTypeMask.get(queryMask);
    if (typeMask === undefined) {
      typeMask = this._computeTypeMask(queryMask);
      this.queryToTypeMask.set(queryMask, typeMask);
    }

    const currentVersion = this.queryVersionData ? Atomics.load(this.queryVersionData, 0) : -1;
    let cachedEntry = currentVersion !== -1 ? this._fallbackActiveQueryCache.get(queryMask) : null;

    if (cachedEntry && cachedEntry.version === currentVersion) {
      return cachedEntry.subarray;
    }

    // Get activeEntitiesData from GameObject
    const activeData = GameObject.activeEntitiesData;
    if (currentVersion !== -1) {
      if (!cachedEntry) {
        cachedEntry = createCachedQueryEntry(this._queryResultBuffer?.length || 0);
        this._fallbackActiveQueryCache.set(queryMask, cachedEntry);
      }
      if (activeData && activeData[0] === 0) {
        return updateCachedQueryEntry(cachedEntry, 0, currentVersion);
      }
      const count = copyActiveMatchesToBuffer(
        typeMask,
        this.entityMetadata,
        activeData,
        cachedEntry.buffer,
        (typeIndex) => this._getTypeActiveList(typeIndex)
      );
      return updateCachedQueryEntry(cachedEntry, count, currentVersion);
    }

    const buffer = this._queryResultBuffer;
    if (!buffer) return EMPTY_QUERY_RESULT;
    if (activeData && activeData[0] === 0) {
      return EMPTY_QUERY_RESULT;
    }

    const count = copyActiveMatchesToBuffer(
      typeMask,
      this.entityMetadata,
      activeData,
      buffer,
      (typeIndex) => this._getTypeActiveList(typeIndex)
    );

    return count === 0 ? EMPTY_QUERY_RESULT : buffer.subarray(0, count);
  }

  _getTypeActiveList(typeIndex) {
    const meta = this.entityMetadata[typeIndex];
    return meta?.entityClass?._activeList || null;
  }

  publishPrecomputedActiveQueries(frameNumber = 0) {
    const activeData = GameObject.activeEntitiesData;

    for (let q = 0; q < this.precomputedQueries.length; q++) {
      const query = this.precomputedQueries[q];
      const snapshotView = this.queryResultViews[q];
      const writeSnapshot =
        (Atomics.load(snapshotView.header, 0) + 1) % QUERY_SNAPSHOT_COUNT;
      const buffer = snapshotView.snapshots[writeSnapshot];
      const count =
        copyActiveMatchesToBuffer(
          query.typeMask,
          this.entityMetadata,
          activeData,
          buffer,
          (typeIndex) => this._getTypeActiveList(typeIndex),
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
    console.log(
      `[QuerySystem] Built metadata for ${this.entityMetadata.length} entity types (${totalEntities} total entities)`
    );

    for (const meta of this.entityMetadata) {
      const componentNames = meta.components.map((c) => c.name).join(', ');
      console.log(
        `  - ${meta.className}: [${componentNames}] (mask: 0x${meta.componentMask.toString(16)})`
      );
    }
  }

  /**
   * Get the result buffer view for a pre-computed query by index
   * Internal helper for direct access to pre-computed query result buffers.
   *
   * @param {number} queryIndex - Index in precomputedQueries array
   * @returns {Uint16Array} - Result buffer view (index 0 = count, rest = entity indices)
   */
  getQueryResultBuffer(queryIndex) {
    return this.queryResultViews[queryIndex];
  }

  /**
   * Get info about a pre-computed query by index
   * Internal helper for systems that need direct access to query metadata.
   *
   * @param {number} queryIndex - Index in precomputedQueries array
   * @returns {Object} - { name, queryMask, typeMask }
   */
  getPrecomputedQueryInfo(queryIndex) {
    return this.precomputedQueries[queryIndex];
  }

  /**
   * Get number of pre-computed queries
   */
  getPrecomputedQueryCount() {
    return this.precomputedQueries.length;
  }
}

// =============================================================================
// WORKER-SIDE QUERY FUNCTION FACTORY
// =============================================================================

/**
 * Create query functions for use in workers
 * Called after receiving SAB references from main thread
 *
 * @param {Object} queryData - Serialized query data from main thread
 * @param {Object} buffers - SAB references { entityMetadataSAB, queryCacheSAB, queryResultsSAB }
 * @param {Uint16Array} activeEntitiesData - Reference to active entities SAB
 * @param {Int32Array|null} queryVersionData - Shared invalidation counter for active-query result caches
 * @returns {Object} - { query, queryActiveEntities }
 */
export function createWorkerQueryFunctions(queryData, buffers, activeEntitiesData, queryVersionData = null) {
  // Reconstruct metadata from serialized data
  const entityMetadata = queryData.metadata.map((m) => ({
    ...m,
    componentMask: BigInt(m.componentMask), // string → BigInt
  }));

  // Reconstruct pre-computed queries
  const precomputedQueries = queryData.precomputedQueries.map((q) => ({
    ...q,
    queryMask: BigInt(q.queryMask),
    typeMask: BigInt(q.typeMask),
  }));

  // Build queryMask → index lookup
  const queryMaskToIndex = new Map();
  precomputedQueries.forEach((q, i) => {
    queryMaskToIndex.set(q.queryMask, i);
  });

  // Build queryMask → typeMask cache
  const queryToTypeMask = new Map();
  precomputedQueries.forEach((q) => {
    queryToTypeMask.set(q.queryMask, q.typeMask);
  });

  // Create result views for pre-computed queries
  const queryResultViews = precomputedQueries.map((q, i) => {
    return createQuerySnapshotViews(buffers.queryResultsSAB, i);
  });

  // OPTIMIZATION: Cache queryMask generation to avoid repeated BigInt allocations
  // Map: componentIds string (sorted, comma-joined) → queryMask (BigInt)
  const queryMaskCache = new Map();

  // Cache per-type active list SAB views once entity classes are attached to global scope.
  const cachedTypeActiveLists = new Array(entityMetadata.length);
  const fallbackActiveQueryCache = queryVersionData ? new Map() : null;

  // OPTIMIZATION: Reusable buffers for query() and queryActiveEntitiesSlow() - avoids GC pressure
  // Multiple buffers allow several queries in the same tick without overwriting
  // Result is a temporary view - consume immediately, do not store
  const totalEntityCount = entityMetadata.reduce((sum, m) => sum + m.poolSize, 0);
  const QUERY_BUFFER_POOL_SIZE = 4;
  const queryResultBuffers = Array.from({ length: QUERY_BUFFER_POOL_SIZE }, () =>
    new Uint16Array(totalEntityCount)
  );
  let queryResultBufferIndex = 0;

  // Helper: generate queryMask from component classes (with caching)
  function generateQueryMask(componentClasses) {
    // Extract and validate component IDs (cheap number operations)
    const ids = [];
    for (const ComponentClass of componentClasses) {
      const componentId = ComponentClass.componentId;
      if (componentId == null || typeof componentId !== 'number') {
        // console.warn(
        //   `[QuerySystem] Component ${ComponentClass?.name || 'unknown'} has no componentId (got: ${componentId}). Was it registered?`
        // );
        continue;
      }
      if (componentId >= MAX_COMPONENTS) {
        continue;
      }
      ids.push(componentId);
    }

    // Generate cache key from sorted IDs (string ops are cheaper than BigInt)
    ids.sort((a, b) => a - b);
    const cacheKey = ids.join(',');

    // Check cache first
    const cached = queryMaskCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    // Compute mask (expensive BigInt operations - only done once per unique query)
    let mask = 0n;
    for (const id of ids) {
      mask |= 1n << BigInt(id);
    }

    // Cache and return
    queryMaskCache.set(cacheKey, mask);
    return mask;
  }

  // Helper: compute typeMask for a queryMask
  function computeTypeMask(queryMask) {
    let typeMask = 0n;
    for (let i = 0; i < entityMetadata.length; i++) {
      const meta = entityMetadata[i];
      if ((meta.componentMask & queryMask) === queryMask) {
        typeMask |= 1n << BigInt(i);
      }
    }
    return typeMask;
  }

  function getTypeActiveList(typeIndex) {
    const cached = cachedTypeActiveLists[typeIndex];
    if (cached) {
      return cached;
    }

    const className = entityMetadata[typeIndex]?.className;
    if (!className) {
      return null;
    }

    const EntityClass = globalThis[className];
    const activeList = EntityClass?._activeList || null;
    if (activeList) {
      cachedTypeActiveLists[typeIndex] = activeList;
    }
    return activeList;
  }

  /**
   * Query for ALL entities with specified components
   * including inactive entities.
   * Result is a temporary view - consume immediately, do not store.
   */
  function query(componentClasses) {
    const queryMask = generateQueryMask(componentClasses);

    let typeMask = queryToTypeMask.get(queryMask);
    if (typeMask === undefined) {
      typeMask = computeTypeMask(queryMask);
      queryToTypeMask.set(queryMask, typeMask);
    }

    const buffer = queryResultBuffers[queryResultBufferIndex];
    queryResultBufferIndex = (queryResultBufferIndex + 1) % QUERY_BUFFER_POOL_SIZE;
    let writeIndex = 0;
    let mask = typeMask;

    while (mask !== 0n) {
      const typeIndex = countTrailingZeros(mask);
      const meta = entityMetadata[typeIndex];
      for (let i = meta.startIndex; i < meta.endIndex; i++) {
        buffer[writeIndex++] = i;
      }
      mask &= mask - 1n;
    }

    return buffer.subarray(0, writeIndex);
  }

  /**
   * Query for ACTIVE entities with specified components
   * Returns view into pre-populated SAB for pre-computed queries.
   * Throws for ad hoc combinations; use queryActiveEntitiesSlow() explicitly.
   */
  function queryActiveEntities(componentClasses) {
    const queryMask = generateQueryMask(componentClasses);

    // Check if pre-computed
    const queryIndex = queryMaskToIndex.get(queryMask);

    if (queryIndex !== undefined) {
      return readPublishedQuerySnapshot(queryResultViews[queryIndex]);
    }

    throw new Error(
      `[QuerySystem] queryActiveEntities([${getQueryComponentNames(componentClasses)}]) is not precomputed. ` +
      `Declare it as a scene query or call queryActiveEntitiesSlow() explicitly.`
    );
  }

  function queryActiveEntitiesSlow(componentClasses) {
    const queryMask = generateQueryMask(componentClasses);

    let typeMask = queryToTypeMask.get(queryMask);
    if (typeMask === undefined) {
      typeMask = computeTypeMask(queryMask);
      queryToTypeMask.set(queryMask, typeMask);
    }

    const currentVersion = queryVersionData ? Atomics.load(queryVersionData, 0) : -1;
    let cachedEntry = currentVersion !== -1 ? fallbackActiveQueryCache.get(queryMask) : null;

    if (cachedEntry && cachedEntry.version === currentVersion) {
      return cachedEntry.subarray;
    }

    if (currentVersion !== -1) {
      if (!cachedEntry) {
        cachedEntry = createCachedQueryEntry(totalEntityCount);
        fallbackActiveQueryCache.set(queryMask, cachedEntry);
      }
      if (activeEntitiesData && activeEntitiesData[0] === 0) {
        return updateCachedQueryEntry(cachedEntry, 0, currentVersion);
      }
      const count = copyActiveMatchesToBuffer(
        typeMask,
        entityMetadata,
        activeEntitiesData,
        cachedEntry.buffer,
        getTypeActiveList
      );
      return updateCachedQueryEntry(cachedEntry, count, currentVersion);
    }

    if (activeEntitiesData && activeEntitiesData[0] === 0) {
      return EMPTY_QUERY_RESULT;
    }

    const buffer = queryResultBuffers[queryResultBufferIndex];
    queryResultBufferIndex = (queryResultBufferIndex + 1) % QUERY_BUFFER_POOL_SIZE;
    const count = copyActiveMatchesToBuffer(
      typeMask,
      entityMetadata,
      activeEntitiesData,
      buffer,
      getTypeActiveList
    );

    return count === 0 ? EMPTY_QUERY_RESULT : buffer.subarray(0, count);
  }

  return {
    query,
    queryActiveEntities,
    queryActiveEntitiesSlow,
    publishPrecomputedActiveQueries(frameNumber = 0) {
      for (let q = 0; q < precomputedQueries.length; q++) {
        const queryDef = precomputedQueries[q];
        const snapshotView = queryResultViews[q];
        const writeSnapshot =
          (Atomics.load(snapshotView.header, 0) + 1) % QUERY_SNAPSHOT_COUNT;
        const buffer = snapshotView.snapshots[writeSnapshot];
        const count =
          copyActiveMatchesToBuffer(
            queryDef.typeMask,
            entityMetadata,
            activeEntitiesData,
            buffer,
            getTypeActiveList,
            1
          ) - 1;
        publishQuerySnapshot(snapshotView, count, frameNumber);
      }
    },
    _precomputedQueries: precomputedQueries,
    _entityMetadata: entityMetadata,
  };
}
