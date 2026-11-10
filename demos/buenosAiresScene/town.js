// What every part of the demo shares: the barrio's numbers, the switches the panel sets for the workers, the components the
// town's entities read of each other, and the lights that come on with the hour.

import WEED from '/src/index.js';
import { META } from './barrio/meta.js';

const { Component, SharedResource, LightEmitter, Sun } = WEED;

export { META };

export const BARRIO = '/demos/buenosAiresScene/barrio/';

/** The page's parameters, the same on every thread. */
const PARAMS = WEED.params || new URLSearchParams('');
export function param(key, fallback) {
  const raw = PARAMS.get(key);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** ?faces=0: walls lit as the floor under them, the engine's lighting without lighting.faces. */
export const FACES = param('faces', 1) === 1;
/** ?raycast=1: lights stopped by the houses' footprints (lighting.raycasted); it turns faces off. */
export const RAYCAST = param('raycast', 0) === 1;

// The editor's view: SF px a floor metre across, the floor drawn SYN as tall as it is wide, a metre of height CZ·SF px up.
export const HEIGHT_PX = META.CZ * META.SF;

export const LAMP_COLOR = 0xffdcaa;
export const HEADLIGHT_COLOR = 0xfff0d0;
/** Lamps light from halfway up their pole (sourceHeight), so they are stronger, or their foot would be dark. */
export const LAMP_GAIN = 2.2;
/** A light's reach for the shadows it casts, and with ?raycast=1 for the houses that stop it. */
export const lightReach = (intensity) => (RAYCAST ? Math.ceil(10 * Math.sqrt(intensity)) : 0);

/** The panel's switches, read by the workers: 1 turns a thing off, so all start at what the barrio does by itself. */
export class TownSwitches extends SharedResource {}
export const OFF = Object.freeze({ LAMPS: 0, HEADLIGHTS: 1, CARS: 2, PEOPLE: 3 });
export const TOWN_SWITCHES = [TownSwitches, { off: { type: Int32Array, length: 4, mailbox: true } }];
export const isOff = (which) => TownSwitches.off.load(which) === 1;

/** A walker's state. `speed` above 0 marks a person for the cars, which wait for people instead of steering round them. */
export class WalkerState extends Component {
  static ARRAY_SCHEMA = { field: Uint8Array, still: Uint8Array, walking: Uint8Array, timer: Float32Array, speed: Float32Array, facing: Uint8Array };
}

/**
 * A car's state, in components so that any logic worker sees it. `active` marks a car for the people, `hl`/`hw` its half length
 * and width on the screen, `ha`/`hb` on the floor of its pictures.
 */
export class CarState extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, driveForce: Float32Array, lateralFriction: Float32Array, turnTorque: Float32Array, minSteerSpeed: Float32Array,
    minSteerFactor: Float32Array, maxSteerSpeed: Float32Array, lastKey: Int16Array, hl: Float32Array, hw: Float32Array, ha: Float32Array,
    hb: Float32Array, headlights: Uint8Array, laneX: Float32Array, laneY: Float32Array, stuck: Float32Array, free: Float32Array,
    stopped: Float32Array, startX: Float32Array, startY: Float32Array, startRot: Float32Array, pace: Float32Array,
  };
}

/**
 * When a light is on: it comes on between 18 and 19 h and goes off between 6 and 7, each light at its own minute. By day the
 * lights are off, or they would add to the sun and, since lighting clips at 1, wash out the shadows around them.
 * `glows` of the entity's first attached decorations are its glows; `alphaA` the even ones' alpha, `alphaB` the odd ones'.
 */
export class LightHours extends Component {
  static ARRAY_SCHEMA = { on: Float32Array, off: Float32Array, base: Float32Array, lit: Uint8Array, glows: Uint8Array, alphaA: Float32Array, alphaB: Float32Array, kind: Uint8Array };
}

/** How often a light looks at the hour, in frames: with an 8-minute day a frame is a fifth of a game minute. */
export const LIGHT_TICK = 30;

/** A light's minute, from where it is: the same on every thread, and from one run to the next. */
function hoursAt(x, y, out) {
  const a = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  const b = Math.sin(x * 39.346 + y * 11.135) * 24634.6345;
  out[0] = 18 + (a - Math.floor(a));
  out[1] = 6 + (b - Math.floor(b));
  return out;
}
const _hours = [0, 0];

/** After its LightEmitter is set: from here on the light follows the hour. `kind` is OFF.LAMPS or OFF.HEADLIGHTS. */
export function lightBorn(go, kind, glows, alphaA, alphaB, x, y) {
  const i = go.index;
  const L = LightHours;
  hoursAt(x, y, _hours);
  L.on[i] = _hours[0];
  L.off[i] = _hours[1];
  L.base[i] = LightEmitter.lightIntensity[i];
  L.lit[i] = 2;
  L.kind[i] = kind;
  L.glows[i] = glows;
  L.alphaA[i] = alphaA;
  L.alphaB[i] = alphaB;
  lightTick(go);
}

export function lightTick(go) {
  const i = go.index;
  const L = LightHours;
  if (!(L.base[i] > 0)) return;
  const h = Sun.hour;
  const lit = !isOff(L.kind[i]) && (h >= L.on[i] || h < L.off[i]) ? 1 : 0;
  if (lit === L.lit[i]) return;
  L.lit[i] = lit;
  LightEmitter.active[i] = lit;
  LightEmitter.lightIntensity[i] = lit ? L.base[i] : 0;
  const n = Math.min(L.glows[i], go.getAttachedDecorationCount());
  for (let q = 0; q < n; q++) {
    const d = go.getAttachedDecoration(q);
    if (d) d.alpha = lit ? (q & 1 ? L.alphaB[i] : L.alphaA[i]) : 0;
  }
}
