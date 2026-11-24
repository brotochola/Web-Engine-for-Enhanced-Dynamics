// The barrio's cars: Box2D bodies drawn with the demos' standard MinZiin sheets (DirectionalSprite picks the frame from
// the rotation; each sheet's json says which heading each frame shows and mirrors the other half) and their height maps,
// with two cone headlights that come on as the light goes, and the police cars' beacon. AutoIA drives the Editor de
// Barrios' lanes (the `calles` flowfield) and keeps the traffic law (traffic.js); AutoEstacionado stays where it was put.

import WEED from '/src/index.js';
import { CARS } from '../img/autos/index.js';
import { PICTURE_FLOOR_SCALE, PICTURE_HEIGHT_SCALE, floorPointInCarFrame, screenFootprint } from './carGeometry.js';
import { POLICE_SHEET } from './carModels.js';
import { PERSON_RADIUS } from './walkers.js';
import {
  META, HEADLIGHT_COLOR, OFF, isOff, TRAFFIC, CROSSING_STRIDE, ROUNDABOUT, Traffic, AutoState, PersonaState,
} from './town.js';
import {
  LIGHT, ZONE, RIGHT_OF_WAY_PATIENCE_S, EMERGENCY_BRAKE_MS2, lightPhase, speedLimitKmh, crossingZone, crossingIdOf,
  trafficCodeAt, metresPerWorldPx, worldToFloorMetres, floorToWorldDirection, offsetInCarFrame, comesFromTheRight,
  safeSpeedForPerson, mustStopDead, chooseExit, readyToExit, exitTarget,
} from './traffic.js';

const {
  GameObject, RigidBody, Collider, CollisionListener, DirectionalSprite, LightEmitter, ShadowCaster, NavGrid, Transform,
  DecorationComponent, Sun, enums, rng, dot2,
} = WEED;
const { ShapeType } = enums;

const DEG = Math.PI / 180;

// Headlights: two cones from the front corners of the footprint, where its picture draws them (HEADLIGHT_SIDE of its half
// width out), measured on the floor. They reach about 65 m (900 px; half the light 6.7 m out), each 44° wide, fading over the outer half of each side,
// at 0.7 brightness (where they meet, ahead, they add up). The car's own LightEmitter is the left one; the right one is
// a LuzAuto child (Transform.parent), which follows the car with no code a frame.
const HEADLIGHT_RADIUS = 900;
const HEADLIGHT_CONE = 44 * DEG;
const HEADLIGHT_SOFTNESS = 0.5;
const HEADLIGHT_BRIGHTNESS = 0.7;
const HEADLIGHT_SIDE = 0.62;
/** The shadows its headlights cast reach 160 px: cheaper than the whole beam. */
const HEADLIGHT_SHADOW_RANGE = 160;
/**
 * How high the headlights are, px of height: about 0.65 m (the pictures' 18 px a metre). A light on the floor (elevation
 * 0) casts nothing into the lamp shadow map, so without a height the headlights cast no shadows of people, cars or posts.
 */
const HEADLIGHT_HEIGHT = 12;
/** Each car's lights come on when Sun.intensity drops under its own threshold, drawn in this range: not all at once. */
const DARKNESS_MIN = 0.25;
const DARKNESS_SPREAD = 0.3;

// The police beacon (the owner's ask to the game, 13/11: red and blue on its roof, pointing to the sides, alternating):
// a cone to each side from the side of its footprint, red on one side and blue on the other, swapped every
// BEACON_PERIOD_S; a coloured dot on each end of the light bar (seen by day) and its halo (seen at night). The cones
// light only at night (by day their light would wash out the sun's shadows) and cast no shadows (cheaper). 120° wide,
// 420 px, 1.5 bright (at 1, coloured light on dark asphalt hardly showed), from the light bar's height.
const BEACON_RADIUS = 420;
const BEACON_CONE = 120 * DEG;
const BEACON_SOFTNESS = 0.6;
const BEACON_BRIGHTNESS = 1.5;
const BEACON_PERIOD_S = 0.3;
const BEACON_RED = 0xff2a2a;
const BEACON_BLUE = 0x2f5bff;

// The driving.
/** The neighbours a driving car reads reach this far (px): enough to see a person at the stopping distance of 30 km/h. */
const DRIVER_VISUAL_RANGE = 220;
/** Half a lane beyond the car's own half width and the person's radius, px: on the open road, and at a corner. */
const LANE_MARGIN_PX = 4;
const CORNER_MARGIN_PX = 16;
/** A person is also counted where they will be this soon (s): someone stepping in from the kerb. */
const PERSON_LOOKAHEAD_S = 0.6;
/** After touching a person anyway, a car stays still this long (s). */
const HALT_AFTER_TOUCH_S = 1.5;
/** Slower than this (px/s) the car counts as stopped. */
const STOPPED_SPEED = 10;

/** Where to look for a lane when the car is off one: round it, nearest first (world px). */
const LANE_PROBES = [
  [0, 0], [0, 8], [0, -8], [16, 0], [-16, 0], [0, 16], [0, -16], [24, 0], [-24, 0], [24, 12], [24, -12], [-24, 12],
  [-24, -12], [0, 24], [0, -24], [48, 0], [-48, 0], [36, 24], [-36, 24], [36, -24], [-36, -24],
];

