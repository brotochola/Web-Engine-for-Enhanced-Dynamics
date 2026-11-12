// The cars: Box2D bodies (carScene's pattern), a drawn frame every 7.5 degrees of their heading on the screen, headlights that
// come on with the hour, and a VolumeShadowCaster box. DrivingCar follows the editor's lanes and brakes for cars and people
// ahead; buenos-aires also keeps the traffic law (lights, right of way, limits by street), which this demo does without.

import WEED from '/src/index.js';
import { CAR_MODELS } from './carModels.js';
import {
  META, RAYCAST, HEADLIGHT_COLOR, OFF, isOff, CarState, WalkerState, LightHours, lightBorn, lightTick, lightReach,
} from './town.js';

const {
  GameObject, RigidBody, Collider, CollisionListener, SpriteRenderer, LightEmitter, VolumeShadowCaster, SpriteSheetRegistry,
  NavGrid, Transform, enums, rng, dot2,
} = WEED;
const { ShapeType } = enums;

/** The car pictures flatten the floor to 0.7 (not to the barrio's 0.5), at 18 px a metre. */
const CAR_FLOOR = 0.7;
const CAR_PX_PER_M = 18;
const CAR_HEIGHT_PX = CAR_PX_PER_M * Math.sqrt(1 - CAR_FLOOR * CAR_FLOOR);
/** A car's light sits this far ahead of the front of its footprint. */
const HEADLIGHT_AHEAD = 18;
const SPEED_LIMIT_KMH = 30;

const _h = { frontX: 0, frontY: 0, rightX: 0, rightY: 0 };
const _v = { x: 0, y: 0 };
const _footprint = [0, 0];

const _frames = new Map();
const NO_FRAMES = [];
/** A sheet's headings: it draws those that look right, and the others are the same mirrored (heading 180° - a). */
function headings(sheet) {
  let list = _frames.get(sheet);
  if (list) return list;
  const names = SpriteSheetRegistry.getAnimationNames(sheet) || [];
  const drawn = names.map((n) => ({ n, a: parseFloat(n), mirror: 0 })).filter((o) => !Number.isNaN(o.a));
  const seen = new Set(drawn.map((o) => ((o.a % 360) + 360) % 360));
  const all = drawn.slice();
  for (const o of drawn) {
    const m = (((180 - o.a) % 360) + 360) % 360;
    if (!seen.has(m)) {
      seen.add(m);
      all.push({ n: o.n, a: m, mirror: 1 });
    }
  }
  list = all.map((o) => ({ n: o.n, c: Math.cos((o.a * Math.PI) / 180), s: Math.sin((o.a * Math.PI) / 180), mirror: o.mirror }));
  _frames.set(sheet, list);
  return list;
}

/**
 * A footprint of 2a × 2b px on the pictures' floor, turned θ, shows on the screen as a parallelogram along the screen heading φ,
 * with tan θ = tan φ / 0.7: 2a·√(cos²θ + 0.7²·sin²θ) long, with the same area. The collider is a box of that length and area,
 * rebuilt as the car changes frame.
 */
function footprint(i, c, s, out) {
  const th = Math.atan2(Math.abs(s) / CAR_FLOOR, Math.abs(c));
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const a = CarState.ha[i];
  const b = CarState.hb[i];
  const L = 2 * a * Math.sqrt(ct * ct + CAR_FLOOR * CAR_FLOOR * st * st);
  out[0] = L;
  out[1] = (4 * a * b * CAR_FLOOR) / L;
  return out;
}

export class Car extends GameObject {
  static deriveSpeed = true;
  static components = [RigidBody, Collider, CollisionListener, SpriteRenderer, LightEmitter, LightHours, VolumeShadowCaster, CarState];

