// spawnParams.js — `static spawnParams`: an entity class declares, once, the config its onSpawned reads, with a
// default and a range for each key, the way Unity's [SerializeField, Range] and Godot's @export_range do. Before
// onSpawned, the engine fills the keys a caller left out into a params object it owns, so onSpawned reads
// `params.width` with no `?? 220` of its own (VISUAL_EDITOR_PLAN.md, D4).
//
//   static spawnParams = {
//     width: { value: 220, min: 8, max: 4000, step: 1 },
//     tint:  { value: 0x495870, type: 'color' },
//     state: { value: 0, type: 'enum', options: { Idle: 0, Patrol: 1 } },
//     door:  { value: null, type: 'entity', class: 'Door' },
//   };
//
// Each realm compiles a class once. describeSpawnParams validates the declaration and keeps what the editor and the
// scene-file loader read (keys, kinds, defaults, the entries). createSpawnParamsState adds what a logic worker's
// _spawnAt needs: four params objects for re-entrant spawns (an onSpawned that spawns the same class) and the depth.
//
// No allocation per spawn. A params object is built once with every key, numbers stored as doubles first, so its
// fields keep one representation whatever integer or fraction a spawn writes, and every object of a class shares
// one hidden class. It is built by JSON.parse: that makes every property in-object, where keyed stores on an empty
// object would turn one with many keys into a dictionary, whose number stores allocate. The declared keys come
// before x and y, so a caller's `{ x, y, … }` literal does not share the params object's hidden class.
//
// The params object belongs to the engine and is valid only during onSpawned: the next spawn of the class
// overwrites it. Copy what you need into components.

/** Param kinds, as written in `type`. */
export const SPAWN_PARAM_KINDS = Object.freeze([
  'number',
  'color',
  'enum',
  'bool',
  'string',
  'sprite',
  'animation',
  'entity',
  'points',
]);

export const KIND_NUMBER = 0;
export const KIND_COLOR = 1;
export const KIND_ENUM = 2;
export const KIND_BOOL = 3;
export const KIND_STRING = 4;
export const KIND_SPRITE = 5;
export const KIND_ANIMATION = 6;
export const KIND_ENTITY = 7;
export const KIND_POINTS = 8;

/** Params objects per class before a deeper re-entrant spawn builds a fresh one (and allocates). */
export const SPAWN_PARAMS_STACK_DEPTH = 4;

/**
 * Keys the params object holds itself (x, y) or _spawnAt reads from the caller's config before onSpawned: a class
 * cannot declare them. Keys starting with `_` are the engine's own (`_hotRestore`, `_saveRestore`).
 */
export const SPAWN_ENGINE_KEYS = Object.freeze(['x', 'y', 'layer', 'layers', 'active', 'forceProcessOnLogicWorker']);
const RESERVED = new Set(SPAWN_ENGINE_KEYS);

const KEY = /^[A-Za-z$][A-Za-z0-9_$]*$/;
const COMMON_FIELDS = ['value', 'type', 'label', 'tip'];
const FIELDS_BY_KIND = [
  [...COMMON_FIELDS, 'min', 'max', 'step'], // number
  COMMON_FIELDS, // color
  [...COMMON_FIELDS, 'options'], // enum
  COMMON_FIELDS, // bool
  COMMON_FIELDS, // string
  COMMON_FIELDS, // sprite
  COMMON_FIELDS, // animation
  [...COMMON_FIELDS, 'class'], // entity
  COMMON_FIELDS, // points
].map((fields) => new Set(fields));
const ALL_FIELDS = new Set(FIELDS_BY_KIND.flatMap((fields) => [...fields]));

/**
 * What `spawn()` passes for a class with spawnParams when the caller gives no config (ED-42): the engine only reads
 * it, so one frozen object serves every such spawn instead of a new `{}` each.
 */
export const NO_SPAWN_CONFIG = Object.freeze({});

/** The points default when a declaration gives none: one empty array per realm, read-only. */
const NO_POINTS = new Float64Array(0);

