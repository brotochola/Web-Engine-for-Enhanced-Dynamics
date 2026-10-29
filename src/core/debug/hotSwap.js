// Hot swap: put a changed game module's code into the running game, with no
// reload. Every thread that runs the module (the page and each worker) imports
// its new version and copies the new methods onto the classes already running,
// so pooled instances run the new code from their next call. Shared memory,
// entities, workers, instance fields and module state outside the changed
// module stay as they are.
//
// The new classes become aliases of the running ones: they share the engine's
// statics (pool, lists, component views) and `instanceof` answers for the
// running class, so new code that names a class from its own module (Coin.spawn,
// GameObject.is(other, Coin)) still reaches the registered one.
//
// What the engine built from a class's shape cannot change in place, and the
// caller falls back to the full save/reload/restore: components, ARRAY_SCHEMA,
// pools and scene config, which hooks a class defines (it decides who ticks and
// who gets callbacks), tickInterval, logic-worker pins, an entity's instance
// fields (the running instances were built without a new one), and exports
// that are not classes when their value changed (other modules keep the old
// binding).

import { ENGINE_INSTANCE_KEYS } from '../save/instanceFields.js';

/** Statics the engine writes on registered classes; the running class keeps them. */
const ENGINE_STATICS = new Set([
  'prototype',
  'length',
  'name',
  'entityType',
  'startIndex',
  'poolSize',
  'endIndex',
  'instances',
  'freeList',
  'freeListTop',
  '_activeList',
  '_componentClassMap',
  '_componentList',
  '_sharedHasComponents',
  // E-164: the class's component slots. The probe that lists a new version's fields leaves 0 and [] on it (it is not
  // registered), and a running class given those threw on its next first read of a component.
  '_componentSlotCount',
  '_componentSlotSpecs',
  'entityIndices',
  'componentId',
  'sharedBuffer',
  'clearValue',
  'scriptUrl',
]);

/** Statics the engine builds buffers, pools or dispatch from: a change needs a reload. */
const SHAPE_STATICS = [
  'components',
  'ARRAY_SCHEMA',
  'entities',
  'config',
  'assets',
  'messages',
  'sharedResources',
  'queries',
  'tickInterval',
  'forceProcessOnLogicWorker',
];

/** Hooks whose presence the engine reads once (tick lists, listener gates, inboxes). */
const SHAPE_HOOKS = [
  'tick',
  'onCollisionEnter',
  'onCollisionStay',
  'onCollisionExit',
  'onCollisionHit',
  'onScreenEnter',
  'onScreenExit',
  'onJointBreak',
  'onMessage',
  'onAnimationEnd',
  'onGotShot',
];

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The URL that loads a new copy of a module: browsers cache modules by URL. */
export function hotModuleUrl(url, version) {
  return `${url}${url.includes('?') ? '&' : '?'}weedHot=${version}`;
}

function isClass(value) {
  return typeof value === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(value));
}

/** JSON of a value with classes and functions by name: compares shapes, not identities. */
function shapeOf(value) {
  try {
    return JSON.stringify(value, (key, v) => (typeof v === 'function' ? `fn:${v.name}` : v)) ?? 'undefined';
  } catch {
    return `unserializable:${String(value)}`;
  }
}

/**
 * Pair each running class with its new version: the module's exports, then
 * what they reach (superclasses, scene entities, components, shared resources,
 * other statics holding classes). Pairs need the same name.
 * @returns {Map<Function, Function>} running → new
 */
export function pairClasses(oldNs, freshNs) {
  const pairs = new Map();
  const visit = (o, f) => {
    if (o === f || !isClass(o) || !isClass(f) || o.name !== f.name || pairs.has(o)) return;
    pairs.set(o, f);
    visit(Object.getPrototypeOf(o), Object.getPrototypeOf(f));
    for (const key of Object.getOwnPropertyNames(f)) {
      if (ENGINE_STATICS.has(key) || !hasOwn(o, key)) continue;
      const ov = o[key];
      const fv = f[key];
      if (Array.isArray(ov) && Array.isArray(fv)) {
        const n = Math.min(ov.length, fv.length);
        for (let i = 0; i < n; i++) {
          if (Array.isArray(ov[i]) && Array.isArray(fv[i])) visit(ov[i][0], fv[i][0]);
          else visit(ov[i], fv[i]);
        }
      } else {
        visit(ov, fv);
      }
    }
  };
  for (const name of Object.keys(freshNs)) visit(oldNs[name], freshNs[name]);
  return pairs;
}

