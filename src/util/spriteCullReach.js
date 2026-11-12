/**
 * N-140. The half extent the cull pads the view with around a sprite's pose: the sprite's reach from its anchor to its
 * farthest corner, so any rotation or flip stays inside. halfW and halfH are half the drawn size
 * (SpriteRenderer.boundsHalfW/H), not a reach from the pose: a sprite anchored at its foot, the default (0.5, 1),
 * reaches its whole height above its pose, and padding with half of it lost houses and trees whose tops were still on
 * screen. A sprite without bounds pads with its collider's visual range. wasm/preRenderCollect.c's
 * half_extent computes the same, in double from the float32 columns.
 */
export function spriteCullReach(halfW, halfH, anchorX, anchorY, visualRange) {
  const w = halfW > 0 ? halfW : 0;
  const h = halfH > 0 ? halfH : 0;
  if (w === 0 && h === 0) return visualRange > 0 ? visualRange : 0;
  const ax = anchorX === anchorX ? anchorX : 0.5;
  const ay = anchorY === anchorY ? anchorY : 0.5;
  const mx = ax > 1 - ax ? ax : 1 - ax;
  const my = ay > 1 - ay ? ay : 1 - ay;
  const rx = 2 * w * mx;
  const ry = 2 * h * my;
  return Math.sqrt(rx * rx + ry * ry);
}
