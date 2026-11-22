// DebugFlags.js - Debug flag management for visualizing game state
// Provides API for enabling/disabling debug visualizations via SharedArrayBuffer

export const DEBUG_FLAGS = Object.freeze({
  SHOW_COLLIDERS: 0,
  SHOW_VELOCITY: 1,
  SHOW_ACCELERATION: 2,
  SHOW_NEIGHBORS: 3,
  SHOW_SPATIAL_GRID: 4,
  SHOW_ENTITY_INFO: 5,
  SHOW_LIGHTS: 6,
  SHOW_FPS_GRAPH: 7,
  SHOW_PROFILER: 8,
  SHOW_ENTITY_INDICES: 9,
  SHOW_ACTIVE_ONLY: 10,
  SHOW_DEBUG_DRAWS: 11,
  SHOW_SELECTED_ENTITY: 12,
  SHOW_SLEEPING_ENTITIES: 13,
  SHOW_SLEEPING_CELLS: 14,
  SHOW_COLLISION_CANDIDATES: 15,
  SHOW_JOINTS: 16,
  SHOW_ENTITY_ORIGINS: 17,
  SHOW_MESHES: 18,
});

/** Flag bytes used by SHOW_* (0..18). Byte 19 stays pad. Selected entity Int32 lives at offset 20. */
export const DEBUG_FLAG_COUNT = 19;

// Selected entity index storage (offset in debug buffer after flag bytes).
// Layout: [flag bytes indexed by DEBUG_FLAGS (0-18)] [pad 19] [selectedEntityIndex at 20-23 as Int32]
export const DEBUG_SELECTED_ENTITY_OFFSET = 20;

/**
 * The flag of each key enable() takes and getState() returns, in their order. The profiler, the selected entity and the
 * collision candidates have no key: their show* methods set them.
 */
export const DEBUG_FLAG_KEYS = Object.freeze({
  colliders: DEBUG_FLAGS.SHOW_COLLIDERS,
  velocity: DEBUG_FLAGS.SHOW_VELOCITY,
  acceleration: DEBUG_FLAGS.SHOW_ACCELERATION,
  neighbors: DEBUG_FLAGS.SHOW_NEIGHBORS,
  spatialGrid: DEBUG_FLAGS.SHOW_SPATIAL_GRID,
  entityInfo: DEBUG_FLAGS.SHOW_ENTITY_INFO,
  lights: DEBUG_FLAGS.SHOW_LIGHTS,
  fpsGraph: DEBUG_FLAGS.SHOW_FPS_GRAPH,
  entityIndices: DEBUG_FLAGS.SHOW_ENTITY_INDICES,
  activeOnly: DEBUG_FLAGS.SHOW_ACTIVE_ONLY,
  debugDraws: DEBUG_FLAGS.SHOW_DEBUG_DRAWS,
  sleepingEntities: DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES,
  sleepingCells: DEBUG_FLAGS.SHOW_SLEEPING_CELLS,
  joints: DEBUG_FLAGS.SHOW_JOINTS,
  entityOrigins: DEBUG_FLAGS.SHOW_ENTITY_ORIGINS,
  meshes: DEBUG_FLAGS.SHOW_MESHES,
});

/**
 * DebugFlags - Manages debug visualization flags
 * Works with SharedArrayBuffer to sync state across workers
 */
export class DebugFlags {
  constructor(debugBuffer) {
    // Uint8Array view of debug flags
    this.flags = new Uint8Array(debugBuffer);
    // Cached view — getSelectedEntity/setSelectedEntity are read on the render hot path.
    this._selectedEntityView = new Int32Array(debugBuffer, DEBUG_SELECTED_ENTITY_OFFSET, 1);

    this._clearFlagBytes();
    this._selectedEntityView[0] = -1;

    // Color palette for debug rendering (used by renderer worker)
    this.colors = {
      collider: 0x00ff00, // Green
      trigger: 0xffff00, // Yellow
      velocity: 0x0088ff, // Blue
      acceleration: 0xff0044, // Red
      neighbor: 0x00ffff, // Cyan
      grid: 0x444444, // Gray
      text: 0xffffff, // White
    };
  }

