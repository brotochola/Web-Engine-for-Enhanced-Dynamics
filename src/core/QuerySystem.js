/**
 * QuerySystem - Pre-calculates entity lists based on component combinations
 *
 * This system generates all possible combinations of components for registered
 * entity classes and creates cached lists of entity indices for fast querying.
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
     * Cache of pre-calculated queries
     * Key: Comma-separated, sorted component names (e.g., "Collider,RigidBody")
     * Value: Int32Array of entity indices that have ALL those components
     */
    this.cache = new Map();
  }

  /**
   * Build all possible component combination queries from registered classes
   * @param {Array} registeredClasses - Array of {class, count, startIndex, entityType}
   */
  buildQueries(registeredClasses) {
    const tempCache = new Map();

    console.log(
      "[QuerySystem] Building queries for",
      registeredClasses.length,
      "entity classes..."
    );

    // For each registered entity class
    registeredClasses.forEach(({ class: EntityClass, count, startIndex }) => {
      // CRITICAL: Use collectComponents to get ALL components including Transform
      // This matches GameObject's component collection logic
      const components = Array.from(
        collectComponents(EntityClass, GameObject, Transform)
      );

      if (!components || components.length === 0) {
        console.warn(
          `[QuerySystem] Class ${EntityClass.name} has no components!`
        );
        return;
      }

      // Generate all possible combinations (power set) of components
      const allCombinations = this._generatePowerSet(components);

      console.log(
        `[QuerySystem] ${EntityClass.name}: ${allCombinations.length} combinations from ${components.length} components`
      );

      // For each entity instance of this class
      for (let i = startIndex; i < startIndex + count; i++) {
        // Add this entity index to all relevant combination queries
        allCombinations.forEach((combo) => {
          const key = this._generateKey(combo);

          if (!tempCache.has(key)) {
            tempCache.set(key, []);
          }

          tempCache.get(key).push(i);
        });
      }
    });

    // Convert temporary arrays to Int32Arrays for better performance
    tempCache.forEach((indices, key) => {
      this.cache.set(key, new Int32Array(indices));
    });

    console.log(`[QuerySystem] Built ${this.cache.size} unique queries`);

    // Log some statistics
    this._logStatistics();
  }

  /**
   * Query entities by component combination
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
    const result = this.cache.get(key);

    if (!result) {
      console.warn(`[QuerySystem] No entities found for query: ${key}`);
      return new Int32Array(0);
    }

    return result;
  }

  /**
   * Generate a unique string key for a component combination
   * Components are sorted alphabetically to ensure consistent keys
   * @private
   */
  _generateKey(componentClasses) {
    return componentClasses
      .map((CompClass) => CompClass.name)
      .sort()
      .join(",");
  }

  /**
   * Generate all possible non-empty combinations (power set) of components
   * @private
   * @param {Array} components - Array of component classes
   * @returns {Array<Array>} - All possible combinations
   */
  _generatePowerSet(components) {
    const result = [];
    const n = components.length;

    // Iterate through all numbers from 1 to 2^n - 1
    // (exclude 0 because that's the empty set)
    for (let i = 1; i < 1 << n; i++) {
      const combination = [];

      // For each bit position, check if it's set
      for (let j = 0; j < n; j++) {
        if (i & (1 << j)) {
          combination.push(components[j]);
        }
      }

      result.push(combination);
    }

    return result;
  }

  /**
   * Serialize queries for sending to workers
   * Converts Int32Arrays to regular arrays for postMessage
   * @returns {Object} - Serializable object with query data
   */
  serialize() {
    const serialized = {};

    this.cache.forEach((int32Array, key) => {
      serialized[key] = Array.from(int32Array);
    });

    return serialized;
  }

  /**
   * Log statistics about built queries
   * @private
   */
  _logStatistics() {
    const stats = {
      totalQueries: this.cache.size,
      largestQuery: { key: "", size: 0 },
      smallestQuery: { key: "", size: Infinity },
      totalEntities: 0,
    };

    this.cache.forEach((indices, key) => {
      if (indices.length > stats.largestQuery.size) {
        stats.largestQuery = { key, size: indices.length };
      }
      if (indices.length < stats.smallestQuery.size) {
        stats.smallestQuery = { key, size: indices.length };
      }
    });

    console.log("[QuerySystem] Statistics:", {
      "Total Queries": stats.totalQueries,
      "Largest Query": `${stats.largestQuery.key} (${stats.largestQuery.size} entities)`,
      "Smallest Query": `${stats.smallestQuery.key} (${stats.smallestQuery.size} entities)`,
    });
  }
}

/**
 * Create a global query function for workers
 * This should be called after receiving query data from main thread
 *
 * @param {Object} queriesData - Deserialized query data from main thread
 * @returns {Function} - Query function for this worker
 */
export function createQueryFunction(queriesData) {
  // Reconstruct Map with Int32Arrays
  const queryCache = new Map();

  Object.entries(queriesData).forEach(([key, array]) => {
    queryCache.set(key, new Int32Array(array));
  });

  console.log(`[Worker Query] Initialized with ${queryCache.size} queries`);

  // Return the query function
  return function query(componentClasses) {
    const key = componentClasses
      .map((CompClass) => CompClass.name)
      .sort()
      .join(",");

    const result = queryCache.get(key);

    if (!result) {
      console.warn(`[Worker Query] No entities found for: ${key}`);
      return new Int32Array(0);
    }

    return result;
  };
}
