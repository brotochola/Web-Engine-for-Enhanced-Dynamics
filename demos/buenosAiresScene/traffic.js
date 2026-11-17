// traffic.js: the rules the barrio's cars and people keep, as pure functions (no engine), so they can be read and tested
// on their own. The Editor de Barrios' game (conurbanoScene.js) kept them inline; the law they follow is Argentina's
// Ley Nacional de Tránsito 24.449 and the Código de Tránsito y Transporte of Buenos Aires.
//
// Two coordinate systems meet here. The world is the oblique projection's screen: SF px a floor metre across, the floor
// drawn SYN as tall as it is wide, and each metre north also shifts K metres east on the screen (`geometry` is the
// package's META: SF, K, SYN, MH). The editor's data (the traffic grid, the roundabout) is in floor metres, x east and
// y north.

/** A traffic light's cycle (the game's): each street of a crossing gets 17 s of green, 3 of amber and 20 of red. */
export const LIGHT_CYCLE_S = 40;
export const GREEN_S = 17;
export const AMBER_S = 3;
export const LIGHT = Object.freeze({ GREEN: 0, AMBER: 1, RED: 2 });

/**
 * The light one street of a crossing shows at `seconds` (any clock all threads share: the lights drawn and the cars that
 * stop read the same one). Street 0, the crossing's first, is green from 0 to 17 s of the cycle, amber to 20 and red to
 * 40; street 1 is red while street 0 is green or amber, then green from 20 to 37 and amber to 40. So the two streets are
 * never open together. `offset` shifts each crossing's cycle, so the lights of a barrio do not all change at once.
 */
export function lightPhase(seconds, offset, street) {
  const t = (((seconds + offset) % LIGHT_CYCLE_S) + LIGHT_CYCLE_S) % LIGHT_CYCLE_S;
  if (street === 0) return t < GREEN_S ? LIGHT.GREEN : t < GREEN_S + AMBER_S ? LIGHT.AMBER : LIGHT.RED;
  const otherOpens = GREEN_S + AMBER_S;
  return t < otherOpens ? LIGHT.RED : t < otherOpens + GREEN_S ? LIGHT.GREEN : LIGHT.AMBER;
}

/**
 * Speed limits by the traffic grid's code (Ley 24.449, art. 51, and the city's code): 1 dirt streets and passages
 * 20 km/h, 2 the last metres before a crossing without lights 30, 3 streets 40, 4 avenues 60. 0 (no data) reads 40.
 */
export const SPEED_LIMIT_KMH = Object.freeze([40, 20, 30, 40, 60]);

/** Where a grid cell is with respect to a crossing (bits 4-5 of its code). */
export const ZONE = Object.freeze({ OPEN_ROAD: 0, BEFORE_CROSSING: 1, IN_CROSSING: 2 });

/** A traffic grid cell's speed limit, km/h (bits 0-3 of its code). */
export function speedLimitKmh(code) {
  return SPEED_LIMIT_KMH[code & 15] ?? SPEED_LIMIT_KMH[0];
}

/** A traffic grid cell's zone (ZONE): the 7 m before a crossing's zebra, the crossing itself, or neither. */
export function crossingZone(code) {
  return (code >> 4) & 3;
}

/** The crossing a traffic grid cell belongs to (bits 6-15 hold its id + 1), -1 for none. */
export function crossingIdOf(code) {
  return (code >> 6) - 1;
}

/** The floor metres (x east, y north) under a world point; `out` receives them, and is returned. */
export function worldToFloorMetres(geometry, worldX, worldY, out) {
  const north = geometry.MH - worldY / (geometry.SYN * geometry.SF);
  out.x = worldX / geometry.SF - geometry.K * north;
  out.y = north;
  return out;
}

/** A direction in floor metres (dx east, dy north) as a world direction (not normalised); `out` receives it. */
export function floorToWorldDirection(geometry, dx, dy, out) {
  out.x = dx + geometry.K * dy;
  out.y = -geometry.SYN * dy;
  return out;
}

/** Floor metres one world px covers along a world heading (headingX, headingY), a unit vector: x and y are not alike. */
export function metresPerWorldPx(geometry, headingX, headingY) {
  const east = headingX / geometry.SF + (geometry.K * headingY) / (geometry.SYN * geometry.SF);
  const north = -headingY / (geometry.SYN * geometry.SF);
  return Math.sqrt(east * east + north * north);
}

/** The code of the traffic grid's cell (1 m) under a world point, 0 off the grid. */
export function trafficCodeAt(grid, gridWidth, gridHeight, geometry, worldX, worldY) {
  if (!gridWidth) return 0;
  const north = geometry.MH - worldY / (geometry.SYN * geometry.SF);
  const east = worldX / geometry.SF - geometry.K * north;
  if (east < 0 || north < 0 || east >= gridWidth || north >= gridHeight) return 0;
  return grid[(north | 0) * gridWidth + (east | 0)];
}

// ---- braking ----

