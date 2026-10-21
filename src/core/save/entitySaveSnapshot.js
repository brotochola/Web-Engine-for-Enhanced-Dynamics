// Sparse entity save snapshot: pack/unpack SoA fields for serializable active entities.
// Used by SaveGame encode/decode and by GameObject.spawn(_saveRestore).

import { Component } from '../component.js';
import { Transform } from '../../components/transform.js';
import { RigidBody } from '../../components/rigidBody.js';
import { Collider } from '../../components/collider.js';
import { Camera } from '../camera.js';
import { Sun } from '../sun.js';
import { VERSION } from '../../version.js';
import { BODY_DIRTY, markBodyDirty } from '../../box2d/box2dBodySync.js';
import { Joint } from '../joint.js';
import { encodeBinarySaveBody, decodeBinarySaveBody } from './binarySaveCodec.js';
import { fnv1a32 } from './schemaHash.js';
import {
  packSharedResources,
  packChains,
  packFixtures,
  packMeshes,
  packNav,
  packTime,
  packTweens,
} from './worldBufferSave.js';

export const SAVE_MAGIC = 'WEEDSAVE1';
export const SAVE_FORMAT_VERSION = 5;

/** @param {Function} EntityClass */
export function isEntityClassSerializable(EntityClass) {
  let cur = EntityClass;
  while (cur && cur !== Function.prototype) {
    if (Object.prototype.hasOwnProperty.call(cur, 'serializable')) {
      // Own false must win over an ancestor true (e.g. GhostMachineBox).
      return cur.serializable === true;
    }
    cur = Object.getPrototypeOf(cur);
  }
  return false;
}

/**
 * Schema fingerprint for a component class (detect field drift on load).
 * @param {typeof Component} ComponentClass
 */
export function componentSchemaFingerprint(ComponentClass) {
  const parts = [ComponentClass.name];
  for (const [name, typeOrSpec] of Object.entries(ComponentClass.ARRAY_SCHEMA || {})) {
    const { type, length, entityId } = Component._schemaEntry(typeOrSpec);
    parts.push(entityId ? `${name}:${type.name}:${length}:entityId` : `${name}:${type.name}:${length}`);
  }
  if (ComponentClass === Transform || ComponentClass.name === 'Transform') {
    parts.push('pose:x,y,rotC,rotS');
  }
  if (ComponentClass === RigidBody || ComponentClass.name === 'RigidBody') {
    parts.push('pose:vx,vy,angularVelocity,sleeping');
  }
  return fnv1a32(parts.join('|'));
}

/**
 * A component's saved fields, in schema order, and its fingerprint. Built once
 * per save for each class: per entity it cost a fingerprint string, an entries
 * array and a schema object per field (E-49). Per save, not global: a schema
 * can change between scenes (entity-id width).
 */
function componentPlan(ComponentClass, plans) {
  let plan = plans.get(ComponentClass);
  if (plan) return plan;
  const names = [];
  const lengths = [];
  for (const [fieldName, typeOrSpec] of Object.entries(ComponentClass.ARRAY_SCHEMA)) {
    names.push(fieldName);
    lengths.push(Component._schemaEntry(typeOrSpec).length);
  }
  plan = { fingerprint: componentSchemaFingerprint(ComponentClass), names, lengths };
  plans.set(ComponentClass, plan);
  return plan;
}

/**
 * Read one entity's component fields into a plain object map.
 * @param {Function} EntityClass
 * @param {number} entityIndex
 * @param {Map} [plans] per-save cache of componentPlan; omitted, one is made for this call
 * @returns {Record<string, { fingerprint: number, fields: Record<string, number|number[]> }>|null}
 */
