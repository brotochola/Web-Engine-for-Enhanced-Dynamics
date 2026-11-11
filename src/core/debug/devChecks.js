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
import { keyDistance } from '../../util/configKeys.js';

let on = false;
/** (entity index) → its class's name; gameObject.js sets it (this module cannot import it: a cycle). */
let classNameOf = () => 'An entity';
/** (entity index) → its Box2D body is made, no creation waiting; gameObject.js sets it. */
let bodyMade = () => false;
/** Turn the checks on or off in this thread. */
export function setDevChecks(enabled) {
  on = enabled === true;
}

/** True while the checks are on in this thread. */
export function devChecksOn() {
  return on;
}

/** gameObject.js gives the lookups from an entity index to its class's name and to whether its body is made. */
export function setDevLookups(className, isBodyMade) {
  classNameOf = typeof className === 'function' ? className : () => 'An entity';
  bodyMade = typeof isBodyMade === 'function' ? isBodyMade : () => false;
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

// ---------------------------------------------------------------------------------------------------------------------
// E3: a body flag written after the body exists.
// ---------------------------------------------------------------------------------------------------------------------

/** What to do instead, by property. */
const BODY_FLAG_FIX = {
  'rigidBody.fixedRotation': 'Use this.setFixedRotation(v) (or this.fixedRotation = v), which updates the body',
};

/**
 * A component property Box2D reads only when it makes the body, written when the body is already made.
 * @param {number} index the entity
 * @param {string} what 'rigidBody.fixedRotation'
 */
export function lateBodyWrite(index, what) {
  if (!on || !bodyMade(index)) return;
  const name = classNameOf(index);
  warnOnce(
    name,
    `late-${what}`,
    `${name} writes ${what} after its Box2D body exists, so the body does not change. ${BODY_FLAG_FIX[what] || ''}.`,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// E4: a mass set by hand, replaced by the collider's.
// ---------------------------------------------------------------------------------------------------------------------

let handMass = new Uint8Array(0);

/** rigidBody.mass was set: remember it until the slot is released or the mass is synced from the collider. */
export function massSetByHand(index) {
  if (!on) return;
  if (index >= handMass.length) {
    const grown = new Uint8Array(Math.max(index + 1, handMass.length * 2, 1024));
    grown.set(handMass);
    handMass = grown;
  }
  handMass[index] = 1;
}

/**
 * RigidBody.syncMassFromCollider gave the entity its collider's mass (a shape's setter: the spawn's sync keeps a mass
 * set by hand, N-132).
 * @param {number} index
 * @param {number} before the mass before
 * @param {number} after the mass now
 */
export function massFromCollider(index, before, after) {
  if (!on || index >= handMass.length || handMass[index] === 0) return;
  handMass[index] = 0;
  if (before === after) return;
  const name = classNameOf(index);
  const fix = "a change of the collider's shape sets the mass from it again. Set the mass after the shape";
  warnOnce(
    name,
    'mass-shape',
    `${name}'s rigidBody.mass, set by hand to ${+before.toFixed(3)}, was replaced by its collider's ${+after.toFixed(3)}: ${fix}.`,
  );
}

/** The slot is free: its next entity has set no mass. */
export function slotReleased(index) {
  if (index < handMass.length) handMass[index] = 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// E5, E6: particle emits.
// ---------------------------------------------------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && v === v;
/** The largest value a number or a { min, max } range gives; undefined when unset. */
function maxOf(v) {
  if (isNum(v)) return v;
  if (v && typeof v === 'object' && (isNum(v.min) || isNum(v.max))) return Math.max(isNum(v.min) ? v.min : -Infinity, isNum(v.max) ? v.max : -Infinity);
  return undefined;
}
function minOf(v) {
  if (isNum(v)) return v;
  if (v && typeof v === 'object' && (isNum(v.min) || isNum(v.max))) return Math.min(isNum(v.min) ? v.min : Infinity, isNum(v.max) ? v.max : Infinity);
  return undefined;
}
const moves = (v) => {
  const lo = minOf(v);
  const hi = maxOf(v);
  return (lo !== undefined && lo !== 0) || (hi !== undefined && hi !== 0);
};

/**
 * A CPU emit's config. E5: heighted particles all born on the floor (z ≥ 0, or unset) with a velocity stop on their
 * first step: the integrate lands them. E6: animation or frame without what they need are ignored.
 * @param {object} cfg the merged config
 * @param {boolean} flat emitFlat's particles (no floor)
 */
export function checkEmit(cfg, flat) {
  if (!on || !cfg) return;
  const subject = `emit:${cfg.texture ?? ''}:${cfg.spritesheet ?? ''}:${cfg.animation ?? ''}`;
  if (!flat) {
    const zMin = minOf(cfg.z);
    const onFloor = cfg.z == null || (zMin !== undefined && zMin >= 0);
    // speed counts with a direction (dirX and dirY, or angleXY), as _spawn reads it; otherwise vx and vy do.
    const aimed = (cfg.dirX != null && cfg.dirY != null) || cfg.angleXY !== undefined;
    const flies = aimed ? moves(cfg.speed) : moves(cfg.vx) || moves(cfg.vy);
    if (onFloor && (flies || moves(cfg.vz))) {
      warnOnce(
        subject,
        'emit-on-floor',
        `ParticleEmitter: an emit${cfg.texture ? ` of ${cfg.texture}` : cfg.spritesheet ? ` of ${cfg.spritesheet}` : ''} ` +
          `has z ${cfg.z == null ? 'unset (0)' : '0 or more'}: a heighted particle at z >= 0 is on the floor, so it ` +
          'stops on its first step. Give z a value below 0 (in the air), or use emitFlat for particles in the screen plane.',
      );
    }
  }
  // _spawn draws a spritesheet frame only with spritesheet and animation both set; otherwise the texture.
  const drawn = cfg.texture ? `texture ${cfg.texture}` : 'texture id 0';
  if ((cfg.animation !== undefined || cfg.frame !== undefined) && !cfg.spritesheet) {
    warnOnce(
      subject,
      'emit-frame-no-sheet',
      `ParticleEmitter: an emit sets ${cfg.animation !== undefined ? 'animation' : 'frame'} without spritesheet, so it ` +
        `is ignored and the particles draw ${drawn}. Add spritesheet: 'name'.`,
    );
  } else if (cfg.spritesheet && cfg.animation === undefined) {
    warnOnce(
      subject,
      'emit-sheet-no-anim',
      `ParticleEmitter: an emit of ${cfg.spritesheet} sets no animation, so the spritesheet${cfg.frame !== undefined ? ' and frame are' : ' is'} ` +
        `ignored and the particles draw ${drawn}. Add animation: 'name'.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// E7: a key name the keyboard map does not have.
// ---------------------------------------------------------------------------------------------------------------------

const keysSaid = new Set();

/**
 * Keyboard.isDown / isPressed with a name the engine's key map does not have: always false.
 * @param {unknown} key what the game asked for
 * @param {Record<string, number>} keyIndexMap the map (' ' is the space bar)
 * @param {Record<string, string>} aliases the names Keyboard also takes (space, ctrl, return, …)
 */
export function unknownKey(key, keyIndexMap, aliases) {
  if (!on || keysSaid.has(key)) return;
  keysSaid.add(key);
  const tracked =
    'It reads the letters, digits, punctuation, arrows (arrowleft …), f1 to f12, space, enter, escape, tab, backspace, ' +
    'delete, shift, control, alt and meta: KeyboardEvent.key, in any case.';
  if (typeof key !== 'string') {
    warnOnce(`key:${String(key)}`, 'unknown-key', `Keyboard: a key is asked for by ${typeof key} ${String(key)}, never down: it takes a key's name ('a', 'space'). ${tracked}`);
    return;
  }
  const names = [...Object.keys(keyIndexMap).map((k) => (k === ' ' ? 'space' : k)), ...Object.keys(aliases || {})];
  let near = null;
  let best = 3;
  for (const n of names) {
    const d = keyDistance(key, n);
    if (d < best) {
      best = d;
      near = n;
    }
  }
  warnOnce(
    `key:${key}`,
    'unknown-key',
    `Keyboard: "${key}" is not a key the engine reads, so it is never down.${near ? ` Did you mean "${near}"?` : ''} ${tracked}`,
  );
}
