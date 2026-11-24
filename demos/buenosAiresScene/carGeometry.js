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
 * A point of a car's floor (`ahead` of its centre and `side` to its right, px on its pictures' floor) in the car's own frame
 * on the screen (x along its heading), the car drawn at the screen heading `angle`. The pictures' floor is flattened, so a
 * car's front is not square to its heading on the screen: at 35° its front runs 17° off square.
 */
export function floorPointInCarFrame(angle, ahead, side, out) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const theta = Math.atan2(sin / PICTURE_FLOOR_SCALE, cos);
  const screenX = ahead * Math.cos(theta) - side * Math.sin(theta);
  const screenY = PICTURE_FLOOR_SCALE * (ahead * Math.sin(theta) + side * Math.cos(theta));
  out.x = screenX * cos + screenY * sin;
  out.y = screenY * cos - screenX * sin;
  return out;
}
