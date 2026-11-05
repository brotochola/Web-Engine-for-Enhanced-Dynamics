// Leaf module: LightEmitter imports it, and utils.js (which imports GameObject)
// re-exports it, so the component does not pull in the GameObject graph.

/** World radius = sqrtIntensity * this. Used by lighting + shadow culls. */
export const LIGHT_INFLUENCE_RADIUS_SCALE = 10;

/** World-space light influence radius for LIGHTING / CASTED_SHADOWS culls. */
export function lightInfluenceRadius(sqrtIntensity) {
  return (sqrtIntensity || 0) * LIGHT_INFLUENCE_RADIUS_SCALE;
}

/** Smallest accepted config.lighting.groundScaleY (a floor seen almost edge-on). */
export const GROUND_SCALE_Y_MIN = 0.05;

/**
 * config.lighting.groundScaleY, validated: the floor's vertical foreshortening on screen, in
 * [GROUND_SCALE_Y_MIN, 1]. Anything that is not a positive number gives 1 (round light pools).
 * Light falloff measures the floor distance sqrt(dx² + (dy / groundScaleY)²), so a pool's
 * on-screen extent is R wide and R * groundScaleY tall; R (and every cull built on it) is unchanged.
 * @param {unknown} value
 * @returns {number}
 */
export function resolveGroundScaleY(value) {
  const v = +value;
  if (!(v > 0)) return 1;
  if (v > 1) return 1;
  return v < GROUND_SCALE_Y_MIN ? GROUND_SCALE_Y_MIN : v;
}
