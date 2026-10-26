// spawnParamsCheck.js — debug builds: catch a spawn config that does not do what its author meant, for classes that
// declare spawnParams (src/core/spawnParams.js). Each problem warns once per class and key:
//   - a key nothing reads: not declared, not an engine key, not a field of the entity (`widht` for `width`);
//   - a declared key with a value of the wrong type (a string for a number param), which onSpawned would get as is;
//   - a points param given a plain array, which is copied into a Float64Array on every spawn.
// The production bundle swaps this module for stubs/spawnParamsCheck.js (webpack configs), so it costs nothing there.

import { KIND_BOOL, KIND_ENTITY, KIND_POINTS, KIND_STRING, KIND_SPRITE, KIND_ANIMATION, SPAWN_ENGINE_KEYS } from '../spawnParams.js';

const ENGINE_KEYS = new Set(SPAWN_ENGINE_KEYS);
/** _spawnAt sizes the collider from these before onSpawned (GameObject._spawnAt). */
const COLLIDER_KEYS = new Set(['width', 'height', 'radius']);

function warnOnce(state, key, message) {
  if (state.warned[key] === true) return;
  state.warned[key] = true;
  console.warn(message);
}

function typeOk(kind, value) {
  if (kind === KIND_BOOL) return typeof value === 'boolean';
  if (kind === KIND_STRING || kind === KIND_SPRITE || kind === KIND_ANIMATION) return typeof value === 'string';
  if (kind === KIND_ENTITY) {
    return typeof value === 'number' || (typeof value === 'object' && typeof value.index === 'number');
  }
  if (kind === KIND_POINTS) return value instanceof Float64Array || Array.isArray(value);
  return typeof value === 'number';
}

function nameOf(value) {
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return value.constructor && value.constructor.name ? `a ${value.constructor.name}` : 'an object';
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * @param {object} state - the class's createSpawnParamsState
 * @param {object} cfg - the caller's spawn config
 * @param {object} instance - the entity being spawned
 */
export function checkSpawnConfig(state, cfg, instance) {
  const className = state.className;
  for (const key in cfg) {
    const value = cfg[key];
    const i = state.indexOf[key];
    if (i !== undefined) {
      if (value === undefined || value === null) continue;
      const kind = state.kinds[i];
      if (!typeOk(kind, value)) {
        warnOnce(state, key, `WeedJS: ${className}.spawn(): "${key}" is a ${state.kindNames[i]} param, got ${nameOf(value)}`);
      } else if (kind === KIND_POINTS && Array.isArray(value)) {
        warnOnce(
          state,
          key,
          `WeedJS: ${className}.spawn(): "${key}" is copied into a Float64Array on every spawn; pass a Float64Array`,
        );
      }
      continue;
    }
    if (key.charCodeAt(0) === 95 || ENGINE_KEYS.has(key)) continue; // "_…": the engine's own
    if (COLLIDER_KEYS.has(key) && instance._hasComponents.Collider) continue;
    const field = instance[key];
    if (field !== undefined && typeof field !== 'function') continue; // _spawnAt copies it onto the entity
    warnOnce(
      state,
      key,
      `WeedJS: ${className}.spawn(): "${key}" is not in ${className}.spawnParams, and nothing else reads it`,
    );
  }
}
