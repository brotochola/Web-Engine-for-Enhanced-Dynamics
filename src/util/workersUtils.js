// workers-utils.js - Shared utilities and schemas for worker statistics
// Single source of truth for stat buffer layouts across all workers

/**
 * Format a number with underscore thousand separators
 * @param {number} num - Number to format
 * @returns {string} Formatted number (e.g., "1_000_000")
 */
function formatNumber(num) {
  if (num === null || num === undefined || Number.isNaN(num)) return '--';
  const rounded = Math.round(num);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

/**
 * Renderer Worker Stats Schema
 * Single renderer worker with draw call and visibility metrics
 */
export const RENDERER_STATS = Object.freeze({
  FPS: 0,
  DRAW_CALLS: 1,
  VISIBLE_SPRITES: 2,
  SPRITES_CREATED: 3,
  DECORATION_SPRITES: 4,
  VISIBLE_DECORATIONS: 5,
  VISIBLE_ENTITIES: 6,
  VISIBLE_PARTICLES: 7,
  ACTIVE_DECORATIONS: 8,
  MSG_MS: 9,
  STEP_MS: 10,
  LIGHTS_MS: 11,
  SHADOWS_MS: 12,
  SPRITES_MS: 13,
  CUSTOM_LAYERS_MS: 14,
  MISC_MS: 15,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
});

/**
 * Particle Worker Stats Schema
 * Single particle worker with particle counts.
 */
export const PARTICLE_STATS = Object.freeze({
  FPS: 0,
  ACTIVE_PARTICLES: 1,
  TOTAL_PARTICLES: 2,
  PARTICLES_STAMPED: 3,
  FLASHES_UPDATED: 4,
  DECAL_STAMP_MS: 5,
  ACTIVE_ENTITIES: 6,
  TOTAL_ENTITIES: 7,
  MSG_MS: 8,
  BUILD_ACTIVE_VISIBLE_MS: 9,
  PARTICLE_PHYSICS_MS: 10,
  STEP_MS: 11,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
});

/**
 * Physics Worker Stats Schema (Box2D)
 * Outer worker writes FPS / STEP_MS / MSG_MS; nested weedjs writes body/joint/contact counts.
 */
export const PHYSICS_STATS = Object.freeze({
  FPS: 0,
  STEP_MS: 1,
  MSG_MS: 2,
  BODY_COUNT: 3,
  JOINT_COUNT: 4,
  CONTACT_BEGIN: 5,
  CONTACT_END: 6,
  SENSOR_BEGIN: 7,
  SENSOR_END: 8,
  WEED_JOINTS: 9,
  BODY_SYNC_MS: 10,
  JOINT_SYNC_MS: 11,
  COMMAND_MS: 12,
  FORCE_MS: 13,
  BOX2D_MS: 14,
  POST_MS: 15,
  BODY_SYNC_CHANGES: 16,
  BODY_SYNC_VISITED: 17,
  JOINT_SYNC_CHANGES: 18,
  COMMAND_COUNT: 19,
  COMMAND_OVERFLOW_TOTAL: 20,
  CONTACT_DROPPED: 21,
  SENSOR_DROPPED: 22,
  /** Allocator used (kilobytes) — float32-safe vs raw bytes above 16MB. */
  HEAP_USED_KB: 23,
  /** Max HEAP_USED_KB seen this session. */
  HEAP_HIGH_WATER_KB: 24,
  BODY_MOVED_COUNT: 25,
  AWAKE_COUNT: 26,
  PROFILE_STEP_MS: 27,
  PROFILE_COLLIDE_MS: 28,
  PROFILE_SOLVE_MS: 29,
  PROFILE_SLEEP_MS: 30,
  PROFILE_SENSORS_MS: 31,
  COUNTER_CONTACTS: 32,
  COUNTER_ISLANDS: 33,
  COUNTER_AWAKE_CONTACTS: 34,
  COUNTER_TREE_HEIGHT: 35,
  /** Wall ms of lfParticleSystem_Step + pose deinterleave inside step_world. */
  LIQUIDFUN_MS: 36,
  STRIDE_FLOATS: 48,
  BUFFER_SIZE: 48 * 4,
});

/**
 * Spatial Worker Stats Schema (Multi-worker)
 * Multiple spatial workers with neighbor query metrics
 */
export const SPATIAL_STATS = Object.freeze({
  FPS: 0,
  NEIGHBOR_CHECKS: 1,
  GRID_CELLS_CHECKED: 2,
  ENTITIES_PROCESSED: 3,
  REBUILD_MS: 4,
  NEIGHBOR_MS: 5,
  MSG_MS: 6,
  NEIGHBORS_REUSED: 7,
  STEP_MS: 8,
  SLEEP_NEIGHBOR_SKIPS: 9,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE_PER_WORKER: 16 * 4,
});

/**
 * Logic Worker Stats Schema (Multi-worker)
 * Multiple logic workers with system execution metrics
 */
export const LOGIC_STATS = Object.freeze({
  FPS: 0,
  ENTITIES_PROCESSED: 1,
  SYSTEMS_EXECUTED: 2,
  MSG_MS: 3,
  STEP_MS: 4,
  RAYCAST_MS: 5,
  RAYCAST_COUNT: 6,
  ENTITY_MS: 7,
  DECIMATE_MS: 8,
  TICK_MS: 9,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE_PER_WORKER: 16 * 4,
});

/**
 * Pre-Render Worker Stats Schema
 * Single pre-render worker with visibility and render queue metrics
 */
export const PRE_RENDER_STATS = Object.freeze({
  FPS: 0,
  VISIBLE_ENTITIES: 1,
  VISIBLE_PARTICLES: 2,
  VISIBLE_DECORATIONS: 3,
  SHADOWS_UPDATED: 4,
  RENDER_QUEUE_SIZE: 5,
  MSG_MS: 6,
  SKIPPED_FRAMES: 7,
  STEP_MS: 8,
  COLLECT_MS: 9,
  SORT_MS: 10,
  EMIT_MS: 11,
  CUSTOM_LAYER_MS: 12,
  SHADOW_Q_MS: 13,
  VISIBILITY_MS: 14,
  ADOBE_MS: 15,
  STRIDE_FLOATS: 16,
  BUFFER_SIZE: 16 * 4,
});

/**
 * Display configuration for worker stats
 * Defines which stats to show in DebugUI and how to format them
 */
/**
 * Display order for Performance tab worker rows (after Main, before Audio).
 */
export const WORKER_ROW_ORDER = Object.freeze([
  'logic',
  'physics',
  'preRender',
  'renderer',
  'spatial',
  'particle',
]);

const fmtMs = (v) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(2) + ' ms');
const fmtFps = (v) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(1));
const fmtNum = (v) => formatNumber(v);
const fmtLoad = (v) => (v == null || Number.isNaN(v) ? '—' : Math.round(v) + '%');