// Scratch objects for the per-frame code: it allocates nothing.
const _footprint = { length: 0, width: 0 };
const _lamp = { x: 0, y: 0 };
const _heading = { frontX: 0, frontY: 0, rightX: 0, rightY: 0 };
const _otherHeading = { frontX: 0, frontY: 0, rightX: 0, rightY: 0 };
const _lane = { x: 0, y: 0 };
const _floor = { x: 0, y: 0 };
const _target = { x: 0, y: 0 };
const _offset = { ahead: 0, side: 0 };
const _offsetSoon = { ahead: 0, side: 0 };
const _steer = { value: 0 };

/** A headlight's cone: forward (direction 0 is where its entity faces), off until the car turns it on. */
function aimHeadlight(light) {
  light.color = HEADLIGHT_COLOR;
  light.glow = 0;
  light.radius = 0;
  light.brightness = HEADLIGHT_BRIGHTNESS;
  light.elevation = HEADLIGHT_HEIGHT;
  light.shadowRange = HEADLIGHT_SHADOW_RANGE;
  light.coneAngle = HEADLIGHT_CONE;
  light.coneSoftness = HEADLIGHT_SOFTNESS;
  light.direction = 0;
  light.active = 0;
}

/** A beacon cone: to the side its LuzAuto is turned to, from the light bar's height, without shadows. */
function aimBeacon(light, barHeight) {
  light.color = BEACON_RED;
  light.glow = 0;
  light.radius = 0;
  light.brightness = BEACON_BRIGHTNESS;
  light.elevation = barHeight;
  light.castShadows = 0;
  light.coneAngle = BEACON_CONE;
  light.coneSoftness = BEACON_SOFTNESS;
  light.direction = 0;
  light.active = 0;
}

/** Turn a light on (at its radius) or off. `index` -1 is no light. */
function switchLight(index, on, radius) {
  if (index < 0) return;
  LightEmitter.active[index] = on;
  LightEmitter.radius[index] = on ? radius : 0;
}

/**
 * A light that hangs from a car (Transform.parent: physics places it with the car every frame): the right headlight,
 * or one side of the police beacon (`beacon` 1, `barHeight`, `turn` its rotation from the car's heading, ±90°).
 */
export class LuzAuto extends GameObject {
  static components = [LightEmitter];

  onSpawned(config = {}) {
    if (config.beacon) aimBeacon(this.lightEmitter, config.barHeight || 0);
    else aimHeadlight(this.lightEmitter);
    this.transform.localRotation = config.turn || 0;
  }
}

/** A car: its sheet, its body, its lights. Parked or driving (AutoIA). */
export class Auto extends GameObject {
  static deriveSpeed = true;
  static components = [RigidBody, Collider, CollisionListener, DirectionalSprite, ShadowCaster, LightEmitter, AutoState];

  onSpawned(config = {}) {
    const sheet = Object.prototype.hasOwnProperty.call(CARS, config.sheet) ? config.sheet : 'hatch_rojo';
    const state = this.autoState;
    state.car = 1;
    state.drives = config.drives ? 1 : 0;
    state.police = sheet === POLICE_SHEET ? 1 : 0;
    state.haltTime = 0;
    this.showSheet(sheet);
    this.setBody(sheet, config);
    this.setLights(sheet);
  }

  onDespawned() {
    this.autoState.car = 0;
  }

  /** Its sheet: the frame the rotation picks, anchored at the car's centre on the floor (the same point in every frame). */
  showSheet(sheet) {
    this.setSpritesheet(sheet);
    const anchor = CARS[sheet].anchor;
    this.spriteRenderer.anchorX = anchor[0];
    this.spriteRenderer.anchorY = anchor[1];
    this.directionalSprite.facingFrom = 'rotation';
    this.setAnimation('drive');
  }

  /** Its body: a box of its footprint as the screen shows it at its heading; static when parked. */
  setBody(sheet, config) {
    const state = this.autoState;
    const box = CARS[sheet].box;
    state.floorHalfLength = (box[1] - box[0]) / 2;
    state.floorHalfWidth = (box[3] - box[2]) / 2;
    const rotation = config.rotation || 0;
    screenFootprint(state.floorHalfLength, state.floorHalfWidth, Math.cos(rotation), Math.sin(rotation), _footprint);
    state.halfLength = _footprint.length / 2;
    state.halfWidth = _footprint.width / 2;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = _footprint.length;
    this.collider.height = _footprint.width;
    this.collider.radius = 0;
    this.collider.friction = 0.3;
    this.collider.visualRange = state.drives ? DRIVER_VISUAL_RANGE : 0;
    this.rigidBody.static = state.drives ? 0 : 1;
    this.rigidBody.linearDamping = 1;
    this.rigidBody.angularDamping = 3;
    this.setFixedRotation(0);
    this.rotation = rotation;
  }