  _clearFlagBytes() {
    const flags = this.flags;
    const n = DEBUG_FLAG_COUNT < flags.length ? DEBUG_FLAG_COUNT : flags.length;
    for (let i = 0; i < n; i++) flags[i] = 0;
  }

  /**
   * Turn one flag (DEBUG_FLAGS) on or off.
   * @param {number} flag
   * @param {boolean} [enabled=true]
   */
  setFlag(flag, enabled = true) {
    this.flags[flag] = enabled ? 1 : 0;
    return this;
  }

  showColliders(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_COLLIDERS, enabled);
  }

  showVelocity(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_VELOCITY, enabled);
  }

  showAcceleration(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_ACCELERATION, enabled);
  }

  showNeighbors(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_NEIGHBORS, enabled);
  }

  showSpatialGrid(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_SPATIAL_GRID, enabled);
  }

  showEntityInfo(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_ENTITY_INFO, enabled);
  }

  showLights(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_LIGHTS, enabled);
  }

  showFPSGraph(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_FPS_GRAPH, enabled);
  }

  showProfiler(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_PROFILER, enabled);
  }

  showEntityIndices(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_ENTITY_INDICES, enabled);
  }

  showActiveOnly(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_ACTIVE_ONLY, enabled);
  }

  showDebugDraws(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_DEBUG_DRAWS, enabled);
  }

  showSelectedEntity(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_SELECTED_ENTITY, enabled);
  }

  showSleepingEntities(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES, enabled);
  }

  showSleepingCells(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_SLEEPING_CELLS, enabled);
  }

  showCollisionCandidates(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES, enabled);
  }

  showJoints(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_JOINTS, enabled);
  }

  showEntityOrigins(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS, enabled);
  }

  showMeshes(enabled = true) {
    return this.setFlag(DEBUG_FLAGS.SHOW_MESHES, enabled);
  }

  /**
   * Set the selected entity index (writes to shared buffer)
   * @param {number} entityIndex - Entity index or -1 for no selection
   */
  setSelectedEntity(entityIndex) {
    this._selectedEntityView[0] = entityIndex;
    if (entityIndex >= 0) {
      this.flags[DEBUG_FLAGS.SHOW_SELECTED_ENTITY] = 1;
    }
    return this;
  }

  /**
   * Get the selected entity index (reads from shared buffer)
   * @returns {number} Entity index or -1 for no selection
   */
  getSelectedEntity() {
    return this._selectedEntityView[0];
  }

  /**
   * Clear selected entity
   */
  clearSelectedEntity() {
    this._selectedEntityView[0] = -1;
    this.flags[DEBUG_FLAGS.SHOW_SELECTED_ENTITY] = 0;
    return this;
  }

  /**
   * Enable multiple debug features at once
   * @param {Object} options - { colliders: true, velocity: true, ... }
   */
  enable(options = {}) {
    for (const key in DEBUG_FLAG_KEYS) {
      if (options[key] !== undefined) this.setFlag(DEBUG_FLAG_KEYS[key], options[key]);
    }
    return this;
  }

  /**
   * Disable visualization flags and clear selected entity to -1.
   */
  disableAll() {
    this._clearFlagBytes();
    this._selectedEntityView[0] = -1;
    return this;
  }

  enablePhysicsDebug() {
    return this.enable({
      colliders: true,
      velocity: true,
      acceleration: true,
    });
  }

  enableAIDebug() {
    return this.enable({
      neighbors: true,
      velocity: true,
      entityInfo: true,
    });
  }

  enablePerformanceDebug() {
    return this.enable({
      fpsGraph: true,
      spatialGrid: true,
    });
  }

  isEnabled(flag) {
    return this.flags[flag] === 1;
  }

  getState() {
    const state = {};
    for (const key in DEBUG_FLAG_KEYS) state[key] = this.isEnabled(DEBUG_FLAG_KEYS[key]);
    return state;
  }
}
