// sceneDocument.js — the editor's changes to the running scene file (VISUAL_EDITOR_PLAN.md D6). The document is the
// scene's own `sceneFile`, the file as loaded and as Ctrl+S writes it. A change edits one entity's record, then
// respawns that entity from it: despawn it, spawn it with the record's config, point its name at the new entity.
// onSpawned derives everything from the config, so there is no per-field write path to get wrong. An entity that
// refers to the respawned one by an entity param holds its old index: it is respawned too.
//
// A value equal to the declared default is left out of the record (and an empty config with it), as the file
// format wants. On the page, once per change; the respawned entity is live on logic0's next frame.
//
// editPlaced makes a change from a write (writeParam, writePosition, writeConfig) and returns the record before and
// after it, which is what undo and redo put back (restorePlaced; history.js).

import { describeSpawnParams, KIND_ENTITY, KIND_POINTS } from '../../spawnParams.js';
import { sceneFileSpawnConfig } from '../../sceneFile.js';
import { Messages } from '../../messages.js';

const NO_BACK_REFS = new Set();

/** The record placed under `name` in the running file, and its position, or null. */
export function recordOf(scene, name) {
  const entities = scene?.sceneFile?.entities;
  if (!Array.isArray(entities)) return null;
  const position = entities.findIndex((e) => e.name === name);
  return position < 0 ? null : { record: entities[position], position };
}

/** The entity class registered under a name in the running scene, or undefined. */
export function classNamed(scene, className) {
  const registered = scene?.registeredClasses || [];
  for (let i = 0; i < registered.length; i++) if (registered[i].class.name === className) return registered[i].class;
  return undefined;
}

/** The spawn params a record's class declares (describeSpawnParams), or null: none, or no such class. */
export function paramsOf(scene, record) {
  const EntityClass = classNamed(scene, record.class);
  return EntityClass === undefined ? null : describeSpawnParams(EntityClass);
}

/** The live index of the entity named `name` in the running file, or -1. */
export function indexOfName(scene, name) {
  const packed = scene._namedEntities.get(name);
  if (packed === undefined) return -1;
  const index = Math.floor(packed / 65536);
  return Messages.spawnGen[index] === packed - index * 65536 ? index : -1;
}

/** Whether a value is a param's declared default (the record then leaves it out). */
export function isDefaultValue(description, k, value) {
  const fallback = description.defaults[k];
  if (description.kinds[k] === KIND_POINTS) return value === null || value === undefined || value.length === 0;
  if (description.kinds[k] === KIND_ENTITY) return value === null || value === undefined || value === '';
  return value === fallback;
}

/**
 * Write one spawn param into a record: a value equal to the declared default is left out (and an empty config).
 * @param {object} record
 * @param {object|null} description - the class's spawn params
 * @param {string} key
 * @param {unknown} value - as the file holds it: a number, boolean, string, an entity's name (or null), x, y pairs
 */
export function writeParam(record, description, key, value) {
  const k = description === null ? undefined : description.indexOf[key];
  if (k !== undefined && isDefaultValue(description, k, value)) {
    if (record.config) delete record.config[key];
  } else {
    if (!record.config) record.config = {};
    record.config[key] = value;
  }
  if (record.config && Object.keys(record.config).length === 0) delete record.config;
}

/** Write a record's position. */
export function writePosition(record, x, y) {
  record.x = x;
  record.y = y;
}

/** Write a record's whole config (a class without spawnParams: the editor's key/value box); `{}` leaves it out. */
export function writeConfig(record, config) {
  if (Object.keys(config).length === 0) delete record.config;
  else record.config = config;
}

/** What a change can touch in a record, copied: its position and its config. */
export function snapshotOf(record) {
  return { x: record.x, y: record.y, config: record.config === undefined ? undefined : structuredClone(record.config) };
}

const sameSnapshot = (a, b) => a.x === b.x && a.y === b.y && JSON.stringify(a.config) === JSON.stringify(b.config);

/**
 * Change a placed entity's record with `write(record, description)`, and respawn the entity.
 * @param {object} scene
 * @param {string} name - the entity's name in the running file
 * @param {(record: object, description: object|null) => void} write
 * @returns {{ index: number, before: object, after: object }|null} the respawned entity's index (-1: a full pool)
 *   and the record before and after; null when there is no such record or the write changed nothing
 */
export function editPlaced(scene, name, write) {
  const found = recordOf(scene, name);
  if (found === null) return null;
  const before = snapshotOf(found.record);
  write(found.record, paramsOf(scene, found.record));
  const after = snapshotOf(found.record);
  if (sameSnapshot(before, after)) return null;
  return { index: respawnPlaced(scene, name), before, after };
}

/**
 * Put a placed entity's record back as a snapshot has it, and respawn the entity (undo and redo).
 * @returns {number} the respawned entity's index, or -1
 */
export function restorePlaced(scene, name, snapshot) {
  const found = recordOf(scene, name);
  if (found === null) return -1;
  const { record } = found;
  record.x = snapshot.x;
  record.y = snapshot.y;
  if (snapshot.config === undefined) delete record.config;
  else record.config = structuredClone(snapshot.config);
  return respawnPlaced(scene, name);
}

/** One change and its respawn, kept by no history (tests, tools). Each returns the new index, or -1. */
export const setParam = (scene, name, key, value) =>
  editPlaced(scene, name, (record, description) => writeParam(record, description, key, value))?.index ?? -1;