  /** Its lights: headlights when it drives, the beacon when it is a police car; each comes on at its own darkness. */
  setLights(sheet) {
    const state = this.autoState;
    state.lightsOn = 2;
    state.darkness = DARKNESS_MIN + rng() * DARKNESS_SPREAD;
    state.headlights = state.drives;
    state.rightHeadlight = 0;
    state.beaconLeft = 0;
    state.beaconRight = 0;
    state.beaconDotLeft = 0;
    state.beaconDotRight = 0;
    state.beaconHaloLeft = 0;
    state.beaconHaloRight = 0;
    const light = this.lightEmitter;
    if (state.headlights) {
      aimHeadlight(light);
      const out = state.floorHalfWidth * HEADLIGHT_SIDE;
      floorPointInCarFrame(this.rotation, state.floorHalfLength, -out, _lamp);
      light.offsetX = _lamp.x;
      light.offsetY = _lamp.y;
      floorPointInCarFrame(this.rotation, state.floorHalfLength, out, _lamp);
      state.rightHeadlight = this.hangLight(_lamp.x, _lamp.y, 0, null);
    } else {
      light.radius = 0;
      light.active = 0;
    }
    if (state.police) this.mountBeacon(sheet);
    this.updateLights();
  }

  /** A LuzAuto hung from the car at (localX, localY) of its frame: its index + 1, 0 when the pool is full. */
  hangLight(localX, localY, turn, barHeight) {
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    const light = LuzAuto.spawn({
      x: this.x + cos * localX - sin * localY,
      y: this.y + sin * localX + cos * localY,
      parent: this.index,
      localX,
      localY,
      turn,
      beacon: barHeight === null ? 0 : 1,
      barHeight: barHeight || 0,
    });
    return light ? light.index + 1 : 0;
  }

  /** The police beacon: a cone to each side (LuzAuto children turned ±90°), a dot and a halo on each end of the bar. */
  mountBeacon(sheet) {
    const state = this.autoState;
    const barHeight = CARS[sheet].zmax; // the light bar's top, px of height (the pictures' 18 px a metre, as the barrio)
    state.beaconHeight = barHeight;
    state.beaconPhase = rng() * 10;
    state.beaconRedLeft = 2;
    floorPointInCarFrame(this.rotation, 0, -state.floorHalfWidth, _lamp);
    state.beaconLeft = this.hangLight(_lamp.x, _lamp.y, -Math.PI / 2, barHeight);
    floorPointInCarFrame(this.rotation, 0, state.floorHalfWidth, _lamp);
    state.beaconRight = this.hangLight(_lamp.x, _lamp.y, Math.PI / 2, barHeight);
    // Hung unturned (inheritParentRotation false): their offsets are the screen's, set each frame from the car's heading.
    const dot = { tint: BEACON_RED, alpha: 1, anchorX: 0.5, anchorY: 0.5, inheritParentRotation: false };
    const halo = { ...dot, layer: 'glows' };
    state.beaconDotLeft = this.addDecoration('_whiteCircle', 0, 0, 0.36, 0.36, 2, dot) + 1;
    state.beaconDotRight = this.addDecoration('_whiteCircle', 0, 0, 0.36, 0.36, 2, { ...dot, tint: BEACON_BLUE }) + 1;
    state.beaconHaloLeft = this.addDecoration('_lightGradient', 0, 0, 0.3, 0.3, 1, halo) + 1;
    state.beaconHaloRight = this.addDecoration('_lightGradient', 0, 0, 0.3, 0.3, 1, { ...halo, tint: BEACON_BLUE }) + 1;
    this.placeBeaconDots();
  }

  /**
   * A new frame (DirectionalSprite drew the one nearest the heading): the collider to the footprint at the heading it
   * shows, the headlights on the front corners, the beacon's cones on the sides.
   */
  onDirectionChanged() {
    const index = this.index;
    const angle = this.directionalSprite.directionAngle;
    if (!Number.isFinite(angle)) return;
    screenFootprint(AutoState.floorHalfLength[index], AutoState.floorHalfWidth[index], Math.cos(angle), Math.sin(angle), _footprint);
    const halfLength = _footprint.length / 2;
    const halfWidth = _footprint.width / 2;
    if (Math.abs(halfLength - AutoState.halfLength[index]) > 0.25 || Math.abs(halfWidth - AutoState.halfWidth[index]) > 0.25) {
      this.collider.width = _footprint.length;
      this.collider.height = _footprint.width;
      AutoState.halfLength[index] = halfLength;
      AutoState.halfWidth[index] = halfWidth;
    }
    const floorHalfLength = AutoState.floorHalfLength[index];
    const floorHalfWidth = AutoState.floorHalfWidth[index];
    if (AutoState.headlights[index]) {
      floorPointInCarFrame(angle, floorHalfLength, -floorHalfWidth * HEADLIGHT_SIDE, _lamp);
      LightEmitter.offsetX[index] = _lamp.x;
      LightEmitter.offsetY[index] = _lamp.y;
      floorPointInCarFrame(angle, floorHalfLength, floorHalfWidth * HEADLIGHT_SIDE, _lamp);
      setLocalOffset(AutoState.rightHeadlight[index] - 1, _lamp.x, _lamp.y);
    }
    if (AutoState.police[index]) {
      floorPointInCarFrame(angle, 0, -floorHalfWidth, _lamp);
      setLocalOffset(AutoState.beaconLeft[index] - 1, _lamp.x, _lamp.y);
      floorPointInCarFrame(angle, 0, floorHalfWidth, _lamp);
      setLocalOffset(AutoState.beaconRight[index] - 1, _lamp.x, _lamp.y);
      this.placeBeaconDots();
    }
  }

