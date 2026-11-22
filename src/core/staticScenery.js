// E-127. Static scenery: an entity type that declares `static isStatic = true` does not move after onSpawned.
// Pre-render bins those types' sprites in a grid of its own (staticSceneryGrid.js) and culls them by the cells in
// view, so a large world of props costs what the view holds, not what the world holds. This counter tells it when to
// bin them again: a static entity spawned or despawned, or moved, resized or given another sprite through the
// GameObject setters. Writing a static entity's Transform columns directly does not move the counter.

/**
 * The Transform class, which transform.js hands over as it loads (setSceneryTransform). Not an import: this module
 * imports nothing, so transform.js's pose setters (Transform.setX, E-533) can alias staticSceneryChangedAt as a module
 * const, which importAliases.test.js allows only from outside the importer's import cycle (E-474).
 */
let Transform = null;

/** transform.js, as it loads. */
export function setSceneryTransform(TransformClass) {
  Transform = TransformClass;
}

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
