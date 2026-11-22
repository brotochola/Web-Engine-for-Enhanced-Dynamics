// Sparse entity save snapshot: the live entities' SoA columns, one table per type (E-539), and the outer
// encode/decode. Used by SaveGame and by GameObject._spawnAt (_saveRestore).

import { Component } from '../component.js';
import { Transform } from '../../components/transform.js';
import { RigidBody } from '../../components/rigidBody.js';
import { Collider } from '../../components/collider.js';
import { Camera } from '../camera.js';
import { Sun } from '../sun.js';
import { VERSION } from '../../version.js';
import { BODY_DIRTY, markBodyDirty } from '../../box2d/box2dBodySync.js';
import { Joint } from '../joint.js';
import { entityIdNone } from '../../util/entityIdWidth.js';
import { encodeBinarySaveBody, decodeBinarySaveBody } from './binarySaveCodec.js';
import { fnv1a32 } from './schemaHash.js';
import {
  packSharedResources,
  packChains,
  packFixtures,
  packMeshes,
  packNav,
  packTime,
  packSimNow,
  packTweens,
} from './worldBufferSave.js';

export const SAVE_MAGIC = 'WEEDSAVE1';
/** 8: the sim clock's time (N-329); 7: decal tiles deflated, not PNG (N-314); 6: entities by columns, one table per type
 * (E-539). A save of any other version does not load. */
export const SAVE_FORMAT_VERSION = 8;

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

// --- Entities by columns (E-539) ---
//
// A save holds its entities as one table per entity type: the saved entities' indices (a Uint32Array) and, for each
// component, one typed array per field with that field's values for every saved entity, in the indices' order, of
// the live column's own kind. Transform's pose (x, y, rotC, rotS) and RigidBody's velocities and sleeping, which live
// on Box2D's heap and not in an ARRAY_SCHEMA, are fields of those two components like the others.
//
//   { typeName, indices: Uint32Array(n), components: [{ name, fingerprint, fields: [{ name, length, entityId, values }] }] }
//
// `length` is the field's elements per entity (values.length = n × length). A table is plain data: it crosses
// postMessage as it is, and each values array is transferable. Copies are bit for bit: they go through unsigned
// integer views of the column's element width, so a float's every bit, a NaN's payload included, comes back.

/**
 * The bits of a typed array, as unsigned integers of its element width: 1 and 2 bytes as themselves, 4 bytes as one
 * Uint32, 8 bytes as two.
 * @param {ArrayBufferView} arr
 * @returns {Uint8Array|Uint16Array|Uint32Array}
 */
function bitsView(arr) {
  const bpe = arr.BYTES_PER_ELEMENT;
  if (bpe === 1) return arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer, arr.byteOffset, arr.length);
  if (bpe === 2) return arr instanceof Uint16Array ? arr : new Uint16Array(arr.buffer, arr.byteOffset, arr.length);
  return arr instanceof Uint32Array ? arr : new Uint32Array(arr.buffer, arr.byteOffset, (arr.length * bpe) >>> 2);
}

/** Words of bitsView(arr) per element of arr: 2 for an 8-byte kind, 1 otherwise. */
function wordsPerElement(arr) {
  return arr.BYTES_PER_ELEMENT === 8 ? 2 : 1;
}

// The gathers: dst[k] = src[idx[k]], one copy per element width so each loop sees one array kind (review R8).
function gather8(dst, src, idx, n) {
  for (let k = 0; k < n; k++) dst[k] = src[idx[k]];
}
function gather16(dst, src, idx, n) {
  for (let k = 0; k < n; k++) dst[k] = src[idx[k]];
}
function gather32(dst, src, idx, n) {
  for (let k = 0; k < n; k++) dst[k] = src[idx[k]];
}
/** w words per entity: a field of several elements, or an 8-byte kind. */
function gatherWide(dst, src, idx, n, w) {
  for (let k = 0; k < n; k++) {
    const s = idx[k] * w;
    const d = k * w;
    for (let e = 0; e < w; e++) dst[d + e] = src[s + e];
  }
}

/** One saved column of a class: where it lives now, and how a save names it. */
function saveColumn(name, live, length, entityId) {
  return { name, live, length, entityId };
}

/**
 * What a save reads of an entity class: its components (each with its fingerprint) and their columns, each column's
 * live array bound now. Built once per save for each class (E-49, E-539): per entity it cost a fingerprint string, an
 * entries array and a schema object per field. Per save, not global: a schema can change between scenes (entity-id
 * width), and so can the arrays.
 * @param {Function} EntityClass
 * @returns {Array<{ name: string, fingerprint: number, columns: object[] }>}
 */
