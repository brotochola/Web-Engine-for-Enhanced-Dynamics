// E-199: neighbour aggregates. An entity type asks for them with `static neighborAggregates`, and the spatial publish
// (wasm/spatialPublish.c, publish_batch_agg) writes them with each neighbour row it publishes for an entity of that
// type: the separation, the cohesion group's centroid (and average velocity) and the K nearest of a type, over the row,
// with the d² the publish already has. Game code then reads one row of NeighborAggregates (src/core/neighborAggregates.js)
// instead of every neighbour's Transform.
//
// This module resolves the classes' configs on the page (resolveNeighborAggregates), says which regions the spatial
// publish memory needs (wasmMemoryMap.js), and writes the kernel's table (writeNeighborAggregateTable, each spatial
// worker the same bytes). The table's words and a config's layout are the kernel's AGG_* defines.

/** The table's u32 words (wasm/spatialPublish.c AGG_*). */
export const AGG_CLASS = 0;
export const AGG_CONFIGS = 1;
export const AGG_SEP_X = 2;
export const AGG_SEP_Y = 3;
export const AGG_SEP_N = 4;
export const AGG_COH_X = 5;
export const AGG_COH_Y = 6;
export const AGG_COH_N = 7;
export const AGG_VEL_X = 8;
export const AGG_VEL_Y = 9;
export const AGG_NEAR_ID = 10;
export const AGG_NEAR_D2 = 11;
export const AGG_NEAR_N = 12;
export const AGG_NEAR_SLOTS = 13;
/** The table's header (16 u32 words), then a config per type, AGG_CONFIG_BYTES each, from index 1 (0: no aggregates). */
export const AGG_HEADER_BYTES = 64;
export const AGG_CONFIG_BYTES = 64;
/** A config's flags (its first u32, at byte 32). */
export const AGG_F_SEPARATION = 1;
export const AGG_F_COHESION = 2;
export const AGG_F_VELOCITY = 4;
export const AGG_F_NEAREST = 8;
/** The most nearest slots a type may ask for (nearest.count). */
export const NEAREST_MAX = 16;
/** The class byte holds a config index: at most this many types with aggregates. */
const MAX_TYPES = 255;
/** "Any type": a range that holds every entity index. */
const ANY_LO = 0;
const ANY_SPAN = 0xffffffff;

const KEYS = ['separation', 'cohesion', 'nearest'];
const SEPARATION_KEYS = ['radius', 'floor', 'falloff', 'ofType'];
const COHESION_KEYS = ['minDistance', 'velocity', 'ofType'];
const NEAREST_KEYS = ['count', 'ofType'];

function fail(className, text) {
  throw new Error(`WeedJS: ${className}.neighborAggregates: ${text}`);
}

function checkKeys(className, where, obj, keys) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) fail(className, `${where} must be an object`);
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) fail(className, `${where}.${k} is not an option (${keys.join(', ')})`);
  }
}

function distanceOption(className, where, value, fallback, { infinite = false } = {}) {
  if (value === undefined) return fallback;
  const ok = typeof value === 'number' && value >= 0 && (Number.isFinite(value) || (infinite && value === Infinity));
  if (!ok) fail(className, `${where} must be a distance in px, 0 or more${infinite ? ' (Infinity: the whole list)' : ''}`);
  return value;
}

/**
 * The slots of the type `ofType` names, as [lo, span) (any type without one).
 * @param {Map<Function, { startIndex: number, count: number }>} byClass
 */
function typeRange(className, where, ofType, byClass) {
  if (ofType === undefined || ofType === null) return [ANY_LO, ANY_SPAN];
  const r = typeof ofType === 'function' ? byClass.get(ofType) : undefined;
  if (!r) {
    const name = typeof ofType === 'function' ? ofType.name : String(ofType);
    fail(className, `${where}.ofType ${name} is not an entity type of this scene (give its class, listed in static entities)`);
  }
  if (!(r.count > 0)) {
    fail(className, `${where}.ofType ${ofType.name} has no slots of its own (a parent class): name the type its entities are`);
  }
  return [r.startIndex >>> 0, r.count >>> 0];
}

