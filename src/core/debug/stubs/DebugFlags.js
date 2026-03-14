// DebugFlags stub — production no-op replacement.
// Exports the same shape (named exports + class) so Scene.js works without changes.

export const DEBUG_FLAGS = {
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
};

export const DEBUG_SELECTED_ENTITY_OFFSET = 16;

export class DebugFlags {
  constructor(debugBuffer) {
    this.flags = new Uint8Array(debugBuffer);
    this.colors = {};
  }

  showColliders() { return this; }
  showVelocity() { return this; }
  showAcceleration() { return this; }
  showNeighbors() { return this; }
  showSpatialGrid() { return this; }
  showEntityInfo() { return this; }
  showFPSGraph() { return this; }
  showProfiler() { return this; }
  showEntityIndices() { return this; }
  showDebugDraws() { return this; }
  showSelectedEntity() { return this; }
  showSleepingEntities() { return this; }
  showSleepingCells() { return this; }
  showCollisionCandidates() { return this; }
  showConstraints() { return this; }
  showEntityOrigins() { return this; }
  setSelectedEntity() { return this; }
  getSelectedEntity() { return -1; }
  clearSelectedEntity() { return this; }
  enable() { return this; }
  disableAll() { return this; }
  enablePhysicsDebug() { return this; }
  enableAIDebug() { return this; }
  enablePerformanceDebug() { return this; }
  isEnabled() { return false; }
  getState() {
    return {
      colliders: false,
      velocity: false,
      acceleration: false,
      neighbors: false,
      spatialGrid: false,
      entityInfo: false,
      fpsGraph: false,
      profiler: false,
      entityIndices: false,
      debugDraws: false,
      sleepingEntities: false,
      sleepingCells: false,
      collisionCandidates: false,
      constraints: false,
      entityOrigins: false,
    };
  }
}