const descriptions = new WeakMap();

/**
 * @typedef {object} SpawnParamsDescription
 * @property {string} className
 * @property {string[]} keys - declared keys, in declaration order
 * @property {Uint8Array} kinds - one KIND_* per key
 * @property {string[]} kindNames - one SPAWN_PARAM_KINDS name per key
 * @property {Array} defaults - one default per key (points: a Float64Array; entity: null)
 * @property {object[]} entries - the declaration's entries, as declared (min, max, step, options, label, tip, class)
 * @property {Record<string, number>} indexOf - key → position (no prototype)
 */

/**
 * A class's spawn params, validated and compiled once per class and realm; null when it declares none. Throws a
 * TypeError naming the class and key when the declaration is malformed: the page calls this at registration, so a
 * bad declaration fails the scene load with that message.
 * @param {Function} EntityClass
 * @returns {SpawnParamsDescription|null}
 */
export function describeSpawnParams(EntityClass) {
  let description = descriptions.get(EntityClass);
  if (description === undefined) {
    description = compile(EntityClass);
    descriptions.set(EntityClass, description);
  }
  return description;
}

function compile(EntityClass) {
  const declared = EntityClass.spawnParams;
  if (declared === null || declared === undefined) return null;
  const where = `${EntityClass.name}.spawnParams`;
  if (typeof declared !== 'object' || Array.isArray(declared)) {
    throw new TypeError(`WeedJS: ${where} must be an object: { key: { value, … }, … }`);
  }
  const keys = Object.keys(declared);
  const n = keys.length;
  const kinds = new Uint8Array(n);
  const kindNames = new Array(n);
  const defaults = new Array(n);
  const entries = new Array(n);
  const indexOf = Object.create(null);
  for (let i = 0; i < n; i++) {
    const key = keys[i];
    const at = `${where}.${key}`;
    if (!KEY.test(key)) {
      throw new TypeError(`WeedJS: ${at}: a param's name is letters, digits, _ and $, and starts with a letter or $`);
    }
    if (RESERVED.has(key)) {
      throw new TypeError(
        `WeedJS: ${at}: "${key}" is not a param: ${key === 'x' || key === 'y' ? 'onSpawned always gets x and y' : 'the engine reads it from the spawn config itself'}`,
      );
    }
    const entry = declared[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`WeedJS: ${at} must be { value: … } (with type, min, max, step, options, label, tip as needed)`);
    }
    for (const field of Object.keys(entry)) {
      if (!ALL_FIELDS.has(field)) {
        throw new TypeError(`WeedJS: ${at}: unknown field "${field}" (value, type, min, max, step, options, label, tip, class)`);
      }
    }
    const kindName = entry.type !== undefined ? entry.type : inferKind(entry.value, at);
    const kind = SPAWN_PARAM_KINDS.indexOf(kindName);
    if (kind < 0) {
      throw new TypeError(`WeedJS: ${at}: type "${kindName}" is not one of ${SPAWN_PARAM_KINDS.join(', ')}`);
    }
    for (const field of Object.keys(entry)) {
      if (!FIELDS_BY_KIND[kind].has(field)) throw new TypeError(`WeedJS: ${at}: a ${kindName} param has no "${field}"`);
    }
    if (entry.label !== undefined && typeof entry.label !== 'string') throw new TypeError(`WeedJS: ${at}.label must be a string`);
    if (entry.tip !== undefined && typeof entry.tip !== 'string') throw new TypeError(`WeedJS: ${at}.tip must be a string`);
    kinds[i] = kind;
    kindNames[i] = kindName;
    defaults[i] = defaultOf(kind, entry, at);
    entries[i] = entry;
    indexOf[key] = i;
  }
  return { className: EntityClass.name, keys, kinds, kindNames, defaults, entries, indexOf };
}

