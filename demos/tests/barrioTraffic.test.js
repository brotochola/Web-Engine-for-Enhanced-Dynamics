import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import {
  LIGHT, LIGHT_CYCLE_S, lightPhase, speedLimitKmh, crossingZone, crossingIdOf, ZONE, worldToFloorMetres,
  floorToWorldDirection, metresPerWorldPx, trafficCodeAt, stoppingDistance, speedToStopWithin, safeSpeedForPerson,
  mustStopDead, COMFORT_BRAKE_MS2, EMERGENCY_BRAKE_MS2, SAFETY_GAP_M, MIN_GAP_M, offsetInCarFrame, comesFromTheRight,
  angleBetween, nearestExit, chooseExit, readyToExit, exitTarget,
} from '../buenosAiresScene/traffic.js';
import { META } from './fixtures/barrioMini/meta.js';

// The traffic rules of the Buenos Aires demo (demos/buenosAiresScene/traffic.js): pure functions the cars, the traffic
// lights and the people share.

const near = (actual, expected, message, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not ${expected}`);

/** The editor's old camera (sheared: north shifts K east on the screen) and the barrio's now (no shear): the rules hold for both. */
const SHEARED = { SF: 18, K: 0.16, SYN: 0.5, MH: 950 };
const UNSHEARED = { SF: 18, K: 0, SYN: 0.5, MH: 45 };

test("a crossing's two streets are never green together, and each gets 17 s green, 3 amber, 20 red", () => {
  const seconds = { 0: [0, 0, 0], 1: [0, 0, 0] };
  for (let tenth = 0; tenth < LIGHT_CYCLE_S * 10; tenth++) {
    const t = tenth / 10;
    const first = lightPhase(t, 0, 0);
    const second = lightPhase(t, 0, 1);
    assert.ok(!(first === LIGHT.GREEN && second === LIGHT.GREEN), `both green at ${t} s`);
    assert.ok(first === LIGHT.RED || second === LIGHT.RED, `neither red at ${t} s`);
    seconds[0][first] += 0.1;
    seconds[1][second] += 0.1;
  }
  for (const street of [0, 1]) {
    near(seconds[street][LIGHT.GREEN], 17, `street ${street} green`, 1e-6);
    near(seconds[street][LIGHT.AMBER], 3, `street ${street} amber`, 1e-6);
    near(seconds[street][LIGHT.RED], 20, `street ${street} red`, 1e-6);
  }
  assert.equal(lightPhase(0, 0, 0), LIGHT.GREEN);
  assert.equal(lightPhase(18, 0, 0), LIGHT.AMBER);
  assert.equal(lightPhase(25, 0, 1), LIGHT.GREEN);
  assert.equal(lightPhase(38, 0, 1), LIGHT.AMBER);
  // A crossing's offset shifts its cycle; any clock, negative too, lands in it.
  assert.equal(lightPhase(5, 15, 0), LIGHT.RED);
  assert.equal(lightPhase(-30, 0, 0), lightPhase(10, 0, 0));
});

test('a traffic cell code holds the speed limit, the zone and the crossing', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(speedLimitKmh), [40, 20, 30, 40, 60]);
  const beforeCrossing7 = 2 | (ZONE.BEFORE_CROSSING << 4) | ((7 + 1) << 6);
  assert.equal(speedLimitKmh(beforeCrossing7), 30);
  assert.equal(crossingZone(beforeCrossing7), ZONE.BEFORE_CROSSING);
  assert.equal(crossingIdOf(beforeCrossing7), 7);
  assert.equal(crossingIdOf(3), -1, 'open road');
  assert.equal(crossingZone(3), ZONE.OPEN_ROAD);
});

test('the projection: world px to floor metres and back, with a shear and without', () => {
  for (const geometry of [SHEARED, UNSHEARED]) {
    const floor = worldToFloorMetres(geometry, 500, 300, { x: 0, y: 0 });
    // Back to the world: x = SF·(east + K·north), y = (MH − north)·SF·SYN.
    near(geometry.SF * (floor.x + geometry.K * floor.y), 500, 'x');
    near((geometry.MH - floor.y) * geometry.SF * geometry.SYN, 300, 'y');
    const north = floorToWorldDirection(geometry, 0, 1, { x: 0, y: 0 });
    near(north.x, geometry.K, 'north shifts K east on the screen');
    near(north.y, -geometry.SYN, 'north is up the screen, SYN as tall');
    near(metresPerWorldPx(geometry, 1, 0), 1 / geometry.SF, 'a px across');
  }
  near(metresPerWorldPx(UNSHEARED, 0, -1), 1 / (UNSHEARED.SF * UNSHEARED.SYN), 'a px up the screen, without a shear');
});

test("the traffic grid's cell under a world point", () => {
  const bytes = gunzipSync(readFileSync(new URL('./fixtures/barrioMini/transito.bin.gz', import.meta.url)));
  const grid = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const { W, H } = META.transito;
  // The cell 1 m east, 1 m north of the grid's corner: world x = SF·1.5, y = (MH − 1.5)·SF·SYN.
  const worldY = (north) => (META.MH - north) * META.SF * META.SYN;
  const code = trafficCodeAt(grid, W, H, META, META.SF * 1.5, worldY(1.5));
  assert.equal(code, 3 | (ZONE.IN_CROSSING << 4) | (1 << 6));
  assert.equal(crossingIdOf(code), 0);
  assert.equal(trafficCodeAt(grid, W, H, META, META.SF * 3.5, worldY(0.5)), 4, 'an avenue cell');
  assert.equal(trafficCodeAt(grid, W, H, META, -5, worldY(0.5)), 0, 'off the grid');
  assert.equal(trafficCodeAt(grid, 0, 0, META, 10, 10), 0, 'no grid');
});

test('stopping: the distance for a speed and the speed for a distance agree', () => {
  for (const speed of [0, 2, 8.3, 11.1, 16.7]) {
    near(speedToStopWithin(stoppingDistance(speed, COMFORT_BRAKE_MS2), COMFORT_BRAKE_MS2), speed, `${speed} m/s`, 1e-9);
  }
  near(stoppingDistance(10, 5, 1), 10 + 10, 'a second of reaction, then 10 m of braking');
  assert.equal(speedToStopWithin(-1, COMFORT_BRAKE_MS2), 0);
});

test('a car never runs into a person: it keeps a speed it can stop from, or it stops dead', () => {
  for (let gap = 0; gap <= 30; gap += 0.25) {
    assert.ok(mustStopDead(Math.min(gap, MIN_GAP_M), 0), 'within MIN_GAP_M nothing moves');
    for (let speed = 0; speed <= 16; speed += 0.25) {
      if (mustStopDead(gap, speed)) continue;
      // Not stopped dead: full braking still stops it short of the person.
      assert.ok(stoppingDistance(speed, EMERGENCY_BRAKE_MS2) < gap - MIN_GAP_M, `${speed} m/s, ${gap} m`);
      // Moving at a speed the person allows, a comfortable braking stops it SAFETY_GAP_M short of them.
      const allowed = safeSpeedForPerson(gap);
      if (speed > 0 && speed <= allowed) assert.ok(stoppingDistance(speed, COMFORT_BRAKE_MS2) <= gap - SAFETY_GAP_M + 1e-9, `${speed} m/s, ${gap} m`);
    }
  }
  assert.equal(safeSpeedForPerson(SAFETY_GAP_M), 0, 'that near, it may not move');
  assert.ok(safeSpeedForPerson(20) > safeSpeedForPerson(10), 'the nearer the person, the slower');
});

test("a point in the car's frame: how far ahead, how far to its right", () => {
  const east = offsetInCarFrame(10, 5, 1, 0, { ahead: 0, side: 0 });
  assert.equal(east.ahead, 10);
  assert.equal(east.side, 5, 'on the screen, y down, south is the right of a car heading east');
  const north = offsetInCarFrame(5, -10, 0, -1, { ahead: 0, side: 0 });
  assert.equal(north.ahead, 10);
  assert.equal(north.side, 5, 'east is the right of a car heading north');
});

test('art. 41: a car crossing from the right goes first', () => {
  // This car heads east; south of it (y down) is its right.
  assert.ok(comesFromTheRight(1, 0, 0, -1, 10, 20), 'heading north, from the south: from the right');
  assert.ok(!comesFromTheRight(1, 0, 0, 1, 10, -20), 'heading south, from the north: from the left');
  assert.ok(!comesFromTheRight(1, 0, 1, 0, 10, 20), 'heading the same way: not crossing');
  assert.ok(!comesFromTheRight(1, 0, -1, 0, 10, 20), 'heading towards it: not crossing');
});

test('the roundabout: a car leaves by another street than the one it came by, and heads for that exit lane', () => {
  near(angleBetween(0.1, -0.1), -0.2, 'angles across 0');
  near(angleBetween(3, -3), 2 * Math.PI - 6, 'angles across π');
  const exits = [[1, 0, 1.3], [0, 1, 1.3], [-1, 0, 1.3], [0, -1, 1.3]];
  assert.equal(nearestExit(exits, 1.5), 1);
  const taken = new Set();
  for (let draw = 0; draw < 100; draw++) taken.add(chooseExit(exits, 1.5, draw / 100));
  assert.deepEqual([...taken].sort(), [0, 2, 3], 'every street but the one it came by');
  assert.ok(readyToExit(1, 0.5), 'half a radian before its exit');
  assert.ok(!readyToExit(1, 0), 'a radian before');
  assert.ok(readyToExit(1, 1.2), 'just past it');
  assert.ok(!readyToExit(1, 1.3), 'too far past it');
  const target = exitTarget({ mx: 10, my: 20, re: 15 }, [1, 0, 1.3], { x: 0, y: 0 });
  near(target.x, 33, '8 m out of the road along the exit street');
  near(target.y, 18.7, 'in its lane: 1.3 m to the right (south) of the street heading east');
});