export function readEntityComponents(EntityClass, entityIndex, plans = new Map()) {
  const map = EntityClass._componentClassMap || {};
  const out = {};

  for (const name in map) {
    const ComponentClass = map[name];
    if (!ComponentClass?.ARRAY_SCHEMA) continue;
    const plan = componentPlan(ComponentClass, plans);
    // Skip empty schemas
    if (plan.names.length === 0 && ComponentClass !== Transform) {
      continue;
    }

    const fields = {};
    for (let p = 0; p < plan.names.length; p++) {
      const fieldName = plan.names[p];
      const length = plan.lengths[p];
      const arr = ComponentClass[fieldName];
      if (!arr) continue;
      if (length === 1) {
        fields[fieldName] = arr[entityIndex];
      } else {
        const base = entityIndex * length;
        const slice = new Array(length);
        for (let k = 0; k < length; k++) slice[k] = arr[base + k];
        fields[fieldName] = slice;
      }
    }

    // Transform pose lives on Box2D HEAP views, not ARRAY_SCHEMA
    if (ComponentClass === Transform || name === 'Transform') {
      if (Transform.x) fields.x = Transform.x[entityIndex];
      if (Transform.y) fields.y = Transform.y[entityIndex];
      if (Transform.rotC) fields.rotC = Transform.rotC[entityIndex];
      if (Transform.rotS) fields.rotS = Transform.rotS[entityIndex];
    }

    // RigidBody velocities / sleeping also live on HEAP
    if (ComponentClass === RigidBody || name === 'RigidBody') {
      if (RigidBody.vx) fields.vx = RigidBody.vx[entityIndex];
      if (RigidBody.vy) fields.vy = RigidBody.vy[entityIndex];
      if (RigidBody.angularVelocity) {
        fields.angularVelocity = RigidBody.angularVelocity[entityIndex];
      }
      if (RigidBody.sleeping) fields.sleeping = RigidBody.sleeping[entityIndex];
    }

    out[ComponentClass.name] = {
      fingerprint: plan.fingerprint,
      fields,
    };
  }

  return out;
}

/**
 * Apply saved component fields onto an entity index (after onSpawned / FSM init).
 * @param {number} entityIndex
 * @param {Function} EntityClass
 * @param {Record<string, { fingerprint?: number, fields: Record<string, number|number[]> }>} components
 */
export function applyEntitySaveRestore(entityIndex, EntityClass, components) {
  if (!components) return;
  const map = EntityClass._componentClassMap || {};

  for (const name in map) {
    const ComponentClass = map[name];
    if (!ComponentClass?.ARRAY_SCHEMA) continue;
    const saved = components[ComponentClass.name] || components[name];
    if (!saved?.fields) continue;

    if (
      saved.fingerprint != null &&
      saved.fingerprint !== componentSchemaFingerprint(ComponentClass)
    ) {
      console.warn(
        `[SaveGame] schema drift for ${ComponentClass.name} on ${EntityClass.name}; applying best-effort`
      );
    }

    const fields = saved.fields;
    for (const [fieldName, typeOrSpec] of Object.entries(ComponentClass.ARRAY_SCHEMA)) {
      if (!(fieldName in fields)) continue;
      const { length } = Component._schemaEntry(typeOrSpec);
      const arr = ComponentClass[fieldName];
      if (!arr) continue;
      const value = fields[fieldName];
      if (length === 1) {
        arr[entityIndex] = value;
      } else if (Array.isArray(value)) {
        const base = entityIndex * length;
        const n = Math.min(length, value.length);
        for (let k = 0; k < n; k++) arr[base + k] = value[k];
      }
    }

    if ((ComponentClass === Transform || name === 'Transform') && Transform.x) {
      if ('x' in fields) Transform.x[entityIndex] = fields.x;
      if ('y' in fields) Transform.y[entityIndex] = fields.y;
      if ('rotC' in fields && Transform.rotC) Transform.rotC[entityIndex] = fields.rotC;
      if ('rotS' in fields && Transform.rotS) Transform.rotS[entityIndex] = fields.rotS;
    }

    if ((ComponentClass === RigidBody || name === 'RigidBody') && RigidBody.vx) {
      if ('vx' in fields) RigidBody.vx[entityIndex] = fields.vx;
      if ('vy' in fields) RigidBody.vy[entityIndex] = fields.vy;
      if ('angularVelocity' in fields && RigidBody.angularVelocity) {
        RigidBody.angularVelocity[entityIndex] = fields.angularVelocity;
      }
      if ('sleeping' in fields && RigidBody.sleeping) {
        RigidBody.sleeping[entityIndex] = fields.sleeping;
      }
    }
  }

  // Ensure entity stays active after restore overwrite
  if (Transform.active) Transform.active[entityIndex] = 1;

  if (RigidBody.active?.[entityIndex] || Collider.active?.[entityIndex]) {
    markBodyDirty(entityIndex, BODY_DIRTY.LIFECYCLE | BODY_DIRTY.GEOMETRY | BODY_DIRTY.DAMPING);
  }
}

/**
 * Collect active serializable entity records from a scene.
 * @param {{ registeredClasses: Array<{ class: Function, name?: string }> }} scene
 * @returns {{ typeName: string, components: object }[]}
 */