function inferKind(value, at) {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'string';
  throw new TypeError(
    `WeedJS: ${at}: say its type (type: 'entity', 'points', …): only a number, boolean or string value implies one`,
  );
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function defaultOf(kind, entry, at) {
  const value = entry.value;
  switch (kind) {
    case KIND_NUMBER: {
      if (!isFiniteNumber(value)) throw new TypeError(`WeedJS: ${at}.value must be a finite number`);
      for (const field of ['min', 'max', 'step']) {
        if (entry[field] !== undefined && !isFiniteNumber(entry[field])) {
          throw new TypeError(`WeedJS: ${at}.${field} must be a finite number`);
        }
      }
      if (entry.step !== undefined && !(entry.step > 0)) throw new TypeError(`WeedJS: ${at}.step must be above 0`);
      if (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max) {
        throw new TypeError(`WeedJS: ${at}: min ${entry.min} is above max ${entry.max}`);
      }
      if (entry.min !== undefined && value < entry.min) throw new TypeError(`WeedJS: ${at}: value ${value} is below min ${entry.min}`);
      if (entry.max !== undefined && value > entry.max) throw new TypeError(`WeedJS: ${at}: value ${value} is above max ${entry.max}`);
      return value;
    }
    case KIND_COLOR:
      if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
        throw new TypeError(`WeedJS: ${at}.value must be a color 0x000000 to 0xffffff`);
      }
      return value;
    case KIND_ENUM: {
      const options = entry.options;
      if (options === null || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length === 0) {
        throw new TypeError(`WeedJS: ${at}.options must be an object of labels to numbers: { Box: 0, Circle: 1 }`);
      }
      const values = Object.values(options);
      if (!values.every(isFiniteNumber)) throw new TypeError(`WeedJS: ${at}.options: every option's value must be a number`);
      if (!isFiniteNumber(value) || !values.includes(value)) {
        throw new TypeError(`WeedJS: ${at}.value must be one of the options' values (${values.join(', ')})`);
      }
      return value;
    }
    case KIND_BOOL:
      if (typeof value !== 'boolean') throw new TypeError(`WeedJS: ${at}.value must be true or false`);
      return value;
    case KIND_STRING:
    case KIND_SPRITE:
    case KIND_ANIMATION:
      if (typeof value !== 'string') throw new TypeError(`WeedJS: ${at}.value must be a string`);
      return value;
    case KIND_ENTITY:
      if (value !== undefined && value !== null) {
        throw new TypeError(`WeedJS: ${at}.value must be null: an entity param's default is "no entity"`);
      }
      if (entry.class !== undefined && typeof entry.class !== 'string') {
        throw new TypeError(`WeedJS: ${at}.class must be an entity class's name`);
      }
      return null;
    case KIND_POINTS: {
      if (value === undefined || value === null) return NO_POINTS;
      const ok =
        (value instanceof Float64Array || (Array.isArray(value) && value.every(isFiniteNumber))) && value.length % 2 === 0;
      if (!ok) throw new TypeError(`WeedJS: ${at}.value must be null or x, y pairs: [x0, y0, x1, y1, …]`);
      return Float64Array.from(value);
    }
  }
  return value;
}

/**
 * What a logic worker's _spawnAt fills for one class: null when it declares no params.
 * @param {Function} EntityClass
 */
