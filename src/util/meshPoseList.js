/**
 * N-138. The poses pre-render drew this frame's sprites at, for the entities that also have a mesh (a
 * VolumeShadowCaster brings one): their mesh is filled at the same pose, so a moving car's volume shadow stays under
 * its sprite. One list per render-queue buffer, written by pre-render before it publishes that buffer's frame and
 * copied by Pixi when it takes the frame, before it hands the buffer back.
 *
 * Layout: Int32 count, 12 bytes of padding, Int32 entity[capacity], Float32 pose[capacity * 4] (x, y, rotC, rotS).
 */
export const MESH_POSE_FLOATS = 4;
const HEADER_BYTES = 16;

export function meshPoseListBytes(capacity) {
  const n = capacity | 0;
  return HEADER_BYTES + n * 4 + n * MESH_POSE_FLOATS * 4;
}

/** Both buffers' lists, or null when no class has a sprite and a mesh (capacity 0). */
export function createMeshPoseLists(capacity) {
  const n = capacity | 0;
  if (n <= 0) return null;
  return [new SharedArrayBuffer(meshPoseListBytes(n)), new SharedArrayBuffer(meshPoseListBytes(n))];
}

export function bindMeshPoseList(buffer, capacity) {
  const n = capacity | 0;
  return {
    capacity: n,
    count: new Int32Array(buffer, 0, 1),
    entity: new Int32Array(buffer, HEADER_BYTES, n),
    pose: new Float32Array(buffer, HEADER_BYTES + n * 4, n * MESH_POSE_FLOATS),
  };
}

/** The capacity of a list: the pools of the registered classes whose components hold both the sprite and the mesh. */
export function meshPoseCapacity(registeredClasses, SpriteRenderer, MeshRenderer) {
  let n = 0;
  for (const rec of registeredClasses || []) {
    const components = rec.components;
    if (!(rec.count > 0) || !components) continue;
    if (components.includes(SpriteRenderer) && components.includes(MeshRenderer)) n += rec.count | 0;
  }
  return n;
}

/**
 * Pre-render: the collected rows [from, to) whose entity has an active mesh, with the pose their sprite row holds.
 * Types 0 (sprite) and 6 (Adobe root) carry the entity's pose in the collect columns.
 */
export function writeMeshPoseList(list, from, to, type, index, meshActive, px, py, rotC, rotS) {
  const cap = list.capacity;
  const entity = list.entity;
  const pose = list.pose;
  let k = 0;
  for (let r = from; r < to && k < cap; r++) {
    const t = type[r];
    if (t !== 0 && t !== 6) continue;
    const e = index[r];
    if (meshActive[e] === 0) continue;
    entity[k] = e;
    const o = k * MESH_POSE_FLOATS;
    pose[o] = px[r];
    pose[o + 1] = py[r];
    pose[o + 2] = rotC[r];
    pose[o + 3] = rotS[r];
    k++;
  }
  list.count[0] = k;
  return k;
}

/** Pixi: the list into per-entity columns, stamped with the frame it came with. */
export function takeMeshPoseList(list, frame, stamp, dst) {
  const n = Math.min(list.count[0] | 0, list.capacity);
  const entity = list.entity;
  const pose = list.pose;
  const limit = stamp.length;
  for (let k = 0; k < n; k++) {
    const e = entity[k];
    if (e < 0 || e >= limit) continue;
    stamp[e] = frame;
    const o = k * MESH_POSE_FLOATS;
    const d = e * MESH_POSE_FLOATS;
    dst[d] = pose[o];
    dst[d + 1] = pose[o + 1];
    dst[d + 2] = pose[o + 2];
    dst[d + 3] = pose[o + 3];
  }
  return n;
}
