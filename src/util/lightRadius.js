// Leaf module: LightEmitter imports it, and utils.js (which imports GameObject)
// re-exports it, so the component does not pull in the GameObject graph.

/** World radius = sqrtIntensity * this. Used by lighting + shadow culls. */
export const LIGHT_INFLUENCE_RADIUS_SCALE = 10;

/** World-space light influence radius for LIGHTING / CASTED_SHADOWS culls. */
export function lightInfluenceRadius(sqrtIntensity) {
  return (sqrtIntensity || 0) * LIGHT_INFLUENCE_RADIUS_SCALE;
}
