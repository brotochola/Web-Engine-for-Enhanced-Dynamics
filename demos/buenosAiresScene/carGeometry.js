// The cars' geometry: from their pictures' floor to the screen. Pure functions (no engine), so the node tests run them.

/**
 * The standard cars are drawn with the standard art's camera (the LPC people's and the light bench's): the floor 0.736 as
 * tall as it is wide, a px of height rising 0.752 px. Their footprints and light bars are measured in those pictures,
 * whatever the scene's camera (the engine fits their height maps to it: DX-MAPCAMERA).
 */
export const PICTURE_FLOOR_SCALE = 0.7364193217154872;
export const PICTURE_HEIGHT_SCALE = 0.7516549042792687;

/**
 * A car's footprint (2·floorHalfLength × 2·floorHalfWidth px on its pictures' floor, turned θ) shows on the screen as a
 * parallelogram along the screen heading φ, with tan θ = tan φ / S (S the pictures' floor scale): 2·a·√(cos²θ + S²·sin²θ)
 * long, with the same area.
 * Its collider is a box of that length and area (Box2D works on the screen), rebuilt when the car changes frame.
 */
export function screenFootprint(floorHalfLength, floorHalfWidth, cos, sin, out) {
  const theta = Math.atan2(Math.abs(sin) / PICTURE_FLOOR_SCALE, Math.abs(cos));
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const length = 2 * floorHalfLength * Math.sqrt(cosTheta * cosTheta + PICTURE_FLOOR_SCALE * PICTURE_FLOOR_SCALE * sinTheta * sinTheta);
  out.length = length;
  out.width = (4 * floorHalfLength * floorHalfWidth * PICTURE_FLOOR_SCALE) / length;
  return out;
}

/**
 * Where a car's picture draws a point of it (`ahead` of its centre and `side` to its right, px on its pictures' floor,
 * `height` px over it): screen px from its centre, the car drawn at the screen heading `angle`. The pictures' floor is
 * flattened, so a car's front is not square to its heading on the screen: at 35° its front runs 17° off square.
 */
export function pointOnScreen(angle, ahead, side, height, out) {
  const theta = Math.atan2(Math.sin(angle) / PICTURE_FLOOR_SCALE, Math.cos(angle));
  out.x = ahead * Math.cos(theta) - side * Math.sin(theta);
  out.y = PICTURE_FLOOR_SCALE * (ahead * Math.sin(theta) + side * Math.cos(theta)) - PICTURE_HEIGHT_SCALE * height;
  return out;
}

/** A screen offset (in place) in the frame of an entity turned by (cos, sin): what its rotation turns back into it. */
export function turnBack(point, cos, sin) {
  const { x, y } = point;
  point.x = x * cos + y * sin;
  point.y = y * cos - x * sin;
  return point;
}

/** How much of a car's front faces the camera, drawn at the screen heading `angle`: 1 seen, 0 hidden behind the car. */
export function frontSeen(angle) {
  const towardsCamera = Math.sin(Math.atan2(Math.sin(angle) / PICTURE_FLOOR_SCALE, Math.cos(angle)));
  return Math.max(0, Math.min(1, (towardsCamera + 0.25) / 0.3));
}
