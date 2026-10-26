// track.js - where things go on the roads tilemap, the same on every peer.
//
// The main road of /demos/map_n_flowfield/tilemap2.json runs east from x ≈ 7300 with
// its centre near y ≈ 1650 (24 px tiles). The race starts on it, heading east.

import { MAX_PLAYERS, CAR_SKINS, seeded } from './netShared.js';

export const ROAD_Y = 1650;
export const START_X = 7700;
export const PARKED_COUNT = 12;
export const ROCK_COUNT = 36;
/** netIds 0..MAX_PLAYERS-1 are player cars (netId = slot); parked cars follow. */
export const FIRST_PARKED_NET_ID = MAX_PLAYERS;

/** Grid start: two rows, players side by side. */
export function startPose(slot) {
  return { x: START_X - (slot >> 1) * 170, y: ROAD_Y - 70 + (slot & 1) * 140, rotation: 0 };
}

/**
 * Everything the host announces in 'start': player cars and parked cars, with net ids.
 * @param {number} seed
 * @param {Array<{ slot: number, skin: number }>} players
 */
export function buildRace(seed, players) {
  const rand = seeded(seed);
  const entities = [];
  for (const p of players) {
    const pose = startPose(p.slot);
    entities.push({
      kind: 'player',
      netId: p.slot,
      slot: p.slot,
      sprite: (CAR_SKINS[p.skin] || CAR_SKINS[0]).sprite,
      ...pose,
    });
  }
  const sprites = ['red_car', 'yellow_car', 'black_car', 'white_car', 'blue_car'];
  for (let k = 0; k < PARKED_COUNT; k++) {
    entities.push({
      kind: 'parked',
      netId: FIRST_PARKED_NET_ID + k,
      slot: -1,
      sprite: sprites[Math.floor(rand() * sprites.length)],
      x: START_X + 700 + k * 330 + rand() * 120,
      y: ROAD_Y + (rand() * 2 - 1) * 150,
      rotation: (rand() * 2 - 1) * 0.6 + (rand() < 0.3 ? Math.PI : 0),
    });
  }
  return entities;
}

/** Rocks along the road's edges, a few on it. Both sides call this with the race seed. */
export function buildRocks(seed) {
  const rand = seeded(seed ^ 0x5bd1e995);
  const rocks = [];
  for (let k = 0; k < ROCK_COUNT; k++) {
    const onRoad = rand() < 0.25;
    const side = rand() < 0.5 ? -1 : 1;
    rocks.push({
      x: START_X + 500 + rand() * 4800,
      y: onRoad ? ROAD_Y + (rand() * 2 - 1) * 120 : ROAD_Y + side * (260 + rand() * 260),
      sprite: `rock${1 + Math.floor(rand() * 4)}`,
      scale: 0.8 + rand() * 0.6,
      flip: rand() < 0.5,
    });
  }
  return rocks;
}
