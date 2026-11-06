// Where things stand on the street: world size and the road, a stadium the cars lap.

export const WORLD_W = 1800;
export const WORLD_H = 1100;

export const ROAD_CX = 900;
export const ROAD_CY = 590;
const HALF = 560; // half of each straight
const RADIUS = 190;
export const ROAD_WIDTH = 110;
export const LAP = 4 * HALF + 2 * Math.PI * RADIUS;

/**
 * Writes the point `s` px along the road and `side` px off its centre line (outwards) to `out`: x, y, heading.
 * Clockwise on screen: right along the top, down the right bend, left along the bottom, up the left bend.
 */
export function roadPoint(s, side, out) {
  let d = ((s % LAP) + LAP) % LAP;
  const straight = 2 * HALF;
  const bend = Math.PI * RADIUS;
  let angle; // of the outward normal
  let cx;
  if (d < straight) {
    out[0] = ROAD_CX - HALF + d;
    out[1] = ROAD_CY - RADIUS - side;
    out[2] = 0;
    return;
  }
  d -= straight;
  if (d < bend) {
    angle = -Math.PI / 2 + d / RADIUS;
    cx = ROAD_CX + HALF;
  } else {
    d -= bend;
    if (d < straight) {
      out[0] = ROAD_CX + HALF - d;
      out[1] = ROAD_CY + RADIUS + side;
      out[2] = Math.PI;
      return;
    }
    angle = Math.PI / 2 + (d - straight) / RADIUS;
    cx = ROAD_CX - HALF;
  }
  const r = RADIUS + side;
  out[0] = cx + Math.cos(angle) * r;
  out[1] = ROAD_CY + Math.sin(angle) * r;
  out[2] = angle + Math.PI / 2;
}
