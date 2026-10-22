/**
 * A spawn into a full pool used to warn on every call, from every thread, so
 * a game that kept spawning flooded the console. Now the first thread that
 * finds a pool empty warns once for the scene, and the rest only count.
 *
 * Layout (Int32, one SAB per scene, bound on main and every worker):
 *   [2 * type]     warned flag for entity type `type` (0 → 1 once, CAS)
 *   [2 * type + 1] spawns that found that pool empty
 *   [2 * T]        warned flag for the joint pool (T = entity type count)
 *   [2 * T + 1]    joint creations that found it empty
 *
 * Only the failure path touches it: two Atomics ops, no allocation after the
 * first warning's message string.
 */

let view = new Int32Array(0);
let jointSlot = 0;
/** Unbound fallback (Node tests, a pool used before the scene binds): per-key flags. */
const localWarned = new Set();

/** @param {number} entityTypeCount */
export function poolExhaustionBytes(entityTypeCount) {
  return ((entityTypeCount | 0) + 1) * 2 * 4;
}

/** @param {SharedArrayBuffer} sab */
export function bindPoolExhaustion(sab) {
  view = new Int32Array(sab);
  jointSlot = view.length - 2;
  localWarned.clear();
}

export function unbindPoolExhaustion() {
  view = new Int32Array(0);
  jointSlot = 0;
  localWarned.clear();
}

function firstToWarn(slot, key) {
  if (view.length === 0) {
    if (localWarned.has(key)) return false;
    localWarned.add(key);
    return true;
  }
  Atomics.add(view, slot + 1, 1);
  return Atomics.compareExchange(view, slot, 0, 1) === 0;
}

/**
 * A spawn found the pool of `EntityClass` empty.
 * @param {{ name: string, entityType: number, poolSize?: number }} EntityClass
 */
export function reportPoolExhausted(EntityClass) {
  const type = EntityClass.entityType | 0;
  const slot = 2 * type;
  if (view.length !== 0 && slot >= jointSlot) return;
  if (!firstToWarn(slot, EntityClass.name)) return;
  const name = EntityClass.name;
  console.warn(
    `WeedJS: the ${name} pool is full (${EntityClass.poolSize} slots), so spawns return null until one despawns. ` +
      `Raise its count in static entities ([${name}, N]). Further failed spawns are counted ` +
      `(getPoolStats(${name}).dropped), not logged.`
  );
}

/** A joint creation found the joint pool empty. @param {number} capacity */
export function reportJointPoolExhausted(capacity) {
  if (!firstToWarn(jointSlot, '#joints')) return;
  console.warn(
    `WeedJS: the joint pool is full (physics.maxJoints = ${capacity}), so new joints return -1 until one is removed. ` +
      'Raise physics.maxJoints. Further failures are counted, not logged.'
  );
}

/** Spawns of this type that found its pool empty this scene. */
export function droppedSpawns(EntityClass) {
  const slot = 2 * (EntityClass.entityType | 0);
  if (view.length === 0 || slot >= jointSlot) return 0;
  return Atomics.load(view, slot + 1);
}

/** Joint creations that found the joint pool empty this scene. */
export function droppedJoints() {
  return view.length === 0 ? 0 : Atomics.load(view, jointSlot + 1);
}
