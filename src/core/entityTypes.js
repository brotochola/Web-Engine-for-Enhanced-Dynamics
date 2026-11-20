// E-533: each entity class's engine components as bits, for the code that works an entity by its index. A component's
// statics (SpriteRenderer.setAlpha(i, a), Collider.setRadius(i, r)) are the implementation of what an entity's methods
// do, and the work depends on which renderers and body parts the entity has (an alpha reaches its sprite row, its
// Adobe clip and the mesh row of its shadow volume). An entity's method passes its class's bits (on the class's
// prototype, beside _hasComponents); a static reads them from a table by entity type, filled where the types are
// registered (the page's scene, each logic worker). Bits rather than an object of flags: one array load, the same map
// for every type, so a static stays monomorphic whatever entity it is handed.

export const HAS_SPRITE = 1 << 0;
export const HAS_MESH = 1 << 1;
export const HAS_ADOBE = 1 << 2;
export const HAS_BODY = 1 << 3; // RigidBody
export const HAS_COLLIDER = 1 << 4;
export const HAS_LIGHT = 1 << 5; // LightEmitter
export const HAS_SHADOW = 1 << 6; // ShadowCaster
export const HAS_DIRECTIONAL = 1 << 7; // DirectionalSprite

/** Set in every bits word a type's registration wrote, so a type with none of the components above is not 0. */
const KNOWN = 1 << 30;

const BIT_BY_COMPONENT_NAME = {
  SpriteRenderer: HAS_SPRITE,
  MeshRenderer: HAS_MESH,
  AdobeAnimComponent: HAS_ADOBE,
  RigidBody: HAS_BODY,
  Collider: HAS_COLLIDER,
  LightEmitter: HAS_LIGHT,
  ShadowCaster: HAS_SHADOW,
  DirectionalSprite: HAS_DIRECTIONAL,
};

let typeBits = new Uint32Array(64);
/** The class registered for an entity type (GameObject.classByType), for a type no registration noted. */
let classOfType = null;

/**
 * The bits of an entity class's components: its static components up its class chain, and what each one requires
 * (collectComponents' list).
 * @param {Function} EntityClass
 */
export function bitsOfClass(EntityClass) {
  let bits = 0;
  const seen = new Set();
  const add = (component) => {
    if (!component || seen.has(component)) return;
    seen.add(component);
    const bit = BIT_BY_COMPONENT_NAME[component.name];
    if (bit !== undefined) bits |= bit;
    if (Array.isArray(component.requires)) component.requires.forEach(add);
  };
  for (let C = EntityClass; C && C !== Object && C !== Function.prototype; C = Object.getPrototypeOf(C)) {
    if (Object.prototype.hasOwnProperty.call(C, 'components') && Array.isArray(C.components)) C.components.forEach(add);
  }
  return bits;
}

/** The bits of an object of component flags ({ SpriteRenderer: true, ... }: an entity's _hasComponents). */
export function bitsOfFlags(flags) {
  let bits = 0;
  if (!flags) return bits;
  for (const name in BIT_BY_COMPONENT_NAME) if (flags[name] === true) bits |= BIT_BY_COMPONENT_NAME[name];
  if (flags.adobeAnimComponent === true) bits |= HAS_ADOBE;
  return bits;
}

/** Where a type's registration notes its class: the page's scene and each logic worker. */
export function noteEntityType(entityType, EntityClass) {
  if (entityType >= typeBits.length) {
    const grown = new Uint32Array(Math.max(entityType + 1, typeBits.length * 2));
    grown.set(typeBits);
    typeBits = grown;
  }
  typeBits[entityType] = bitsOfClass(EntityClass) | KNOWN;
}

/** A scene's teardown: its types go (the next scene numbers its own). */
export function clearEntityTypes() {
  typeBits.fill(0);
}

/** GameObject hands its class table over at load, for a type no registration noted (tests, tools). */
export function setEntityClassLookup(lookup) {
  classOfType = lookup;
}

/**
 * The component bits of entity type `entityType`: from its registration, or from its class when none noted it.
 * @param {number} entityType
 */
export function typeBitsOf(entityType) {
  const bits = entityType < typeBits.length ? typeBits[entityType] : 0;
  return bits !== 0 ? bits : unregisteredTypeBits(entityType);
}

/**
 * The name of entity type `entityType`'s class, for a warning a static gives (an entity's method names this.constructor).
 * @param {number} entityType
 */
export function classNameOfType(entityType) {
  const C = classOfType !== null ? classOfType(entityType) : undefined;
  return C ? C.name : 'An entity';
}

function unregisteredTypeBits(entityType) {
  const C = classOfType !== null ? classOfType(entityType) : undefined;
  return C ? bitsOfClass(C) : 0;
}