/**
 * One type's config, resolved for the kernel (the doubles squared, the types as slot ranges).
 * @param {{ class: Function, startIndex: number, count: number }} reg
 * @param {object} cfg the class's neighborAggregates
 * @param {Map<Function, { startIndex: number, count: number }>} byClass
 * @param {boolean} physics
 */
function resolveOne(reg, cfg, byClass, physics) {
  const className = reg.class.name;
  checkKeys(className, 'neighborAggregates', cfg, KEYS);
  let flags = 0;
  let sepR2 = 0;
  let sepFloor2 = 0;
  let sepFalloff = 0;
  let cohMin2 = 0;
  let sep = [ANY_LO, 0];
  let coh = [ANY_LO, 0];
  let near = [ANY_LO, 0];
  let nearK = 0;
  if (cfg.separation !== undefined) {
    const s = cfg.separation;
    checkKeys(className, 'separation', s, SEPARATION_KEYS);
    const radius = distanceOption(className, 'separation.radius', s.radius, Infinity, { infinite: true });
    const floor = distanceOption(className, 'separation.floor', s.floor, 0);
    const falloff = s.falloff === undefined ? 'none' : s.falloff;
    if (falloff !== 'none' && falloff !== 'linear') fail(className, "separation.falloff must be 'none' or 'linear'");
    if (falloff === 'linear' && !Number.isFinite(radius)) fail(className, "separation.falloff 'linear' needs a separation.radius");
    if (!(radius > 0)) fail(className, 'separation.radius must be over 0');
    flags |= AGG_F_SEPARATION;
    sepR2 = radius * radius;
    sepFloor2 = floor * floor;
    sepFalloff = falloff === 'linear' ? 1 / sepR2 : 0;
    sep = typeRange(className, 'separation', s.ofType, byClass);
  }
  if (cfg.cohesion !== undefined) {
    const c = cfg.cohesion;
    checkKeys(className, 'cohesion', c, COHESION_KEYS);
    const minDistance = distanceOption(className, 'cohesion.minDistance', c.minDistance, 0);
    if (c.velocity !== undefined && typeof c.velocity !== 'boolean') fail(className, 'cohesion.velocity must be true or false');
    flags |= AGG_F_COHESION;
    if (c.velocity === true) {
      if (!physics) fail(className, "cohesion.velocity averages RigidBody's velocities, which are Box2D's: it needs physics");
      flags |= AGG_F_VELOCITY;
    }
    cohMin2 = minDistance * minDistance;
    coh = typeRange(className, 'cohesion', c.ofType, byClass);
  }
  if (cfg.nearest !== undefined) {
    const n = cfg.nearest;
    checkKeys(className, 'nearest', n, NEAREST_KEYS);
    const count = n.count === undefined ? 1 : n.count;
    if (!Number.isInteger(count) || count < 1 || count > NEAREST_MAX) fail(className, `nearest.count must be a whole number from 1 to ${NEAREST_MAX}`);
    flags |= AGG_F_NEAREST;
    nearK = count;
    near = typeRange(className, 'nearest', n.ofType, byClass);
  }
  if (flags === 0) return null;
  return {
    name: className,
    startIndex: reg.startIndex | 0,
    endIndex: (reg.startIndex | 0) + (reg.count | 0),
    flags,
    sepR2,
    sepFloor2,
    sepFalloff,
    cohMin2,
    sepLo: sep[0],
    sepSpan: sep[1],
    cohLo: coh[0],
    cohSpan: coh[1],
    nearLo: near[0],
    nearSpan: near[1],
    nearK,
  };
}

/**
 * The scene's aggregates: each registered type with slots whose class (or a parent) sets `static neighborAggregates`,
 * resolved, and which outputs any of them asks for. null when none does: the scene keeps the plain publish.
 * @param {Array<{ class: Function, startIndex: number, count: number }>} registeredClasses
 * @param {{ physics?: boolean }} [opts] physics: the scene runs Box2D (cohesion.velocity reads its velocities)
 */
