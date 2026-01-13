/**
 * QuerySystem - Lazy entity list cache based on component combinations
 *
 * This system caches entity lists on-demand when queries are first executed,
 * avoiding expensive pre-computation of all possible combinations (2^n - 1).
 *
 * Usage:
 *   const rigidBodies = query([RigidBody]);
 *   const visibleEntities = query([SpriteRenderer, Transform]);
 */

import { collectComponents } from "./utils.js";
import { Transform } from "../components/Transform.js";
import { GameObject } from "./gameObject.js";

export class QuerySystem {
  constructor() {
    /**
     * Cache of computed queries
     * Key: Numeric hash based on sorted component IDs
     * Value: Int32Array of entity indices that have ALL those components
     */
    this.cache = new Map();

    /**
     * Metadata about registered entity classes for lazy query computation
     * Array of { entityType, components: [ComponentClass, ...], startIndex, endIndex, poolSize }
     */
    this.entityMetadata = [];
  }

  /**
   * Build metadata from registered classes (lazy approach - no pre-computation)
   * @param {Array} registeredClasses - Array of {class, poolSize, startIndex, entityType}
   */
  buildQueries(registeredClasses) {
    // Store metadata for each entity class
    this.entityMetadata = registeredClasses.map(
      ({ class: EntityClass, count, startIndex, entityType }) => {
        // CRITICAL: Use collectComponents to get ALL components including Transform
        // This matches GameObject's component collection logic
        const components = Array.from(
          collectComponents(EntityClass, GameObject, Transform)
        );

        if (!components || components.length === 0) {
          console.warn(
            `[QuerySystem] Class ${EntityClass.name} has no components!`
          );
        }

        return {
          entityType,
          className: EntityClass.name,
          components,
          startIndex,
          endIndex: startIndex + count,
          poolSize: count,
        };
      }
    );

    // Log statistics about entity classes
    this._logStatistics();
  }

  /**
   * Query entities by component combination (lazy computation)
   * @param {Array<Component>} componentClasses - Array of component classes
   * @returns {Int32Array} - Indices of entities that have ALL specified components
   *
   * @example
   * const lights = query([LightEmitter]);
   * const physics = query([RigidBody, Collider]);
   *
   * // FUTURE: Optional filters
   * // query([LightEmitter], { enabled: true })
   * // query([RigidBody], { filter: (i) => !RigidBody.isStatic[i] })
   */
  query(componentClasses) {
    const key = this._generateKey(componentClasses);

    // Check if already computed
    let result = this.cache.get(key);

    if (!result) {
      // Compute on-demand

      result = this._computeQuery(componentClasses);

      this.cache.set(key, result);
    }
    // Note: Cached queries don't log to avoid console spam

    return result;
  }

  /**
   * Compute a query by checking which entities have all required components
   * Uses numeric component IDs for faster comparison
   * @private
   * @param {Array<Component>} componentClasses - Array of component classes
   * @returns {Int32Array} - Indices of matching entities
   */
  _computeQuery(componentClasses) {
    // Use numeric IDs instead of string comparison
    const requiredIds = new Set(
      componentClasses.map((c) => this._getComponentId(c))
    );

    // Pre-allocate array with max possible size (all entities)
    const maxSize = this.entityMetadata.reduce((sum, m) => sum + m.poolSize, 0);
    const matchingIndices = new Int32Array(maxSize);
    let count = 0;

    // Check each entity class metadata
    for (const metadata of this.entityMetadata) {
      // Check if this entity class has all required components (by ID)
      const entityComponentIds = metadata.components.map((c) =>
        this._getComponentId(c)
      );
      const hasAllComponents = [...requiredIds].every((id) =>
        entityComponentIds.includes(id)
      );

      if (hasAllComponents) {
        // Add all entity indices of this class
        for (let i = metadata.startIndex; i < metadata.endIndex; i++) {
          matchingIndices[count++] = i;
        }
      }
    }

    // Return a subarray view with only the used portion (zero-copy)
    return matchingIndices.subarray(0, count);
  }

  /**
   * Get the pre-assigned componentId ID for a component class
   * @private
   */
  _getComponentId(ComponentClass) {
    return ComponentClass.componentId;
  }

  /**
   * Generate a unique numeric key for a component combination
   * Uses a hash based on sorted component IDs - no string allocation
   * @private
   */
  _generateKey(componentClasses) {
    // Get IDs and sort in-place (numeric sort)
    const ids = componentClasses
      .map((c) => this._getComponentId(c))
      .sort((a, b) => a - b);

    // Generate hash from sorted IDs using polynomial rolling hash
    let hash = 0;
    for (let i = 0; i < ids.length; i++) {
      hash = (hash * 31 + ids[i]) | 0; // | 0 keeps it as 32-bit int
    }
    return hash;
  }

