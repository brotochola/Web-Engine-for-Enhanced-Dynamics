// poseSnapshot.js - the POSES packet: position, rotation and velocity of replicated entities.
//
//   u8  NET_MSG.POSES
//   u32 tick                 host frame counter (wraps)
//   u16 count
//   count × {
//     u16 netId
//     f32 x, y, rotation, vx, vy, angularVelocity
//   }                        26 bytes each, little endian
//
// N0 format: full floats, every entity every packet. NETWORKING_PLAN.md N2 replaces
// it with a quantized, delta-coded snapshot. Pure functions over typed arrays, no
// engine imports: the main thread, a future network worker and Node tests share them.

import { NET_MSG } from './netProtocol.js';

export const POSE_HEADER_BYTES = 7;
export const POSE_ENTRY_BYTES = 26;
/** One packet stays under the ~16 KiB a data channel message can carry everywhere. */
export const POSE_MAX_ENTRIES = Math.floor((16 * 1024 - POSE_HEADER_BYTES) / POSE_ENTRY_BYTES);

/** Bytes a snapshot of `count` entities takes. */
export function poseSnapshotBytes(count) {
  return POSE_HEADER_BYTES + count * POSE_ENTRY_BYTES;
}

/**
 * Write a snapshot from SoA arrays.
 *
 * @param {DataView} view - at least poseSnapshotBytes(count) bytes
 * @param {number} tick
 * @param {ArrayLike<number>} netIds - netIds[k] for the k-th entity (0–65535)
 * @param {ArrayLike<number>} indices - entity index of the k-th entity
 * @param {number} count
 * @param {{ x: Float32Array, y: Float32Array, rotation: Float32Array|null }} pose - Transform's views
 * @param {{ vx: Float32Array|null, vy: Float32Array|null, angularVelocity: Float32Array|null }|null} [vel]
 *   RigidBody's views; null (or null fields) sends zero velocity
 * @returns {number} bytes written
 */
export function writePoseSnapshot(view, tick, netIds, indices, count, pose, vel) {
  const n = Math.min(count | 0, POSE_MAX_ENTRIES);
  view.setUint8(0, NET_MSG.POSES);
  view.setUint32(1, tick >>> 0, true);
  view.setUint16(5, n, true);
  const xs = pose.x;
  const ys = pose.y;
  const rs = pose.rotation;
  const vxs = vel ? vel.vx : null;
  const vys = vel ? vel.vy : null;
  const vas = vel ? vel.angularVelocity : null;
  let o = POSE_HEADER_BYTES;
  for (let k = 0; k < n; k++) {
    const i = indices[k];
    view.setUint16(o, netIds[k], true);
    view.setFloat32(o + 2, xs[i], true);
    view.setFloat32(o + 6, ys[i], true);
    view.setFloat32(o + 10, rs ? rs[i] : 0, true);
    view.setFloat32(o + 14, vxs ? vxs[i] : 0, true);
    view.setFloat32(o + 18, vys ? vys[i] : 0, true);
    view.setFloat32(o + 22, vas ? vas[i] : 0, true);
    o += POSE_ENTRY_BYTES;
  }
  return o;
}

/**
 * Read a snapshot into arrays indexed by netId (a SharedResource's fields fit).
 * Entities whose netId does not fit the target arrays are skipped.
 *
 * @param {DataView} view
 * @param {{ x: Float32Array, y: Float32Array, rotation: Float32Array, vx: Float32Array,
 *           vy: Float32Array, angularVelocity: Float32Array, time?: Float64Array, tick?: Uint32Array }} target
 * @param {number} stampMs - written to target.time[netId] (epoch ms, netNow()) when target.time is given
 * @returns {{ tick: number, count: number } | null} null when the packet is not a whole snapshot
 */
export function readPoseSnapshot(view, target, stampMs) {
  if (view.byteLength < POSE_HEADER_BYTES || view.getUint8(0) !== NET_MSG.POSES) return null;
  const tick = view.getUint32(1, true);
  const count = view.getUint16(5, true);
  if (view.byteLength < poseSnapshotBytes(count)) return null;
  const cap = target.x.length;
  const times = target.time || null;
  const ticks = target.tick || null;
  let o = POSE_HEADER_BYTES;
  for (let k = 0; k < count; k++) {
    const id = view.getUint16(o, true);
    if (id < cap) {
      target.x[id] = view.getFloat32(o + 2, true);
      target.y[id] = view.getFloat32(o + 6, true);
      target.rotation[id] = view.getFloat32(o + 10, true);
      target.vx[id] = view.getFloat32(o + 14, true);
      target.vy[id] = view.getFloat32(o + 18, true);
      target.angularVelocity[id] = view.getFloat32(o + 22, true);
      if (times) times[id] = stampMs;
      if (ticks) ticks[id] = tick;
    }
    o += POSE_ENTRY_BYTES;
  }
  return { tick, count };
}

/**
 * Is tick `a` newer than `b`? Ticks are u32 and wrap; this compares by the shorter way round.
 */
export function isNewerTick(a, b) {
  return ((a - b) | 0) > 0;
}
