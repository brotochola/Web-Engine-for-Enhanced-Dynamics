// DebugFlags.js - Debug flag management for visualizing game state
// Provides API for enabling/disabling debug visualizations via SharedArrayBuffer

export const DEBUG_FLAGS = Object.freeze({
  SHOW_COLLIDERS: 0,
  SHOW_VELOCITY: 1,
  SHOW_ACCELERATION: 2,
  SHOW_NEIGHBORS: 3,
  SHOW_SPATIAL_GRID: 4,
  SHOW_ENTITY_INFO: 5,
  SHOW_FPS_GRAPH: 7,
  SHOW_PROFILER: 8,
  SHOW_ENTITY_INDICES: 9,
  SHOW_ACTIVE_ONLY: 10,
  SHOW_DEBUG_DRAWS: 11,
  SHOW_SELECTED_ENTITY: 12,
  SHOW_SLEEPING_ENTITIES: 13,
  SHOW_SLEEPING_CELLS: 14,
  SHOW_COLLISION_CANDIDATES: 15,
  SHOW_CONSTRAINTS: 16,
  SHOW_ENTITY_ORIGINS: 17,
});

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

    // Initialize all flags to 0 (disabled)
    for (let i = 0; i < this.flags.length; i++) {
      this.flags[i] = 0;
    }

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

  /**
   * Enable/disable collision shape visualization
   */
  showColliders(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_COLLIDERS] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable velocity vector visualization
   */
  showVelocity(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_VELOCITY] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable acceleration vector visualization
   */
  showAcceleration(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_ACCELERATION] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable neighbor connection visualization
   */
  showNeighbors(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_NEIGHBORS] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable spatial grid visualization
   */
  showSpatialGrid(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_SPATIAL_GRID] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable entity info on hover
   */
  showEntityInfo(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_ENTITY_INFO] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable FPS graph
   */
  showFPSGraph(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_FPS_GRAPH] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable profiler
   */
  showProfiler(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_PROFILER] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable entity index display
   */
  showEntityIndices(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_ENTITY_INDICES] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable debug draw visualization (lines, circles, text, etc.)
   */
  showDebugDraws(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_DEBUG_DRAWS] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable selected entity bounding box
   */
  showSelectedEntity(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_SELECTED_ENTITY] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable sleeping entities visualization
   */
  showSleepingEntities(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable sleeping cells visualization
   */
  showSleepingCells(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_SLEEPING_CELLS] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable collision candidates visualization
   */
  showCollisionCandidates(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable distance constraints visualization
   */
  showConstraints(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_CONSTRAINTS] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable/disable entity origin points (Transform.x, Transform.y) visualization
   */
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
    // Auto-enable the flag when selecting
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
    this.setSelectedEntity(-1);
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
    if (options.fpsGraph !== undefined) this.showFPSGraph(options.fpsGraph);
    if (options.profiler !== undefined) this.showProfiler(options.profiler);
    if (options.entityIndices !== undefined) this.showEntityIndices(options.entityIndices);
    if (options.debugDraws !== undefined) this.showDebugDraws(options.debugDraws);
    if (options.sleepingEntities !== undefined) this.showSleepingEntities(options.sleepingEntities);
    if (options.sleepingCells !== undefined) this.showSleepingCells(options.sleepingCells);
    if (options.collisionCandidates !== undefined) this.showCollisionCandidates(options.collisionCandidates);
    if (options.constraints !== undefined) this.showConstraints(options.constraints);
    if (options.entityOrigins !== undefined) this.showEntityOrigins(options.entityOrigins);
    return this;
  }

  /**
   * Disable all debug features
   */
  disableAll() {
    for (let i = 0; i < this.flags.length; i++) {
      this.flags[i] = 0;
    }
    return this;
  }

  /**
   * Enable common physics debug preset
   */
  enablePhysicsDebug() {
    return this.enable({
      colliders: true,
      velocity: true,
      acceleration: true,
    });
  }

  /**
   * Enable AI/behavior debug preset
   */
  enableAIDebug() {
    return this.enable({
      neighbors: true,
      velocity: true,
      entityInfo: true,
    });
  }

  /**
   * Enable performance debug preset
   */
  enablePerformanceDebug() {
    return this.enable({
      fpsGraph: true,
      profiler: true,
      spatialGrid: true,
    });
  }

  /**
   * Check if a debug flag is enabled
   */
  isEnabled(flag) {
    return this.flags[flag] === 1;
  }

  /**
   * Get current state of all flags
   */
  getState() {
    return {
      colliders: this.isEnabled(DEBUG_FLAGS.SHOW_COLLIDERS),
      velocity: this.isEnabled(DEBUG_FLAGS.SHOW_VELOCITY),
      acceleration: this.isEnabled(DEBUG_FLAGS.SHOW_ACCELERATION),
      neighbors: this.isEnabled(DEBUG_FLAGS.SHOW_NEIGHBORS),
      spatialGrid: this.isEnabled(DEBUG_FLAGS.SHOW_SPATIAL_GRID),
      entityInfo: this.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INFO),
      fpsGraph: this.isEnabled(DEBUG_FLAGS.SHOW_FPS_GRAPH),
      profiler: this.isEnabled(DEBUG_FLAGS.SHOW_PROFILER),
      entityIndices: this.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INDICES),
      debugDraws: this.isEnabled(DEBUG_FLAGS.SHOW_DEBUG_DRAWS),
      sleepingEntities: this.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES),
      sleepingCells: this.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_CELLS),
      collisionCandidates: this.isEnabled(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES),
      constraints: this.isEnabled(DEBUG_FLAGS.SHOW_CONSTRAINTS),
      entityOrigins: this.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS),
    };
  }
}