/** Why `fresh` cannot replace `old` in place, or null when it can. */
export function shapeChange(old, fresh) {
  for (const key of SHAPE_STATICS) {
    const a = hasOwn(old, key) ? shapeOf(old[key]) : 'none';
    const b = hasOwn(fresh, key) ? shapeOf(fresh[key]) : 'none';
    if (a !== b) return `${old.name}.${key} changed`;
  }
  for (const hook of SHAPE_HOOKS) {
    if (hasOwn(old.prototype, hook) !== hasOwn(fresh.prototype, hook)) {
      return `${old.name}: ${hook}() was ${hasOwn(fresh.prototype, hook) ? 'added' : 'removed'}`;
    }
  }
  if ((typeof old.tickAll === 'function') !== (typeof fresh.tickAll === 'function')) {
    return `${old.name}: tickAll was added or removed`;
  }
  // A field the new class declares would be missing on the running instances
  // (or start undefined instead of at its initializer).
  const fields = instanceFields(old);
  if (fields !== null && fields !== instanceFields(fresh)) {
    return `${old.name}: its instance fields changed`;
  }
  return null;
}

/** An entity class's instance fields, from one detached instance; null for other classes. */
function instanceFields(C) {
  if (typeof C.prototype?.bindToEntitySlot !== 'function') return null;
  try {
    // A page instance: it builds the fields, writes no shared memory, joins no pool.
    // No config and no worker: the realm keeps the ones its entities share (E-167). The engine's own fields are left
    // out: how many component fields a probe declares depends on whether its class is registered (E-164b), and the
    // new version never is.
    const probe = new C(0, undefined, null, { page: true });
    return Object.keys(probe).filter((key) => !ENGINE_INSTANCE_KEYS.has(key)).sort().join(',');
  } catch {
    return 'unbuildable';
  }
}

/** Why a non-class export cannot be swapped (other modules keep its old binding), or null. */
function exportChange(name, a, b) {
  if (a === b) return null;
  if (typeof a !== typeof b) return `export ${name} changed`;
  if (typeof a === 'function') {
    return Function.prototype.toString.call(a) === Function.prototype.toString.call(b)
      ? null
      : `export ${name} is not a class and changed`;
  }
  if (typeof a === 'object' && a !== null && b !== null) {
    return shapeOf(a) === shapeOf(b) ? null : `export ${name} is not a class and changed`;
  }
  return `export ${name} changed`;
}

/** Copy `fresh`'s code onto `old`, and make `fresh` an alias of `old`. */
export function patchClass(old, fresh) {
  // Methods and accessors. The engine's own prototype keys (component accessors) stay.
  const op = old.prototype;
  const fp = fresh.prototype;
  // E-167 keeps the class's component flags on its prototype (`_hasComponents`): the running class's stay too.
  const engineProtoKeys = new Set([
    'constructor',
    '_componentAccessorsCreated',
    '_hasComponents',
    ...Object.keys(old._componentClassMap || {}),
  ]);
  for (const key of Reflect.ownKeys(fp)) {
    if (engineProtoKeys.has(key)) continue;
    Object.defineProperty(op, key, Object.getOwnPropertyDescriptor(fp, key));
  }
  for (const key of Reflect.ownKeys(op)) {
    if (!engineProtoKeys.has(key) && !hasOwn(fp, key)) delete op[key];
  }

  // The class's own statics (methods, values), except what the engine owns or built from.
  for (const key of Reflect.ownKeys(fresh)) {
    if (typeof key === 'string' && (ENGINE_STATICS.has(key) || SHAPE_STATICS.includes(key))) continue;
    if (key === Symbol.hasInstance) continue;
    Object.defineProperty(old, key, Object.getOwnPropertyDescriptor(fresh, key));
  }

  // The new class stands for the running one.
  for (const key of Reflect.ownKeys(old)) {
    if (key === 'prototype' || key === 'length' || key === 'name') continue;
    if (typeof key === 'string' && !ENGINE_STATICS.has(key) && hasOwn(fresh, key)) continue;
    Object.defineProperty(fresh, key, Object.getOwnPropertyDescriptor(old, key));
  }
  Object.defineProperty(fresh, Symbol.hasInstance, {
    configurable: true,
    value: (value) => value instanceof old,
  });
}

/**
 * Swap a module: pair its classes, check nothing the engine built from changed,
 * then patch every pair. Nothing is patched when the answer is a reload.
 * @param {object} oldNs the module as the game loaded it
 * @param {object} freshNs its new version
 * @returns {{ swapped: string[], reload: string|null }}
 */
export function swapModule(oldNs, freshNs) {
  for (const name of new Set([...Object.keys(oldNs), ...Object.keys(freshNs)])) {
    if (!(name in oldNs)) return { swapped: [], reload: `export ${name} was added` };
    if (!(name in freshNs)) return { swapped: [], reload: `export ${name} was removed` };
    if (isClass(oldNs[name]) && isClass(freshNs[name])) continue;
    const why = exportChange(name, oldNs[name], freshNs[name]);
    if (why) return { swapped: [], reload: why };
  }
  const pairs = pairClasses(oldNs, freshNs);
  for (const [old, fresh] of pairs) {
    const why = shapeChange(old, fresh);
    if (why) return { swapped: [], reload: why };
  }
  const swapped = [];
  for (const [old, fresh] of pairs) {
    patchClass(old, fresh);
    swapped.push(old.name);
  }
  return { swapped, reload: null };
}
