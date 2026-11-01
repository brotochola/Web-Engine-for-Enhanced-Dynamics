// Accessors the engine defines on game classes' prototypes: an entity class's component getters (gameObject.js) and a
// component's field accessors (component.js). A hot swap keeps them on the running class: the new version of a class
// is never registered or initialized, so its prototype has none of its own (or a probe's), and the running class's are
// the ones its instances read. Everything else on a prototype is the class's code, which a swap replaces.

const ENGINE_ACCESSORS = new WeakSet();

/** Mark a getter or setter the engine defined on a game class's prototype. Returns it. */
export function markEngineAccessor(fn) {
  if (typeof fn === 'function') ENGINE_ACCESSORS.add(fn);
  return fn;
}

/** True when a property descriptor is one of the engine's accessors. */
export function isEngineAccessor(descriptor) {
  if (descriptor === undefined) return false;
  const { get, set } = descriptor;
  return (typeof get === 'function' && ENGINE_ACCESSORS.has(get)) || (typeof set === 'function' && ENGINE_ACCESSORS.has(set));
}
