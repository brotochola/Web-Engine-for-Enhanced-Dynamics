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
});

/** Flag bytes used by SHOW_* (0..17). Selected entity Int32 lives at offset 20. */
export const DEBUG_FLAG_COUNT = 18;

// Selected entity index storage (offset in debug buffer after flag bytes).
// Layout: [flag bytes indexed by DEBUG_FLAGS (0-17)] [pad 18-19] [selectedEntityIndex at 20-23 as Int32]
export const DEBUG_SELECTED_ENTITY_OFFSET = 20;

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

  showColliders(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_COLLIDERS] = enabled ? 1 : 0;
    return this;
  }

  showVelocity(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_VELOCITY] = enabled ? 1 : 0;
    return this;
  }

  showAcceleration(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_ACCELERATION] = enabled ? 1 : 0;
    return this;
  }

  showNeighbors(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_NEIGHBORS] = enabled ? 1 : 0;
    return this;
  }

  showSpatialGrid(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_SPATIAL_GRID] = enabled ? 1 : 0;
    return this;
  }

  showEntityInfo(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_ENTITY_INFO] = enabled ? 1 : 0;
    return this;
  }

  showLights(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_LIGHTS] = enabled ? 1 : 0;
    return this;
  }

  showFPSGraph(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_FPS_GRAPH] = enabled ? 1 : 0;
    return this;
  }

  showProfiler(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_PROFILER] = enabled ? 1 : 0;
    return this;
  }

  showEntityIndices(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_ENTITY_INDICES] = enabled ? 1 : 0;
    return this;
  }

  showActiveOnly(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_ACTIVE_ONLY] = enabled ? 1 : 0;
    return this;
  }

  showDebugDraws(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_DEBUG_DRAWS] = enabled ? 1 : 0;
    return this;
  }

  showSelectedEntity(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_SELECTED_ENTITY] = enabled ? 1 : 0;
    return this;
  }

  showSleepingEntities(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES] = enabled ? 1 : 0;
    return this;
  }

  showSleepingCells(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_SLEEPING_CELLS] = enabled ? 1 : 0;
    return this;
  }

  showCollisionCandidates(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES] = enabled ? 1 : 0;
    return this;
  }

  showJoints(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_JOINTS] = enabled ? 1 : 0;
    return this;
  }

  showEntityOrigins(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_ENTITY_ORIGINS] = enabled ? 1 : 0;
    return this;
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
    if (options.colliders !== undefined) this.showColliders(options.colliders);
    if (options.velocity !== undefined) this.showVelocity(options.velocity);
    if (options.acceleration !== undefined) this.showAcceleration(options.acceleration);
    if (options.neighbors !== undefined) this.showNeighbors(options.neighbors);
    if (options.spatialGrid !== undefined) this.showSpatialGrid(options.spatialGrid);
    if (options.entityInfo !== undefined) this.showEntityInfo(options.entityInfo);
    if (options.lights !== undefined) this.showLights(options.lights);
    if (options.fpsGraph !== undefined) this.showFPSGraph(options.fpsGraph);
    if (options.entityIndices !== undefined) this.showEntityIndices(options.entityIndices);
    if (options.activeOnly !== undefined) this.showActiveOnly(options.activeOnly);
    if (options.debugDraws !== undefined) this.showDebugDraws(options.debugDraws);
    if (options.sleepingEntities !== undefined) this.showSleepingEntities(options.sleepingEntities);
    if (options.sleepingCells !== undefined) this.showSleepingCells(options.sleepingCells);
    if (options.joints !== undefined) this.showJoints(options.joints);
    if (options.entityOrigins !== undefined) this.showEntityOrigins(options.entityOrigins);
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
    return {
      colliders: this.isEnabled(DEBUG_FLAGS.SHOW_COLLIDERS),
      velocity: this.isEnabled(DEBUG_FLAGS.SHOW_VELOCITY),
      acceleration: this.isEnabled(DEBUG_FLAGS.SHOW_ACCELERATION),
      neighbors: this.isEnabled(DEBUG_FLAGS.SHOW_NEIGHBORS),
      spatialGrid: this.isEnabled(DEBUG_FLAGS.SHOW_SPATIAL_GRID),
      entityInfo: this.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INFO),
      lights: this.isEnabled(DEBUG_FLAGS.SHOW_LIGHTS),
      fpsGraph: this.isEnabled(DEBUG_FLAGS.SHOW_FPS_GRAPH),
      entityIndices: this.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INDICES),
      activeOnly: this.isEnabled(DEBUG_FLAGS.SHOW_ACTIVE_ONLY),
      debugDraws: this.isEnabled(DEBUG_FLAGS.SHOW_DEBUG_DRAWS),
      sleepingEntities: this.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES),
      sleepingCells: this.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_CELLS),
      joints: this.isEnabled(DEBUG_FLAGS.SHOW_JOINTS),
      entityOrigins: this.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS),
    };
  }
}
