/**
 * Thin LiquidFun group mirror SAB. Physics worker writes alive groups each
 * afterStep; main/logic reads via LiquidFun.getGroups().
 * Cap 256 — intentional blobs / melt handles, not every spray.
 */

export const LIQUIDFUN_GROUPS_MAX = 256;

export function liquidFunGroupsByteSize(maxGroups = LIQUIDFUN_GROUPS_MAX) {
  const n = maxGroups | 0;
  // count i32 + id/particleCount/first/last i32 + 7 f32 pose + lightIntensity + sqrtLightIntensity (by group id)
  const bytes = 4 + n * 4 * 13;
  return (bytes + 3) & ~3;
}

export function bindLiquidFunGroups(sab, maxGroups = LIQUIDFUN_GROUPS_MAX) {
  const n = maxGroups | 0;
  let off = 0;
  const count = new Int32Array(sab, off, 1);
  off += 4;
  const id = new Int32Array(sab, off, n);
  off += n * 4;
  const particleCount = new Int32Array(sab, off, n);
  off += n * 4;
  const firstIndex = new Int32Array(sab, off, n);
  off += n * 4;
  const lastIndex = new Int32Array(sab, off, n);
  off += n * 4;
  const viscousScale = new Float32Array(sab, off, n);
  off += n * 4;
  const x = new Float32Array(sab, off, n);
  off += n * 4;
  const y = new Float32Array(sab, off, n);
  off += n * 4;
  const vx = new Float32Array(sab, off, n);
  off += n * 4;
  const vy = new Float32Array(sab, off, n);
  off += n * 4;
  const angularVelocity = new Float32Array(sab, off, n);
  off += n * 4;
  const angle = new Float32Array(sab, off, n);
  off += n * 4;
  const lightIntensity = new Float32Array(sab, off, n);
  off += n * 4;
  const sqrtLightIntensity = new Float32Array(sab, off, n);
  return {
    count,
    id,
    particleCount,
    firstIndex,
    lastIndex,
    viscousScale,
    x,
    y,
    vx,
    vy,
    angularVelocity,
    angle,
    lightIntensity,
    sqrtLightIntensity,
    maxGroups: n,
  };
}
