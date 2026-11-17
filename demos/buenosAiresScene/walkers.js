// The barrio's people: the demos' standard LPC characters (civil1 to civil7 and poli, with their height maps), drawn from
// four sides by DirectionalSprite, each with a Box2D body. They walk the Editor de Barrios' static flowfields (eight
// towards places, one round the blocks), wait at the kerb when a car comes, step out of the way of moving cars and keep
// apart from each other: the game's Persona, readable.

import WEED from '/src/index.js';
import { META, OFF, isOff, AutoState, PersonaState } from './town.js';
import { metresPerWorldPx } from './traffic.js';

const { GameObject, RigidBody, Collider, DirectionalSprite, ShadowCaster, NavGrid, Transform, rng } = WEED;

/** The standard LPC sheets (one layout: demos/img/civil1.json). */
export const PEOPLE_SHEETS = ['civil1', 'civil2', 'civil3', 'civil4', 'civil5', 'civil6', 'civil7', 'poli'];

/** The LPC animations nobody here plays (people walk and stand): left out of the atlas. */
const LPC_DIRECTIONS = ['up', 'left', 'down', 'right'];
export const LPC_UNUSED = ['spellcast', 'thrust', 'slash', 'shoot', 'jump', 'sit', 'emote', 'run', 'combat', '1h_slash', '1h_halfslash']
  .flatMap((animation) => LPC_DIRECTIONS.map((direction) => `${animation}_${direction}`))
  .concat(['hurt', 'climb']);

/** The fields people follow: the editor's destinations, and "veredas", round the block on the sidewalks. */
export const WALK_FIELDS = Array.from({ length: META.peatones | 0 }, (_, n) => `peaton${n}`).concat(['veredas']);

/** An LPC frame's feet are on its row 62 of 64. */
const FEET_ANCHOR_Y = 62 / 64;
/** A person's collider radius, px (the cars read the same number). */
export const PERSON_RADIUS = 4.5;
/** A car faster than this (px/s) is one a person waits for. */
const MOVING_CAR_SPEED = 20;
/** How far (px) a person looks for a car before stepping onto the street. */
const LOOK_FOR_CARS_PX = 160;
/** A person checks whether its next 1.2 m (on the floor) are street. */
const KERB_LOOKAHEAD_M = 1.2;

const _way = { x: 0, y: 0 };
const _street = { x: 0, y: 0 };

export class Persona extends GameObject {
  static deriveSpeed = true;
  static tickInterval = 2;
  static components = [RigidBody, Collider, DirectionalSprite, ShadowCaster, PersonaState];

  /** What it plays now: 1 walk, 0 stand, -1 nothing yet (this thread's copy: setAnimation only when it changes). */
  animation = -1;

  onSpawned() {
    this.setSpritesheet(PEOPLE_SHEETS[Math.floor(rng() * PEOPLE_SHEETS.length)]);
    // Facing the camera; it turns at the borders between its four sides, with no margin.
    this.directionalSprite.turnMargin = 0;
    this.directionalSprite.facing = Math.PI / 2;
    this.setAnimation('idle');
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = FEET_ANCHOR_Y;
    // LPC characters are drawn wide: 6 % narrower than tall, and each a little taller or shorter.
    const size = 0.56 + rng() * 0.08;
    this.setScale(size * 0.94, size);
    this.rigidBody.linearDamping = 3;
    this.setFixedRotation(1);
    this.collider.radius = PERSON_RADIUS;
    this.collider.visualRange = 52;
    const state = this.personaState;
    state.person = 1;
    state.field = Math.floor(rng() * WALK_FIELDS.length);
    state.walking = 0;
    state.timer = rng() * 4;
    state.walkSpeed = 17 + rng() * 9;
    this.animation = -1;
  }

  onDespawned() {
    this.personaState.person = 0;
  }

  tick(dtRatio, deltaTime) {
    const seconds = (deltaTime || 33) / 1000;
    if (isOff(OFF.PEOPLE)) this.standStill();
    else this.walk(seconds);
    this.keepApart();
    this.animate();
  }

