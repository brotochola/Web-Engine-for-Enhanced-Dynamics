// The people: LPC characters with a Box2D body, walking the editor's static flowfields (eight towards places, one round the
// blocks), waiting at the curb for a car that comes, and keeping apart. buenos-aires' Persona, in short.

import WEED from '/src/index.js';
import { META, OFF, isOff, CarState, WalkerState } from './town.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, ShadowCaster, NavGrid, Transform, rng } = WEED;

/** demos/img/people: LPC characters on one sheet layout (demos/img/civil1.json). */
export const PEOPLE_SHEETS = [
  'amarillo_01', 'amarillo_02', 'female_01', 'female_04', 'female_09', 'female_15', 'female_22', 'male_01', 'male_05', 'male_12',
  'male_18',
];
/** Animations the walkers never play: left out of the sheets, so the atlas holds less. */
export const LPC_EXCLUDE = ['spellcast', 'thrust', 'slash', 'shoot', 'jump', 'sit', 'emote', 'run', 'combat', '1h_slash', '1h_halfslash'];

export const WALK_FIELDS = Array.from({ length: META.peatones }, (_, i) => 'peaton' + i).concat(['veredas']);
const DIRECTIONS = ['up', 'left', 'down', 'right'];
const WALK = DIRECTIONS.map((d) => 'walk_' + d);
const IDLE = DIRECTIONS.map((d) => 'idle_' + d);
const _v = { x: 0, y: 0 };
const _w = { x: 0, y: 0 };

export class Walker extends GameObject {
  static deriveSpeed = true;
  static tickInterval = 2;
  static components = [RigidBody, Collider, SpriteRenderer, ShadowCaster, WalkerState];

  animation = -1;

  onSpawned(c = {}) {
    this.setSpritesheet(PEOPLE_SHEETS[(rng() * PEOPLE_SHEETS.length) | 0]);
    this.setAnimation('idle_down');
    this.rigidBody.linearDamping = 3;
    this.setFixedRotation(1);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.93;
    // LPC characters are drawn wide: 6 % narrower than tall.
    const s = 0.56 + rng() * 0.08;
    this.setScale(s * 0.94, s);
    this.collider.radius = 4.5;
    this.collider.visualRange = 52;
    const w = this.walkerState;
    w.field = (rng() * WALK_FIELDS.length) | 0;
    w.still = c.still ? 1 : 0;
    w.walking = 0;
    w.timer = rng() * 4;
    w.speed = 17 + rng() * 9;
    w.facing = 2;
    this.shadowCaster.heightMultiplier = 1.2;
    this.animation = -1;
  }

  tick(dtRatio, dt) {
    const i = this.index;
    const W = WalkerState;
    const dts = (dt || 33) / 1000;
    const vx = RigidBody.vx[i];
    const vy = RigidBody.vy[i];
    if (!W.still[i] && !isOff(OFF.PEOPLE)) {
      W.timer[i] -= dts;
      if (W.walking[i] === 0) {
        if (W.timer[i] <= 0) {
          W.walking[i] = 1;
          W.timer[i] = 15 + rng() * 45;
        }
      } else {
        NavGrid.requestVectorFromStaticFlowfield(WALK_FIELDS[W.field[i]], this.x, this.y, _v);
        if ((_v.x === 0 && _v.y === 0) || W.timer[i] <= 0) {
          // There, no way, or tired of it: a pause, and another field.
          W.walking[i] = 0;
          W.timer[i] = 1 + rng() * 7;
          W.field[i] = (rng() * WALK_FIELDS.length) | 0;
        } else {
          // Street ahead? Then look for cars: one coming, and the walker waits at the curb.
          let wait = false;
          NavGrid.requestVectorFromStaticFlowfield('calles', this.x + _v.x * 22, this.y + _v.y * 14, _w);
          if (_w.x !== 0 || _w.y !== 0) {
            for (let n = 0; n < this.neighborCount; n++) {
              const j = this.getNeighbor(n);
              if (!CarState.active[j] || !Transform.active[j]) continue;
              const cvx = RigidBody.vx[j];
              const cvy = RigidBody.vy[j];
              if (cvx * cvx + cvy * cvy < 400) continue;
              const dx = this.x - Transform.x[j];
              const dy = this.y - Transform.y[j];
              const d2 = dx * dx + dy * dy;
              if (d2 > 26000) continue;
              const over = CarState.hl[j] + 2;
              if (dx * cvx + dy * cvy > 0 || d2 < over * over) {
                wait = true;
                break;
              }
            }
          }
          const sp = wait ? 0 : W.speed[i];
          this.addAcceleration((_v.x * sp - vx) * 6, (_v.y * sp - vy) * 6);
        }
      }
    } else if (isOff(OFF.PEOPLE)) {
      this.addAcceleration(-vx * 6, -vy * 6);
    }
    // Keep apart from each other and clear of the cars (the spatial grid's neighbours).
    let sx = 0;
    let sy = 0;
    for (let n = 0; n < this.neighborCount; n++) {
      const j = this.getNeighbor(n);
      if (!Transform.active[j]) continue;
      const dx = this.x - Transform.x[j];
      const dy = this.y - Transform.y[j];
      const d2 = dx * dx + dy * dy;
      if (CarState.active[j]) {
        const r = CarState.hl[j] + 22;
        const r2 = r * r;
        if (d2 < r2 && d2 > 1) {
          const f = (r2 - d2) / r2;
          const d = Math.sqrt(d2);
          sx += (dx / d) * f * 3;
          sy += (dy / d) * f * 3;
        }
        continue;
      }
      if (d2 < 100 && d2 > 0.01) {
        const f = (100 - d2) / 100;
        const d = Math.sqrt(d2);
        sx += (dx / d) * f;
        sy += (dy / d) * f;
      }
    }
    if (sx || sy) this.addAcceleration(sx * 120, sy * 120);
    // Walk or stand, facing the way the screen shows the walker going.
    const s2 = vx * vx + vy * vy;
    if (s2 > 16) {
      const ax = Math.abs(vx);
      const ay = Math.abs(vy) * 2;
      W.facing[i] = ax > ay ? (vx > 0 ? 3 : 1) : vy > 0 ? 2 : 0;
      const want = W.facing[i];
      if (this.animation !== want) {
        this.animation = want;
        this.setAnimation(WALK[want]);
      }
      this.setAnimationSpeed(Math.sqrt(s2) * 0.0045);
    } else if (this.animation !== 10 + W.facing[i]) {
      this.animation = 10 + W.facing[i];
      this.setAnimation(IDLE[W.facing[i]]);
      this.setAnimationSpeed(0.03);
    }
  }
}
