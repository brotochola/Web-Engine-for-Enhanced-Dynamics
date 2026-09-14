// decorationFacades.js - Lazy Decoration JS facades (avoids DecorationPool <-> Decoration circular import)

const facadeMap = new Map();

/**
 * @param {function(new:object, number)} DecorationCtor
 * @param {number} id
 */
export function ensureDecorationFacade(DecorationCtor, id) {
  let f = facadeMap.get(id);
  if (!f) {
    f = new DecorationCtor(id);
    facadeMap.set(id, f);
  }
  return f;
}

/** @param {number} id */
export function evictDecorationFacade(id) {
  facadeMap.delete(id);
}

export function clearAllDecorationFacades() {
  facadeMap.clear();
}