  onSpawned(c = {}) {
    const model = CAR_MODELS[c.sheet];
    this.setSpritesheet('car_' + c.sheet);
    this.setAnimation('0');
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
    // The frame shows the heading: the entity turns, the picture does not.
    this.spriteRenderer.inheritTransformRotation = 0;
    this.spriteRenderer.spriteRotation = 0;
    const A = this.carState;
    A.driveForce = c.drive ?? 340;
    A.lateralFriction = 8;
    A.turnTorque = 10;
    A.minSteerSpeed = 8;
    A.minSteerFactor = 0.5;
    A.maxSteerSpeed = 140;
    A.lastKey = -1;
    A.ha = model.length * 9;
    A.hb = model.width * 9;
    const rot = c.rot || 0;
    const [length, width] = footprint(this.index, Math.cos(rot), Math.sin(rot), _footprint);
    A.hl = length / 2;
    A.hw = width / 2;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = length;
    this.collider.height = width;
    this.collider.radius = 0;
    this.collider.friction = 0.3;
    this.collider.visualRange = 160;
    this.rigidBody.static = c.still ? 1 : 0;
    this.rigidBody.linearDamping = 1;
    this.rigidBody.angularDamping = 3;
    this.setFixedRotation(0);
    this.rotation = rot;
    A.active = 1;
    // Its shadow: a box on the pictures' floor, turned with the car and moved with the sun by the GPU.
    this.volumeShadowCaster.setBox(A.ha * 2, A.hb * 2, model.height * CAR_HEIGHT_PX, { topScale: model.roof, floorScaleY: CAR_FLOOR });
    const L = this.lightEmitter;
    A.headlights = c.headlights ? 1 : 0;
    if (c.headlights) {
      // One light ahead of the car (LightEmitter.offsetX turns with it) and two glows on the front, decorations 0 and 1.
      L.color = HEADLIGHT_COLOR;
      L.radius = 265;
      L.offsetX = A.hl + HEADLIGHT_AHEAD;
      L.offsetY = 0;
      L.active = 1;
      if (RAYCAST) this.collider.visualRange = lightReach(L.radius) + A.hl + HEADLIGHT_AHEAD;
      for (let k = 0; k < 2; k++) {
        this.addDecoration('_lightGradient', 0, 0, 0.18, 0.18, 1, { tint: HEADLIGHT_COLOR, alpha: 0.9, anchorX: 0.5, anchorY: 0.5, offsetY: -8 });
      }
      lightBorn(this, OFF.HEADLIGHTS, 2, 0.9, 0.9, c.x, c.y);
    } else {
      L.radius = 0;
      L.offsetX = 0;
      L.offsetY = 0;
      L.active = 0;
      this.lightHours.base = 0;
    }
    this.frame();
  }

  onDespawned() {
    this.carState.active = 0;
  }

  /** The wheels do not slide sideways. */
  friction() {
    const i = this.index;
    GameObject.getHeadingAxes(i, _h);
    const lat = dot2(RigidBody.vx[i], RigidBody.vy[i], _h.rightX, _h.rightY);
    const k = CarState.lateralFriction[i];
    RigidBody.ax[i] -= _h.rightX * lat * k;
    RigidBody.ay[i] -= _h.rightY * lat * k;
  }

  applyForces(forward = 0, turn = 0) {
    const i = this.index;
    if (!Transform.active[i]) return;
    GameObject.getHeadingAxes(i, _h);
    const sp = dot2(RigidBody.vx[i], RigidBody.vy[i], _h.frontX, _h.frontY);
    if (forward) {
      const f = CarState.driveForce[i] * forward;
      RigidBody.ax[i] += _h.frontX * f;
      RigidBody.ay[i] += _h.frontY * f;
    }
    if (turn) {
      const a = Math.abs(sp);
      if (a >= CarState.minSteerSpeed[i]) {
        const mf = CarState.minSteerFactor[i];
        const f = mf + (1 - mf) * Math.min(a / CarState.maxSteerSpeed[i], 1);
        RigidBody.angularAccel[i] += turn * CarState.turnTorque[i] * f * (sp >= 0 ? 1 : -1);
      }
    }
    if (forward || turn) RigidBody.sleeping[i] = 0;
  }

