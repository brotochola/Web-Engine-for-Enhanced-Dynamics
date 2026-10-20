// Pack and apply the world buffers that sit outside entity SoA:
// shared resources, chains, extra fixtures, custom meshes, nav walkability,
// Time.scale, and in-flight tweens. Entity-id fields and camera follow
// are remapped here after spawn builds oldToNew.

import { Component } from '../component.js';
import { Collider } from '../../components/collider.js';
import { ShapeType } from '../../util/configDefaults.js';
import { Camera } from '../camera.js';
import { ChainPoints } from '../chainPoints.js';
import { ColliderFixture } from '../colliderFixture.js';
import { MeshGeometry } from '../meshGeometry.js';
import { NavGrid } from '../navGrid.js';
import { SharedResource } from '../sharedResource.js';
import { Time } from '../timeScale.js';
import { Tween, TWEEN_KIND_ZOOM } from '../tween.js';
import { Transform } from '../../components/transform.js';
import { entityIdNone } from '../../util/entityIdWidth.js';
import { fnv1a32 } from './schemaHash.js';

function copyInto(dst, src, n) {
  const count = n | 0;
  for (let i = 0; i < count; i++) dst[i] = src[i];
}

/**
 * Schema fingerprint of a shared resource: its name, then each field's name,
 * type, length and atomic flag in layout order. Two schemas can share a byte
 * size and still lay the bytes out differently.
 * @param {typeof SharedResource} ResourceClass
 * @returns {number}
 */
export function sharedResourceFingerprint(ResourceClass) {
  const parts = [ResourceClass.name];
  for (const [name, spec] of Object.entries(ResourceClass._schema || {})) {
    const { type, length, atomic } = SharedResource._schemaEntry(spec);
    parts.push(atomic ? `${name}:${type.name}:${length}:atomic` : `${name}:${type.name}:${length}`);
  }
  return fnv1a32(parts.join('|'));
}

export function packSharedResources() {
  const bound = SharedResource.boundList();
  const out = [];
  for (let i = 0; i < bound.length; i++) {
    const ResourceClass = bound[i].class;
    const buf = ResourceClass?.sharedBuffer;
    if (!buf) continue;
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(new Uint8Array(buf));
    out.push({ name: bound[i].name, fingerprint: sharedResourceFingerprint(ResourceClass), bytes });
  }
  return out;
}

export function applySharedResources(records) {
  if (!records || !records.length) return;
  const bound = SharedResource.boundList();
  const byName = new Map();
  for (let i = 0; i < bound.length; i++) byName.set(bound[i].name, bound[i].class);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const ResourceClass = byName.get(rec.name);
    const bytes = rec.bytes;
    if (!ResourceClass?.sharedBuffer || !bytes) {
      console.warn(`[SaveGame] shared resource ${rec.name} missing; skipped`);
      continue;
    }
    if (ResourceClass.sharedBuffer.byteLength !== bytes.byteLength) {
      console.warn(
        `[SaveGame] shared resource ${rec.name} size ${bytes.byteLength} != ${ResourceClass.sharedBuffer.byteLength}; skipped`
      );
      continue;
    }
    // Raw bytes cannot be applied best-effort: a different layout at the same
    // size would land values in the wrong fields. Saves older than the
    // fingerprint carry none and keep the size check alone.
    if (rec.fingerprint != null && rec.fingerprint !== sharedResourceFingerprint(ResourceClass)) {
      console.warn(`[SaveGame] shared resource ${rec.name} schema changed since the save; skipped`);
      continue;
    }
    new Uint8Array(ResourceClass.sharedBuffer).set(bytes);
  }
}

/**
 * @param {number[]} entityIndices saved entity slots
 */
export function packChains(entityIndices) {
  const out = [];
  // null: the pool is unbound, so the save writes no CHAINS section and a load leaves
  // whatever onSpawned built. [] (even empty) writes the section.
  if (!ChainPoints.count || !ChainPoints.begin) return null;
  if (!entityIndices) return out;
  for (let i = 0; i < entityIndices.length; i++) {
    const entityIndex = entityIndices[i] | 0;
    if (entityIndex < 0 || entityIndex >= ChainPoints.entityCount) continue;
    // Points left in a slot whose collider is no longer a chain are not its shape.
    if (Collider.shapeType && (Collider.shapeType[entityIndex] | 0) !== ShapeType.Chain) continue;
    const count = ChainPoints.count[entityIndex] | 0;
    const begin = ChainPoints.begin[entityIndex] | 0;
    if (begin < 0 || count <= 0) continue;
    const xy = new Float32Array(count * 2);
    copyInto(xy, ChainPoints.xy.subarray(begin * 2), xy.length);
    out.push({
      entityIndex,
      loop: ChainPoints.loop[entityIndex] | 0,
      count,
      xy,
    });
  }
  return out;
}

