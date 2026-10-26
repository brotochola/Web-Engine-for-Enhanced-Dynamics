// E-127. Static scenery: an entity type that declares `static isStatic = true` does not move after onSpawned.
// Pre-render bins those types' sprites in a grid of its own (staticSceneryGrid.js) and culls them by the cells in
// view, so a large world of props costs what the view holds, not what the world holds. This counter tells it when to
// bin them again: a static entity spawned or despawned, or moved, resized or given another sprite through the
// GameObject setters. Writing a static entity's Transform columns directly does not move the counter.

import { Transform } from '../components/transform.js';

let gen = null;
/** 1 for each entity type that declares isStatic, by entityType. */
let staticTypes = new Uint8Array(0);
let anyStatic = false;

/** The scene's counter (a SharedArrayBuffer of one Int32), or null to unbind. */
export function bindStaticSceneryGen(sab) {
  gen = sab ? new Int32Array(sab, 0, 1) : null;
}

/**
 * The static types from the registered classes, as the workers receive them ({ entityType, isStatic }) or as the
 * scene holds them ({ entityType, class }).
 */
export function bindStaticTypes(registeredClasses) {
  let max = -1;
  for (const r of registeredClasses || []) if (r.entityType > max) max = r.entityType;
  staticTypes = new Uint8Array(max + 1);
  anyStatic = false;
  for (const r of registeredClasses || []) {
    const flag = r.isStatic === true || (r.class && r.class.isStatic === true);
    if (flag && r.entityType >= 0) {
      staticTypes[r.entityType] = 1;
      anyStatic = true;
    }
  }
}

/** Whether entity type `t` is static scenery. */
export function isStaticType(t) {
  return t < staticTypes.length && staticTypes[t] === 1;
}

/** A static entity changed what pre-render binned: bin again. */
export function staticSceneryChanged() {
  if (gen !== null) Atomics.add(gen, 0, 1);
}

/** The same, when entity `i` is static scenery. */
export function staticSceneryChangedAt(i) {
  if (anyStatic && gen !== null && staticTypes[Transform.entityType[i]] === 1) Atomics.add(gen, 0, 1);
}

/** The counter's value (0 unbound). */
export function staticSceneryGen() {
  return gen !== null ? Atomics.load(gen, 0) : 0;
}
