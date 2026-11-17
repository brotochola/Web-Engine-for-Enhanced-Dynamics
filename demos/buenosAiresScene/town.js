// What every part of the demo shares: the package's numbers, the page's parameters, the switches the panel sets for the
// workers, the traffic data, the components the barrio's entities read of each other, and the lights that come on with
// the hour.

import WEED from '/src/index.js';
import { META } from './barrio/meta.js';
import { checkPackageMeta } from './barrioLoader.js';

const { Component, SharedResource, LightEmitter, Sun } = WEED;

// Every thread imports this file: each checks the package before anything reads it.
checkPackageMeta(META, '/demos/buenosAiresScene/barrio/meta.js');

export { META };

/** Where the package is: what the Editor de Barrios exports for one barrio (Parque Chas). */
export const BARRIO = '/demos/buenosAiresScene/barrio/';

/** The page's parameters, the same on every thread. */
const PARAMS = WEED.params || new URLSearchParams('');

/** A number from the page's parameters, or `fallback`. */
export function param(key, fallback) {
  const raw = PARAMS.get(key);
  const value = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** The editor's view: SF px a floor metre across, a metre of height rises CZ·SF px on the screen. */
export const HEIGHT_PX_PER_M = META.CZ * META.SF;
/**
 * World px a metre of the editor's radii covers (its colliders: radius in m × PXM): between a metre across (SF px) and a
 * metre deep (SF·SYN px), as the editor measures them.
 */
export const PX_PER_M = META.PXM || (META.SF * (1 + META.SYN)) / 2;

/** Warm city light, about 3000 K: lamps, posts and the lit glass of a lamp. */
export const LAMP_COLOR = 0xffdcaa;
export const HEADLIGHT_COLOR = 0xfff0d0;

// ---- the panel's switches ----

/** The panel's switches, read by the workers: 1 turns a thing off, so all start at what the barrio does by itself. */
export class TownSwitches extends SharedResource {}
export const OFF = Object.freeze({ LAMPS: 0, HEADLIGHTS: 1, CARS: 2, PEOPLE: 3 });
export const TOWN_SWITCHES = [TownSwitches, { off: { type: Int32Array, length: 4, mailbox: true } }];
export const isOff = (which) => TownSwitches.off.load(which) === 1;

// ---- the traffic data (transito.bin.gz and the crossings) ----

/** The editor's traffic data: the grid (1 m cells, see traffic.js) and its crossings. */
export const TRAFFIC = META.transito || { W: 0, H: 0, n: 0, nSem: 0 };
/** Numbers a crossing has in Traffic.crossings: x, y (world px), lights (1) or not (0), its first street's heading x, y, offset (s). */
export const CROSSING_STRIDE = 6;

/**
 * The traffic data in shared memory: every logic worker reads it, the scene writes it once in preload. `grid` is
 * transito.bin as it comes (Uint16 a cell); `crossings` holds CROSSING_STRIDE numbers a crossing.
 */
export class Traffic extends SharedResource {}
export const TRAFFIC_RESOURCE = [Traffic, {
  grid: { type: Uint16Array, length: Math.max(1, (TRAFFIC.W | 0) * (TRAFFIC.H | 0)) },
  crossings: { type: Float32Array, length: Math.max(CROSSING_STRIDE, (TRAFFIC.n | 0) * CROSSING_STRIDE) },
}];

/** The barrio's roundabout (Parque Chas has one), or null. */
export const ROUNDABOUT = (META.rotondas && META.rotondas[0]) || null;

// ---- what the entities read of each other ----

/** A person's state. `person` marks one for the cars, which count every person in their lane. */
export class PersonaState extends Component {
  static ARRAY_SCHEMA = {
    person: Uint8Array,
    field: Uint8Array, // the flowfield it follows (WALK_FIELDS)
    walking: Uint8Array, // 1 walking, 0 resting
    timer: Float32Array, // seconds left of this walk or this rest
    walkSpeed: Float32Array, // px/s
  };
}

/**
 * A car's state, in components so that any logic worker sees it (an entity's tick moves between workers). `car` marks
 * one for the people and the other cars; halfLength and halfWidth are its collider on the screen, rebuilt as it turns.
 */
export class AutoState extends Component {
  static ARRAY_SCHEMA = {
    car: Uint8Array,
    drives: Uint8Array, // 1 driving (its AI runs), 0 parked
    police: Uint8Array,
    driveForce: Float32Array,
    lateralGrip: Float32Array, // how hard the tyres take out its sideways speed
    turnTorque: Float32Array,
    minSteerSpeed: Float32Array, // under this speed (px/s) it does not steer
    minSteerFactor: Float32Array, // the share of its turn it gets at that speed, all of it at maxSteerSpeed
    maxSteerSpeed: Float32Array,
    halfLength: Float32Array, // its collider on the screen, px
    halfWidth: Float32Array,
    floorHalfLength: Float32Array, // its footprint on its pictures' floor (18 px a metre), px
    floorHalfWidth: Float32Array,
    headlights: Uint8Array, // 1: it has headlights
    lightsOn: Uint8Array, // its headlights (or its beacon's cones) are on: 2 before the first decision
    darkness: Float32Array, // its lights come on when Sun.intensity drops under this (each car its own)
    rightHeadlight: Int32Array, // its right headlight, a LuzAuto child: entity index + 1, 0 for none
    beaconLeft: Int32Array, // the police beacon's cones, LuzAuto children: entity index + 1
    beaconRight: Int32Array,
    beaconDotLeft: Int32Array, // its coloured dots and their halos, attached decorations: pool index + 1
    beaconDotRight: Int32Array,
    beaconHaloLeft: Int32Array,
    beaconHaloRight: Int32Array,
    beaconRedLeft: Uint8Array, // which side is red now: 1 left, 0 right, 2 not drawn yet
    beaconHeight: Float32Array, // the light bar's height above the floor, px of height
    beaconPhase: Float32Array, // seconds its blinking is shifted, so police cars do not blink together
    homeX: Float32Array, // where it started: a car stuck off screen goes back there
    homeY: Float32Array,
    homeRotation: Float32Array,
    laneX: Float32Array, // the last lane direction it read from the flowfield
    laneY: Float32Array,
    stuckTime: Float32Array, // seconds under 10 px/s
    stoppedTime: Float32Array,
    ignoreCarsTime: Float32Array, // seconds left ignoring other cars (two cars that wait for each other)
    pace: Float32Array, // the share of the speed limit it drives at: 0.8 to 0.97, nobody speeds
    waitedForRight: Float32Array, // seconds it has given way to a car on its right
    roundaboutExit: Int8Array, // the roundabout exit it takes, -1 out of the roundabout
    haltTime: Float32Array, // seconds it stays stopped after touching a person
  };
}

// ---- lights by the hour ----

/**
 * When a light is on: it comes on between 18 and 19 h and goes off between 6 and 7, each light at its own minute. By day
 * the lamps are off, or their light would add to the sun's and wash out the shadows around them. `radius` is its reach
 * when on; `lit` 1 on, 0 off, 2 not decided yet; `kind` which switch of the panel turns it off (OFF.LAMPS).
 */
export class LightHours extends Component {
  static ARRAY_SCHEMA = { on: Float32Array, off: Float32Array, radius: Float32Array, lit: Uint8Array, kind: Uint8Array };
}

/** How often a lamp looks at the hour, in frames: with an 8-minute day a frame is a fifth of a game minute. */
export const LIGHT_TICK = 30;

const _hours = [0, 0];

/** A light's minutes to come on and go off, from where it stands: the same on every thread and from one run to the next. */
function hoursAt(x, y, out) {
  const a = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  const b = Math.sin(x * 39.346 + y * 11.135) * 24634.6345;
  out[0] = 18 + (a - Math.floor(a));
  out[1] = 6 + (b - Math.floor(b));
  return out;
}

/** After its LightEmitter is set: from here on the light follows the hour (lightTick). */
export function lightBorn(entity, kind, x, y) {
  const index = entity.index;
  hoursAt(x, y, _hours);
  LightHours.on[index] = _hours[0];
  LightHours.off[index] = _hours[1];
  LightHours.radius[index] = LightEmitter.radius[index];
  LightHours.lit[index] = 2;
  LightHours.kind[index] = kind;
}

/** Whether a light that follows the hour should be on now. */
export function lightWanted(index) {
  if (!(LightHours.radius[index] > 0)) return false;
  const hour = Sun.hour;
  return !isOff(LightHours.kind[index]) && (hour >= LightHours.on[index] || hour < LightHours.off[index]);
}

/**
 * Turn a light that follows the hour on or off when its time comes. Returns 1 when it has just come on, -1 when it has
 * just gone off, 0 when nothing changed (the entity changes its picture, if it has a lit one).
 */
export function lightTick(entity) {
  const index = entity.index;
  if (!(LightHours.radius[index] > 0)) return 0;
  const lit = lightWanted(index) ? 1 : 0;
  if (lit === LightHours.lit[index]) return 0;
  LightHours.lit[index] = lit;
  LightEmitter.active[index] = lit;
  LightEmitter.radius[index] = lit ? LightHours.radius[index] : 0;
  return lit ? 1 : -1;
}
