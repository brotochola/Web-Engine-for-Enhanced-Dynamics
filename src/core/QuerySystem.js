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
 *   const allLights = query([LightEmitter]);           // All entities with component
 *   const activeLights = queryActiveEntities([LightEmitter]); // Only active entities
 */

import { collectComponents } from './utils.js';
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

/** Bytes per entity type metadata entry (aligned to 16 bytes) */
const ENTITY_TYPE_ENTRY_SIZE = 16;

/** Bytes per query cache entry */
const QUERY_CACHE_ENTRY_SIZE = 16;

/** Bytes per query result buffer (count + max entities as Uint16) */
const QUERY_RESULT_BUFFER_SIZE = 2 + MAX_ENTITIES * 2; // ~128KB per query

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
 *     [0-1]   count (Uint16)
 *     [2+]    entity indices (Uint16 array, max 65535 entries)
 *
 * @param {number} numQueries - Number of pre-computed queries
 * @returns {number} Buffer size in bytes
 */
export function calculateQueryResultsSABSize(numQueries) {
  return numQueries * QUERY_RESULT_BUFFER_SIZE;
}

// =============================================================================
// QUERYSYSTEM CLASS
// =============================================================================

export class QuerySystem {
  constructor() {
    /**
     * Entity type metadata (populated during buildQueries)
     * Array of { entityType, className, componentMask, startIndex, endIndex, poolSize }
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

    // Typed array views into SABs
    this.entityMetadataView = null;
    this.queryCacheView = null;
    this.queryResultViews = []; // Array of Uint16Array views, one per pre-computed query
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

    this._logStatistics();
  }

  /**
   * Define which queries to pre-compute for engine components
   * Call this after buildQueries() and before createSharedBuffers()
   *
   * @param {Object} componentClasses - Map of component names to classes
   */
  definePrecomputedQueries(componentClasses) {
    const {
      Transform,
      RigidBody,
      Collider,
      SpriteRenderer,
      LightEmitter,
      ShadowCaster,
      FlashComponent,
    } = componentClasses;

    // Define single-component queries
    const singleComponentQueries = [
      { name: 'Transform', components: [Transform] },
      { name: 'RigidBody', components: [RigidBody] },
      { name: 'Collider', components: [Collider] },
      { name: 'SpriteRenderer', components: [SpriteRenderer] },
      { name: 'LightEmitter', components: [LightEmitter] },
      { name: 'ShadowCaster', components: [ShadowCaster] },
      { name: 'FlashComponent', components: [FlashComponent] },
    ].filter((q) => q.components.every((c) => c !== undefined));

    // Define common multi-component queries
    const multiComponentQueries = [
      { name: 'RigidBody+Collider', components: [RigidBody, Collider] },
      { name: 'LightEmitter+ShadowCaster', components: [LightEmitter, ShadowCaster] },
      { name: 'LightEmitter+FlashComponent', components: [LightEmitter, FlashComponent] },
      { name: 'SpriteRenderer+RigidBody', components: [SpriteRenderer, RigidBody] },
    ].filter((q) => q.components.every((c) => c !== undefined));

    const allQueries = [...singleComponentQueries, ...multiComponentQueries];

    // Compute queryMask and typeMask for each
    this.precomputedQueries = [];
    let resultOffset = 0;

    for (const queryDef of allQueries) {
      const queryMask = this._generateQueryMask(queryDef.components);
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

    return {
      entityMetadataSAB: this.entityMetadataSAB,
      queryCacheSAB: this.queryCacheSAB,
      queryResultsSAB: this.queryResultsSAB,
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

    for (let i = 0; i < this.precomputedQueries.length; i++) {
      const offset = i * QUERY_RESULT_BUFFER_SIZE;
      const view = new Uint16Array(this.queryResultsSAB, offset, 1 + MAX_ENTITIES);
      view[0] = 0; // Initialize count to 0
      this.queryResultViews.push(view);
    }
  }

  /**
   * Generate queryMask (BigInt bitmask) from component classes
   * @param {Array} componentClasses - Array of component classes
   * @returns {BigInt} - Bitmask representing the component combination
   */
  _generateQueryMask(componentClasses) {
    let mask = 0n;
    for (const ComponentClass of componentClasses) {
      const componentId = ComponentClass.componentId;
      // Check for null, undefined, or non-number
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
      mask |= 1n << BigInt(componentId);
    }
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
   * @private
   */
  _buildQueryResult(typeMask) {
    // Count total entities first
    let totalCount = 0;
    let mask = typeMask;
    while (mask !== 0n) {
      const typeIndex = this._countTrailingZeros(mask);
      const meta = this.entityMetadata[typeIndex];
      totalCount += meta.poolSize;
      mask &= mask - 1n; // Clear lowest set bit
    }

    // Allocate and fill result array
    const result = new Uint16Array(totalCount);
    let writeIndex = 0;
    mask = typeMask;

    while (mask !== 0n) {
      const typeIndex = this._countTrailingZeros(mask);
      const meta = this.entityMetadata[typeIndex];

      for (let i = meta.startIndex; i < meta.endIndex; i++) {
        result[writeIndex++] = i;
      }

      mask &= mask - 1n;
    }

    return result;
  }

  /**
   * Query for ACTIVE entities with specified components
   * Returns view into pre-populated SAB (updated each frame by particle_worker)
   *
   * @param {Array} componentClasses - Array of component classes
   * @returns {Uint16Array} - Active entity indices (view into SAB, do not modify)
   */
  queryActiveEntities(componentClasses) {
    const queryMask = this._generateQueryMask(componentClasses);

    // Check if this is a pre-computed query
    const queryIndex = this.queryMaskToIndex.get(queryMask);

    if (queryIndex !== undefined) {
      // Return view into pre-computed result buffer
      const view = this.queryResultViews[queryIndex];
      const count = view[0];
      return view.subarray(1, 1 + count);
    }

    // Not pre-computed - fall back to computing from activeEntitiesData
    // This path is slower but works for any component combination
    console.warn(
      `[QuerySystem] queryActiveEntities called with non-precomputed query. Consider adding to precomputedQueries.`
    );
    return this._computeActiveQuery(componentClasses);
  }

  /**
   * Compute active query result on-demand (fallback for non-precomputed queries)
   * @private
   */
  _computeActiveQuery(componentClasses) {
    // Get typeMask
    const queryMask = this._generateQueryMask(componentClasses);
    let typeMask = this.queryToTypeMask.get(queryMask);
    if (typeMask === undefined) {
      typeMask = this._computeTypeMask(queryMask);
      this.queryToTypeMask.set(queryMask, typeMask);
    }

    // Get activeEntitiesData from GameObject
    const activeData = GameObject.activeEntitiesData;
    if (!activeData) {
      return new Uint16Array(0);
    }

    const totalActive = activeData[0];
    if (totalActive === 0) {
      return new Uint16Array(0);
    }

    // For each matching entity type, binary search activeEntitiesData
    const result = new Uint16Array(totalActive); // Max possible size
    let count = 0;

    let mask = typeMask;
    while (mask !== 0n) {
      const typeIndex = this._countTrailingZeros(mask);
      const meta = this.entityMetadata[typeIndex];

      // Binary search for range [startIndex, endIndex) in activeData
      const slice = this._binarySearchRange(activeData, meta.startIndex, meta.endIndex);

      for (let i = 0; i < slice.length; i++) {
        result[count++] = slice[i];
      }

      mask &= mask - 1n;
    }

    return result.subarray(0, count);
  }

  /**
   * Binary search for indices in range [start, end) within sorted activeData
   * @private
   */
  _binarySearchRange(activeData, start, end) {
    const totalCount = activeData[0];
    if (totalCount === 0) return new Uint16Array(0);

    // Binary search for first index >= start
    let lo = 1;
    let hi = 1 + totalCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (activeData[mid] < start) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;

    // Binary search for first index >= end
    hi = 1 + totalCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (activeData[mid] < end) lo = mid + 1;
      else hi = mid;
    }
    const last = lo;

    // Return subarray view
    return activeData.subarray(first, last);
  }

  /**
   * Count trailing zeros in BigInt (position of lowest set bit)
   * @private
   */
  _countTrailingZeros(n) {
    if (n === 0n) return 64;
    let count = 0;
    while ((n & 1n) === 0n) {
      n >>= 1n;
      count++;
    }
    return count;
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
   * Used by particle_worker to populate results each frame
   *
   * @param {number} queryIndex - Index in precomputedQueries array
   * @returns {Uint16Array} - Result buffer view (index 0 = count, rest = entity indices)
   */
  getQueryResultBuffer(queryIndex) {
    return this.queryResultViews[queryIndex];
  }

  /**
   * Get info about a pre-computed query by index
   * Used by particle_worker to know which entity types to check
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
 * @param {Uint32Array} activeEntitiesData - Reference to active entities SAB
 * @returns {Object} - { query, queryActiveEntities }
 */
export function createWorkerQueryFunctions(queryData, buffers, activeEntitiesData) {
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
    const offset = i * QUERY_RESULT_BUFFER_SIZE;
    return new Uint16Array(buffers.queryResultsSAB, offset, 1 + MAX_ENTITIES);
  });

  // Helper: generate queryMask from component classes
  function generateQueryMask(componentClasses) {
    let mask = 0n;
    for (const ComponentClass of componentClasses) {
      const componentId = ComponentClass.componentId;
      // Check for null, undefined, or non-number
      if (componentId == null || typeof componentId !== 'number') {
        console.warn(
          `[QuerySystem] Component ${ComponentClass?.name || 'unknown'} has no componentId (got: ${componentId}). Was it registered?`
        );
        continue;
      }
      if (componentId >= MAX_COMPONENTS) {
        continue;
      }
      mask |= 1n << BigInt(componentId);
    }
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

  // Helper: count trailing zeros in BigInt
  function countTrailingZeros(n) {
    if (n === 0n) return 64;
    let count = 0;
    while ((n & 1n) === 0n) {
      n >>= 1n;
      count++;
    }
    return count;
  }

  // Helper: binary search for range in sorted array
  function binarySearchRange(data, start, end) {
    const totalCount = data[0];
    if (totalCount === 0) return data.subarray(1, 1);

    let lo = 1;
    let hi = 1 + totalCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (data[mid] < start) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;

    hi = 1 + totalCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (data[mid] < end) lo = mid + 1;
      else hi = mid;
    }
    const last = lo;

    return data.subarray(first, last);
  }

  /**
   * Query for ALL entities with specified components
   * including inactive entities
   */
  function query(componentClasses) {
    const queryMask = generateQueryMask(componentClasses);

    let typeMask = queryToTypeMask.get(queryMask);
    if (typeMask === undefined) {
      typeMask = computeTypeMask(queryMask);
      queryToTypeMask.set(queryMask, typeMask);
    }

    // Build result from matching entity type ranges
    let totalCount = 0;
    let mask = typeMask;
    while (mask !== 0n) {
      const typeIndex = countTrailingZeros(mask);
      totalCount += entityMetadata[typeIndex].poolSize;
      mask &= mask - 1n;
    }

    const result = new Uint16Array(totalCount);
    let writeIndex = 0;
    mask = typeMask;

    while (mask !== 0n) {
      const typeIndex = countTrailingZeros(mask);
      const meta = entityMetadata[typeIndex];
      for (let i = meta.startIndex; i < meta.endIndex; i++) {
        result[writeIndex++] = i;
      }
      mask &= mask - 1n;
    }

    return result;
  }

  /**
   * Query for ACTIVE entities with specified components
   * Returns view into pre-populated SAB for pre-computed queries
   */
  function queryActiveEntities(componentClasses) {
    const queryMask = generateQueryMask(componentClasses);

    // Check if pre-computed
    const queryIndex = queryMaskToIndex.get(queryMask);

    if (queryIndex !== undefined) {
      const view = queryResultViews[queryIndex];
      const count = view[0];
      return view.subarray(1, 1 + count);
    }

    // Fallback: compute from activeEntitiesData
    let typeMask = queryToTypeMask.get(queryMask);
    if (typeMask === undefined) {
      typeMask = computeTypeMask(queryMask);
      queryToTypeMask.set(queryMask, typeMask);
    }

    if (!activeEntitiesData || activeEntitiesData[0] === 0) {
      return new Uint16Array(0);
    }

    const result = new Uint16Array(activeEntitiesData[0]);
    let count = 0;

    let mask = typeMask;
    while (mask !== 0n) {
      const typeIndex = countTrailingZeros(mask);
      const meta = entityMetadata[typeIndex];
      const slice = binarySearchRange(activeEntitiesData, meta.startIndex, meta.endIndex);
      for (let i = 0; i < slice.length; i++) {
        result[count++] = slice[i];
      }
      mask &= mask - 1n;
    }

    return result.subarray(0, count);
  }

  return {
    query,
    queryActiveEntities,
    // Expose internals for particle_worker to populate results
    _queryResultViews: queryResultViews,
    _precomputedQueries: precomputedQueries,
    _entityMetadata: entityMetadata,
  };
}