function entitySavePlan(EntityClass) {
  const map = EntityClass._componentClassMap || {};
  const components = [];
  const seen = new Set();
  for (const key in map) {
    const ComponentClass = map[key];
    if (!ComponentClass?.ARRAY_SCHEMA || seen.has(ComponentClass)) continue;
    seen.add(ComponentClass);
    const columns = [];
    for (const [fieldName, typeOrSpec] of Object.entries(ComponentClass.ARRAY_SCHEMA)) {
      const arr = ComponentClass[fieldName];
      if (!arr) continue;
      const spec = Component._schemaEntry(typeOrSpec);
      columns.push(saveColumn(fieldName, arr, spec.length, spec.entityId));
    }
    // Transform's pose and RigidBody's velocities live on Box2D's heap views, not in ARRAY_SCHEMA.
    if (ComponentClass === Transform) {
      for (const f of POSE_FIELDS) if (Transform[f]) columns.push(saveColumn(f, Transform[f], 1, false));
    } else if (ComponentClass === RigidBody) {
      for (const f of VELOCITY_FIELDS) if (RigidBody[f]) columns.push(saveColumn(f, RigidBody[f], 1, false));
    } else if (columns.length === 0) {
      continue; // a component with no columns has nothing to save
    }
    components.push({ name: ComponentClass.name, fingerprint: componentSchemaFingerprint(ComponentClass), columns });
  }
  return components;
}

const POSE_FIELDS = ['x', 'y', 'rotC', 'rotS'];
const VELOCITY_FIELDS = ['vx', 'vy', 'angularVelocity', 'sleeping'];

/**
 * The table of `indices`, entities of EntityClass: every saved column gathered for them. One buffer holds every
 * column of the table (each aligned to 8 bytes), so it crosses postMessage as one transferable.
 * @param {Function} EntityClass
 * @param {ArrayLike<number>} indices the entities, in the table's order
 * @param {Map} [plans] per-save cache of entitySavePlan by class; omitted, one is made for this call
 * @returns {{ typeName: string, indices: Uint32Array, components: object[] }}
 */
export function gatherEntityTable(EntityClass, indices, plans = new Map()) {
  let plan = plans.get(EntityClass);
  if (plan === undefined) {
    plan = entitySavePlan(EntityClass);
    plans.set(EntityClass, plan);
  }
  const n = indices.length;
  let bytes = n * 4;
  for (let c = 0; c < plan.length; c++) {
    const cols = plan[c].columns;
    for (let f = 0; f < cols.length; f++) {
      bytes = (bytes + 7) & ~7;
      bytes += n * cols[f].length * cols[f].live.BYTES_PER_ELEMENT;
    }
  }
  const buffer = new ArrayBuffer(bytes);
  const idx = new Uint32Array(buffer, 0, n);
  for (let k = 0; k < n; k++) idx[k] = indices[k];
  let offset = n * 4;
  const components = new Array(plan.length);
  for (let c = 0; c < plan.length; c++) {
    const cols = plan[c].columns;
    const fields = new Array(cols.length);
    for (let f = 0; f < cols.length; f++) {
      const col = cols[f];
      const live = col.live;
      offset = (offset + 7) & ~7;
      const values = new live.constructor(buffer, offset, n * col.length);
      offset += values.byteLength;
      const w = wordsPerElement(live) * col.length;
      const dst = bitsView(values);
      const src = bitsView(live);
      if (w !== 1) gatherWide(dst, src, idx, n, w);
      else if (live.BYTES_PER_ELEMENT === 1) gather8(dst, src, idx, n);
      else if (live.BYTES_PER_ELEMENT === 2) gather16(dst, src, idx, n);
      else gather32(dst, src, idx, n);
      fields[f] = { name: col.name, length: col.length, entityId: col.entityId, values };
    }
    components[c] = { name: plan[c].name, fingerprint: plan[c].fingerprint, fields };
  }
  return { typeName: EntityClass.name, indices: idx, components };
}

/** Saved entities in a payload: the sum of its tables' rows. */
export function savedEntityCount(payload) {
  const tables = payload?.entities || [];
  let n = 0;
  for (let t = 0; t < tables.length; t++) n += tables[t].indices.length;
  return n;
}

/** "Class|Component" pairs already warned about: one schema-drift warning each, not one per entity. */
const driftWarned = new Set();

