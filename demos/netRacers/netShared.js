// netShared.js - what the lobby and the race share, and what crosses to workers.
//
// Main thread: one Network for the whole visit (it survives scene loads), the
// players and the car list the host announced. Workers: three SharedResources,
// each with one writer, the main thread:
//   NetSession  which car this browser drives / follows
//   NetInput    (host) the input state of every remote player, by slot
//   NetPose     (client) the latest pose of every replicated entity, by netId
//
// Nothing here touches the DOM at import time: workers import the scene file, and
// the scene file imports this one.

import WEED from '/src/index.js';

const { SharedResource, Network, Keyboard } = WEED;

export const MAX_PLAYERS = 4;
/** Replicated entities: player cars + parked cars. */
export const MAX_NET_IDS = 64;

/** Input bits (one byte per player). */
export const INPUT = Object.freeze({ UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, BRAKE: 16 });
/** Game message type for input: [16][u32 seq][u8 bits]. */
export const MSG_INPUT = 16;

/** WASD / arrows → INPUT bits. Works on the main thread and in workers (Keyboard is shared). */
export function readKeyboardBits() {
  let bits = 0;
  if (Keyboard.w || Keyboard.arrowup) bits |= INPUT.UP;
  if (Keyboard.s || Keyboard.arrowdown) bits |= INPUT.DOWN;
  if (Keyboard.a || Keyboard.arrowleft) bits |= INPUT.LEFT;
  if (Keyboard.d || Keyboard.arrowright) bits |= INPUT.RIGHT;
  return bits;
}

/** INPUT bits → Car.applyForces(forward, turn) arguments. */
export function bitsToForward(bits) {
  return (bits & INPUT.UP ? 1 : 0) - (bits & INPUT.DOWN ? 1 : 0);
}

export function bitsToTurn(bits) {
  return (bits & INPUT.RIGHT ? 1 : 0) - (bits & INPUT.LEFT ? 1 : 0);
}

/** Car sprites, in the order the lobby offers them, with the colour its chip shows. */
export const CAR_SKINS = [
  { sprite: 'car_police', label: 'Police', color: '#3d6fd8' },
  { sprite: 'red_car', label: 'Red', color: '#e04848' },
  { sprite: 'yellow_car', label: 'Yellow', color: '#f2c230' },
  { sprite: 'blue_car', label: 'Blue', color: '#3aa6e8' },
  { sprite: 'white_car', label: 'White', color: '#e8e8e8' },
  { sprite: 'black_car', label: 'Black', color: '#3a3a3a' },
];

export const CAR_SPRITESHEETS = {
  red_car: { json: '/demos/img/cars/red.json', png: '/demos/img/cars/red.png' },
  yellow_car: { json: '/demos/img/cars/yellow.json', png: '/demos/img/cars/yellow.png' },
  black_car: { json: '/demos/img/cars/black.json', png: '/demos/img/cars/black.png' },
  white_car: { json: '/demos/img/cars/white.json', png: '/demos/img/cars/white.png' },
  blue_car: { json: '/demos/img/cars/blue.json', png: '/demos/img/cars/blue.png' },
  car_police: { json: '/demos/img/cars/poli.json', png: '/demos/img/cars/poli.png' },
};

export const ROADS_TILEMAP = {
  json: '/demos/map_n_flowfield/tilemap2.json',
  png: '/demos/img/tilemap/2.png',
};

/**
 * Firebase project used by the `networking` branch's demo (Realtime Database, signaling only).
 * The web API key identifies the project; it is not a secret. What protects the database is its
 * rules: see docs/internal/NETWORKING_PLAN.md (NET-60). Replace with your own project to ship.
 */
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyA2PW7pAnTSrutVDYabtwL7Q3JB2Mir3Pw',
  authDomain: 'webrtc-5c119.firebaseapp.com',
  databaseURL: 'https://webrtc-5c119-default-rtdb.firebaseio.com',
  projectId: 'webrtc-5c119',
  storageBucket: 'webrtc-5c119.firebasestorage.app',
  messagingSenderId: '334466186648',
  appId: '1:334466186648:web:10429db094bf249c203fed',
};

// -----------------------------------------------------------------------------
// SharedResources (bound in every thread that imports the race scene)
// -----------------------------------------------------------------------------

/** Written by the main thread once, in preload. */
export class NetSession extends SharedResource {}
NetSession.schema = {
  /** 1 host, 2 client */
  role: { type: Uint8Array, length: 1 },
  /** netId of the car this browser drives (camera follows it) */
  localNetId: { type: Int16Array, length: 1 },
};

/** Host only: written by the main thread when an input packet arrives, read by NetCar.tick. */
export class NetInput extends SharedResource {}
NetInput.schema = {
  bits: { type: Uint8Array, length: MAX_PLAYERS },
};

/** Client only: written by the main thread per snapshot, read by PuppetCar.tick. */
export class NetPose extends SharedResource {}
NetPose.schema = {
  x: { type: Float32Array, length: MAX_NET_IDS },
  y: { type: Float32Array, length: MAX_NET_IDS },
  rotation: { type: Float32Array, length: MAX_NET_IDS },
  vx: { type: Float32Array, length: MAX_NET_IDS },
  vy: { type: Float32Array, length: MAX_NET_IDS },
  angularVelocity: { type: Float32Array, length: MAX_NET_IDS },
  /** netNow() when the pose arrived; 0 = never */
  time: { type: Float64Array, length: MAX_NET_IDS },
};

export const ROLE = Object.freeze({ NONE: 0, HOST: 1, CLIENT: 2 });

// -----------------------------------------------------------------------------
// The session (main thread)
// -----------------------------------------------------------------------------

/**
 * One per page. `players` is the host's list: [{ id, name, skin, slot, isHost, rtt }].
 * `race` is the last 'start' message (seed, entities) while a race runs.
 */
export const session = {
  /** @type {InstanceType<typeof Network>|null} */
  net: null,
  signaling: 'firebase',
  name: '',
  skin: 0,
  players: [],
  race: null,
  /** Called by the scene that owns the screen when the network does something it shows. */
  onChange: null,
};

/** A Network for the chosen signaling, replacing (and closing) an old one. */
export async function openNetwork(signaling) {
  await closeNetwork();
  session.signaling = signaling;
  session.net = new Network(
    signaling === 'local'
      ? { signaling: 'local' }
      : { signaling: 'firebase', firebase: FIREBASE_CONFIG }
  );
  return session.net;
}

export async function closeNetwork() {
  const net = session.net;
  session.net = null;
  session.players = [];
  session.race = null;
  if (net) await net.destroy().catch(() => {});
}

export function playerBySlot(slot) {
  return session.players.find((p) => p.slot === slot) || null;
}

export function me() {
  const net = session.net;
  return net ? session.players.find((p) => p.id === net.myId) || null : null;
}

/** Persisted name and car (per browser). */
export function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem('netRacers.prefs') || '{}');
    if (typeof raw.name === 'string') session.name = raw.name.slice(0, 16);
    if (Number.isInteger(raw.skin) && raw.skin >= 0 && raw.skin < CAR_SKINS.length)
      session.skin = raw.skin;
    if (raw.signaling === 'local' || raw.signaling === 'firebase')
      session.signaling = raw.signaling;
  } catch {
    // private mode, blocked storage: defaults are fine
  }
}

export function savePrefs() {
  try {
    localStorage.setItem(
      'netRacers.prefs',
      JSON.stringify({ name: session.name, skin: session.skin, signaling: session.signaling })
    );
  } catch {
    // ignore
  }
}

/** Small seeded generator (mulberry32) so host and clients place the same rocks. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
