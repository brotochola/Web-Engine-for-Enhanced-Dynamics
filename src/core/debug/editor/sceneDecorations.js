// sceneDecorations.js — the running scene file's decorations in the editor (VISUAL_EDITOR_PLAN.md ED-25): the
// document's `decorations` section (one record of flat arrays per class) and the decorations the scene spawned from
// it (Scene._fileDecorations: each record's pool index per decoration), kept in step.
//
// The brush (scatterBrush.js) appends decorations to a record and spawns them, or takes them out and despawns them;
// undo and redo put a record back as a copy has it (syncRecord). A record changed by one stroke differs from its copy
// by decorations added at its end or taken out of it, so syncRecord spawns or despawns only those; a copy it cannot
// line up that way is spawned whole.
//
// No DOM here. Page only; once per brush dab or undo.

import { DecorationPool } from '../../decorationPool.js';
import {
  DECORATION_VALUE_KEYS,
  decorationClassOf,
  decorationClassProblem,
  decorationSpawnConfig,
} from '../../sceneFileDecorations.js';

/** The running file's record of decoration class `className`, and its position, or null. */
export function decorationRecordOf(scene, className) {
  const records = scene?.sceneFile?.decorations;
  if (!Array.isArray(records)) return null;
  const position = records.findIndex((r) => r.class === className);
  return position < 0 ? null : { record: records[position], position };
}

/** How many decorations the running file places of each class. */
export function decorationCounts(scene) {
  const counts = new Map();
  for (const record of scene?.sceneFile?.decorations || []) counts.set(record.class, record.x.length);
  return counts;
}

/** The pool indices of a record's decorations (-1: not spawned), made when the scene has none for it. */
export function indicesOf(scene, record) {
  let indices = scene._fileDecorations.get(record);
  if (indices === undefined) {
    indices = new Array(record.x.length).fill(-1);
    scene._fileDecorations.set(record, indices);
  }
  return indices;
}

/** The decoration class of a record, when the scene can draw it; else null. */
function drawableClass(scene, className) {
  const decl = decorationClassOf(scene.constructor, className);
  if (decl === null || decorationClassProblem(decl) !== null) return null;
  return decl;
}

/**
 * Spawn the decorations of a record at `positions` (its last ones, or the ones a sync puts back), one spawnMany.
 * @returns {number[]} their pool indices, -1 where the pool had no room
 */
export function spawnRecordDecorations(scene, record, positions) {
  const out = new Array(positions.length).fill(-1);
  const decl = drawableClass(scene, record.class);
  if (decl === null || positions.length === 0 || !(scene.config?.decoration?.maxDecorations > 0)) return out;
  const cfg = decorationSpawnConfig(decl, record, positions);
  cfg.out = out;
  DecorationPool.spawnMany(cfg);
  return out;
}

function despawnAll(indices) {
  for (const index of indices) if (index >= 0) DecorationPool.despawn(index);
}

/** The arrays a record holds, x and y first. */
function arrayKeys(record) {
  const keys = ['x', 'y'];
  for (const key of DECORATION_VALUE_KEYS) if (Array.isArray(record[key])) keys.push(key);
  return keys;
}

function sameDecoration(a, i, b, j, keys) {
  for (const key of keys) if (a[key][i] !== b[key][j]) return false;
  return true;
}

/**
 * Where each decoration of `small` is in `big`, when `small` is `big` with some decorations taken out (in order);
 * else null.
 */
function lineUp(small, big, keys) {
  const at = new Array(small.x.length);
  let i = 0;
  for (let j = 0; j < big.x.length && i < small.x.length; j++) {
    if (sameDecoration(small, i, big, j, keys)) at[i++] = j;
  }
  return i === small.x.length ? at : null;
}

/** Take a record out of the document (and the section with its last record), despawning its decorations. */
function removeRecord(scene, record) {
  despawnAll(scene._fileDecorations.get(record) || []);
  scene._fileDecorations.delete(record);
  const records = scene.sceneFile.decorations;
  records.splice(records.indexOf(record), 1);
  if (records.length === 0) delete scene.sceneFile.decorations;
}

/**
 * Put the record of class `className` back as `target` has it (a copy the caller gives away), or take it out
 * (null): undo and redo of a brush stroke. Decorations both have keep their slots; the others are spawned or
 * despawned.
 * @param {object} scene
 * @param {string} className
 * @param {number} at - where in the section a record put back goes
 * @param {object|null} target
 */
export function syncRecord(scene, className, at, target) {
  const found = decorationRecordOf(scene, className);
  if (target === null) {
    if (found !== null) removeRecord(scene, found.record);
    return;
  }
  if (found === null) {
    if (!Array.isArray(scene.sceneFile.decorations)) scene.sceneFile.decorations = [];
    const records = scene.sceneFile.decorations;
    records.splice(Math.min(Math.max(at, 0), records.length), 0, target);
    const all = target.x.map((_, i) => i);
    scene._fileDecorations.set(target, spawnRecordDecorations(scene, target, all));
    return;
  }
  const current = found.record;
  const indices = indicesOf(scene, current);
  const keys = arrayKeys(current);
  const sameKeys = keys.length === arrayKeys(target).length && keys.every((k) => Array.isArray(target[k]));
  let next = null;
  if (sameKeys && target.x.length >= current.x.length) {
    // Decorations added: the current ones keep their slots, the others spawn.
    const at = lineUp(current, target, keys);
    if (at !== null) {
      next = new Array(target.x.length).fill(-2);
      for (let i = 0; i < at.length; i++) next[at[i]] = indices[i];
    }
  } else if (sameKeys) {
    // Decorations taken out: the ones the target keeps keep their slots, the others despawn.
    const at = lineUp(target, current, keys);
    if (at !== null) {
      next = new Array(target.x.length);
      const kept = new Uint8Array(current.x.length);
      for (let i = 0; i < at.length; i++) {
        next[i] = indices[at[i]];
        kept[at[i]] = 1;
      }
      for (let j = 0; j < current.x.length; j++) if (!kept[j] && indices[j] >= 0) DecorationPool.despawn(indices[j]);
    }
  }
  if (next === null) {
    // A copy that does not line up with the record (another set of arrays): all of it again.
    despawnAll(indices);
    next = new Array(target.x.length).fill(-2);
  }
  const missing = [];
  for (let i = 0; i < next.length; i++) if (next[i] === -2) missing.push(i);
  const spawned = spawnRecordDecorations(scene, target, missing);
  for (let k = 0; k < missing.length; k++) next[missing[k]] = spawned[k];
  scene.sceneFile.decorations[found.position] = target;
  scene._fileDecorations.delete(current);
  scene._fileDecorations.set(target, next);
}

export { removeRecord as removeDecorationRecord };