export function collectSerializableEntities(scene) {
  const records = [];
  const registered = scene.registeredClasses || [];
  const plans = new Map();

  for (let r = 0; r < registered.length; r++) {
    const EntityClass = registered[r].class;
    if (!EntityClass || !isEntityClassSerializable(EntityClass)) continue;

    const typeName = EntityClass.name;
    const active = EntityClass.getAllActive?.();
    if (!active || active.length === 0) continue;

    const filter = typeof EntityClass.shouldSaveEntity === 'function' ? EntityClass : null;
    for (let a = 0; a < active.length; a++) {
      const entityIndex = active[a];
      if (Transform.active && Transform.active[entityIndex] !== 1) continue;
      if (filter && !filter.shouldSaveEntity(entityIndex)) continue;
      records.push({
        typeName,
        entityIndex,
        components: readEntityComponents(EntityClass, entityIndex, plans),
      });
    }
  }

  return records;
}

/**
 * Soft layout hint from scene registry (detect missing types on load).
 * @param {object} scene
 */
export function buildLayoutHint(scene) {
  const types = [];
  for (const reg of scene.registeredClasses || []) {
    if (!isEntityClassSerializable(reg.class)) continue;
    types.push({ name: reg.class.name, poolSize: reg.count | 0 });
  }
  types.sort((a, b) => a.name.localeCompare(b.name));
  return { types, totalEntityCount: scene.totalEntityCount | 0 };
}

export function readCameraGlobals() {
  if (!Camera._data) return null;
  // The tail slot is the follow seqlock, not camera state.
  return Array.from(Camera._data.slice(0, Camera.IDX_FOLLOW_SEQ));
}

export function readSunGlobals() {
  if (!Sun._float32 || !Sun._uint8) return null;
  return {
    enabled: Sun._uint8[Sun.OFFSETS.ENABLED],
    f32: Array.from(Sun._float32),
    color: Sun._uint32 ? Sun._uint32[Sun.U32.COLOR] : 0,
  };
}

export function applyCameraGlobals(camera) {
  if (!camera || !Camera._data) return;
  const n = Math.min(Camera._data.length, camera.length, Camera.IDX_FOLLOW_SEQ);
  // Inside the camera write lock, so pre-render never packs half a restore.
  // Never store to the lock slot: a write in flight on another thread would
  // end on an odd count, and every later read would fall back for good.
  Camera._followWriteBegin();
  try {
    for (let i = 0; i < n; i++) Camera._data[i] = camera[i];
  } finally {
    Camera._followWriteEnd();
  }
}

export function applySunGlobals(sun) {
  if (!sun || !Sun._float32) return;
  if (Sun._uint8 && sun.enabled != null) Sun._uint8[Sun.OFFSETS.ENABLED] = sun.enabled ? 1 : 0;
  if (Array.isArray(sun.f32)) {
    const n = Math.min(Sun._float32.length, sun.f32.length);
    for (let i = 0; i < n; i++) Sun._float32[i] = sun.f32[i];
  }
  if (Sun._uint32 && sun.color != null) Sun._uint32[Sun.U32.COLOR] = sun.color >>> 0;
}

/**
 * Build a logical save payload object (typed arrays OK; binary codec serializes).
 * @param {object} scene
 * @param {{ camera?: number[]|null, sun?: number[]|null }} [globals]
 */
export function buildSavePayload(scene, globals = {}) {
  const entities = collectSerializableEntities(scene);
  const joints = typeof Joint.serializeActive === 'function' ? Joint.serializeActive() : [];
  const payload = {
    magic: SAVE_MAGIC,
    formatVersion: SAVE_FORMAT_VERSION,
    engineVersion: VERSION,
    sceneName: scene.constructor?.name || 'Scene',
    layout: buildLayoutHint(scene),
    camera: globals.camera !== undefined ? globals.camera : readCameraGlobals(),
    sun: globals.sun !== undefined ? globals.sun : readSunGlobals(),
    entities,
    joints,
  };
  if (globals.liquidFun !== undefined) {
    payload.liquidFun = globals.liquidFun;
  } else if (scene._liquidFunSaveSnapshot) {
    payload.liquidFun = scene._liquidFunSaveSnapshot;
  }
  if (globals.decals !== undefined) {
    payload.decals = globals.decals;
  }
  const savedIndices = new Array(entities.length);
  for (let i = 0; i < entities.length; i++) savedIndices[i] = entities[i].entityIndex | 0;
  const sharedResources = packSharedResources();
  if (sharedResources.length) payload.sharedResources = sharedResources;
  // null: that pool is unbound, write no section (a load leaves onSpawned geometry).
  // [] is kept: a bound pool writes its section even empty, so a load clears geometry
  // the saved entities did not have.
  const chains = packChains(savedIndices);
  if (chains) payload.chains = chains;
  const fixtures = packFixtures(savedIndices);
  if (fixtures) payload.fixtures = fixtures;
  const meshes = packMeshes(savedIndices);
  if (meshes) payload.meshes = meshes;
  const nav = packNav();
  if (nav) payload.nav = nav;
  const timeScale = packTime();
  if (timeScale != null) payload.timeScale = timeScale;
  const tweens = packTweens();
  if (tweens) payload.tweens = tweens;
  // Scene state outside entities (score, quest flags, level): JSON, back as payload.custom.
  const custom = typeof scene.onSaveGame === 'function' ? scene.onSaveGame() : undefined;
  if (custom !== undefined && custom !== null) payload.custom = custom;
  return payload;
}

