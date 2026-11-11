/**
 * DX-GUARDS C3, C4, C5: entity classes written in a way that does not do what it says. Checked once, when the scene
 * registers its classes (main thread, both builds), and said once per class and rule.
 */
import { warnOnce } from './dxWarn.js';

/** The class (Entity itself or a game base class below Base) that defines `name`, or null. */
function definer(EntityClass, BaseClass, name) {
  let proto = EntityClass.prototype;
  const stop = BaseClass.prototype;
  while (proto && proto !== stop) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) return proto.constructor;
    proto = Object.getPrototypeOf(proto);
  }
  return null;
}

/**
 * True when a method's body holds nothing but whitespace and comments: `tick() {}`, `tick(dt) { // later }`.
 * @param {Function} fn
 */
export function isEmptyMethod(fn) {
  if (typeof fn !== 'function') return false;
  const src = Function.prototype.toString.call(fn);
  const open = src.indexOf('{');
  const close = src.lastIndexOf('}');
  if (open < 0 || close <= open) return false;
  // A parameter's default may hold a brace (`tick(o = {})`): the body is what follows the parameter list.
  const params = src.indexOf('(');
  const paramsEnd = params >= 0 ? matchingParen(src, params) : -1;
  const start = paramsEnd > 0 ? src.indexOf('{', paramsEnd) : open;
  if (start < 0) return false;
  const body = src.slice(start + 1, close).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return body.trim() === '';
}

function matchingParen(src, at) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/**
 * C3: `static tickInterval > 1` needs `logic.staggeredUpdates`; without it the type ticks every frame.
 * C4: an empty `tick() {}` still has the logic workers call it on every entity of the type, every frame.
 * @param {{ class: Function, count: number }[]} registered
 * @param {Function} BaseClass GameObject
 * @param {{ logic?: { staggeredUpdates?: boolean } }} config the scene's config, defaults applied
 */
export function warnEntityClassMistakes(registered, BaseClass, config) {
  const staggered = config?.logic?.staggeredUpdates === true;
  for (const r of registered) {
    const C = r.class;
    if (!(r.count > 0) || !BaseClass.typeNeedsLogicTick(C)) continue;
    const name = C.name;
    const interval = C.tickInterval | 0;
    if (interval > 1 && !staggered) {
      warnOnce(
        name,
        'tick-interval',
        `${name} has static tickInterval = ${interval}, but the scene's logic.staggeredUpdates is off, so it ticks ` +
          'every frame. Set logic: { staggeredUpdates: true } in the scene\'s config.',
      );
    }
    if (isEmptyMethod(C.prototype.tick)) {
      const owner = definer(C, BaseClass, 'tick');
      const where = owner && owner !== C ? ` (from ${owner.name})` : '';
      warnOnce(
        name,
        'empty-tick',
        `${name}'s tick()${where} is empty, yet the logic workers call it on every ${name} each frame. Delete it, ` +
          'or set static tickInterval = 0 if it is there to stop a parent\'s tick.',
      );
    }
  }
}

/**
 * C5: the line for a class the scene skips because one with its name is registered already.
 * @param {{ class: Function, count: number }} existing the registered one
 * @param {Function} EntityClass the one being skipped
 * @param {number} count the pool asked for it
 * @param {{ class: Function }[]} registered every class registered so far
 */
export function duplicateEntityClassText(existing, EntityClass, count, registered) {
  const name = EntityClass.name;
  if (existing.class !== EntityClass) {
    return `two entity classes are named ${name}: the second is not registered, so it has no pool and cannot spawn ` +
      '(the workers find entity classes by name). Rename one.';
  }
  if (existing.count === 0 && count > 0) {
    const child = registered.find((r) => r.class !== EntityClass && r.class.prototype instanceof EntityClass);
    const by = child ? `${child.class.name}, which extends it, registered it first` : 'a subclass registered it first';
    return `${name} is listed in static entities after its subclasses: ${by} with no pool, so [${name}, ${count}] ` +
      `is ignored and ${name}.spawn() finds no slot. List ${name} before the classes that extend it.`;
  }
  return `${name} is listed twice in static entities: the entry [${name}, ${count}] is ignored and its pool stays ` +
    `${existing.count}. List it once.`;
}
