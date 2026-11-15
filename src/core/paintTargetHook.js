// A sprite or mesh turned on or off on an entity: the SpriteRenderer and MeshRenderer
// `active` setters call paintTargetChanged, and tween.js registers Tween.paintTargetChanged
// here, so a paint tween reads its target again (E-275) without the components importing
// the tween pool (tween.js imports them).

let hook = null;

/** @param {((entityIndex: number) => void) | null} fn */
export function setPaintTargetHook(fn) {
  hook = fn;
}

/** @param {number} entityIndex */
export function paintTargetChanged(entityIndex) {
  if (hook !== null) hook(entityIndex);
}
