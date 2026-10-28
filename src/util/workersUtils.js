// workersUtils.js - Shared utilities and schemas for worker statistics
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
  /** Dirty decal tiles seen this frame (always on). */
  DECAL_TILES_DIRTY: 16,
  /** Decal tile ImageBitmap uploads this frame (always on). */
  DECAL_TILES_UPLOADED: 17,
  /** Live cover/static/tiling scenery display objects (always on). */
  SCENERY_COUNT: 18,
  /** Packed MESH fill instances last upload (always on). */
  MESH_FILL_INSTANCES: 19,
  /** MESH fill RT draws this frame; 0 means skip-RT (always on). */
  MESH_RT_DRAWS: 20,
  /** CPU painter sort, not included in SPRITES_MS or CUSTOM_LAYERS_MS. Written only when collectDetailedStats. */
  SORT_MS: 21,
  /** Render-queue latch at the start of update(). Written only when collectDetailedStats. */
  QUEUE_MS: 22,
  /** Stage present plus the finally that releases the queue. Written only when collectDetailedStats. */
  PRESENT_MS: 23,
  /** GPU elapsed (disjoint query, 1–2 frames late). Shadows + lights + custom RT + present. */
  GPU_STEP_MS: 24,
  GPU_SHADOWS_MS: 25,
  GPU_LIGHTS_MS: 26,
  GPU_PRESENT_MS: 27,
  GPU_PASSES: 28,
  GPU_CASTERS: 29,
  GPU_SHADOW_LIGHTS: 30,
  GPU_FPS: 31,
  /** Custom-layer and MESH render-texture draws. */
  GPU_CUSTOM_MS: 32,
  /** Unused. The GPU clock was removed; it wedged Chrome and WebGL queries came back empty. */
  GPU_TIMER: 33,
  /** GPU timestamp for a sort pass, when the timer is on. 0 otherwise. */
  GPU_SORT_MS: 34,
  /** Last frame that uploaded sprites. Not cleared on interpolation-only frames. Not part of Step. */
  LAST_UPLOAD_MS: 35,
  /** 1 when this frame consumed a new render queue. 0 when it only interpolated. */
  NEW_QUEUE: 36,
  /**
   * Wall ms the worker spent blocked on a sibling, inside the step. 0 when the
   * renderer never blocks (it has no sync sibling API). See E-01.
   */
  WAIT_MS: 37,
  /**
   * Wall ms between the end of the previous frame and the start of this one.
   *
   * This is the scheduler idle, NOT algorithm time and NOT STEP_MS: no work was
   * in flight on this thread during it. It exists because every other metric in
   * the engine is intra-step, so the gap between frames has never been measured.
   * E-06 in docs/internal/EXECUTION_PLAN.md.
   */
  IDLE_MS: 38,
  STRIDE_FLOATS: 39,
  BUFFER_SIZE: 39 * 4,
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
  ACTIVE_BULLETS: 12,
  ACTIVE_DECORATIONS: 13,
  /** Wall ms blocked on a sibling inside the step. See E-01. */
  WAIT_MS: 14,
  /** Wall ms between the end of the previous frame and the start of this one. See E-01/E-06. */
  IDLE_MS: 15,
  /**
   * E-37. Flowfields actually COMPUTED this frame, not requested.
   *
   * `particleWorker.flowfieldsComputedThisFrame` has been incremented and zeroed every
   * frame since the nav system landed and was **published nowhere**, so the single
   * number that decides whether E-11 is a real hypothesis or a cache that always hits
   * had no way out of the worker.
   *
   * The difference from a request count is the whole point. `_processNextFlowfieldRequest`
   * calls `_findExistingFlowfieldSlot` first and returns on a hit without computing
   * anything, so "per request" and "per computation" can differ by orders of magnitude
   * and only this one is the expensive one. Same reasoning as E-02's `ENTITIES_PROCESSED`
   * vs `VISIBLE_ENTITIES` pair.
   */
  FLOWFIELDS_COMPUTED: 16,
  /** E-37. Paths actually computed this frame. See FLOWFIELDS_COMPUTED. */
  PATHS_COMPUTED: 17,
  /**
   * E-37. Flowfield requests serviced this frame, hits and misses alike.
   *
   * `COMPUTED / SERVICED` is the LRU miss rate. If it is 0 the entire flowfield path is
   * dead weight and E-11 is moot; if it is 1, every request pays for five full-grid
   * `fill()`s and E-11 is real. One ratio instead of two raw counters, because the two
   * numbers are not interpretable on their own.
   */
  FLOWFIELDS_SERVICED: 18,
  STRIDE_FLOATS: 19,
  BUFFER_SIZE: 19 * 4,
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
  /** Cumulative pose publishes skipped because pre-render still holds the slot. */
  POSE_SKIP_TOTAL: 45,
  /** Cumulative pose publish attempts (skip + success). */
  POSE_PUBLISH_TOTAL: 46,
  /** Wall ms of lfParticleSystem_Step + pose deinterleave inside step_world. */
  LIQUIDFUN_MS: 36,
  LF_PASS_GRID_MS: 37,
  LF_PASS_FIND_CONTACTS_MS: 38,
  LF_PASS_BODY_MS: 39,
  LF_PASS_WEIGHT_MS: 40,
  LF_PASS_STATIC_PRESSURE_MS: 41,
  LF_PASS_PRESSURE_MS: 42,
  LF_PASS_CONTACT_SOLVERS_MS: 43,
  LF_PASS_REST_MS: 44,
  /** Wall ms blocked on a sibling inside the step. See E-01. */
  WAIT_MS: 47,
  /** Wall ms between the end of the previous frame and the start of this one. See E-01/E-06. */
  IDLE_MS: 48,
  /**
   * Wall ms answering sync queries between steps, since the previous frame (E-56).
   * Outside STEP_MS: a request that lands after the step's service point is
   * answered by the host's wake instead of waiting for the next frame.
   */
  QUERY_WAKE_MS: 49,
  /**
   * Box2D memory in use at its highest (kilobytes): static data, stacks and the highest heap
   * address reached (`sbrk(0)`; dlmalloc never gives memory back). This is the figure to size
   * Box2D's memory from; HEAP_USED_KB counts live bytes only.
   */
  MEMORY_PEAK_KB: 50,
  STRIDE_FLOATS: 51,
  BUFFER_SIZE: 51 * 4,
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
  /** Grid actives with a sprite and neither RigidBody nor Collider (no Box2D body). */
  NO_BODY_COUNT: 10,
  /** Wall ms blocked on a sibling inside the step. See E-01. */
  WAIT_MS: 11,
  /** Wall ms between the end of the previous frame and the start of this one. See E-01/E-06. */
  IDLE_MS: 12,
  /** 1 when the frame's grid was rewritten for the bodies that moved, 0 when it was rebuilt (E-126). */
  GRID_MOVERS: 13,
  /** Neighbour lists searched again this frame (the gather's rows). See E-147. */
  NEIGHBORS_REBUILT: 14,
  /** Neighbour lists published this frame: the rebuilt ones and the ones kept within the skin. See E-147. */
  NEIGHBORS_PUBLISHED: 15,
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
  /** logic0 precomputed query snapshot publish. Written only when collectDetailedStats. */
  QUERY_PUBLISH_MS: 10,
  /** Sync Box2d.castRayClosest SAB wait on logic. Not Ray.* DDA. */
  BOX2D_RAYCAST_MS: 11,
  BOX2D_RAYCAST_COUNT: 12,
  /** Always-on load key for Bunny Mark (and similar toy movers). */
  MARK_ACTIVE: 13,
  /** Wall ms blocked on a sibling inside the step. See E-01. */
  WAIT_MS: 14,
  /** Wall ms between the end of the previous frame and the start of this one. See E-01/E-06. */
  IDLE_MS: 15,
  /**
   * E-27. Live contact-pair map size. `_pairSlot.size` is the only count of pairs
   * and was published nowhere, so a kernel delta on the pair key had nothing to
   * divide by except a scene step from a different world.
   *
   * Own plus foreign pairs. Every logic worker reads every contact, so each one
   * publishes the same total: do not sum it across workers (review M11).
   */
  PAIR_COUNT: 16,
  /** Pairs this worker owns and validates every frame (minE % workers === index). */
  PAIR_OWN: 17,
  STRIDE_FLOATS: 18,
  BUFFER_SIZE_PER_WORKER: 18 * 4,
});

