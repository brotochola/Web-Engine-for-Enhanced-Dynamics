import { CollisionListener } from '../components/collisionListener.js';
import { CameraInOutListener } from '../components/cameraInOutListener.js';
import { JointBreakListener } from '../components/jointBreakListener.js';
import { DirectionalSprite } from '../components/directionalSprite.js';
import { ENTITY_HOOKS, definesHook } from '../core/entityHooks.js';

const GATES = { CollisionListener, CameraInOutListener, JointBreakListener, DirectionalSprite };

/**
 * Callbacks that only run when the entity type lists a component (the hook table's gates): [hook, component].
 * Defining one without its component is legal and silent at runtime: the hook never runs. The scene checks this once
 * at registration (main thread) and warns. A static form counts as a method does (E-528).
 */
const GATED_HOOKS = ENTITY_HOOKS.filter((h) => h.gate !== null).map((h) => {
  const Tag = GATES[h.gate];
  if (Tag === undefined) throw new Error(`listenerTags: no component for the gate ${h.gate} of ${h.name}`);
  return [h.name, Tag];
});

/**
 * Tags an entity class needs for the gated hooks it overrides but does not list.
 * @param {Function} EntityClass
 * @param {Function[]} components - what collectComponents returned for it
 * @param {Function} BaseClass - GameObject
 * @returns {{ tag: Function, hooks: string[] }[]}
 */
export function missingListenerTags(EntityClass, components, BaseClass) {
  const missing = [];
  for (const [hook, Tag] of GATED_HOOKS) {
    if (components.includes(Tag)) continue;
    if (!definesHook(EntityClass, BaseClass, hook)) continue;
    let entry = missing.find((m) => m.tag === Tag);
    if (!entry) {
      entry = { tag: Tag, hooks: [] };
      missing.push(entry);
    }
    entry.hooks.push(hook);
  }
  return missing;
}

/**
 * True when a method of the class (own or inherited below BaseClass) calls
 * isCollidingWith. A dev-time lint on the method source: a helper outside
 * the class is not seen.
 * @param {Function} EntityClass
 * @param {Function} BaseClass
 */
export function callsIsCollidingWith(EntityClass, BaseClass) {
  let proto = EntityClass.prototype;
  const stop = BaseClass.prototype;
  while (proto && proto !== stop) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc && typeof desc.value === 'function' && desc.value.toString().includes('isCollidingWith(')) {
        return true;
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Warn once per class for missing tags, and once per scene when a class calls
 * isCollidingWith but no type lists CollisionListener (the pair set is never built).
 * @param {{ class: Function, components: Function[] }[]} registered
 * @param {Function} BaseClass
 * @param {(msg: string) => void} [warn]
 */
export function warnMissingListenerTags(registered, BaseClass, warn = console.warn) {
  let anyCollisionListener = false;
  for (const r of registered) {
    if (r.components.includes(CollisionListener)) anyCollisionListener = true;
    for (const { tag, hooks } of missingListenerTags(r.class, r.components, BaseClass)) {
      warn(
        `WeedJS: ${r.class.name} defines ${hooks.join(', ')} but its static components do not list ` +
          `${tag.name}, so ${hooks.length > 1 ? 'they never run' : 'it never runs'}. ` +
          `Add ${tag.name} to ${r.class.name}.components.`
      );
    }
  }
  if (anyCollisionListener) return;
  for (const r of registered) {
    if (!callsIsCollidingWith(r.class, BaseClass)) continue;
    warn(
      `WeedJS: ${r.class.name} calls isCollidingWith, but no entity type in this scene lists ` +
        `CollisionListener, so it always returns false. Add CollisionListener to at least one type.`
    );
    return;
  }
}