export function resolveNeighborAggregates(registeredClasses, { physics = true } = {}) {
  const byClass = new Map();
  for (const r of registeredClasses || []) byClass.set(r.class, r);
  const classes = [];
  for (const r of registeredClasses || []) {
    const cfg = r.class?.neighborAggregates;
    if (cfg === undefined || cfg === null || !(r.count > 0)) continue;
    const resolved = resolveOne(r, cfg, byClass, physics);
    if (resolved) classes.push(resolved);
  }
  if (classes.length === 0) return null;
  if (classes.length > MAX_TYPES) throw new Error(`WeedJS: neighborAggregates: ${classes.length} entity types ask for them, at most ${MAX_TYPES} can`);
  let nearestSlots = 0;
  for (const c of classes) if (c.nearK > nearestSlots) nearestSlots = c.nearK;
  return {
    separation: classes.some((c) => (c.flags & AGG_F_SEPARATION) !== 0),
    cohesion: classes.some((c) => (c.flags & AGG_F_COHESION) !== 0),
    velocity: classes.some((c) => (c.flags & AGG_F_VELOCITY) !== 0),
    nearestSlots,
    classes,
  };
}

/** The table region's bytes: the header, then a config for each type from index 1. */
export function neighborAggregateTableBytes(spec) {
  return AGG_HEADER_BYTES + (1 + spec.classes.length) * AGG_CONFIG_BYTES;
}

/**
 * Write the kernel's table and the class byte of every entity into the memory (every spatial worker writes the same
 * bytes). `layout` is the spec with its regions' bytes (createSpatialPublishMemory's `aggregates`); a region the scene
 * does not need is 0.
 * @param {ArrayBufferLike} buffer
 * @param {object} layout
 */
export function writeNeighborAggregateTable(buffer, layout) {
  const words = new Uint32Array(buffer, layout.tableByte, AGG_HEADER_BYTES / 4);
  words.fill(0);
  words[AGG_CLASS] = layout.classByte;
  words[AGG_CONFIGS] = layout.tableByte + AGG_HEADER_BYTES;
  words[AGG_SEP_X] = layout.separationXByte;
  words[AGG_SEP_Y] = layout.separationYByte;
  words[AGG_SEP_N] = layout.separationCountByte;
  words[AGG_COH_X] = layout.centroidXByte;
  words[AGG_COH_Y] = layout.centroidYByte;
  words[AGG_COH_N] = layout.cohesionCountByte;
  words[AGG_VEL_X] = layout.averageVelocityXByte;
  words[AGG_VEL_Y] = layout.averageVelocityYByte;
  words[AGG_NEAR_ID] = layout.nearestIndexByte;
  words[AGG_NEAR_D2] = layout.nearestDistanceSqByte;
  words[AGG_NEAR_N] = layout.nearestCountByte;
  words[AGG_NEAR_SLOTS] = layout.nearestSlots;
  const classOf = new Uint8Array(buffer, layout.classByte, layout.entityCount);
  classOf.fill(0);
  for (let c = 0; c < layout.classes.length; c++) {
    const t = layout.classes[c];
    const at = layout.tableByte + AGG_HEADER_BYTES + (c + 1) * AGG_CONFIG_BYTES;
    const d = new Float64Array(buffer, at, 4);
    d[0] = t.sepR2;
    d[1] = t.sepFloor2;
    d[2] = t.sepFalloff;
    d[3] = t.cohMin2;
    const u = new Uint32Array(buffer, at + 32, 8);
    u[0] = t.flags;
    u[1] = t.sepLo;
    u[2] = t.sepSpan;
    u[3] = t.cohLo;
    u[4] = t.cohSpan;
    u[5] = t.nearLo;
    u[6] = t.nearSpan;
    u[7] = t.nearK;
    classOf.fill(c + 1, Math.max(0, t.startIndex), Math.min(layout.entityCount, t.endIndex));
  }
}