/**
 * Real-time busyness: STEP_MS as % of frame budget (60 Hz ≈ 16.67 ms, or 1000/fixedFps).
 * @param {number} stepMs
 * @param {{ fixedFps?: number, budgetHz?: number }} [opts]
 * @returns {number}
 */
export function workerLoadPct(stepMs, { fixedFps = 0, budgetHz = 60 } = {}) {
  if (!(stepMs >= 0) || Number.isNaN(stepMs)) return 0;
  const hz = fixedFps > 0 ? fixedFps : budgetHz;
  const budgetMs = 1000 / (hz > 0 ? hz : 60);
  return (stepMs / budgetMs) * 100;
}

/** Synthetic Load column (derived from STEP_MS; not a SAB field). */
const LOAD_STAT = Object.freeze({ key: 'LOAD', label: 'Load', format: fmtLoad });

/**
 * Display configuration for worker stats.
 * First four keys (Step / Load / Fps / Msg) are common columns for alignment.
 * Remaining stats go in the Details column.
 */
export const WORKER_DISPLAY_CONFIG = Object.freeze({
  renderer: {
    label: 'Render',
    color: 'renderer',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'MSG_MS', label: 'Msg', format: fmtMs },
      { key: 'DRAW_CALLS', label: 'Draws', format: fmtNum },
      { key: 'VISIBLE_SPRITES', label: 'Sprites', format: fmtNum },
      { key: 'VISIBLE_ENTITIES', label: 'Visible', format: fmtNum },
      { key: 'LIGHTS_MS', label: 'Lights', format: fmtMs },
      { key: 'SHADOWS_MS', label: 'Shadows', format: fmtMs },
      { key: 'SPRITES_MS', label: 'SpritesMs', format: fmtMs },
      { key: 'CUSTOM_LAYERS_MS', label: 'Custom', format: fmtMs },
      { key: 'MISC_MS', label: 'Misc', format: fmtMs },
    ],
  },
  particle: {
    label: 'Particles',
    color: 'particle',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'MSG_MS', label: 'Msg', format: fmtMs },
      { key: 'ACTIVE_PARTICLES', label: 'Active', format: fmtNum },
      { key: 'PARTICLES_STAMPED', label: 'Stamped', format: fmtNum },
      { key: 'DECAL_STAMP_MS', label: 'Stamp', format: fmtMs },
      { key: 'PARTICLE_PHYSICS_MS', label: 'Sim', format: fmtMs },
      { key: 'BUILD_ACTIVE_VISIBLE_MS', label: 'Lists', format: fmtMs },
    ],
  },
  physics: {
    label: 'Physics',
    color: 'physics',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'MSG_MS', label: 'Msg', format: fmtMs },
      { key: 'BODY_COUNT', label: 'Bodies', format: fmtNum },
      { key: 'AWAKE_COUNT', label: 'Awake', format: fmtNum },
      { key: 'BODY_MOVED_COUNT', label: 'Moved', format: fmtNum },
      { key: 'BOX2D_MS', label: 'Box2d', format: fmtMs },
      { key: 'LIQUIDFUN_MS', label: 'LiquidFun', format: fmtMs },
      { key: 'PROFILE_COLLIDE_MS', label: 'Collide', format: fmtMs },
      { key: 'PROFILE_SOLVE_MS', label: 'Solve', format: fmtMs },
      { key: 'PROFILE_SLEEP_MS', label: 'Sleep', format: fmtMs },
      { key: 'CONTACT_BEGIN', label: 'Contacts', format: fmtNum },
      { key: 'COUNTER_ISLANDS', label: 'Islands', format: fmtNum },
      { key: 'COUNTER_AWAKE_CONTACTS', label: 'AwakeC', format: fmtNum },
      { key: 'WEED_JOINTS', label: 'Joints', format: fmtNum },
    ],
  },
  spatial: {
    label: 'Spatial',
    color: 'spatial',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'MSG_MS', label: 'Msg', format: fmtMs },
      { key: 'ENTITIES_PROCESSED', label: 'Entities', format: fmtNum },
      { key: 'NEIGHBOR_CHECKS', label: 'Neighbors', format: fmtNum },
      { key: 'REBUILD_MS', label: 'Rebuild', format: fmtMs },
      { key: 'NEIGHBOR_MS', label: 'Search', format: fmtMs },
      { key: 'NEIGHBORS_REUSED', label: 'Reused', format: fmtNum },
      { key: 'SLEEP_NEIGHBOR_SKIPS', label: 'SleepSkip', format: fmtNum },
    ],
  },
  logic: {
    label: 'Logic',
    color: 'logic',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'MSG_MS', label: 'Msg', format: fmtMs },
      { key: 'ENTITIES_PROCESSED', label: 'Entities', format: fmtNum },
      { key: 'RAYCAST_MS', label: 'Ray', format: fmtMs },
      { key: 'RAYCAST_COUNT', label: 'Rays', format: fmtNum },
      { key: 'ENTITY_MS', label: 'Entity', format: fmtMs },
      { key: 'DECIMATE_MS', label: 'Decim', format: fmtMs },
      { key: 'TICK_MS', label: 'Tick', format: fmtMs },
    ],
  },
  preRender: {
    label: 'PreRender',
    color: 'preRender',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'MSG_MS', label: 'Msg', format: fmtMs },
      { key: 'RENDER_QUEUE_SIZE', label: 'Queue', format: fmtNum },
      { key: 'SKIPPED_FRAMES', label: 'Skipped', format: fmtNum },
      { key: 'VISIBLE_ENTITIES', label: 'Visible', format: fmtNum },
      { key: 'SHADOWS_UPDATED', label: 'Shadows', format: fmtNum },
      { key: 'COLLECT_MS', label: 'Collect', format: fmtMs },
      { key: 'SORT_MS', label: 'Sort', format: fmtMs },
      { key: 'EMIT_MS', label: 'Emit', format: fmtMs },
      { key: 'CUSTOM_LAYER_MS', label: 'Custom', format: fmtMs },
      { key: 'SHADOW_Q_MS', label: 'ShadowQ', format: fmtMs },
      { key: 'VISIBILITY_MS', label: 'Vis', format: fmtMs },
      { key: 'ADOBE_MS', label: 'Adobe', format: fmtMs },
    ],
  },
});

