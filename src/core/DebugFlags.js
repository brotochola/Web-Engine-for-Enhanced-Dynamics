// DebugFlags.js - Debug flag management for visualizing game state
// Provides API for enabling/disabling debug visualizations via SharedArrayBuffer

export const DEBUG_FLAGS = {
  SHOW_COLLIDERS: 0, // Draw collision shapes
  SHOW_VELOCITY: 1, // Draw velocity vectors
  SHOW_ACCELERATION: 2, // Draw acceleration vectors
  SHOW_NEIGHBORS: 3, // Draw neighbor connections
  SHOW_SPATIAL_GRID: 4, // Draw spatial hash grid
  SHOW_ENTITY_INFO: 5, // Show entity data on hover
  SHOW_AABB: 6, // Draw axis-aligned bounding boxes
  SHOW_FPS_GRAPH: 7, // Draw FPS history graph
  SHOW_PROFILER: 8, // Show detailed timing breakdown
  SHOW_ENTITY_INDICES: 9, // Show entity index numbers
  SHOW_ACTIVE_ONLY: 10, // Only show debug for active entities
  SHOW_RAYCASTS: 11, // Draw raycasts with hit points
};

/**
 * DebugFlags - Manages debug visualization flags
 * Works with SharedArrayBuffer to sync state across workers
 */
export class DebugFlags {
  constructor(debugBuffer) {
    // Uint8Array view of debug flags
    this.flags = new Uint8Array(debugBuffer);

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
      aabb: 0xff8800, // Orange
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
   * Enable/disable AABB visualization
   */
  showAABB(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_AABB] = enabled ? 1 : 0;
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
   * Enable/disable raycast visualization
   */
  showRaycasts(enabled = true) {
    this.flags[DEBUG_FLAGS.SHOW_RAYCASTS] = enabled ? 1 : 0;
    return this;
  }

  /**
   * Enable multiple debug features at once
   * @param {Object} options - { colliders: true, velocity: true, ... }
   */
  enable(options = {}) {
    if (options.colliders !== undefined) this.showColliders(options.colliders);
    if (options.velocity !== undefined) this.showVelocity(options.velocity);
    if (options.acceleration !== undefined)
      this.showAcceleration(options.acceleration);
    if (options.neighbors !== undefined) this.showNeighbors(options.neighbors);
    if (options.spatialGrid !== undefined)
      this.showSpatialGrid(options.spatialGrid);
    if (options.entityInfo !== undefined)
      this.showEntityInfo(options.entityInfo);
    if (options.aabb !== undefined) this.showAABB(options.aabb);
    if (options.fpsGraph !== undefined) this.showFPSGraph(options.fpsGraph);
    if (options.profiler !== undefined) this.showProfiler(options.profiler);
    if (options.entityIndices !== undefined)
      this.showEntityIndices(options.entityIndices);
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
      aabb: false,
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
      aabb: this.isEnabled(DEBUG_FLAGS.SHOW_AABB),
      fpsGraph: this.isEnabled(DEBUG_FLAGS.SHOW_FPS_GRAPH),
      profiler: this.isEnabled(DEBUG_FLAGS.SHOW_PROFILER),
      entityIndices: this.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INDICES),
      raycasts: this.isEnabled(DEBUG_FLAGS.SHOW_RAYCASTS),
    };
  }
}