  /** Walk a while along a field, rest a while, pick another field: a person on an errand, then on another. */
  walk(seconds) {
    const index = this.index;
    PersonaState.timer[index] -= seconds;
    if (PersonaState.walking[index] === 0) {
      if (PersonaState.timer[index] <= 0) {
        PersonaState.walking[index] = 1;
        PersonaState.timer[index] = 15 + rng() * 45;
      }
      return;
    }
    NavGrid.requestVectorFromStaticFlowfield(WALK_FIELDS[PersonaState.field[index]], this.x, this.y, _way);
    const arrived = _way.x === 0 && _way.y === 0;
    if (arrived || PersonaState.timer[index] <= 0) {
      // There, no way on, or tired of it: a rest, and then another field.
      PersonaState.walking[index] = 0;
      PersonaState.timer[index] = 1 + rng() * 7;
      PersonaState.field[index] = Math.floor(rng() * WALK_FIELDS.length);
      return;
    }
    const speed = this.waitsAtTheKerb() ? 0 : PersonaState.walkSpeed[index];
    this.addAcceleration((_way.x * speed - RigidBody.vx[index]) * 6, (_way.y * speed - RigidBody.vy[index]) * 6);
  }

  /**
   * Whether the next step is onto the street with a car coming: then it waits at the kerb. A car comes when it moves
   * towards the person, or is already over them (its length plus a margin), within LOOK_FOR_CARS_PX.
   */
  waitsAtTheKerb() {
    const reach = KERB_LOOKAHEAD_M / metresPerWorldPx(META, _way.x, _way.y);
    NavGrid.requestVectorFromStaticFlowfield('calles', this.x + _way.x * reach, this.y + _way.y * reach, _street);
    if (_street.x === 0 && _street.y === 0) return false;
    for (let n = 0; n < this.neighborCount; n++) {
      const car = this.getNeighbor(n);
      if (AutoState.car[car] !== 1 || !Transform.active[car]) continue;
      const carVx = RigidBody.vx[car];
      const carVy = RigidBody.vy[car];
      if (carVx * carVx + carVy * carVy < MOVING_CAR_SPEED * MOVING_CAR_SPEED) continue;
      const dx = this.x - Transform.x[car];
      const dy = this.y - Transform.y[car];
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > LOOK_FOR_CARS_PX * LOOK_FOR_CARS_PX) continue;
      const comesTowardsMe = dx * carVx + dy * carVy > 0;
      const over = AutoState.halfLength[car] + 2;
      if (comesTowardsMe || distanceSquared < over * over) return true;
    }
    return false;
  }

  /** The panel stopped the people: they slow to a stand. */
  standStill() {
    const index = this.index;
    this.addAcceleration(-RigidBody.vx[index] * 6, -RigidBody.vy[index] * 6);
  }

  /**
   * Keep 10 px from the other people and step out of the cars' way: a push away from each neighbour that is too close,
   * stronger the closer it is; a car pushes from further (its half length plus 22 px), and moving ones more.
   */
  keepApart() {
    let pushX = 0;
    let pushY = 0;
    for (let n = 0; n < this.neighborCount; n++) {
      const other = this.getNeighbor(n);
      if (!Transform.active[other]) continue;
      const dx = this.x - Transform.x[other];
      const dy = this.y - Transform.y[other];
      const distanceSquared = dx * dx + dy * dy;
      if (AutoState.car[other] === 1) {
        const reach = AutoState.halfLength[other] + 22;
        const reachSquared = reach * reach;
        if (distanceSquared < reachSquared && distanceSquared > 1) {
          const closeness = (reachSquared - distanceSquared) / reachSquared;
          const distance = Math.sqrt(distanceSquared);
          pushX += (dx / distance) * closeness * 3;
          pushY += (dy / distance) * closeness * 3;
        }
        continue;
      }
      if (distanceSquared < 100 && distanceSquared > 0.01) {
        const closeness = (100 - distanceSquared) / 100;
        const distance = Math.sqrt(distanceSquared);
        pushX += (dx / distance) * closeness;
        pushY += (dy / distance) * closeness;
      }
    }
    if (pushX || pushY) this.addAcceleration(pushX * 120, pushY * 120);
  }

  /**
   * Walk or stand, facing the way it goes on the floor: the floor is drawn SYN as tall as it is wide, so a screen px down
   * is 1 / SYN px on the floor.
   */
  animate() {
    const index = this.index;
    const vx = RigidBody.vx[index];
    const vy = RigidBody.vy[index];
    const speedSquared = vx * vx + vy * vy;
    if (speedSquared > 16) {
      this.directionalSprite.facing = Math.atan2(vy / META.SYN, vx);
      if (this.animation !== 1) {
        this.animation = 1;
        this.setAnimation('walk');
      }
      this.setAnimationSpeed(Math.sqrt(speedSquared) * 0.0045);
    } else if (this.animation !== 0) {
      this.animation = 0;
      this.setAnimation('idle');
      this.setAnimationSpeed(0.03);
    }
  }
}