/**
 * Create a stats writer view for a single worker
 * @param {SharedArrayBuffer} buffer - The stats buffer
 * @param {Object} statsSchema - Schema object (e.g., RENDERER_STATS)
 * @returns {Float32Array} Typed array view for writing stats
 */
export function createStatsWriter(buffer, statsSchema) {
  return new Float32Array(buffer, 0, statsSchema.STRIDE_FLOATS);
}

/**
 * Create a stats writer view for a multi-worker buffer (strided access)
 * @param {SharedArrayBuffer} buffer - The stats buffer
 * @param {Object} statsSchema - Schema object (e.g., SPATIAL_STATS)
 * @param {number} workerIndex - Index of this worker (0-based)
 * @returns {Float32Array} Typed array view for writing stats
 */
export function createMultiWorkerStatsWriter(buffer, statsSchema, workerIndex) {
  const offset = workerIndex * statsSchema.STRIDE_FLOATS;
  return new Float32Array(
    buffer,
    offset * 4, // byte offset
    statsSchema.STRIDE_FLOATS // length in floats
  );
}

/**
 * Create stats reader views for all workers in a multi-worker buffer
 * @param {SharedArrayBuffer} buffer - The stats buffer
 * @param {Object} statsSchema - Schema object (e.g., SPATIAL_STATS)
 * @param {number} workerCount - Number of workers
 * @returns {Float32Array[]} Array of typed array views for reading stats
 */