/**
 * Pre-Render Worker Stats Schema
 * One stride per pre-render worker (same layout as logic/spatial).
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
  /** Shadow instance rows only (sun, stamp, cookies). Sprite rows are SPRITE_PACK_MS. */
  SHADOW_Q_MS: 13,
  VISIBILITY_MS: 14,
  ADOBE_MS: 15,
  /**
   * Wall ms blocked on Pixi inside the step.
   *
   * This slot used to be assigned `0` from two places and never incremented
   * anywhere in `src/`, so the debug panel showed a hardcoded zero for every
   * session. The pre-render worker's only wait on a sibling is the backpressure
   * skip, which is counted separately as SKIPPED_FRAMES; the scheduler idle is
   * IDLE_MS below. E-01 in docs/internal/EXECUTION_PLAN.md.
   */
  WAIT_MS: 16,
  /** Sprite-queue instance rows. Sort time stays in SORT_MS. */
  SPRITE_PACK_MS: 17,
  /** Wall ms between the end of the previous frame and the start of this one. See E-01/E-06. */
  IDLE_MS: 18,
  /**
   * E-29. `_collectVisibleLights` -- sort, screen-bounds test and persist for every
   * visible light, plus its flash branch.
   *
   * **Not a sibling of COLLECT_MS.** It runs after `buildCustomLayerQueues` and before
   * `buildVisibilityPolygons`, so it sits in the gap between COLLECT_MS + CUSTOM_LAYER_MS
   * and VISIBILITY_MS and belongs to neither. That gap is exactly why it was invisible:
   * every phase around it had a timer, and the one without a timer was the one nobody
   * could name.
   */
  VISIBLE_LIGHTS_MS: 19,
  /**
   * E-29. `_collectStampLights` -- the light list for the shadow stamp pass.
   *
   * **A sub-timer of SHADOW_Q_MS, not a sibling.** It is called from `_stampAgainstSun`,
   * which is inside `_packGpuShadows`, which is inside the window `SHADOW_Q_MS` measures.
   * Summing the two double-counts. It is its own slot because the shadow work is the one
   * thing on the critical path (E-33) and a caller had no way to separate "pick the
   * lights" from "stamp against them".
   */
  STAMP_LIGHTS_MS: 20,
  STRIDE_FLOATS: 21,
  BUFFER_SIZE_PER_WORKER: 21 * 4,
  /** One worker. Multi-worker buffers are BUFFER_SIZE_PER_WORKER * N. */
  BUFFER_SIZE: 21 * 4,
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