/**
 * @param {Array<{entityIndex:number, loop:number, count:number, xy:Float32Array}>|null} records
 * @param {Array<{old:number, neu:number}>} restored
 */
export function applyChains(records, restored) {
  // null: the save has no such section (older than 67a93c49, or the pool was unbound):
  // leave what onSpawned built. [] means none of the saved entities had one.
  if (records == null || !restored || !restored.length) return;
  const byOld = indexRecords(records);
  for (let i = 0; i < restored.length; i++) {
    const neu = restored[i].neu | 0;
    const rec = byOld.get(restored[i].old | 0);
    if (!rec) {
      if (ChainPoints.count && (ChainPoints.count[neu] | 0) > 0) ChainPoints.clearForEntity(neu);
      continue;
    }
    if (!ChainPoints.setForEntity(neu, rec.xy, rec.count | 0, rec.loop)) {
      console.warn(
        `[SaveGame] chain restore failed for entity ${neu}: ${ChainPoints.lastError.code}`
      );
    }
  }
}

export function packFixtures(entityIndices) {
  const out = [];
  if (!ColliderFixture.head) return null;
  if (!entityIndices) return out;
  for (let i = 0; i < entityIndices.length; i++) {
    const entityIndex = entityIndices[i] | 0;
    const counts = [];
    const xy = [];
    ColliderFixture.forEach(entityIndex, (idx) => {
      const count = ColliderFixture.vertCount[idx] | 0;
      if (count < 3) return;
      counts.push(count);
      const base = ColliderFixture.vertBase(idx);
      for (let v = 0; v < count; v++) {
        xy.push(ColliderFixture.vertexX[base + v], ColliderFixture.vertexY[base + v]);
      }
    });
    if (!counts.length) continue;
    out.push({
      entityIndex,
      counts: Uint8Array.from(counts),
      xy: Float32Array.from(xy),
    });
  }
  return out;
}

export function applyFixtures(records, restored) {
  // null: the save has no such section (older than 67a93c49, or the pool was unbound):
  // leave what onSpawned built. [] means none of the saved entities had one.
  if (records == null || !restored || !restored.length) return;
  const byOld = indexRecords(records);
  for (let i = 0; i < restored.length; i++) {
    const neu = restored[i].neu | 0;
    const rec = byOld.get(restored[i].old | 0);
    if (!rec || !rec.counts || !rec.counts.length) {
      const hasExtras = (Collider.fixtureCount && (Collider.fixtureCount[neu] | 0) > 0)
        || (ColliderFixture.head && ColliderFixture.headOf(neu) !== ColliderFixture.INVALID_INDEX);
      if (hasExtras) Collider.clearFixtures(neu);
      continue;
    }
    const ok = Collider.replacePolygonsFlat(neu, rec.xy, rec.counts, rec.counts.length);
    if (!ok) {
      console.warn(
        `[SaveGame] fixture restore failed for entity ${neu}: ${ColliderFixture.lastReplaceError.code}`
      );
    }
  }
}

export function packMeshes(entityIndices) {
  const out = [];
  if (!MeshGeometry.vertCount) return null;
  if (!entityIndices) return out;
  for (let i = 0; i < entityIndices.length; i++) {
    const entityIndex = entityIndices[i] | 0;
    if (entityIndex < 0 || entityIndex >= (MeshGeometry.entityCount | 0)) continue;
    const vertN = MeshGeometry.vertCount[entityIndex] | 0;
    const off = MeshGeometry.vertOffset[entityIndex] | 0;
    if (vertN <= 0 || off < 0) continue;
    const xy = new Float32Array(vertN * 2);
    for (let v = 0; v < vertN; v++) {
      xy[v * 2] = MeshGeometry.vertexX[off + v];
      xy[v * 2 + 1] = MeshGeometry.vertexY[off + v];
    }
    let uv = null;
    if (MeshGeometry.hasUv[entityIndex]) {
      uv = new Float32Array(vertN * 2);
      for (let v = 0; v < vertN; v++) {
        uv[v * 2] = MeshGeometry.uvU[off + v];
        uv[v * 2 + 1] = MeshGeometry.uvV[off + v];
      }
    }
    let indices = null;
    const indexN = MeshGeometry.indexCount[entityIndex] >>> 0;
    const indexOff = MeshGeometry.indexOffset[entityIndex] | 0;
    if (indexN > 0 && indexOff >= 0 && MeshGeometry.indices) {
      indices = new Uint16Array(indexN);
      copyInto(indices, MeshGeometry.indices.subarray(indexOff), indexN);
    }
    out.push({ entityIndex, xy, uv, indices });
  }
  return out;
}