  tick() {
    const index = this.index;
    if (!Transform.active[index]) return;
    this.updateLights();
    if (AutoState.police[index]) this.blinkBeacon();
  }

  /** Lights on when it gets dark enough for this car (and the panel leaves them on), off when the light comes back. */
  updateLights() {
    const index = this.index;
    const wanted = Sun.intensity < AutoState.darkness[index] && !isOff(OFF.HEADLIGHTS) ? 1 : 0;
    if (wanted === AutoState.lightsOn[index]) return;
    AutoState.lightsOn[index] = wanted;
    if (AutoState.headlights[index]) {
      switchLight(index, wanted, HEADLIGHT_RADIUS);
      switchLight(AutoState.rightHeadlight[index] - 1, wanted, HEADLIGHT_RADIUS);
    }
    switchLight(AutoState.beaconLeft[index] - 1, wanted, BEACON_RADIUS);
    switchLight(AutoState.beaconRight[index] - 1, wanted, BEACON_RADIUS);
  }

  /** The beacon: red and blue swap sides every BEACON_PERIOD_S. */
  blinkBeacon() {
    const index = this.index;
    const redLeft = Math.floor((performance.now() / 1000 + AutoState.beaconPhase[index]) / BEACON_PERIOD_S) % 2 === 0 ? 1 : 0;
    if (redLeft === AutoState.beaconRedLeft[index]) return;
    AutoState.beaconRedLeft[index] = redLeft;
    const leftColor = redLeft ? BEACON_RED : BEACON_BLUE;
    const rightColor = redLeft ? BEACON_BLUE : BEACON_RED;
    paintLight(AutoState.beaconLeft[index] - 1, leftColor);
    paintLight(AutoState.beaconRight[index] - 1, rightColor);
    paintDecoration(AutoState.beaconDotLeft[index] - 1, leftColor);
    paintDecoration(AutoState.beaconHaloLeft[index] - 1, leftColor);
    paintDecoration(AutoState.beaconDotRight[index] - 1, rightColor);
    paintDecoration(AutoState.beaconHaloRight[index] - 1, rightColor);
  }

  /**
   * The beacon's dots on the roof of the frame drawn: 40 % of the half width to each side of the car on its floor, and the
   * bar's height up the screen.
   */
  placeBeaconDots() {
    const index = this.index;
    const drawn = this.directionalSprite.directionAngle;
    const angle = Number.isFinite(drawn) ? drawn : this.rotation;
    const theta = Math.atan2(Math.sin(angle) / PICTURE_FLOOR_SCALE, Math.cos(angle));
    const side = AutoState.floorHalfWidth[index] * 0.4;
    const up = AutoState.beaconHeight[index] * PICTURE_HEIGHT_SCALE;
    // On the floor (y down) the left of the heading (cos, sin) is (sin, −cos).
    const leftX = side * Math.sin(theta);
    const leftY = -side * PICTURE_FLOOR_SCALE * Math.cos(theta);
    placeDecoration(AutoState.beaconDotLeft[index] - 1, leftX, leftY - up);
    placeDecoration(AutoState.beaconHaloLeft[index] - 1, leftX, leftY - up);
    placeDecoration(AutoState.beaconDotRight[index] - 1, -leftX, -leftY - up);
    placeDecoration(AutoState.beaconHaloRight[index] - 1, -leftX, -leftY - up);
  }
}

/** A child light's place in its car's frame (Transform.localX, localY: physics composes it with the car's pose). */
function setLocalOffset(index, localX, localY) {
  if (index < 0) return;
  Transform.localX[index] = localX;
  Transform.localY[index] = localY;
}

function paintLight(index, color) {
  if (index >= 0) LightEmitter.color[index] = color;
}

function paintDecoration(index, color) {
  if (index >= 0) DecorationComponent.tint[index] = color;
}

function placeDecoration(index, localX, localY) {
  if (index < 0) return;
  DecorationComponent.localX[index] = localX;
  DecorationComponent.localY[index] = localY;
}

/**
 * A parked car (or a wreck): a static body that listens to no collisions. It ticks every 4 frames, often enough for a
 * police car's beacon to swap its colours every 0.3 s.
 */
export class AutoEstacionado extends Auto {
  static tickInterval = 4;
  static components = [RigidBody, Collider, DirectionalSprite, ShadowCaster, LightEmitter, AutoState];
}

