/**
 * E-528: every entity hook, in one table. Each hook has two forms:
 *
 *   onCollisionEnter(otherIndex) { … }               the method: runs on the entity's instance (`this`)
 *   static onCollisionEnter(entityIndex, otherIndex)  the static form: the entity's index first, `this` the class
 *
 * The static form needs no instance: a type whose hooks are all static (and that has no tick(), or ticks through
 * static tickAll) never makes one in a logic worker's dispatch. A static is inherited down the extends chain as a
 * method is, and it wins over a method of the same name. A logic worker resolves each type's static forms once, when it
 * registers the type (`createStaticHookTables`, `resolveStaticHooks`): dispatch reads an array by entity type.
 *
 * The table drives the dispatch tables, the listener tag warnings, the hot swap's shape check, the hook declarations
 * in types/weed.d.ts and the guide's hook list (`node scripts/syncEntityHooks.mjs` writes those two; a node test fails
 * when they are stale). A new hook still needs its dispatch site, where the event comes from.
 *
 * Fields: `name`; `params`, the method's arguments as [name, TypeScript type] (the static form takes `entityIndex`
 * first); `gate`, the component the type must list for the hook to run (null: none); `runs`, where and when it runs;
 * `summary`, what it says; `presenceReadOnce`, whether a worker reads once whether a type defines it (a hot swap that
 * adds or removes it needs a reload).
 */
export const ENTITY_HOOKS = Object.freeze([
  {
    name: 'onSpawned',
    params: [['spawnConfig', 'any']],
    gate: null,
    runs: 'on the thread that sets the spawn up',
    summary:
      'Each spawn from the pool, after its spawn config keys (it may override them). The config is the object ' +
      'Type.spawn was given ({} when none), typed any so a subclass declares the keys it reads.',
    presenceReadOnce: false,
  },
  {
    name: 'onDespawned',
    params: [],
    gate: null,
    runs: 'on the thread that despawns the entity',
    summary: 'Before the entity returns to the pool.',
    presenceReadOnce: false,
  },
  {
    name: 'onCollisionEnter',
    params: [['otherIndex', 'number']],
    gate: 'CollisionListener',
    runs: 'on a logic worker, before the ticks',
    summary: 'The first frame this entity touches another.',
    presenceReadOnce: true,
  },
  {
    name: 'onCollisionStay',
    params: [['otherIndex', 'number']],
    gate: 'CollisionListener',
    runs: 'on a logic worker, before the ticks',
    summary: 'Each later frame it still touches the other.',
    presenceReadOnce: true,
  },
  {
    name: 'onCollisionExit',
    params: [['otherIndex', 'number']],
    gate: 'CollisionListener',
    runs: 'on a logic worker, before the ticks',
    summary: 'The first frame it no longer touches the other.',
    presenceReadOnce: true,
  },
  {
    name: 'onCollisionHit',
    params: [
      ['otherIndex', 'number'],
      ['px', 'number'],
      ['py', 'number'],
      ['nx', 'number'],
      ['ny', 'number'],
      ['approachSpeed', 'number'],
    ],
    gate: 'CollisionListener',
    runs: 'on a logic worker, before the ticks',
    summary:
      'A hard impact above the world\'s hit threshold (Collider.enableHitEvents on): the contact point, the normal ' +
      'from this entity to the other, the approach speed.',
    presenceReadOnce: true,
  },
  {
    name: 'onJointBreak',
    params: [
      ['jointIndex', 'number'],
      ['entityA', 'number'],
      ['entityB', 'number'],
    ],
    gate: 'JointBreakListener',
    runs: 'on a logic worker, before the ticks',
    summary: 'A joint on this entity went past its force or torque threshold and was destroyed.',
    presenceReadOnce: true,
  },
  {
    name: 'onScreenEnter',
    params: [],
    gate: 'CameraInOutListener',
    runs: 'on a logic worker, after its tick (after the ticks for a type without tick())',
    summary: 'The camera\'s view now holds the entity.',
    presenceReadOnce: true,
  },
  {
    name: 'onScreenExit',
    params: [],
    gate: 'CameraInOutListener',
    runs: 'on a logic worker, after its tick (after the ticks for a type without tick())',
    summary: 'The camera\'s view no longer holds it.',
    presenceReadOnce: true,
  },
  {
    name: 'onGotShot',
    params: [
      ['damage', 'number'],
      ['hitX', 'number'],
      ['hitY', 'number'],
      ['ownerId', 'number'],
      ['shooterEntityType', 'number'],
    ],
    gate: null,
    runs: 'on a logic worker, at the start of its frame',
    summary: 'A BulletPool bullet hit this entity: the damage, where, the shooter and its entity type.',
    presenceReadOnce: true,
  },
  {
    name: 'onMessage',
    params: [
      ['name', 'string'],
      ['from', 'number'],
      ['a', 'number'],
      ['b', 'number'],
      ['c', 'number'],
      ['d', 'number'],
    ],
    gate: null,
    runs: 'on a logic worker, the frame after it was sent, before the ticks',
    summary:
      'A message from sendTo or scene.sendToEntity (the scene lists its name in static messages); from is the ' +
      'sender\'s index, -1 for the scene.',
    presenceReadOnce: true,
  },
  {
    name: 'onAnimationEnd',
    params: [['name', 'string']],
    gate: null,
    runs: 'on a logic worker, the frame after, before the ticks',
    summary:
      'A play-once animation (setAnimation(name, false)) or an Adobe clip played without loop finished. Animations ' +
      'advance while drawn, so an off-screen one waits.',
    presenceReadOnce: true,
  },
  {
    name: 'onDirectionChanged',
    params: [['direction', 'string']],
    gate: 'DirectionalSprite',
    runs: 'on a logic worker, after the ticks',
    summary: 'The direction its DirectionalSprite draws changed (and once when it draws its first): the sheet\'s name of it.',
    presenceReadOnce: true,
  },
]);

