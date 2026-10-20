// Steering sign for the little-city AI. No engine imports, so Node can test it.
//
// Convention (Car.applyForces): a positive turnInput adds positive angular
// acceleration, so the heading f = (cos θ, sin θ) rotates toward (-fy, fx), the side
// where cross(f, v) = fx*vy - fy*vx is positive. Road-seek uses that sign to turn
// toward a target. Avoidance has to use the opposite one.

/**
 * Turn sign that steers heading (fx, fy) away from an offset (dx, dy).
 * Dead ahead (cross 0) turns negative.
 * @returns {number} -1 or 1
 */
export function avoidTurnSign(fx, fy, dx, dy) {
  return fx * dy - fy * dx >= 0 ? -1 : 1;
}