/** A car that drives the editor's lanes on the right hand and keeps the traffic law. */
export class AutoIA extends Auto {
  onSpawned(config = {}) {
    super.onSpawned({ ...config, drives: 1 });
    const state = this.autoState;
    const rotation = config.rotation || 0;
    state.driveForce = config.driveForce || 340;
    state.lateralGrip = 8;
    state.turnTorque = 10;
    state.minSteerSpeed = 8;
    state.minSteerFactor = 0.5;
    state.maxSteerSpeed = 140;
    state.homeX = config.x ?? this.x;
    state.homeY = config.y ?? this.y;
    state.homeRotation = rotation;
    state.laneX = Math.cos(rotation);
    state.laneY = Math.sin(rotation);
    state.stuckTime = 0;
    state.stoppedTime = 0;
    state.ignoreCarsTime = 0;
    state.pace = 0.8 + rng() * 0.17;
    state.waitedForRight = 0;
    state.roundaboutExit = -1;
  }

  tick(dtRatio, deltaTime) {
    super.tick();
    if (!Transform.active[this.index]) return;
    this.keepGrip();
    this.drive(dtRatio || 1, (deltaTime || 16) / 1000);
  }

  /** One frame of driving: follow the lane, obey the law, never hit a person, keep under the limit. */
  drive(dtRatio, seconds) {
    const index = this.index;
    if (isOff(OFF.CARS)) {
      this.brakeBy(Math.pow(0.86, dtRatio));
      return;
    }
    if (AutoState.haltTime[index] > 0) {
      AutoState.haltTime[index] -= seconds;
      this.stopDead();
      return;
    }
    if (!this.readLane()) return;
    this.followRoundabout();
    const laneLength = Math.sqrt(_lane.x * _lane.x + _lane.y * _lane.y);
    if (laneLength < 0.1) return;
    const headingX = this.forwardX;
    const headingY = this.forwardY;
    const laneX = _lane.x / laneLength;
    const laneY = _lane.y / laneLength;
    const cross = headingX * laneY - headingY * laneX;
    const alignment = headingX * laneX + headingY * laneY;
    // Steer towards the lane; off its heading, only creep forward, so it can turn.
    let turn = Math.max(-1, Math.min(1, cross * 2)) * 0.8;
    let forward = alignment > 0.15 ? 1 : RigidBody.speed[index] < 30 ? 0.25 : 0;
    this.countStuckTime(seconds);
    if (this.goHomeIfLost()) return;

    const metresPerPx = metresPerWorldPx(META, headingX, headingY);
    const speed = RigidBody.speed[index] * metresPerPx; // m/s
    const lookAhead = AutoState.halfLength[index] + 10;
    const code = trafficCodeAt(Traffic.grid, TRAFFIC.W | 0, TRAFFIC.H | 0, META, this.x + headingX * lookAhead, this.y + headingY * lookAhead);
    const zone = crossingZone(code);

    // People first: whatever else happens, the car never runs into someone in its lane.
    const allowedForPeople = this.speedAllowedByPeople(headingX, headingY, metresPerPx, speed, zone);
    if (allowedForPeople === 0) {
      this.stopDead();
      return;
    }
    // Then the cars ahead (the game's following: brake, and steer round a car that stands).
    const carBrake = AutoState.ignoreCarsTime[index] > 0 ? 0 : this.brakeForCarsAhead(headingX, headingY);
    if (carBrake > 0) {
      turn = Math.max(-1, Math.min(1, turn * (1 - carBrake * 0.6) + Math.max(-1, Math.min(1, _steer.value)) * 0.8));
      forward *= 1 - carBrake;
      if (carBrake > 0.6) this.brakeBy(1 - (carBrake - 0.6) * 0.25);
    }
    // The law at the crossing ahead, and the speed limit of the street (art. 51) at this driver's pace.
    const waits = zone === ZONE.BEFORE_CROSSING && this.mustWaitAtCrossing(crossingIdOf(code), headingX, headingY, metresPerPx, seconds);
    if (zone !== ZONE.BEFORE_CROSSING) AutoState.waitedForRight[index] = 0;
    const limit = (speedLimitKmh(code) / 3.6) * AutoState.pace[index];
    const target = Math.min(limit, allowedForPeople);
    if (waits) {
      forward = 0;
      this.brakeBy(Math.pow(0.86, dtRatio));
    } else if (speed > target) {
      forward = 0;
      // For a person it brakes as hard as it must; over the limit alone, gently (3 % a frame past 6 % over).
      if (allowedForPeople < limit) this.slowTowards(allowedForPeople, speed, EMERGENCY_BRAKE_MS2, seconds);
      else if (speed > limit * 1.06) this.brakeBy(Math.pow(0.97, dtRatio));
    } else {
      // Less throttle near the target speed, so it settles under it.
      forward *= Math.max(0.2, Math.min(1, (target - speed) / (target * 0.3)));
    }
    this.applyForces(forward, turn);
  }

  // ---- the lane ----