function warnDrift(EntityClass, ComponentClass) {
  const key = EntityClass.name + '|' + ComponentClass.name;
  if (driftWarned.has(key)) return;
  driftWarned.add(key);
  console.warn(`[SaveGame] schema drift for ${ComponentClass.name} on ${EntityClass.name}; applying best-effort`);
}

/**
 * The live array a saved field of ComponentClass goes to, or null: a schema field (with its length and whether it holds
 * entity ids now, which decides the remap), or a Box2D heap column.
 */
function liveColumnOf(ComponentClass, fieldName) {
  const schema = ComponentClass.ARRAY_SCHEMA;
  if (Object.prototype.hasOwnProperty.call(schema, fieldName)) {
    const spec = Component._schemaEntry(schema[fieldName]);
    return { arr: ComponentClass[fieldName] || null, length: spec.length, entityId: spec.entityId };
  }
  if ((ComponentClass === Transform && POSE_FIELDS.includes(fieldName)) ||
    (ComponentClass === RigidBody && VELOCITY_FIELDS.includes(fieldName))) {
    return { arr: ComponentClass[fieldName] || null, length: 1, entityId: false };
  }
  return null;
}

/**
 * How one load writes a saved table onto the entities it spawns (E-539): every saved field matched once to the live
 * column it restores, the fingerprints compared once, not per entity. A column of the same kind and length is copied
 * as bits; one whose kind or length changed since the save (schema drift) is copied value by value, as far as both
 * go. The restore sets `row` to the table row of the entity it spawns next; GameObject's spawn calls apply (through
 * applyEntitySaveRestore) for it, after onSpawned and the FSM's initialization, before the entity goes live.
 */
export class EntityRestorePlan {
  /**
   * @param {Function} EntityClass
   * @param {{ typeName: string, indices: Uint32Array, components: object[] }} table
   */
  constructor(EntityClass, table) {
    this.table = table;
    this.row = 0;
    // Bit copies of one element per entity, by width: the live columns and the saved ones.
    this.live8 = [];
    this.saved8 = [];
    this.live16 = [];
    this.saved16 = [];
    this.live32 = [];
    this.saved32 = [];
    // Bit copies of several words per entity (a field of several elements, or an 8-byte kind).
    this.liveWide = [];
    this.savedWide = [];
    this.wordsWide = [];
    // Value copies (the kind or the length changed since the save): live, saved, and elements per entity of each.
    this.liveDrift = [];
    this.savedDrift = [];
    this.liveDriftLength = [];
    this.savedDriftLength = [];
    // Entity-id fields, remapped once every entity is placed (remapIds).
    this.idLive = [];
    this.idSaved = [];
    this.idLiveLength = [];
    this.idSavedLength = [];
    // The saved Transform.parent (DX-PARENT's relink), x and y (the spawn's position), when the save has them.
    this.parent = null;
    this.x = null;
    this.y = null;
    this._build(EntityClass, table);
  }

  _build(EntityClass, table) {
    const map = EntityClass._componentClassMap || {};
    const byName = new Map();
    for (const key in map) {
      const ComponentClass = map[key];
      if (!ComponentClass?.ARRAY_SCHEMA) continue;
      byName.set(ComponentClass.name, ComponentClass);
      if (!byName.has(key)) byName.set(key, ComponentClass);
    }
    const n = table.indices.length;
    const components = table.components || [];
    for (let c = 0; c < components.length; c++) {
      const saved = components[c];
      const ComponentClass = byName.get(saved.name);
      if (!ComponentClass) continue;
      if (saved.fingerprint != null && saved.fingerprint !== componentSchemaFingerprint(ComponentClass)) {
        warnDrift(EntityClass, ComponentClass);
      }
      const fields = saved.fields || [];
      for (let f = 0; f < fields.length; f++) {
        const field = fields[f];
        const values = field.values;
        const length = field.length | 0 || 1;
        if (!values || values.length < n * length) continue;
        if (ComponentClass === Transform) {
          if (field.name === 'x') this.x = values;
          else if (field.name === 'y') this.y = values;
          else if (field.name === 'parent') this.parent = values;
        }
        const live = liveColumnOf(ComponentClass, field.name);
        if (live === null || live.arr === null) continue;
        if (live.entityId) {
          this.idLive.push(live.arr);
          this.idSaved.push(values);
          this.idLiveLength.push(live.length);
          this.idSavedLength.push(length);
        }
        if (live.arr.constructor === values.constructor && live.length === length) {
          const w = wordsPerElement(values) * length;
          const lv = bitsView(live.arr);
          const sv = bitsView(values);
          if (w !== 1) {
            this.liveWide.push(lv);
            this.savedWide.push(sv);
            this.wordsWide.push(w);
          } else if (values.BYTES_PER_ELEMENT === 1) {
            this.live8.push(lv);
            this.saved8.push(sv);
          } else if (values.BYTES_PER_ELEMENT === 2) {
            this.live16.push(lv);
            this.saved16.push(sv);
          } else {
            this.live32.push(lv);
            this.saved32.push(sv);
          }
        } else {
          this.liveDrift.push(live.arr);
          this.savedDrift.push(values);
          this.liveDriftLength.push(live.length);
          this.savedDriftLength.push(length);
        }
      }
    }
  }