  /**
   * The drawn frame nearest the heading on the screen, changed only past half a step (no flicker between two). With a new frame:
   * the anchor at its lowest wheel, the collider to the footprint at that heading, the headlights on its front.
   */
  frame() {
    const i = this.index;
    const c = Transform.rotC ? Transform.rotC[i] : 1;
    const s = Transform.rotS ? Transform.rotS[i] : 0;
    const sid = SpriteRenderer.spritesheetId[i];
    // From the sheet's name, not a field: an entity can move from one logic worker to another, and its fields stay behind.
    const sheet = sid ? SpriteSheetRegistry.getSpritesheetName(sid) || '' : '';
    const ks = sheet ? headings(sheet) : NO_FRAMES;
    if (!ks.length) return;
    const last = CarState.lastKey[i];
    if (last >= 0 && c * ks[last].c + s * ks[last].s >= Math.cos(Math.PI / ks.length)) return;
    let best = 0;
    let bestDot = -2;
    for (let k = 0; k < ks.length; k++) {
      const d = c * ks[k].c + s * ks[k].s;
      if (d > bestDot) {
        bestDot = d;
        best = k;
      }
    }
    if (last === best) return;
    CarState.lastKey[i] = best;
    const k = ks[best];
    this.setAnimation(k.n);
    this.flipX = k.mirror === 1;
    this.spriteRenderer.anchorY = CAR_MODELS[sheet.slice(4)]?.anchorY[k.n] || 0.5;
    const [L, W] = footprint(i, k.c, k.s, _footprint);
    if (Math.abs(L * 0.5 - CarState.hl[i]) > 0.5 || Math.abs(W * 0.5 - CarState.hw[i]) > 0.5) {
      this.collider.width = L;
      this.collider.height = W;
      CarState.hl[i] = L * 0.5;
      CarState.hw[i] = W * 0.5;
    }
    if (CarState.headlights[i]) {
      LightEmitter.offsetX[i] = L * 0.5 + HEADLIGHT_AHEAD;
      // A glow sorts at the car's foot line plus sortOffsetY: on the body when the front looks at the camera, a length behind and
      // under it when it looks away.
      const behind = k.s < -0.25 ? -L : 0;
      if (this.getAttachedDecorationCount() >= 2) {
        for (let q = 0; q < 2; q++) {
          const d = this.getAttachedDecoration(q);
          if (!d) continue;
          d.localX = L * 0.5 - 2;
          d.localY = (q ? 0.3 : -0.3) * W;
          d.sortOffsetY = behind;
        }
      }
    }
  }

  tick() {
    if (!Transform.active[this.index]) return;
    this.friction();
    this.frame();
    lightTick(this);
  }
}

export class ParkedCar extends Car {}
export class WreckedCar extends Car {}

/** Where to look for a lane when the car is off one: round it, nearest first. */
const PROBES = [
  [0, 0], [0, 8], [0, -8], [16, 0], [-16, 0], [0, 16], [0, -16], [24, 0], [-24, 0], [24, 12], [24, -12], [-24, 12], [-24, -12],
  [0, 24], [0, -24], [48, 0], [-48, 0], [36, 24], [-36, 24], [36, -24], [-36, -24],
];