  /** The direction its lane runs (into _lane): the flowfield under it, or near it; off the map, back to its middle. */
  readLane() {
    const index = this.index;
    if (this.x < 0 || this.y < 0 || this.x > META.WW || this.y > META.WH) {
      _lane.x = META.WW / 2 - this.x;
      _lane.y = META.WH / 2 - this.y;
      return true;
    }
    if (this.findLaneNear(this.x, this.y)) {
      AutoState.laneX[index] = _lane.x;
      AutoState.laneY[index] = _lane.y;
      return true;
    }
    // No lane near: it keeps the last direction it read.
    _lane.x = AutoState.laneX[index];
    _lane.y = AutoState.laneY[index];
    return _lane.x * _lane.x + _lane.y * _lane.y >= 0.01;
  }

  /**
   * The lane under (x, y); off it (it cut a corner, climbed a kerb), the nearest one round it, with a push towards it, so
   * it goes back to the street instead of running along the sidewalk.
   */
  findLaneNear(x, y) {
    for (let probe = 0; probe < LANE_PROBES.length; probe++) {
      const offsetX = LANE_PROBES[probe][0];
      const offsetY = LANE_PROBES[probe][1];
      NavGrid.requestVectorFromStaticFlowfield('calles', x + offsetX, y + offsetY, _lane);
      if (_lane.x * _lane.x + _lane.y * _lane.y < 0.01) continue;
      if (probe > 0) {
        const offsetLength = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
        const laneLength = Math.sqrt(_lane.x * _lane.x + _lane.y * _lane.y);
        _lane.x = _lane.x / laneLength + (offsetX / offsetLength) * 1.3;
        _lane.y = _lane.y / laneLength + (offsetY / offsetLength) * 1.3;
      }
      return true;
    }
    return false;
  }