export const setPosition = (scene, name, x, y) => editPlaced(scene, name, (record) => writePosition(record, x, y))?.index ?? -1;
export const setConfig = (scene, name, config) => editPlaced(scene, name, (record) => writeConfig(record, config))?.index ?? -1;

/**
 * Despawn the entity placed under `name` and spawn it again from its record; then the same for every placed entity
 * whose entity params name it.
 * @returns {number} its new index, or -1 (no such record or class, or a full pool)
 */
export function respawnPlaced(scene, name) {
  const index = respawnOne(scene, name);
  if (index < 0) return index;
  respawnReferrers(scene, name);
  return index;
}

/** Respawn every placed entity whose entity params name `name`: they hold its old index, or none. */
function respawnReferrers(scene, name) {
  for (const other of scene.sceneFile.entities) {
    if (other.name !== name && refersTo(scene, other, name)) respawnOne(scene, other.name);
  }
}

// ---- adding, removing and renaming placed entities (ED-11) ----

/**
 * A record's editor id: made once, kept on the record as a property the file never holds (not enumerable), so the
 * history finds a record after it was renamed, or removed and put back (`withEditorId` on the copy).
 */
let nextEditorId = 1;
export function editorIdOf(record) {
  if (!Object.prototype.hasOwnProperty.call(record, '_editorId')) withEditorId(record, nextEditorId++);
  return record._editorId;
}

/** Give a record (a copy put back by undo) its editor id. */
export function withEditorId(record, id) {
  Object.defineProperty(record, '_editorId', { value: id, enumerable: false, configurable: true });
  return record;
}

/** The current name of the record with that editor id, or null when the file has none. */
export function nameOfEditorId(scene, id) {
  for (const record of scene?.sceneFile?.entities || []) if (record._editorId === id) return record.name;
  return null;
}

/** A name the file does not use: `base` without its trailing digits, then the smallest free number (Platform13). */
export function uniqueName(scene, base) {
  const used = new Set(scene.sceneFile.entities.map((e) => e.name));
  const stem = base.replace(/\d+$/, '') || base;
  for (let n = 1; ; n++) {
    const name = `${stem}${n}`;
    if (!used.has(name)) return name;
  }
}

/**
 * Put a record into the file at `position` (the end when -1) and spawn it. Entities that already name it (an undone
 * delete) respawn with it.
 * @returns {number} its index, or -1: its pool is full, and the record is not added
 */
export function addPlaced(scene, record, position = -1) {
  const entities = scene.sceneFile.entities;
  const at = position < 0 || position > entities.length ? entities.length : position;
  entities.splice(at, 0, record);
  const index = respawnOne(scene, record.name);
  if (index < 0) {
    entities.splice(at, 1);
    return -1;
  }
  respawnReferrers(scene, record.name);
  return index;
}

/**
 * Take a record out of the file and despawn its entity. Entities that named it respawn without it (their params
 * still hold the name: a later add puts it back).
 * @returns {{ record: object, position: number }|null}
 */
export function removePlaced(scene, name) {
  const found = recordOf(scene, name);
  if (found === null) return null;
  const index = indexOfName(scene, name);
  const EntityClass = classNamed(scene, found.record.class);
  if (index >= 0 && EntityClass !== undefined) EntityClass.despawn(index);
  scene._namedEntities.delete(name);
  scene.sceneFile.entities.splice(found.position, 1);
  respawnReferrers(scene, name);
  return found;
}

/**
 * Rename a placed entity, and every entity param that names it; the entity itself does not change.
 * @returns {boolean} false when `to` is empty, taken, or `from` is not in the file
 */
export function renamePlaced(scene, from, to) {
  if (typeof to !== 'string' || to.trim() === '' || to === from || recordOf(scene, to) !== null) return false;
  const found = recordOf(scene, from);
  if (found === null) return false;
  found.record.name = to;
  const packed = scene._namedEntities.get(from);
  scene._namedEntities.delete(from);
  if (packed !== undefined) scene._namedEntities.set(to, packed);
  for (const record of scene.sceneFile.entities) {
    const config = record.config;
    const description = config ? paramsOf(scene, record) : null;
    if (description === null) continue;
    for (let k = 0; k < description.keys.length; k++) {
      const key = description.keys[k];
      if (description.kinds[k] === KIND_ENTITY && config[key] === from) config[key] = to;
    }
  }
  return true;
}

function respawnOne(scene, name) {
  const found = recordOf(scene, name);
  if (found === null) return -1;
  const EntityClass = classNamed(scene, found.record.class);
  if (EntityClass === undefined) return -1;
  const old = indexOfName(scene, name);
  if (old >= 0) EntityClass.despawn(old);
  const indexOf = (target) => indexOfName(scene, target);
  const spawnConfig = sceneFileSpawnConfig(found.record, found.position, EntityClass, indexOf, NO_BACK_REFS);
  const entity = EntityClass.spawn(spawnConfig);
  if (entity === null) {
    scene._namedEntities.delete(name);
    return -1;
  }
  const index = entity.index;
  scene._namedEntities.set(name, index * 65536 + (Messages.spawnGen[index] | 0));
  return index;
}

/** Whether a record names `name` in one of its entity params. */
function refersTo(scene, record, name) {
  const config = record.config;
  if (!config) return false;
  const description = paramsOf(scene, record);
  if (description === null) return false;
  for (let k = 0; k < description.keys.length; k++) {
    if (description.kinds[k] === KIND_ENTITY && config[description.keys[k]] === name) return true;
  }
  return false;
}