// --- Binary encode/decode (JSON body after header for simplicity + deflate) ---

function encodeUtf8(str) {
  return new TextEncoder().encode(str);
}

function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes);
}

/**
 * Encode payload object to uncompressed ArrayBuffer (magic + u32 ver + utf8 JSON).
 * @param {object} payload
 * @returns {Uint8Array}
 */
export function encodeSaveUncompressed(payload) {
  const body = encodeBinarySaveBody(payload);
  const magicBytes = encodeUtf8(SAVE_MAGIC);
  const out = new Uint8Array(magicBytes.length + 4 + body.byteLength);
  out.set(magicBytes, 0);
  const view = new DataView(out.buffer);
  view.setUint32(magicBytes.length, SAVE_FORMAT_VERSION, true);
  out.set(body, magicBytes.length + 4);
  return out;
}

/**
 * @param {Uint8Array|ArrayBuffer} data
 * @returns {object}
 */
export function decodeSaveUncompressed(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const magicBytes = encodeUtf8(SAVE_MAGIC);
  for (let i = 0; i < magicBytes.length; i++) {
    if (bytes[i] !== magicBytes[i]) {
      throw new Error('SaveGame: bad magic');
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint32(magicBytes.length, true);
  if (formatVersion !== SAVE_FORMAT_VERSION) {
    throw new Error(`SaveGame: unsupported formatVersion ${formatVersion}`);
  }
  const body = bytes.subarray(magicBytes.length + 4);
  const decoded = decodeBinarySaveBody(body);
  return {
    magic: SAVE_MAGIC,
    formatVersion: SAVE_FORMAT_VERSION,
    ...decoded,
  };
}

export async function deflateBytes(input) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('deflateBytes requires CompressionStream (browser or Node 18+)');
  }
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * @param {Uint8Array} input
 * @returns {Promise<Uint8Array>}
 */
export async function inflateBytes(input) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('inflateBytes requires DecompressionStream (browser or Node 18+)');
  }
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * @param {object} payload
 * @returns {Promise<Uint8Array>}
 */
export async function encodeSave(payload) {
  const body = encodeBinarySaveBody(payload);
  const compressed = await deflateBytes(body);
  const magicBytes = encodeUtf8(SAVE_MAGIC);
  const out = new Uint8Array(magicBytes.length + 4 + compressed.byteLength);
  out.set(magicBytes, 0);
  new DataView(out.buffer).setUint32(magicBytes.length, SAVE_FORMAT_VERSION, true);
  out.set(compressed, magicBytes.length + 4);
  return out;
}

/**
 * @param {Uint8Array|ArrayBuffer} compressed
 * @returns {Promise<object>}
 */
export async function decodeSave(compressed) {
  const bytes = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);
  const magicBytes = encodeUtf8(SAVE_MAGIC);
  for (let i = 0; i < magicBytes.length; i++) {
    if (bytes[i] !== magicBytes[i]) {
      throw new Error('SaveGame: bad magic');
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const formatVersion = view.getUint32(magicBytes.length, true);
  if (formatVersion !== SAVE_FORMAT_VERSION) {
    throw new Error(`SaveGame: unsupported formatVersion ${formatVersion}`);
  }
  const body = await inflateBytes(bytes.subarray(magicBytes.length + 4));
  const decoded = decodeBinarySaveBody(body);
  return {
    magic: SAVE_MAGIC,
    formatVersion: SAVE_FORMAT_VERSION,
    ...decoded,
  };
}

export function shouldSaveEntity(EntityClass, entityIndex, transformLike = Transform) {
  if (!isEntityClassSerializable(EntityClass)) return false;
  const active = transformLike.active;
  if (active && active[entityIndex] !== 1) return false;
  // Optional per-entity filter on a serializable class (N-5: terrain saves its
  // loose chunks and rebuilds its static rock from the grid).
  if (typeof EntityClass.shouldSaveEntity === 'function' && !EntityClass.shouldSaveEntity(entityIndex)) return false;
  return true;
}