export function applyMeshes(records, restored) {
  // null: the save has no such section (older than 67a93c49, or the pool was unbound):
  // leave what onSpawned built. [] means none of the saved entities had one.
  if (records == null || !restored || !restored.length) return;
  const byOld = indexRecords(records);
  for (let i = 0; i < restored.length; i++) {
    const neu = restored[i].neu | 0;
    const rec = byOld.get(restored[i].old | 0);
    if (!rec || !rec.xy) {
      MeshGeometry.clearEntity(neu);
      continue;
    }
    const ok = MeshGeometry.replace(neu, rec.xy, rec.indices || null, rec.uv || null);
    if (!ok) console.warn(`[SaveGame] mesh restore failed for entity ${neu}`);
  }
}

export function packNav() {
  const walk = NavGrid.getWalkabilityArray();
  if (!walk) return null;
  const info = NavGrid.getGridInfo();
  const walkability = new Uint8Array(walk.length);
  walkability.set(walk);
  return {
    gridWidth: info.width | 0,
    gridHeight: info.height | 0,
    cellSize: info.cellSize >>> 0,
    walkability,
  };
}

export function applyNav(nav) {
  if (!nav) return;
  const dst = NavGrid.getWalkabilityArray();
  if (!dst) {
    console.warn('[SaveGame] nav restore skipped: grid not initialized');
    return;
  }
  const info = NavGrid.getGridInfo();
  const src = nav.walkability;
  if (
    !src ||
    info.width !== (nav.gridWidth | 0) ||
    info.height !== (nav.gridHeight | 0) ||
    (info.cellSize >>> 0) !== (nav.cellSize >>> 0) ||
    dst.length !== src.length
  ) {
    console.warn('[SaveGame] nav restore skipped: dimension mismatch');
    return;
  }
  dst.set(src);
  NavGrid.invalidate();
}

/** @returns {number|null} sanitized scale, or null when the clock is unbound */
export function packTime() {
  if (!Time.view) return null;
  return Time.scale;
}

export function applyTime(scale) {
  if (scale == null || !Time.view) return;
  Time.scale = +scale;
}

export function packTweens() {
  if (!Tween.active) return null;
  const out = [];
  const n = Tween.capacity | 0;
  for (let i = 0; i < n; i++) {
    // 1 = live. 2 is a claim still writing its fields (another worker): skip it.
    if (Tween.active[i] !== 1) continue;
    out.push({
      kind: Tween.kind[i] | 0,
      ease: Tween.ease[i] | 0,
      mask: Tween.mask[i] | 0,
      entity: Tween.entity[i] | 0,
      duration: Tween.duration[i],
      elapsed: Tween.elapsed[i],
      from0: Tween.from0[i],
      to0: Tween.to0[i],
      from1: Tween.from1[i],
      to1: Tween.to1[i],
      from2: Tween.from2[i],
      to2: Tween.to2[i],
      from3: Tween.from3[i],
      to3: Tween.to3[i],
      tintFrom: Tween.tintFrom[i] >>> 0,
      tintTo: Tween.tintTo[i] >>> 0,
    });
  }
  return out.length ? out : null;
}

/**
 * Restore the saved tweens. Zoom slots keep their entity field. Paint and xy slots whose
 * target was not restored are dropped.
 *
 * The live pool is not wiped: create() runs again on a load, and tweens it started on
 * entities the save does not own (non-serializable props) must survive. A live slot is
 * cleared when it is a zoom tween (the saved zoom replaces it), when its entity is no
 * longer active (a serializable entity the restore despawned), or when its entity is
 * one of the restored entities (the saved tween state replaces what onSpawned started).
 * @param {object[]|null} slots
 * @param {(oldId:number) => number|null} mapGet
 * @param {Array<{old:number, neu:number}>} [restored]
 */
