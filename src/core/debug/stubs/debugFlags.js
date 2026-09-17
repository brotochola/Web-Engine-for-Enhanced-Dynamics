// DebugFlags stub — production replacement without the debug UI subtree.
// Same SAB contract as the real class (flags + selected entity at offset 20).

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

export const DEBUG_FLAG_COUNT = 18;
export const DEBUG_SELECTED_ENTITY_OFFSET = 20;

export class DebugFlags {
  constructor(debugBuffer) {
    this.flags = new Uint8Array(debugBuffer);
    this._selectedEntityView = new Int32Array(debugBuffer, DEBUG_SELECTED_ENTITY_OFFSET, 1);
    this.colors = {};
  }

  _set(flag, enabled = true) {
    this.flags[flag] = enabled ? 1 : 0;
    return this;
  }

  showColliders(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_COLLIDERS, enabled); }
  showVelocity(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_VELOCITY, enabled); }
  showAcceleration(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_ACCELERATION, enabled); }
  showNeighbors(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_NEIGHBORS, enabled); }
  showSpatialGrid(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_SPATIAL_GRID, enabled); }
  showEntityInfo(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_ENTITY_INFO, enabled); }
  showLights(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_LIGHTS, enabled); }
  showFPSGraph(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_FPS_GRAPH, enabled); }
  showProfiler(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_PROFILER, enabled); }
  showEntityIndices(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_ENTITY_INDICES, enabled); }
  showActiveOnly(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_ACTIVE_ONLY, enabled); }
  showDebugDraws(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_DEBUG_DRAWS, enabled); }
  showSelectedEntity(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_SELECTED_ENTITY, enabled); }
  showSleepingEntities(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES, enabled); }
  showSleepingCells(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_SLEEPING_CELLS, enabled); }
  showCollisionCandidates(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES, enabled); }
  showJoints(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_JOINTS, enabled); }
  showEntityOrigins(enabled = true) { return this._set(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS, enabled); }

  setSelectedEntity(entityIndex) {
    this._selectedEntityView[0] = entityIndex;
    if (entityIndex >= 0) this.flags[DEBUG_FLAGS.SHOW_SELECTED_ENTITY] = 1;
    return this;
  }

  getSelectedEntity() {
    return this._selectedEntityView[0];
  }

  clearSelectedEntity() {
    this._selectedEntityView[0] = -1;
    this.flags[DEBUG_FLAGS.SHOW_SELECTED_ENTITY] = 0;
    return this;
  }

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

  disableAll() {
    const n = DEBUG_FLAG_COUNT < this.flags.length ? DEBUG_FLAG_COUNT : this.flags.length;
    for (let i = 0; i < n; i++) this.flags[i] = 0;
    this._selectedEntityView[0] = -1;
    return this;
  }

  enablePhysicsDebug() {
    return this.enable({ colliders: true, velocity: true, acceleration: true });
  }

  enableAIDebug() {
    return this.enable({ neighbors: true, velocity: true, entityInfo: true });
  }

  enablePerformanceDebug() {
    return this.enable({ fpsGraph: true, spatialGrid: true });
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