export const STAT_KIND = Object.freeze({
  /** Part of STEP_MS that no other TIME chip contains. Rest subtracts these. */
  TIME: 'time',
  COUNT: 'count',
  /** Inside another chip (STAMP_LIGHTS_MS in SHADOW_Q_MS, LIQUIDFUN_MS in BOX2D_MS). */
  NESTED: 'nested',
  REST: 'rest',
  /** Time outside STEP_MS: IDLE_MS is the gap between frames. */
  OUTSIDE: 'outside',
});

/** Step minus partition time chips. Derived in the Performance panel, not a SAB field. */
const REST_STAT = Object.freeze({
  key: 'REST_MS',
  label: 'Rest',
  format: fmtMs,
  kind: STAT_KIND.REST,
});

/**
 * @param {{ key: string, src?: string|null }} stat
 * @param {Float32Array} view
 * @param {Record<string, number>} schema
 */
export function readDisplayStat(stat, view, schema) {
  if (!view || !schema || stat.src === null) return NaN;
  const key = stat.src || stat.key;
  const idx = schema[key];
  if (idx == null) return NaN;
  return view[idx];
}

/** STEP_MS minus chips with kind time. Nested, outside-the-step and counts are ignored. */
export function computeRestMs(config, view, schema) {
  if (!config?.stats) return 0;
  let step = 0;
  let sum = 0;
  for (let i = 0; i < config.stats.length; i++) {
    const stat = config.stats[i];
    if (stat.key === 'STEP_MS') {
      const v = readDisplayStat(stat, view, schema);
      step = Number.isFinite(v) ? v : 0;
      continue;
    }
    if (stat.kind !== STAT_KIND.TIME) continue;
    const v = readDisplayStat(stat, view, schema);
    if (Number.isFinite(v)) sum += v;
  }
  return step - sum;
}

export function displayHeadKeys() {
  return ['STEP_MS', 'LOAD', 'FPS'];
}