export function applyTweens(slots, mapGet, restored) {
  if (!Tween.active) {
    if (slots && slots.length) console.warn('[SaveGame] tween restore skipped: pool is unbound');
    return;
  }
  const n = Tween.capacity | 0;
  const restoredNew = new Set();
  if (restored) for (let i = 0; i < restored.length; i++) restoredNew.add(restored[i].neu | 0);
  const alive = Transform.active;
  for (let i = 0; i < n; i++) {
    const state = Tween.active[i];
    if (state === 0) continue;
    const ent = Tween.entity[i];
    const keep = state === 1 &&
      Tween.kind[i] !== TWEEN_KIND_ZOOM &&
      !!alive && alive[ent] === 1 &&
      !restoredNew.has(ent);
    if (!keep) Atomics.store(Tween.active, i, 0);
  }
  if (!slots || !slots.length) return;
  let slot = 0;
  for (let i = 0; i < slots.length; i++) {
    const rec = slots[i];
    const kind = rec.kind | 0;
    let entity = rec.entity | 0;
    if (kind !== TWEEN_KIND_ZOOM) {
      const next = mapGet(entity);
      if (next == null) continue;
      entity = next | 0;
    }
    while (slot < n && Tween.active[slot] !== 0) slot++;
    if (slot >= n) {
      console.warn('[SaveGame] tween restore dropped slots: pool is smaller than the save');
      return;
    }
    Tween.kind[slot] = kind;
    Tween.entity[slot] = entity;
    Tween.ease[slot] = rec.ease | 0;
    Tween.mask[slot] = rec.mask | 0;
    Tween.duration[slot] = +rec.duration || 0;
    Tween.elapsed[slot] = +rec.elapsed || 0;
    Tween.from0[slot] = +rec.from0 || 0;
    Tween.to0[slot] = +rec.to0 || 0;
    Tween.from1[slot] = +rec.from1 || 0;
    Tween.to1[slot] = +rec.to1 || 0;
    Tween.from2[slot] = +rec.from2 || 0;
    Tween.to2[slot] = +rec.to2 || 0;
    Tween.from3[slot] = +rec.from3 || 0;
    Tween.to3[slot] = +rec.to3 || 0;
    Tween.tintFrom[slot] = rec.tintFrom >>> 0;
    Tween.tintTo[slot] = rec.tintTo >>> 0;
    Atomics.store(Tween.active, slot, 1);
    slot++;
  }
}

function remapOne(value, mapGet) {
  if (value == null) return entityIdNone;
  const id = value >>> 0;
  if (id === (entityIdNone >>> 0)) return entityIdNone;
  const next = mapGet(id);
  if (next == null) return entityIdNone;
  return next >>> 0;
}

/**
 * Rewrite saved entity-id fields onto the restored slot.
 * Fields absent from the save are left as spawn wrote them.
 * @param {Function} EntityClass
 * @param {number} entityIndex new slot
 * @param {object} components saved component map
 * @param {(oldId:number) => number|null} mapGet
 */
export function remapEntityIdFields(EntityClass, entityIndex, components, mapGet) {
  if (!components || !EntityClass) return;
  const map = EntityClass._componentClassMap || {};
  const index = entityIndex | 0;
  for (const name in map) {
    const ComponentClass = map[name];
    if (!ComponentClass?.ARRAY_SCHEMA) continue;
    const saved = components[ComponentClass.name] || components[name];
    if (!saved?.fields) continue;
    const fields = saved.fields;
    for (const [fieldName, typeOrSpec] of Object.entries(ComponentClass.ARRAY_SCHEMA)) {
      const spec = Component._schemaEntry(typeOrSpec);
      if (!spec.entityId || !(fieldName in fields)) continue;
      const arr = ComponentClass[fieldName];
      if (!arr) continue;
      const value = fields[fieldName];
      if (spec.length === 1) {
        arr[index] = remapOne(value, mapGet);
        continue;
      }
      if (!Array.isArray(value)) continue;
      const base = index * spec.length;
      const n = Math.min(spec.length, value.length);
      for (let k = 0; k < n; k++) arr[base + k] = remapOne(value[k], mapGet);
    }
  }
}

/**
 * Camera follow is 0 for none, otherwise entityIndex + 1.
 * @param {ArrayLike<number>|null} camera
 * @param {(oldId:number) => number|null} mapGet
 */
/**
 * The saved camera with its follow entity mapped to this load's index. A copy:
 * the caller's payload keeps the saved id, so loading the same payload again
 * maps from it rather than from the previous load's index.
 * @param {number[]|null|undefined} camera saved camera floats
 * @param {(old: number) => number|null} mapGet
 * @returns {number[]|null}
 */
export function remapCameraFollow(camera, mapGet) {
  if (!camera) return null;
  const out = Array.from(camera);
  if (out.length <= Camera.IDX_FOLLOW_ENTITY) return out;
  const stored = out[Camera.IDX_FOLLOW_ENTITY] | 0;
  if (!stored) return out;
  const next = mapGet(stored - 1);
  out[Camera.IDX_FOLLOW_ENTITY] = next == null ? 0 : (next | 0) + 1;
  return out;
}

/** @param {number[]|null|undefined} pairs flat [old, neu, ...] */
export function idMapGetter(pairs) {
  const map = new Map();
  if (pairs) {
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      map.set(pairs[i] | 0, pairs[i + 1] | 0);
    }
  }
  return (old) => {
    const key = old | 0;
    return map.has(key) ? map.get(key) | 0 : null;
  };
}

function indexRecords(records) {
  const byOld = new Map();
  if (!records) return byOld;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    byOld.set(rec.entityIndex | 0, rec);
  }
  return byOld;
}
