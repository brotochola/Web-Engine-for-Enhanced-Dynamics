// Toy box bounce for Bunny Mark A/B/C. No gravity. No floor damp.
// World is the cached 1920×1080 box, not Camera.getViewportBounds().

export const TOY_WORLD_W = 1920;
export const TOY_WORLD_H = 1080;
export const TOY_HALF_SIZE = 8;
export const TOY_LEFT = TOY_HALF_SIZE;
export const TOY_RIGHT = TOY_WORLD_W - TOY_HALF_SIZE;
export const TOY_TOP = TOY_HALF_SIZE;
export const TOY_BOTTOM = TOY_WORLD_H - TOY_HALF_SIZE;

export function toyWorldBounce(
  xs,
  ys,
  vxs,
  vys,
  ids,
  count,
  dtRatio,
  left = TOY_LEFT,
  right = TOY_RIGHT,
  top = TOY_TOP,
  bottom = TOY_BOTTOM,
) {
  const n = count | 0;
  for (let k = 0; k < n; k++) {
    const i = ids[k];
    let vx = vxs[i];
    let vy = vys[i];
    let x = xs[i] + vx * dtRatio;
    let y = ys[i] + vy * dtRatio;

    if (x < left) {
      x = left;
      vx = -vx;
    } else if (x > right) {
      x = right;
      vx = -vx;
    }
    if (y < top) {
      y = top;
      vy = -vy;
    } else if (y > bottom) {
      y = bottom;
      vy = -vy;
    }

    xs[i] = x;
    ys[i] = y;
    vxs[i] = vx;
    vys[i] = vy;
  }
}

export function toyWorldBounceChecksum(xs, ys, vxs, vys, n) {
  let h = 2166136261;
  const bits = new Uint32Array(1);
  const f32 = new Float32Array(bits.buffer);
  const mix = (v) => {
    f32[0] = v;
    h ^= bits[0];
    h = Math.imul(h, 16777619) >>> 0;
  };
  const count = n | 0;
  for (let i = 0; i < count; i++) {
    mix(xs[i]);
    mix(ys[i]);
    mix(vxs[i]);
    mix(vys[i]);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