export function createMultiWorkerStatsReaderArray(buffer, statsSchema, workerCount) {
  const views = [];
  for (let i = 0; i < workerCount; i++) {
    const offset = i * statsSchema.STRIDE_FLOATS;
    views.push(new Float32Array(buffer, offset * 4, statsSchema.STRIDE_FLOATS));
  }
  return views;
}

/**
 * Create a stats reader view for a single worker
 * @param {SharedArrayBuffer} buffer - The stats buffer
 * @param {Object} statsSchema - Schema object (e.g., RENDERER_STATS)
 * @returns {Float32Array} Typed array view for reading stats
 */
export function createStatsReader(buffer, statsSchema) {
  return new Float32Array(buffer, 0, statsSchema.STRIDE_FLOATS);
}

/**
 * Get the cell index containing an entity's center position
 * Pure function, zero allocation
 *
 * @param {number} posX - Entity center X position
 * @param {number} posY - Entity center Y position
 * @param {number} invCellSize - Inverse of cell size (1 / cellSize)
 * @param {number} gridWidth - Grid width in cells
 * @param {number} gridHeight - Grid height in cells
 * @returns {number} Cell index containing entity center, or -1 if out of bounds
 */
export function getEntityHomeCellIndex(posX, posY, invCellSize, gridWidth, gridHeight) {
  const col = (posX * invCellSize) | 0;
  const row = (posY * invCellSize) | 0;

  // Clamp to grid bounds
  const maxCol = gridWidth - 1;
  const maxRow = gridHeight - 1;
  const clampedCol = col < 0 ? 0 : col > maxCol ? maxCol : col;
  const clampedRow = row < 0 ? 0 : row > maxRow ? maxRow : row;

  // Check if out of bounds
  if (col < 0 || col > maxCol || row < 0 || row > maxRow) {
    return -1;
  }

  return clampedRow * gridWidth + clampedCol;
}
