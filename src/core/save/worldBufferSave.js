// Pack and apply the world buffers that sit outside entity SoA:
// shared resources, chains, extra fixtures, custom meshes, nav walkability,
// Time.scale, and in-flight tweens. Camera follow is remapped here after the
// spawns build oldToNew (entity-id fields: EntityRestorePlan.remapIds).

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
import { TWEEN_RECORD_FIELDS, tweenFieldValue } from './tweenRecord.js';
import { Transform } from '../../components/transform.js';
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
    // size would land values in the wrong fields. A record without one (0 on the
    // wire) keeps the size check alone.
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
  applyPerEntity(records, restored, (neu, rec) => {
    if (!rec) {
      if (ChainPoints.count && (ChainPoints.count[neu] | 0) > 0) ChainPoints.clearForEntity(neu);
    } else if (!ChainPoints.setForEntity(neu, rec.xy, rec.count | 0, rec.loop)) {
      console.warn(`[SaveGame] chain restore failed for entity ${neu}: ${ChainPoints.lastError.code}`);
    }
  });
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
  applyPerEntity(records, restored, (neu, rec) => {
    if (!rec || !rec.counts || !rec.counts.length) {
      const hasExtras = (Collider.fixtureCount && (Collider.fixtureCount[neu] | 0) > 0)
        || (ColliderFixture.head && ColliderFixture.headOf(neu) !== ColliderFixture.INVALID_INDEX);
      if (hasExtras) Collider.clearFixtures(neu);
    } else if (!Collider.replacePolygonsFlat(neu, rec.xy, rec.counts, rec.counts.length)) {
      console.warn(`[SaveGame] fixture restore failed for entity ${neu}: ${ColliderFixture.lastReplaceError.code}`);
    }
  });
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
      // The arena's width (E-130): Uint16 up to 65535 vertices, Uint32 past that.
      indices = new MeshGeometry.IndexArray(indexN);
      copyInto(indices, MeshGeometry.indices.subarray(indexOff), indexN);
    }
    out.push({ entityIndex, xy, uv, indices });
  }
  return out;
}

export function applyMeshes(records, restored) {
  applyPerEntity(records, restored, (neu, rec) => {
    if (!rec || !rec.xy) MeshGeometry.clearEntity(neu);
    else if (!MeshGeometry.replace(neu, rec.xy, rec.indices || null, rec.uv || null)) {
      console.warn(`[SaveGame] mesh restore failed for entity ${neu}`);
    }
  });
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

/**
 * N-329: the sim clock's time (Time.simNowMs), so a load goes on from it: a game that stamps it (a weapon's last shot,
 * a cooldown's start) compares those stamps with the same clock after a load. Null when the clock is unbound.
 * @returns {number|null}
 */
export function packSimNow() {
  if (!Time._simSeq) return null;
  return Time.simNowMs;
}

/** The sim clock set to the saved time (a save without one leaves it alone). */
export function applySimNow(simNowMs) {
  if (simNowMs == null || !Time._simSeq) return;
  Time._setSimNow(+simNowMs);
}

export function packTweens() {
  if (!Tween.active) return null;
  const out = [];
  const n = Tween.capacity | 0;
  for (let i = 0; i < n; i++) {
    // 1 = live. 2 is a claim still writing its fields (another worker): skip it.
    if (Tween.active[i] !== 1) continue;
    const rec = {};
    for (let f = 0; f < TWEEN_RECORD_FIELDS.length; f++) {
      const name = TWEEN_RECORD_FIELDS[f][0];
      rec[name] = Tween[name][i];
    }
    out.push(rec);
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
  if (!slots || !slots.length) {
    Tween.rebuildEntityCounts();
    return;
  }
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
    for (let f = 0; f < TWEEN_RECORD_FIELDS.length; f++) {
      const name = TWEEN_RECORD_FIELDS[f][0];
      Tween[name][slot] = tweenFieldValue(TWEEN_RECORD_FIELDS[f][1], rec[name]);
    }
    // The entity was remapped above.
    Tween.entity[slot] = entity;
    Atomics.store(Tween.active, slot, 1);
    slot++;
  }
  // Slots were written and cleared directly: recount live tweens per entity.
  Tween.rebuildEntityCounts();
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

/**
 * A lookup of the restore's pairs: old index -> new, or null for an entity the load did not restore. By a table over
 * the saved indices, not a Map: a crowd's 42 000 pairs took 3.5 ms as a Map.
 * @param {ArrayLike<number>|null|undefined} pairs flat [old, neu, ...]
 */
export function idMapGetter(pairs) {
  const n = pairs ? pairs.length - (pairs.length & 1) : 0;
  let known = 0;
  for (let i = 0; i < n; i += 2) {
    const old = pairs[i] | 0;
    if (old >= known) known = old + 1;
  }
  const neu = new Int32Array(known).fill(-1);
  for (let i = 0; i < n; i += 2) {
    const old = pairs[i] | 0;
    if (old >= 0) neu[old] = pairs[i + 1] | 0;
  }
  return (old) => {
    const key = old | 0;
    return key >= 0 && key < known && neu[key] >= 0 ? neu[key] : null;
  };
}

/**
 * The apply functions' walk: `apply(neu, rec)` for each restored entity, with the record saved under its old index
 * (undefined when it had none). Null records: the save has no such section (the pool was unbound), so what onSpawned
 * built stays; [] means none of the saved entities had one.
 */
function applyPerEntity(records, restored, apply) {
  if (records == null || !restored || !restored.length) return;
  const byOld = indexRecords(records);
  for (let i = 0; i < restored.length; i++) apply(restored[i].neu | 0, byOld.get(restored[i].old | 0));
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