export function displayDetailStart() {
  return 3;
}

/**
 * Display configuration for worker stats.
 * First keys (Step / Load / Fps) are common columns.
 * Remaining stats go in Details. kind time partitions Step; Rest is derived.
 */
export const WORKER_DISPLAY_CONFIG = Object.freeze({
  renderer: {
    label: 'Render',
    color: 'renderer',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'QUEUE_MS', label: 'Queue', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'LIGHTS_MS', label: 'Lights', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'SHADOWS_MS', label: 'Shadows', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'SPRITES_MS', label: 'Upload', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'LAST_UPLOAD_MS', label: 'LastUp', format: fmtMs },
      { key: 'NEW_QUEUE', label: 'NewQ', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'SORT_MS', label: 'Sort', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'CUSTOM_LAYERS_MS', label: 'Custom', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'MISC_MS', label: 'Misc', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'PRESENT_MS', label: 'Present', format: fmtMs, kind: STAT_KIND.TIME },
      REST_STAT,
      { key: 'DRAW_CALLS', label: 'Draws', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'VISIBLE_SPRITES', label: 'Sprites', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'VISIBLE_ENTITIES', label: 'Visible', format: fmtNum, kind: STAT_KIND.COUNT },
    ],
  },
  gpu: {
    label: 'GPU',
    color: 'gpu',
    stats: [
      { key: 'GPU_PASSES', label: 'Passes', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'GPU_CASTERS', label: 'Casters', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'GPU_SHADOW_LIGHTS', label: 'ShadowLights', format: fmtNum, kind: STAT_KIND.COUNT },
    ],
  },
  particle: {
    label: 'Particles',
    color: 'particle',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'DECAL_STAMP_MS', label: 'Stamp', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'PARTICLE_PHYSICS_MS', label: 'Sim', format: fmtMs, kind: STAT_KIND.TIME },
      // E-37. COMPUTED / SERVICED is the flowfield LRU miss rate; the panel shows both
      // because either alone is not interpretable.
      { key: 'FLOWFIELDS_COMPUTED', label: 'FlowCalc', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'FLOWFIELDS_SERVICED', label: 'FlowReq', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'PATHS_COMPUTED', label: 'PathCalc', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'BUILD_ACTIVE_VISIBLE_MS', label: 'Lists', format: fmtMs, kind: STAT_KIND.TIME },
      REST_STAT,
      { key: 'ACTIVE_PARTICLES', label: 'Active', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'PARTICLES_STAMPED', label: 'Stamped', format: fmtNum, kind: STAT_KIND.COUNT },
    ],
  },
  physics: {
    label: 'Physics',
    color: 'physics',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'BOX2D_MS', label: 'Box2d', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'LIQUIDFUN_MS', label: 'LiquidFun', format: fmtMs, kind: STAT_KIND.NESTED },
      // M4: waiting for the next logic query of a burst; outside BOX2D_MS.
      { key: 'WAIT_MS', label: 'Wait', format: fmtMs, kind: STAT_KIND.TIME },
      REST_STAT,
      // E-56: queries answered between steps, outside STEP_MS (like Idle).
      { key: 'QUERY_WAKE_MS', label: 'QueryWake', format: fmtMs, kind: STAT_KIND.OUTSIDE },
      { key: 'LF_PASS_FIND_CONTACTS_MS', label: 'LfFind', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'LF_PASS_CONTACT_SOLVERS_MS', label: 'LfSolv', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'LF_PASS_PRESSURE_MS', label: 'LfP', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'LF_PASS_STATIC_PRESSURE_MS', label: 'LfStatP', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'LF_PASS_WEIGHT_MS', label: 'LfWt', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'LF_PASS_BODY_MS', label: 'LfBody', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'LF_PASS_GRID_MS', label: 'LfGrid', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'LF_PASS_REST_MS', label: 'LfRest', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'PROFILE_COLLIDE_MS', label: 'Collide', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'PROFILE_SOLVE_MS', label: 'Solve', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'PROFILE_SLEEP_MS', label: 'Sleep', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'BODY_COUNT', label: 'Bodies', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'AWAKE_COUNT', label: 'Awake', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'BODY_MOVED_COUNT', label: 'Moved', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'CONTACT_BEGIN', label: 'Contacts', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'COUNTER_ISLANDS', label: 'Islands', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'COUNTER_AWAKE_CONTACTS', label: 'AwakeC', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'WEED_JOINTS', label: 'Joints', format: fmtNum, kind: STAT_KIND.COUNT },
    ],
  },
  spatial: {
    label: 'Spatial',
    color: 'spatial',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'REBUILD_MS', label: 'Rebuild', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'NEIGHBOR_MS', label: 'Search', format: fmtMs, kind: STAT_KIND.TIME },
      REST_STAT,
      { key: 'ENTITIES_PROCESSED', label: 'Entities', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'NEIGHBOR_CHECKS', label: 'Neighbors', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'NEIGHBORS_REUSED', label: 'Reused', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'SLEEP_NEIGHBOR_SKIPS', label: 'SleepSkip', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'IDLE_MS', label: 'Idle', format: fmtMs, kind: STAT_KIND.OUTSIDE },
    ],
  },
  logic: {
    label: 'Logic',
    color: 'logic',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      // ENTITY_MS is the whole entity loop. Rays, decimation, ticks and the
      // query waits all run inside it, so they are nested, not partitions.
      { key: 'RAYCAST_MS', label: 'Ray', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'BOX2D_RAYCAST_MS', label: 'Box2dRay', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'ENTITY_MS', label: 'Entity', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'DECIMATE_MS', label: 'Decim', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'TICK_MS', label: 'Tick', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'QUERY_PUBLISH_MS', label: 'QueryPub', format: fmtMs, kind: STAT_KIND.TIME },
      REST_STAT,
      { key: 'ENTITIES_PROCESSED', label: 'Entities', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'RAYCAST_COUNT', label: 'Rays', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'BOX2D_RAYCAST_COUNT', label: 'Box2dRays', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'MARK_ACTIVE', label: 'Mark', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'WAIT_MS', label: 'Wait', format: fmtMs, kind: STAT_KIND.NESTED },
      { key: 'IDLE_MS', label: 'Idle', format: fmtMs, kind: STAT_KIND.OUTSIDE },
      { key: 'PAIR_COUNT', label: 'Pairs', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'PAIR_OWN', label: 'OwnPairs', format: fmtNum, kind: STAT_KIND.COUNT },
    ],
  },
  preRender: {
    label: 'PreRender',
    color: 'preRender',
    stats: [
      { key: 'STEP_MS', label: 'Step', format: fmtMs },
      LOAD_STAT,
      { key: 'FPS', label: 'Fps', format: fmtFps },
      { key: 'COLLECT_MS', label: 'Collect', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'SORT_MS', label: 'Sort', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'EMIT_MS', label: 'Emit', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'CUSTOM_LAYER_MS', label: 'Custom', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'SPRITE_PACK_MS', label: 'SpritePack', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'SHADOW_Q_MS', label: 'ShadowPack', format: fmtMs, kind: STAT_KIND.TIME },
      // E-29. Labeled "StampLights" and placed directly under ShadowPack because it is a
      // SUB-TIMER of SHADOW_Q_MS, not a peer: reading this row as additive with the one
      // above is the mistake the schema comment warns about. It sits last of the time
      // rows so the panel's own ordering does not imply a sum.
      { key: 'STAMP_LIGHTS_MS', label: 'StampLights', format: fmtMs, kind: STAT_KIND.NESTED },
      // E-29. A peer of every row above: it is the one phase that falls between
      // CUSTOM_LAYER_MS and VISIBILITY_MS rather than inside either.
      { key: 'VISIBLE_LIGHTS_MS', label: 'VisLights', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'VISIBILITY_MS', label: 'Vis', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'ADOBE_MS', label: 'Adobe', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'WAIT_MS', label: 'Wait', format: fmtMs, kind: STAT_KIND.TIME },
      { key: 'IDLE_MS', label: 'Idle', format: fmtMs, kind: STAT_KIND.OUTSIDE },
      REST_STAT,
      { key: 'RENDER_QUEUE_SIZE', label: 'Queue', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'SKIPPED_FRAMES', label: 'Skipped', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'VISIBLE_ENTITIES', label: 'Visible', format: fmtNum, kind: STAT_KIND.COUNT },
      { key: 'SHADOWS_UPDATED', label: 'Shadows', format: fmtNum, kind: STAT_KIND.COUNT },
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
