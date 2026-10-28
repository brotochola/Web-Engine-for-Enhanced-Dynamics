// Plain JS fields of entity instances, carried across a hot reload.
//
// Entity state belongs in components, but game code also keeps JS fields on the
// instance (a scratch buffer, a facing, the current tool). A reload builds new
// instances, and a tick that reads such a field would find it missing. Each
// logic worker reports its own instances' fields before the reload and gets the
// same ones back after it. Only plain data travels: numbers, strings, booleans,
// null, arrays, plain objects and typed arrays. Functions and class instances do
// not; create those in the constructor.

/** Fields the engine sets on every instance (GameObject constructor, spawn). */
export const ENGINE_INSTANCE_KEYS = new Set([
  'index',
  'config',
  'logicWorker',
  '_onPage',
  '_hasComponents',
  '_neighborOffset',
  '_neighbors',
  '_components',
  '_spawnAborted',
]);

const TYPED_ARRAYS = {
  Float32Array,
  Float64Array,
  Int8Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
};
const MAX_DEPTH = 6;
const SKIP = Symbol('skip');

function numberToWire(n) {
  return Number.isFinite(n) ? n : { $num: String(n) };
}

/** JSON-safe copy of a plain value, or SKIP when any part of it is not plain data. */
function toWire(value, depth) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return numberToWire(value);
  if (typeof value !== 'object' || depth > MAX_DEPTH) return SKIP;
  if (ArrayBuffer.isView(value)) {
    const name = value.constructor && value.constructor.name;
    // A view over shared memory is engine data (a component column): never copy it.
    if (!TYPED_ARRAYS[name] || value.buffer instanceof SharedArrayBuffer) return SKIP;
    return { $typed: name, v: Array.from(value, numberToWire) };
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const w = toWire(value[i], depth + 1);
      if (w === SKIP) return SKIP;
      out[i] = w;
    }
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return SKIP;
  const out = {};
  for (const key of Object.keys(value)) {
    const w = toWire(value[key], depth + 1);
    if (w === SKIP) return SKIP;
    out[key] = w;
  }
  return out;
}

function fromWire(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fromWire);
  if (typeof value.$num === 'string') return Number(value.$num);
  if (typeof value.$typed === 'string' && Array.isArray(value.v)) {
    const Typed = TYPED_ARRAYS[value.$typed];
    if (Typed) return Typed.from(value.v, fromWire);
  }
  const out = {};
  for (const key of Object.keys(value)) out[key] = fromWire(value[key]);
  return out;
}

/**
 * The plain fields of every active entity's instance.
 * @param {(index: number) => object|undefined} instanceAt
 * @param {ArrayLike<number>} active Transform.active
 * @returns {Array<[number, Record<string, unknown>]>} [entityIndex, fields] pairs, JSON-safe
 */
export function collectInstanceFields(instanceAt, active) {
  const entries = [];
  for (let i = 0; i < active.length; i++) {
    if (active[i] !== 1) continue;
    const instance = instanceAt(i);
    if (!instance) continue;
    let fields = null;
    for (const key of Object.keys(instance)) {
      if (ENGINE_INSTANCE_KEYS.has(key)) continue;
      const w = toWire(instance[key], 0);
      if (w === SKIP) continue;
      if (fields === null) fields = {};
      fields[key] = w;
    }
    if (fields !== null) entries.push([i, fields]);
  }
  return entries;
}

/**
 * Put collected fields back on the instances. A field the edited class no
 * longer declares is skipped when the instance takes no new fields.
 * @param {(index: number) => object|undefined} instanceAt
 * @param {Array<[number, Record<string, unknown>]>} entries
 * @returns {number} instances written
 */
export function applyInstanceFields(instanceAt, entries) {
  let applied = 0;
  for (let e = 0; e < entries.length; e++) {
    const [index, fields] = entries[e];
    const instance = instanceAt(index);
    if (!instance) continue;
    const extensible = Object.isExtensible(instance);
    for (const key of Object.keys(fields)) {
      if (extensible || Object.prototype.hasOwnProperty.call(instance, key)) instance[key] = fromWire(fields[key]);
    }
    applied++;
  }
  return applied;
}