/**
 * The static form of hook `name` on EntityClass or a game class it extends below BaseClass (GameObject), or null.
 * @param {Function} EntityClass
 * @param {Function} BaseClass
 * @param {string} name
 * @returns {Function|null}
 */
export function staticHookOf(EntityClass, BaseClass, name) {
  for (let C = EntityClass; typeof C === 'function' && C !== BaseClass; C = Object.getPrototypeOf(C)) {
    const own = Object.getOwnPropertyDescriptor(C, name);
    if (own !== undefined) return typeof own.value === 'function' ? own.value : null;
  }
  return null;
}

/** Whether EntityClass (or a game class it extends below BaseClass) has the method `name` on its prototype chain. */
export function definesMethodBelow(EntityClass, BaseClass, name) {
  let proto = EntityClass.prototype;
  const stop = BaseClass.prototype;
  while (proto && proto !== stop) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/** Whether EntityClass (or a game class it extends below BaseClass) defines hook `name`, as a static or a method. */
export function definesHook(EntityClass, BaseClass, name) {
  return staticHookOf(EntityClass, BaseClass, name) !== null || definesMethodBelow(EntityClass, BaseClass, name);
}

/**
 * Per hook of the table, its static form by entity type, every slot null (the method runs). `typeCount` covers every
 * entity type id (Transform.entityType is a Uint8Array: 256), so a slot no type was resolved into reads null.
 * @param {number} typeCount
 * @returns {Record<string, (Function|null)[]>}
 */
export function createStaticHookTables(typeCount) {
  const tables = {};
  for (const hook of ENTITY_HOOKS) tables[hook.name] = new Array(typeCount).fill(null);
  return tables;
}

/** Every slot of every table back to null. */
export function clearStaticHookTables(tables) {
  for (const hook of ENTITY_HOOKS) tables[hook.name].fill(null);
}

/** Entity type `entityType`'s static forms (or null) into the tables. */
export function resolveStaticHooks(tables, EntityClass, entityType, BaseClass) {
  for (const hook of ENTITY_HOOKS) tables[hook.name][entityType] = staticHookOf(EntityClass, BaseClass, hook.name);
}