export function createSpawnParamsState(EntityClass) {
  const description = describeSpawnParams(EntityClass);
  if (description === null) return null;
  const { keys, kinds, defaults } = description;
  const plainKeys = [];
  const plainDefaults = [];
  const specialKeys = [];
  const specialKinds = [];
  const specialDefaults = [];
  // The JSON the params objects are built from: every declared key, then x and y. Numbers start as 0.5, so their
  // fields are doubles from the first store.
  let template = '{';
  for (let i = 0; i < keys.length; i++) {
    const kind = kinds[i];
    if (kind === KIND_ENTITY || kind === KIND_POINTS) {
      specialKeys.push(keys[i]);
      specialKinds.push(kind);
      specialDefaults.push(defaults[i]);
    } else {
      plainKeys.push(keys[i]);
      plainDefaults.push(defaults[i]);
    }
    const start =
      kind === KIND_BOOL
        ? 'false'
        : kind === KIND_STRING || kind === KIND_SPRITE || kind === KIND_ANIMATION
          ? '""'
          : kind === KIND_ENTITY || kind === KIND_POINTS
            ? 'null'
            : '0.5';
    template += `${JSON.stringify(keys[i])}:${start},`;
  }
  template += '"x":0.5,"y":0.5}';

  const state = {
    EntityClass,
    className: description.className,
    keys,
    kinds,
    kindNames: description.kindNames,
    indexOf: description.indexOf,
    plainKeys,
    plainDefaults,
    specialKeys,
    specialKinds: Uint8Array.from(specialKinds),
    specialDefaults,
    template,
    stack: [],
    depth: 0,
    /** Params objects built past the stack (a re-entrant spawn deeper than SPAWN_PARAMS_STACK_DEPTH). */
    overflow: 0,
    /** Debug: keys already warned about (spawnParamsCheck.js). */
    warned: Object.create(null),
  };
  for (let s = 0; s < SPAWN_PARAMS_STACK_DEPTH; s++) state.stack.push(newParamsObject(state));
  return state;
}

/** A params object of the state's class, holding its defaults. */
export function newParamsObject(state) {
  const params = JSON.parse(state.template);
  const { plainKeys, plainDefaults, specialKeys, specialDefaults } = state;
  for (let i = 0; i < plainKeys.length; i++) params[plainKeys[i]] = plainDefaults[i];
  for (let i = 0; i < specialKeys.length; i++) params[specialKeys[i]] = specialDefaults[i];
  params.x = 0;
  params.y = 0;
  return params;
}

/**
 * The params object onSpawned gets: each declared key from `cfg` when it is there (not undefined or null), else its
 * default; x and y from `cfg`, else 0. An entity param arrives as the instance at the index it was given (or an
 * object with an `index`), else null; a points param as a Float64Array (a plain array is copied: pass a Float64Array
 * to spawn without allocating). Call releaseSpawnParams after onSpawned, also when it throws.
 * @param {object} state - createSpawnParamsState's
 * @param {object} cfg - the caller's spawn config
 * @param {Array} instances - this realm's instance per entity index (GameObject.instances)
 * @returns {object}
 */
export function fillSpawnParams(state, cfg, instances) {
  const depth = state.depth;
  let params;
  if (depth < SPAWN_PARAMS_STACK_DEPTH) {
    params = state.stack[depth];
  } else {
    params = newParamsObject(state);
    state.overflow++;
  }
  state.depth = depth + 1;
  const keys = state.plainKeys;
  const defaults = state.plainDefaults;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = cfg[key];
    params[key] = value !== undefined && value !== null ? value : defaults[i];
  }
  const x = cfg.x;
  const y = cfg.y;
  params.x = x !== undefined && x !== null ? x : 0;
  params.y = y !== undefined && y !== null ? y : 0;
  if (state.specialKeys.length !== 0) fillSpecialParams(state, params, cfg, instances);
  return params;
}

function fillSpecialParams(state, params, cfg, instances) {
  const keys = state.specialKeys;
  const kinds = state.specialKinds;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = cfg[key];
    if (kinds[i] === KIND_ENTITY) {
      const index =
        typeof value === 'number'
          ? value
          : value !== null && typeof value === 'object' && typeof value.index === 'number'
            ? value.index
            : -1;
      const entity = index >= 0 ? instances[index] : undefined;
      params[key] = entity !== undefined ? entity : null;
    } else if (value instanceof Float64Array) {
      params[key] = value;
    } else if (Array.isArray(value)) {
      params[key] = Float64Array.from(value);
    } else {
      params[key] = state.specialDefaults[i];
    }
  }
}

/** After onSpawned: the params object is free for the next spawn of the class. */
export function releaseSpawnParams(state) {
  state.depth--;
}