  /**
   * Write the saved row `this.row` onto entity i.
   * @param {number} i
   */
  apply(i) {
    const r = this.row;
    const l8 = this.live8;
    const s8 = this.saved8;
    for (let c = 0; c < l8.length; c++) l8[c][i] = s8[c][r];
    const l16 = this.live16;
    const s16 = this.saved16;
    for (let c = 0; c < l16.length; c++) l16[c][i] = s16[c][r];
    const l32 = this.live32;
    const s32 = this.saved32;
    for (let c = 0; c < l32.length; c++) l32[c][i] = s32[c][r];
    const lw = this.liveWide;
    if (lw.length !== 0) this._applyWide(i, r);
    if (this.liveDrift.length !== 0) this._applyDrift(i, r);
  }

  _applyWide(i, r) {
    const lw = this.liveWide;
    const sw = this.savedWide;
    const ww = this.wordsWide;
    for (let c = 0; c < lw.length; c++) {
      const w = ww[c];
      const live = lw[c];
      const saved = sw[c];
      const d = i * w;
      const s = r * w;
      for (let e = 0; e < w; e++) live[d + e] = saved[s + e];
    }
  }

  _applyDrift(i, r) {
    const ld = this.liveDrift;
    for (let c = 0; c < ld.length; c++) {
      const live = ld[c];
      const saved = this.savedDrift[c];
      const ll = this.liveDriftLength[c];
      const sl = this.savedDriftLength[c];
      const n = ll < sl ? ll : sl;
      for (let e = 0; e < n; e++) live[i * ll + e] = saved[r * sl + e];
    }
  }

  /**
   * Every entity is placed: write its entity-id fields again, each id mapped to the index its entity has now (an id
   * whose entity was not restored, or entityIdNone, becomes entityIdNone).
   * @param {Int32Array} newIndexOf new index by saved index, -1 for one not restored
   */
  remapIds(newIndexOf) {
    const idx = this.table.indices;
    const n = idx.length;
    const none = entityIdNone >>> 0;
    const known = newIndexOf.length;
    for (let c = 0; c < this.idLive.length; c++) {
      const live = this.idLive[c];
      const saved = this.idSaved[c];
      const ll = this.idLiveLength[c];
      const sl = this.idSavedLength[c];
      const m = ll < sl ? ll : sl;
      for (let r = 0; r < n; r++) {
        const old = idx[r];
        const neu = old < known ? newIndexOf[old] : -1;
        if (neu < 0) continue;
        for (let e = 0; e < m; e++) {
          const id = saved[r * sl + e] >>> 0;
          const next = id !== none && id < known ? newIndexOf[id] : -1;
          live[neu * ll + e] = next >= 0 ? next : none;
        }
      }
    }
  }
}

/**
 * A table of one row, `row` of `table`: what a spawn handed to another logic worker carries (a copy, cheap to clone),
 * where that worker builds its own plan.
 * @returns {{ table: object, row: 0 }}
 */
export function rowRestore(table, row) {
  const components = table.components.map((c) => ({
    name: c.name,
    fingerprint: c.fingerprint,
    fields: c.fields.map((f) => {
      const length = f.length | 0 || 1;
      return { name: f.name, length, entityId: f.entityId, values: f.values.slice(row * length, (row + 1) * length) };
    }),
  }));
  return { table: { typeName: table.typeName, indices: Uint32Array.of(table.indices[row]), components }, row: 0 };
}

/**
 * Write a saved entity's columns onto entity `entityIndex` (GameObject's spawn calls it after onSpawned and the FSM's
 * initialization): row `saveRestore.row` of its table, through the load's EntityRestorePlan for its type, or through a
 * plan made here for a restore that crossed to another worker as plain data (rowRestore).
 * @param {number} entityIndex
 * @param {Function} EntityClass
 * @param {EntityRestorePlan|{ table: object, row: number }} saveRestore
 */