/** Metres a screen px in the heading (fx, fy): the view does not take x and y alike. */
function metresPerPx(fx, fy) {
  const dx = fx / META.SF + (META.K * fy) / (META.SYN * META.SF);
  const dy = -fy / (META.SYN * META.SF);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Follows the editor's lanes (the right hand), brakes for the cars and people ahead, and keeps under the limit. */
export class DrivingCar extends Car {
  onSpawned(c = {}) {
    super.onSpawned(c);
    const A = this.carState;
    const rot = c.rot || 0;
    A.laneX = Math.cos(rot);
    A.laneY = Math.sin(rot);
    A.stuck = 0;
    A.free = 0;
    A.stopped = 0;
    A.startX = c.x;
    A.startY = c.y;
    A.startRot = rot;
    A.pace = 0.8 + rng() * 0.17;
  }

  /** The lane under the car; off it, the nearest lane round it and a push towards it, back to the street. */
  lane(x, y) {
    for (let k = 0; k < PROBES.length; k++) {
      NavGrid.requestVectorFromStaticFlowfield('calles', x + PROBES[k][0], y + PROBES[k][1], _v);
      if (_v.x * _v.x + _v.y * _v.y < 0.01) continue;
      if (k) {
        const ox = PROBES[k][0];
        const oy = PROBES[k][1];
        const l = Math.sqrt(ox * ox + oy * oy);
        const m = Math.sqrt(_v.x * _v.x + _v.y * _v.y);
        _v.x = _v.x / m + (ox / l) * 1.3;
        _v.y = _v.y / m + (oy / l) * 1.3;
      }
      return true;
    }
    return false;
  }

  tick(dtRatio, dt) {
    super.tick();
    const i = this.index;
    if (!Transform.active[i]) return;
    const A = CarState;
    if (isOff(OFF.CARS)) {
      const k = Math.pow(0.86, dtRatio || 1);
      RigidBody.vx[i] *= k;
      RigidBody.vy[i] *= k;
      return;
    }
    const dts = (dt || 16) / 1000;
    if (this.x < 0 || this.y < 0 || this.x > META.WW || this.y > META.WH) {
      _v.x = META.WW / 2 - this.x;
      _v.y = META.WH / 2 - this.y;
    } else if (this.lane(this.x, this.y)) {
      A.laneX[i] = _v.x;
      A.laneY[i] = _v.y;
    } else {
      _v.x = A.laneX[i];
      _v.y = A.laneY[i];
    }
    const l2 = _v.x * _v.x + _v.y * _v.y;
    if (l2 < 0.01) return;
    const inv = 1 / Math.sqrt(l2);
    const nx = _v.x * inv;
    const ny = _v.y * inv;
    const fx = this.forwardX;
    const fy = this.forwardY;
    const cross = fx * ny - fy * nx;
    const align = fx * nx + fy * ny;
    // Off its heading, it only creeps, so it can turn.
    let turn = Math.max(-1, Math.min(1, cross * 2)) * 0.8;
    let forward = align > 0.15 ? 1 : RigidBody.speed[i] < 30 ? 0.25 : 0;
    // Stuck over 5 s (two cars braking for each other): 3 s without looking at the others.
    if (RigidBody.speed[i] < 10) {
      A.stuck[i] += dts;
      A.stopped[i] += dts;
      if (A.stuck[i] > 5) {
        A.stuck[i] = 0;
        A.free[i] = 3;
      }
    } else {
      A.stuck[i] = 0;
      A.stopped[i] = 0;
    }
    // Stopped over 12 s (into a lot, against a post): off the screen, back to where it started.
    if (A.stopped[i] > 12 && !this.isOnScreen) {
      A.stopped[i] = 0;
      this.x = A.startX[i];
      this.y = A.startY[i];
      this.rotation = A.startRot[i];
      RigidBody.vx[i] = 0;
      RigidBody.vy[i] = 0;
      A.laneX[i] = Math.cos(A.startRot[i]);
      A.laneY[i] = Math.sin(A.startRot[i]);
      return;
    }
    if (A.free[i] > 0) A.free[i] -= dts;
    // Someone ahead in the lane? People are waited for, not steered round (the car would climb the sidewalk).
    let brake = 0;
    let steer = 0;
    if (A.free[i] <= 0) {
      for (let n = 0; n < this.neighborCount; n++) {
        const j = this.getNeighbor(n);
        if (!Transform.active[j] || j === i) continue;
        const isCar = A.active[j] === 1;
        const isPerson = !isCar && WalkerState.speed[j] > 0;
        if (!isCar && !isPerson) continue;
        const dx = Transform.x[j] + RigidBody.vx[j] * 0.2 - this.x;
        const dy = Transform.y[j] + RigidBody.vy[j] * 0.2 - this.y;
        const ahead = dx * fx + dy * fy;
        const reach = isCar ? A.hl[i] + A.hl[j] + 35 : A.hl[i] + 40;
        if (ahead <= 8 || ahead > reach) continue;
        const side = fx * dy - fy * dx;
        const as = Math.abs(side);
        const lane = isCar ? A.hw[i] + A.hw[j] - 2 : A.hw[i] + 4;
        if (as > lane) continue;
        const u = (1 - ahead / reach) * (0.4 + 0.6 * (1 - as / lane));
        if (u > brake) brake = u;
        if (isCar) steer += (side >= 0 ? -1 : 1) * u;
      }
    }
    if (brake > 0) {
      turn = Math.max(-1, Math.min(1, turn * (1 - brake * 0.6) + Math.max(-1, Math.min(1, steer)) * 0.8));
      forward *= 1 - brake;
      if (brake > 0.6) {
        const k = 1 - (brake - 0.6) * 0.25;
        RigidBody.vx[i] *= k;
        RigidBody.vy[i] *= k;
      }
    }
    // Under the limit: less throttle near it, a brake past it (per second, so at any frame rate).
    const kmh = RigidBody.speed[i] * metresPerPx(fx, fy) * 3.6;
    const limit = SPEED_LIMIT_KMH * A.pace[i];
    if (kmh > limit) {
      forward = 0;
      if (kmh > limit * 1.06) {
        const k = Math.pow(0.97, dtRatio || 1);
        RigidBody.vx[i] *= k;
        RigidBody.vy[i] *= k;
      }
    } else {
      forward *= Math.max(0.2, Math.min(1, (limit - kmh) / (limit * 0.3)));
    }
    this.applyForces(forward, turn);
  }
}
