/**
 * DX-GUARDS: the run-time checks of the debug build. Each names a mistake a game makes while it runs, once per class
 * (or emitter, or key) and rule, in one line: what, where, how to fix it. The production bundle takes
 * stubs/devChecks.js, whose functions do nothing (webpack.bundle.config.js, debugStubAliases), so none of this is in it.
 *
 * On by default from source and in the debug bundle; `config.debug.checks: false` turns them off (the bench page
 * does, so a measurement does not time them). Every thread that runs game code turns them on or off from the
 * scene's config: the page (Scene) and each worker (AbstractWorker).
 */
import { warnOnce } from '../../util/dxWarn.js';

let on = false;
/** Turn the checks on or off in this thread. */
export function setDevChecks(enabled) {
  on = enabled === true;
}

/** True while the checks are on in this thread. */
export function devChecksOn() {
  return on;
}

// ---------------------------------------------------------------------------------------------------------------------
// E1: a class field named like an accessor (`health = 3` hides `this.health`).
// ---------------------------------------------------------------------------------------------------------------------

const firstSeen = new Set();

/**
 * The first instance of each class in this thread: an own property with the name of an accessor on its prototype
 * chain (a component's, or the engine's: x, rotation, …) hides the accessor from every method of the class.
 * @param {object} instance
 */
export function checkFirstInstance(instance) {
  if (!on || !instance) return;
  const C = instance.constructor;
  if (firstSeen.has(C)) return;
  firstSeen.add(C);
  for (const key of Object.keys(instance)) {
    for (let p = Object.getPrototypeOf(instance); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, key);
      if (!d) continue;
      if (d.get || d.set) {
        // A component's accessor is on the class's own prototype (GameObject._ensureComponentAccessors puts it there).
        const component = C._componentClassMap?.[key];
        const text = component
          ? `${C.name} has a field named ${key}, which hides its ${component.name} component: this.${key} is the ` +
            'field, never the component. Rename the field.'
          : `${C.name} has a field named ${key}, which hides ${p.constructor?.name || 'its prototype'}'s ${key}: on a ` +
            `${C.name}, this.${key} is the field, not the engine's ${key}. If the field is meant, a name of its own ` +
            'keeps both: rename it.';
        warnOnce(C.name, `field-hides-${key}`, text);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// E2: a field first written after onSpawned.
// ---------------------------------------------------------------------------------------------------------------------

/** class → the own property names its instances have had right after onSpawned. */
const spawnedKeys = new Map();
let lastAuditMs = -Infinity;
const AUDIT_EVERY_MS = 1000;

/**
 * After onSpawned: what the class's instances hold by then is their shape. A field first written later reshapes the
 * object (every method that saw the old shape deoptimizes) and lives only in the worker that wrote it.
 * @param {object} instance
 */
export function noteSpawned(instance) {
  if (!on || !instance) return;
  const C = instance.constructor;
  let keys = spawnedKeys.get(C);
  if (!keys) {
    keys = new Set();
    spawnedKeys.set(C, keys);
  }
  for (const key in instance) {
    if (Object.prototype.hasOwnProperty.call(instance, key)) keys.add(key);
  }
}

/**
 * Once a second (called every frame): one live instance of each class seen spawning, its own names against those it
 * had after onSpawned.
 * @param {(C: Function) => object|null} liveInstanceOf one live instance of the class, or null
 * @param {number} [nowMs] the clock (tests)
 */
export function auditFields(liveInstanceOf, nowMs) {
  if (!on) return;
  const now = nowMs === undefined ? performance.now() : nowMs;
  if (now - lastAuditMs < AUDIT_EVERY_MS) return;
  lastAuditMs = now;
  for (const [C, keys] of spawnedKeys) {
    const instance = liveInstanceOf(C);
    if (!instance) continue;
    for (const key of Object.keys(instance)) {
      if (keys.has(key)) continue;
      keys.add(key);
      warnOnce(
        C.name,
        `late-field-${key}`,
        `${C.name}'s field ${key} is first written after onSpawned: the object changes shape, every method that saw ` +
          `the old one deoptimizes, and the field lives only in this worker. Declare it in the constructor ` +
          `(this.${key} = …).`,
      );
    }
  }
}