export function applyEntitySaveRestore(entityIndex, EntityClass, saveRestore) {
  if (!saveRestore || !saveRestore.table) return;
  let plan = saveRestore;
  if (!(saveRestore instanceof EntityRestorePlan)) {
    plan = new EntityRestorePlan(EntityClass, saveRestore.table);
    plan.row = saveRestore.row | 0;
  }
  plan.apply(entityIndex);

  // Ensure entity stays active after restore overwrite
  if (Transform.active) Transform.active[entityIndex] = 1;

  if (RigidBody.active?.[entityIndex] || Collider.active?.[entityIndex]) {
    markBodyDirty(entityIndex, BODY_DIRTY.LIFECYCLE | BODY_DIRTY.GEOMETRY | BODY_DIRTY.DAMPING);
  }
}

/**
 * Collect the live serializable entities of a scene, one table per type.
 * @param {{ registeredClasses: Array<{ class: Function, name?: string }> }} scene
 * @param {{ allEntities?: boolean }} [options] allEntities: every registered type,
 *   serializable or not (hot reload keeps the whole scene)
 * @returns {Array<{ typeName: string, indices: Uint32Array, components: object[] }>}
 */
export function collectSerializableEntities(scene, options = {}) {
  const allEntities = options.allEntities === true;
  const tables = [];
  const registered = scene.registeredClasses || [];
  const plans = new Map();
  const alive = Transform.active;

  for (let r = 0; r < registered.length; r++) {
    const EntityClass = registered[r].class;
    if (!EntityClass || (!allEntities && !isEntityClassSerializable(EntityClass))) continue;

    const active = EntityClass.getAllActive?.();
    if (!active || active.length === 0) continue;

    // A hot reload keeps everything; shouldSaveEntity trims what a player's save holds.
    const filter = !allEntities && typeof EntityClass.shouldSaveEntity === 'function' ? EntityClass : null;
    const indices = new Uint32Array(active.length);
    let n = 0;
    for (let a = 0; a < active.length; a++) {
      const entityIndex = active[a];
      if (alive && alive[entityIndex] !== 1) continue;
      if (filter && !filter.shouldSaveEntity(entityIndex)) continue;
      indices[n++] = entityIndex;
    }
    if (n === 0) continue;
    tables.push(gatherEntityTable(EntityClass, n === indices.length ? indices : indices.subarray(0, n), plans));
  }

  return tables;
}

/**
 * Soft layout hint from scene registry (detect missing types on load).
 * @param {object} scene
 */
export function buildLayoutHint(scene, allEntities = false) {
  const types = [];
  for (const reg of scene.registeredClasses || []) {
    if (!allEntities && !isEntityClassSerializable(reg.class)) continue;
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
  Sun.markAllWritten();
  Sun.publish();
}

/**
 * Build a logical save payload object (typed arrays OK; binary codec serializes).
 * @param {object} scene
 * @param {{ camera?: number[]|null, sun?: number[]|null }} [globals]
 * @param {{ allEntities?: boolean }} [options] see collectSerializableEntities
 */
export function buildSavePayload(scene, globals = {}, options = {}) {
  const allEntities = options.allEntities === true;
  const entities = collectSerializableEntities(scene, { allEntities });
  const joints = typeof Joint.serializeActive === 'function' ? Joint.serializeActive() : [];
  const payload = {
    magic: SAVE_MAGIC,
    formatVersion: SAVE_FORMAT_VERSION,
    engineVersion: VERSION,
    sceneName: scene.constructor?.name || 'Scene',
    layout: buildLayoutHint(scene, allEntities),
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
  const savedIndices = new Uint32Array(savedEntityCount({ entities }));
  for (let t = 0, o = 0; t < entities.length; t++) {
    savedIndices.set(entities[t].indices, o);
    o += entities[t].indices.length;
  }
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
  const simNowMs = packSimNow();
  if (simNowMs != null) payload.simNowMs = simNowMs;
  const tweens = packTweens();
  if (tweens) payload.tweens = tweens;
  // Scene state outside entities (score, quest flags, level): JSON, back as payload.custom.
  const custom = typeof scene.onSaveGame === 'function' ? scene.onSaveGame() : undefined;
  if (custom !== undefined && custom !== null) payload.custom = custom;
  if (globals.instanceFields) payload.instanceFields = globals.instanceFields;
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