  /**
   * The roundabout (Parque Chas): the flowfield goes round it counter-clockwise (the right hand); entering, each car
   * picks the street it leaves by (not the one it came by) and, near that exit, heads for the street's exit lane.
   */
  followRoundabout() {
    if (ROUNDABOUT === null) return;
    const index = this.index;
    worldToFloorMetres(META, this.x, this.y, _floor);
    const dx = _floor.x - ROUNDABOUT.mx;
    const dy = _floor.y - ROUNDABOUT.my;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > ROUNDABOUT.re + 8) {
      AutoState.roundaboutExit[index] = -1;
      return;
    }
    if (distance >= ROUNDABOUT.re + 1) return;
    const exits = ROUNDABOUT.sal;
    const angle = Math.atan2(dy, dx);
    if (AutoState.roundaboutExit[index] < 0) AutoState.roundaboutExit[index] = chooseExit(exits, angle, rng());
    const exit = exits[AutoState.roundaboutExit[index]];
    if (!readyToExit(Math.atan2(exit[1], exit[0]), angle)) return;
    exitTarget(ROUNDABOUT, exit, _target);
    floorToWorldDirection(META, _target.x - _floor.x, _target.y - _floor.y, _lane);
  }

  /** Slower than STOPPED_SPEED for over 5 s (two cars waiting for each other): it ignores other cars for 3 s (never people). */
  countStuckTime(seconds) {
    const index = this.index;
    if (RigidBody.speed[index] < STOPPED_SPEED) {
      AutoState.stuckTime[index] += seconds;
      AutoState.stoppedTime[index] += seconds;
      if (AutoState.stuckTime[index] > 5) {
        AutoState.stuckTime[index] = 0;
        AutoState.ignoreCarsTime[index] = 3;
      }
    } else {
      AutoState.stuckTime[index] = 0;
      AutoState.stoppedTime[index] = 0;
    }
    if (AutoState.ignoreCarsTime[index] > 0) AutoState.ignoreCarsTime[index] -= seconds;
  }

  /** Stopped for over 12 s (into a lot, against a post) and off screen: back where it started, in its lane. */
  goHomeIfLost() {
    const index = this.index;
    if (AutoState.stoppedTime[index] <= 12 || this.isOnScreen) return false;
    AutoState.stoppedTime[index] = 0;
    this.x = AutoState.homeX[index];
    this.y = AutoState.homeY[index];
    this.rotation = AutoState.homeRotation[index];
    RigidBody.vx[index] = 0;
    RigidBody.vy[index] = 0;
    AutoState.laneX[index] = Math.cos(AutoState.homeRotation[index]);
    AutoState.laneY[index] = Math.sin(AutoState.homeRotation[index]);
    return true;
  }

  // ---- people ----

  /**
   * The highest speed (m/s) the people in its lane allow: Infinity for none, 0 when it must stop dead now. Every person
   * counts, standing or walking (the game braked only for walking people, and gently, so it could push someone who stood
   * or stepped in), where they are and where they will be in PERSON_LOOKAHEAD_S. The nearer one is, the slower the car
   * goes: from the speed it keeps it can still stop SAFETY_GAP_M short of them (traffic.js safeSpeedForPerson); when even
   * full braking would not, it stops dead (mustStopDead). At a corner the lane it watches is wider: people cross there.
   */
  speedAllowedByPeople(headingX, headingY, metresPerPx, speed, zone) {
    const index = this.index;
    const halfLength = AutoState.halfLength[index];
    const laneHalfWidth = AutoState.halfWidth[index] + PERSON_RADIUS + (zone === ZONE.OPEN_ROAD ? LANE_MARGIN_PX : CORNER_MARGIN_PX);
    let allowed = Infinity;
    for (let n = 0; n < this.neighborCount; n++) {
      const other = this.getNeighbor(n);
      if (PersonaState.person[other] !== 1 || !Transform.active[other]) continue;
      const ahead = this.personAheadInLane(other, headingX, headingY, halfLength, laneHalfWidth);
      if (ahead === Infinity) continue;
      const gapMetres = Math.max(0, ahead - halfLength - PERSON_RADIUS) * metresPerPx;
      if (mustStopDead(gapMetres, speed)) return 0;
      allowed = Math.min(allowed, safeSpeedForPerson(gapMetres));
    }
    return allowed;
  }

  /** How far ahead of its centre (px) a person is in its lane, now or soon; Infinity when neither (or behind the car). */
  personAheadInLane(other, headingX, headingY, halfLength, laneHalfWidth) {
    const dx = Transform.x[other] - this.x;
    const dy = Transform.y[other] - this.y;
    offsetInCarFrame(dx, dy, headingX, headingY, _offset);
    const soonX = dx + RigidBody.vx[other] * PERSON_LOOKAHEAD_S;
    const soonY = dy + RigidBody.vy[other] * PERSON_LOOKAHEAD_S;
    offsetInCarFrame(soonX, soonY, headingX, headingY, _offsetSoon);
    let ahead = Infinity;
    if (_offset.ahead > -halfLength && Math.abs(_offset.side) < laneHalfWidth) ahead = _offset.ahead;
    if (_offsetSoon.ahead > -halfLength && Math.abs(_offsetSoon.side) < laneHalfWidth) ahead = Math.min(ahead, _offsetSoon.ahead);
    return ahead;
  }

  /** A person touched it anyway (pushed by the crowd, out from behind a bus): it stops, and stays still a moment. */
  onCollisionEnter(other) {
    this.stopIfPerson(other);
  }

  onCollisionStay(other) {
    this.stopIfPerson(other);
  }

  stopIfPerson(other) {
    if (PersonaState.person[other] !== 1) return;
    AutoState.haltTime[this.index] = HALT_AFTER_TOUCH_S;
    this.stopDead();
  }

  // ---- other cars ----

  /**
   * How hard to brake (0 to 1) for the cars ahead in its lane, and which way to steer round one (into _steer). Its reach
   * and its lane grow with both cars' sizes (about 95 and 22 px for two small cars), so a bus keeps a bus's distance.
   */
  brakeForCarsAhead(headingX, headingY) {
    const index = this.index;
    const halfLength = AutoState.halfLength[index];
    const halfWidth = AutoState.halfWidth[index];
    let brake = 0;
    let steer = 0;
    for (let n = 0; n < this.neighborCount; n++) {
      const other = this.getNeighbor(n);
      if (other === index || AutoState.car[other] !== 1 || !Transform.active[other]) continue;
      // Where it will be in 0.2 s: a car pulling away needs less braking.
      const dx = Transform.x[other] + RigidBody.vx[other] * 0.2 - this.x;
      const dy = Transform.y[other] + RigidBody.vy[other] * 0.2 - this.y;
      offsetInCarFrame(dx, dy, headingX, headingY, _offset);
      const reach = halfLength + AutoState.halfLength[other] + 35;
      if (_offset.ahead <= 8 || _offset.ahead > reach) continue;
      const laneHalfWidth = halfWidth + AutoState.halfWidth[other] - 2;
      const sideways = Math.abs(_offset.side);
      if (sideways > laneHalfWidth) continue;
      const urgency = (1 - _offset.ahead / reach) * (0.4 + 0.6 * (1 - sideways / laneHalfWidth));
      if (urgency > brake) brake = urgency;
      steer += (_offset.side >= 0 ? -1 : 1) * urgency;
    }
    _steer.value = steer;
    return brake;
  }

  // ---- the crossing ahead ----

  /**
   * Whether it must stop before the zebra of the crossing ahead: its light is not green; or, at a crossing without
   * lights, a car comes from its right (art. 41); or the car ahead stands on the far side, and going on would leave it in
   * the middle of the crossing.
   */
  mustWaitAtCrossing(crossingId, headingX, headingY, metresPerPx, seconds) {
    if (crossingId < 0 || crossingId >= (TRAFFIC.n | 0)) return false;
    const base = crossingId * CROSSING_STRIDE;
    const crossings = Traffic.crossings;
    if (crossings[base + 2] > 0) {
      // Its street is the crossing's first (0) when it runs along that street's heading.
      const street = Math.abs(headingX * crossings[base + 3] + headingY * crossings[base + 4]) > 0.7 ? 0 : 1;
      if (lightPhase(Date.now() / 1000, crossings[base + 5], street) !== LIGHT.GREEN) return true;
    } else if (this.givesWayToTheRight(crossingId, headingX, headingY, seconds)) {
      return true;
    }
    return this.crossingBlockedAhead(headingX, headingY, metresPerPx);
  }

  /**
   * Art. 41 (the vehicle coming from the right goes first): whether a driving car comes from its right into this same
   * crossing, not yet past its middle. After RIGHT_OF_WAY_PATIENCE_S of waiting it goes anyway (if every car waited for
   * its right, a full crossing would never move).
   */
  givesWayToTheRight(crossingId, headingX, headingY, seconds) {
    const index = this.index;
    const crossingX = Traffic.crossings[crossingId * CROSSING_STRIDE];
    const crossingY = Traffic.crossings[crossingId * CROSSING_STRIDE + 1];
    let waits = false;
    for (let n = 0; n < this.neighborCount && !waits; n++) {
      const other = this.getNeighbor(n);
      if (other === index || AutoState.drives[other] !== 1 || !Transform.active[other]) continue;
      GameObject.getHeadingAxes(other, _otherHeading);
      const dx = Transform.x[other] - this.x;
      const dy = Transform.y[other] - this.y;
      if (!comesFromTheRight(headingX, headingY, _otherHeading.frontX, _otherHeading.frontY, dx, dy)) continue;
      const otherAhead = AutoState.halfLength[other] + 10;
      const otherCode = trafficCodeAt(
        Traffic.grid, TRAFFIC.W | 0, TRAFFIC.H | 0, META,
        Transform.x[other] + _otherHeading.frontX * otherAhead, Transform.y[other] + _otherHeading.frontY * otherAhead,
      );
      if (crossingIdOf(otherCode) !== crossingId || crossingZone(otherCode) === ZONE.OPEN_ROAD) continue;
      const pastTheMiddle = (crossingX - Transform.x[other]) * _otherHeading.frontX + (crossingY - Transform.y[other]) * _otherHeading.frontY < 0;
      if (!pastTheMiddle) waits = true;
    }
    if (!waits) {
      AutoState.waitedForRight[index] = 0;
      return false;
    }
    AutoState.waitedForRight[index] += seconds;
    return AutoState.waitedForRight[index] <= RIGHT_OF_WAY_PATIENCE_S;
  }

  /** Whether a driving car stands still in its lane just past the crossing (22 m ahead at most): then it waits before it. */
  crossingBlockedAhead(headingX, headingY, metresPerPx) {
    const index = this.index;
    const reach = 22 / metresPerPx;
    for (let n = 0; n < this.neighborCount; n++) {
      const other = this.getNeighbor(n);
      if (other === index || AutoState.drives[other] !== 1 || !Transform.active[other] || RigidBody.speed[other] > 12) continue;
      offsetInCarFrame(Transform.x[other] - this.x, Transform.y[other] - this.y, headingX, headingY, _offset);
      if (_offset.ahead < AutoState.halfLength[index] + 30 || _offset.ahead > reach) continue;
      if (Math.abs(_offset.side) < AutoState.halfWidth[index] + AutoState.halfWidth[other]) return true;
    }
    return false;
  }

  // ---- the body ----

  /** The tyres do not slide sideways: its sideways speed is taken out (lateralGrip a second). */
  keepGrip() {
    const index = this.index;
    GameObject.getHeadingAxes(index, _heading);
    const sideways = dot2(RigidBody.vx[index], RigidBody.vy[index], _heading.rightX, _heading.rightY);
    const grip = AutoState.lateralGrip[index];
    RigidBody.ax[index] -= _heading.rightX * sideways * grip;
    RigidBody.ay[index] -= _heading.rightY * sideways * grip;
  }

  /** Throttle (forward, −1 to 1) and steering (turn, −1 to 1): it steers less when slow, and not at all when stopped. */
  applyForces(forward, turn) {
    const index = this.index;
    GameObject.getHeadingAxes(index, _heading);
    const speedAlong = dot2(RigidBody.vx[index], RigidBody.vy[index], _heading.frontX, _heading.frontY);
    if (forward) {
      const push = AutoState.driveForce[index] * forward;
      RigidBody.ax[index] += _heading.frontX * push;
      RigidBody.ay[index] += _heading.frontY * push;
    }
    if (turn) {
      const speed = Math.abs(speedAlong);
      if (speed >= AutoState.minSteerSpeed[index]) {
        const least = AutoState.minSteerFactor[index];
        const steering = least + (1 - least) * Math.min(speed / AutoState.maxSteerSpeed[index], 1);
        RigidBody.angularAccel[index] += turn * AutoState.turnTorque[index] * steering * (speedAlong >= 0 ? 1 : -1);
      }
    }
    if (forward || turn) RigidBody.sleeping[index] = 0;
  }

  /** Its velocity times `factor` (a brake that keeps its direction). */
  brakeBy(factor) {
    RigidBody.vx[this.index] *= factor;
    RigidBody.vy[this.index] *= factor;
  }

  /** Brakes towards `target` m/s, losing at most `deceleration` m/s² this frame. */
  slowTowards(target, speed, deceleration, seconds) {
    if (!(speed > target) || speed <= 0) return;
    this.brakeBy(Math.max(target, speed - deceleration * seconds) / speed);
  }

  stopDead() {
    const index = this.index;
    RigidBody.vx[index] = 0;
    RigidBody.vy[index] = 0;
    RigidBody.angularVelocity[index] = 0;
  }
}