  /**
   * Serialize queries and metadata for sending to workers
   * Converts Int32Arrays to regular arrays for postMessage
   * @returns {Object} - Serializable object with query data and metadata
   */
  serialize() {
    const serialized = {
      cache: {},
      metadata: this.entityMetadata.map((meta) => ({
        entityType: meta.entityType,
        className: meta.className,
        componentNames: meta.components.map((c) => c.name),
        componentIds: meta.components.map((c) => c.componentId),
        startIndex: meta.startIndex,
        endIndex: meta.endIndex,
        poolSize: meta.poolSize,
      })),
    };

    // Serialize already computed queries
    this.cache.forEach((int32Array, key) => {
      serialized.cache[key] = Array.from(int32Array);
    });

    return serialized;
  }

  /**
   * Log statistics about entity metadata and cached queries
   * @private
   */
  _logStatistics() {
    const totalEntities = this.entityMetadata.reduce(
      (sum, meta) => sum + meta.poolSize,
      0
    );

    // Calculate potential combinations (2^n - 1 for each entity class)
    const totalPossibleCombinations = this.entityMetadata.reduce(
      (sum, meta) => {
        const n = meta.components.length;
        const combinations = Math.pow(2, n) - 1;
        return sum + combinations;
      },
      0
    );

    if (this.cache.size > 0) {
      const stats = {
        largestQuery: { key: "", size: 0 },
        smallestQuery: { key: "", size: Infinity },
      };

      this.cache.forEach((indices, key) => {
        if (indices.length > stats.largestQuery.size) {
          stats.largestQuery = { key, size: indices.length };
        }
        if (indices.length < stats.smallestQuery.size) {
          stats.smallestQuery = { key, size: indices.length };
        }
      });
    }
  }
}

/**
 * Create a global query function for workers (lazy approach)
 * This should be called after receiving query data from main thread
 *
 * @param {Object} queriesData - Deserialized query data from main thread
 * @returns {Function} - Query function for this worker
 */
export function createQueryFunction(queriesData) {
  // Reconstruct cache with Int32Arrays (numeric keys)
  const queryCache = new Map();
  const entityMetadata = queriesData.metadata || [];

  // Load pre-computed queries from main thread (if any)
  if (queriesData.cache) {
    Object.entries(queriesData.cache).forEach(([key, array]) => {
      queryCache.set(Number(key), new Int32Array(array));
    });
  }

  /**
   * Generate numeric key from component IDs (no allocation)
   * @private
   */
  function generateKey(componentIds) {
    // Sort IDs in-place
    const sorted = componentIds.sort((a, b) => a - b);

    // Generate hash using polynomial rolling hash
    let hash = 0;
    for (let i = 0; i < sorted.length; i++) {
      hash = (hash * 31 + sorted[i]) | 0;
    }
    return hash;
  }

  /**
   * Compute a query on-demand using numeric component IDs
   * @private
   */
  function computeQuery(componentIds) {
    const componentIdSet = new Set(componentIds);

    // Pre-allocate array with max possible size (all entities)
    const maxSize = entityMetadata.reduce((sum, m) => sum + m.poolSize, 0);
    const matchingIndices = new Int32Array(maxSize);
    let count = 0;

    // Check each entity class metadata
    for (const metadata of entityMetadata) {
      // Check if this entity class has all required components (by ID)
      const hasAllComponents = componentIds.every((id) =>
        metadata.componentIds.includes(id)
      );

      if (hasAllComponents) {
        // Add all entity indices of this class
        for (let i = metadata.startIndex; i < metadata.endIndex; i++) {
          matchingIndices[count++] = i;
        }
      }
    }

    // Return a subarray view with only the used portion (zero-copy)
    return matchingIndices.subarray(0, count);
  }

  // Return the query function
  return function query(componentClasses) {
    // Use pre-assigned componentId IDs from component classes
    const componentIds = componentClasses.map(
      (CompClass) => CompClass.componentId
    );

    // Generate numeric key
    const key = generateKey(componentIds);

    // Check cache first
    let result = queryCache.get(key);

    if (!result) {
      // Compute on-demand
      result = computeQuery(componentIds);
      queryCache.set(key, result);
    }

    return result;
  };
}
