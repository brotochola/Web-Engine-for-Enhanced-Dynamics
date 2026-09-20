// Bind Weed Transform / RigidBody hot views onto Box2D WASM HEAP channels.
// Sole owner of Transform.x/y/rotation/rotC/rotS and RigidBody.vx/vy/angularVelocity/sleeping
// after box2dReady. Logic constructs GameObjects only after this bind.
// Units: px, px/s, rad, rad/s (Box2D native).

import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { STATE_CHANNELS } from './box2dConstants.js';
import { setRotCSFromAngle } from '../util/utils.js';

export { STATE_CHANNELS };

/**
 * @param {{
 *   sab: SharedArrayBuffer,
 *   channelOffsets: number[],
 *   sleepingByteOffset: number,
 *   bodyCapacity: number,
 * }} payload
 */
export function bindBox2dHotFields(payload) {
  const sab = payload.sab;
  const off = payload.channelOffsets;
  const n = payload.bodyCapacity | 0;
  if (!sab || !off || !(n > 0)) {
    throw new Error('bindBox2dHotFields: invalid payload');
  }

  Transform.x = new Float32Array(sab, off[STATE_CHANNELS.X] << 2, n);
  Transform.y = new Float32Array(sab, off[STATE_CHANNELS.Y] << 2, n);
  Transform.rotation = new Float32Array(
    sab,
    off[STATE_CHANNELS.ROTATION] << 2,
    n,
  );
  Transform.rotC = new Float32Array(sab, off[STATE_CHANNELS.ROT_C] << 2, n);
  Transform.rotS = new Float32Array(sab, off[STATE_CHANNELS.ROT_S] << 2, n);
  RigidBody.vx = new Float32Array(sab, off[STATE_CHANNELS.VX] << 2, n);
  RigidBody.vy = new Float32Array(sab, off[STATE_CHANNELS.VY] << 2, n);
  RigidBody.angularVelocity = new Float32Array(
    sab,
    off[STATE_CHANNELS.ANG_VEL] << 2,
    n,
  );

  if (payload.sleepingByteOffset >= 0) {
    RigidBody.sleeping = new Uint8Array(sab, payload.sleepingByteOffset, n);
  }
}

export function isBox2dHotFieldsBound(payload) {
  return !!(payload?.sab && Transform.x?.buffer === payload.sab);
}

/** Five float channels: x, y, rotation, rotC, rotS. Used when physics.enabled === false. */
export const WEED_POSE_CHANNEL_COUNT = 5;

export function createWeedPosePayload(entityCount) {
  const n = entityCount | 0;
  if (!(n > 0)) {
    throw new Error('createWeedPosePayload: entityCount must be > 0');
  }
  const sab = new SharedArrayBuffer(n * WEED_POSE_CHANNEL_COUNT * 4);
  return {
    sab,
    channelOffsets: [0, n, n * 2, n * 3, n * 4],
    bodyCapacity: n,
  };
}

export function bindWeedPoseFields(payload) {
  const sab = payload.sab;
  const off = payload.channelOffsets;
  const n = payload.bodyCapacity | 0;
  if (!sab || !off || !(n > 0)) {
    throw new Error('bindWeedPoseFields: invalid payload');
  }
  Transform.x = new Float32Array(sab, off[0] << 2, n);
  Transform.y = new Float32Array(sab, off[1] << 2, n);
  Transform.rotation = new Float32Array(sab, off[2] << 2, n);
  Transform.rotC = new Float32Array(sab, off[3] << 2, n);
  Transform.rotS = new Float32Array(sab, off[4] << 2, n);
}

export function initWeedPoseDefaults(payload) {
  bindWeedPoseFields(payload);
  Transform.x.fill(0);
  Transform.y.fill(0);
  Transform.rotation.fill(0);
  Transform.rotC.fill(1);
  Transform.rotS.fill(0);
}

/** Keep rotC/rotS coherent when JS writes an angle before the next physics export. */
export function syncRotCSFromAngle(index, angle) {
  if (!Transform.rotC || !Transform.rotS) return;
  setRotCSFromAngle(Transform.rotC, Transform.rotS, index, angle);
}