/** A braking every driver accepts, m/s². */
export const COMFORT_BRAKE_MS2 = 3.5;
/** Full braking on dry asphalt, m/s² (the editor's own knob for its cars, `freno`). */
export const EMERGENCY_BRAKE_MS2 = 8;
/** How far short of a person a car means to stop, metres. */
export const SAFETY_GAP_M = 1.5;
/** Closer than this to a person, a car does not move at all, metres. */
export const MIN_GAP_M = 0.6;

/** Metres a car at `speed` m/s needs to stop braking at `deceleration` m/s², after `reactionS` seconds at full speed. */
export function stoppingDistance(speed, deceleration, reactionS = 0) {
  return speed * reactionS + (speed * speed) / (2 * deceleration);
}

/** The highest speed (m/s) from which braking at `deceleration` stops a car within `gapMetres`: √(2·a·d). */
export function speedToStopWithin(gapMetres, deceleration) {
  return gapMetres > 0 ? Math.sqrt(2 * deceleration * gapMetres) : 0;
}

/**
 * The highest speed (m/s) a car may keep with a person `gapMetres` ahead of its bumper: one from which a comfortable
 * braking still stops it SAFETY_GAP_M short of them. The nearer the person, the slower the car; 0 when already that near.
 */
export function safeSpeedForPerson(gapMetres) {
  return speedToStopWithin(gapMetres - SAFETY_GAP_M, COMFORT_BRAKE_MS2);
}

/**
 * Whether a car at `speed` m/s must stop dead now for a person `gapMetres` ahead: it is closer than MIN_GAP_M, or even
 * full braking would carry it past MIN_GAP_M short of them. The demo then stops it in the frame (never hit a person).
 */
export function mustStopDead(gapMetres, speed) {
  return gapMetres <= MIN_GAP_M || stoppingDistance(speed, EMERGENCY_BRAKE_MS2) >= gapMetres - MIN_GAP_M;
}

/**
 * How far ahead of a car's centre a point is, along its heading (headingX, headingY, a unit vector), and how far to its
 * side (positive: to its right, which on the screen, y down, is (−headingY, headingX)). `out` receives { ahead, side }.
 */
export function offsetInCarFrame(dx, dy, headingX, headingY, out) {
  out.ahead = dx * headingX + dy * headingY;
  out.side = headingX * dy - headingY * dx;
  return out;
}

// ---- right of way ----

/**
 * Right of way at a crossing without lights (Ley 24.449, art. 41: the vehicle coming from the right goes first): whether
 * another car, `dx`, `dy` from this one and heading (otherX, otherY), crosses this car's path (their headings are more
 * than 60° apart) coming from its right.
 */
export function comesFromTheRight(headingX, headingY, otherX, otherY, dx, dy) {
  const crossing = Math.abs(headingX * otherX + headingY * otherY) <= 0.5;
  const fromTheRight = dx * -headingY + dy * headingX > 0;
  return crossing && fromTheRight;
}

/** After waiting this long for the car on its right, a car goes anyway: if every car waits for its right, none moves. */
export const RIGHT_OF_WAY_PATIENCE_S = 4;

// ---- the roundabout (Parque Chas has one; META.rotondas) ----

const TURN = Math.PI * 2;

/** The angle from `from` to `to`, in (−π, π]. */
export function angleBetween(from, to) {
  return ((((to - from) % TURN) + TURN + Math.PI) % TURN) - Math.PI;
}

/** The exit (index into the roundabout's `sal`: each street's direction out, floor metres) nearest an angle about its centre. */
export function nearestExit(exits, angle) {
  let nearest = 0;
  let smallest = Infinity;
  for (let exit = 0; exit < exits.length; exit++) {
    const gap = Math.abs(angleBetween(Math.atan2(exits[exit][1], exits[exit][0]), angle));
    if (gap < smallest) {
      smallest = gap;
      nearest = exit;
    }
  }
  return nearest;
}

/** The exit a car entering at `angle` takes: any street but the one it came by. `random` is in [0, 1). */
export function chooseExit(exits, angle, random) {
  if (exits.length < 2) return 0;
  const entry = nearestExit(exits, angle);
  return (entry + 1 + Math.floor(random * (exits.length - 1))) % exits.length;
}

/**
 * Whether a car going round (counter-clockwise: the right hand, as the editor's flowfield turns) at `carAngle` is close
 * enough to its exit at `exitAngle` to leave for it: within 0.7 rad ahead of it, or up to 0.25 rad past it.
 */
export function readyToExit(exitAngle, carAngle) {
  const ahead = (((exitAngle - carAngle) % TURN) + TURN) % TURN;
  return ahead < 0.7 || ahead > TURN - 0.25;
}

/**
 * Where a car leaving by `exit` heads for, floor metres: 8 m out along the exit street from the roundabout's road, in its
 * exit lane (the exit's lane offset to the right of the street's direction). `out` receives { x, y }.
 */
export function exitTarget(roundabout, exit, out) {
  const [dirX, dirY, laneOffset] = exit;
  const reach = roundabout.re + 8;
  out.x = roundabout.mx + dirX * reach + dirY * laneOffset;
  out.y = roundabout.my + dirY * reach - dirX * laneOffset;
  return out;
}
