// CityPerson — calm pedestrian: follows sidewalks flowfield, walk/idle only (no flee, no run)

import WEED from '/src/index.js';
import { NavGrid } from '/src/core/navGrid.js';

const { rng, GameObject, RigidBody, Collider, SpriteRenderer, Transform } = WEED;

const _navVec = { x: 0, y: 0 };

const PEOPLE_SHEETS = [];
function pushSheets(prefix, count) {
  for (let i = 1; i <= count; i++) {
    const id = i < 10 ? `0${i}` : `${i}`;
    PEOPLE_SHEETS.push(`${prefix}_${id}`);
  }
}
pushSheets('male', 30);
pushSheets('female', 30);
pushSheets('amarillo', 3);
pushSheets('rojito', 3);
pushSheets('verde', 3);

const DIR_NAMES = ['up', 'left', 'down', 'right'];
const DIR_UP = 0;
const DIR_LEFT = 1;
const DIR_DOWN = 2;
const DIR_RIGHT = 3;

const WALK_SPEED_THRESHOLD = 8; // px/s
const WALK_ANIM_MULT = 0.00277;
const IDLE_ANIM_MULT = 0.05;
/** Soft cap so they never hit run-looking speeds */
const MAX_SPEED = 90;

function facingFromVelocity(vx, vy) {
  const ax = vx < 0 ? -vx : vx;
  const ay = vy < 0 ? -vy : vy;
  if (ay >= ax) return vy >= 0 ? DIR_DOWN : DIR_UP;
  return vx >= 0 ? DIR_RIGHT : DIR_LEFT;
}

export class CityPerson extends GameObject {
  static deriveSpeed = true;
  static tickInterval = 4;

  static components = [RigidBody, Collider, SpriteRenderer];

  static peopleSpritesheets = PEOPLE_SHEETS;
  static flowfieldName = 'sidewalks';
  static flowFollowStrength = 220;
  static linearDamping = 2.2;
  static separationForce = 400;
  static separationRadius = 28;
  static separationRadiusSq = 28 * 28;

  onSpawned(spawnConfig = {}) {
    const sheets = this.constructor.peopleSpritesheets;
    const sheet = sheets[(rng() * sheets.length) | 0];
    this.setSpritesheet(sheet);
    this.setAnimation('idle_down');

    super.onSpawned(spawnConfig);

    this.rigidBody.linearDamping = this.constructor.linearDamping;
    this.setFixedRotation(1);

    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.98;
    this.spriteRenderer.animationSpeed = IDLE_ANIM_MULT;

    const scale = 0.7 + rng() * 0.2;
    this.setScale(scale, scale);

    this.collider.radius = 10 * scale;
    this.collider.visualRange = 120;

    this._facing = DIR_DOWN;
    this._anim = 'idle';

    // this.addDecoration('_whiteCircle_64x64', 0, 0, 0.33, 0.16, -1, {
    //   anchorX: 0.5,
    //   anchorY: 0.5,
    //   alpha: 0.25,
    //   offsetY: 0,
    //   tint: 0x000000,
    // });
  }

  _updateAnim(speed, vx, vy) {
    const wantWalk = speed > WALK_SPEED_THRESHOLD;
    if (wantWalk) {
      const dir = facingFromVelocity(vx, vy);
      if (dir !== this._facing || this._anim !== 'walk') {
        this._facing = dir;
        this._anim = 'walk';
        this.setAnimation(`walk_${DIR_NAMES[dir]}`);
      }
      this.setAnimationSpeed(speed * WALK_ANIM_MULT);
    } else if (this._anim !== 'idle') {
      this._anim = 'idle';
      this.setAnimation(`idle_${DIR_NAMES[this._facing]}`);
      this.setAnimationSpeed(IDLE_ANIM_MULT);
    }
  }

  tick() {
    NavGrid.requestVectorFromStaticFlowfield(
      this.constructor.flowfieldName,
      this.x,
      this.y,
      _navVec,
    );
    const follow = this.constructor.flowFollowStrength;
    this.addAcceleration(_navVec.x * follow, _navVec.y * follow);

    const myX = this.x;
    const myY = this.y;
    const myType = this.entityType;
    const sepR2 = this.constructor.separationRadiusSq;
    const sepF = this.constructor.separationForce;
    let sx = 0;
    let sy = 0;

    for (let n = 0; n < this.neighborCount; n++) {
      const ni = this.getNeighbor(n);
      if (Transform.entityType[ni] !== myType) continue;
      const dx = myX - Transform.x[ni];
      const dy = myY - Transform.y[ni];
      const d2 = dx * dx + dy * dy;
      if (d2 < sepR2 && d2 > 1) {
        const strength = (sepR2 - d2) / sepR2;
        sx += (dx / d2) * strength;
        sy += (dy / d2) * strength;
      }
    }
    if (sx !== 0 || sy !== 0) {
      this.addAcceleration(sx * sepF, sy * sepF);
    }

    const i = this.index;
    let vx = RigidBody.vx[i];
    let vy = RigidBody.vy[i];
    let speed = RigidBody.speed[i];

    if (speed > MAX_SPEED) {
      const s = MAX_SPEED / speed;
      vx *= s;
      vy *= s;
      this.setVelocity(vx, vy);
      speed = MAX_SPEED;
    } else if (speed < 6) {
      this.setVelocity(0, 0);
      vx = 0;
      vy = 0;
      speed = 0;
    }

    if (this.spriteRenderer?.spritesheetId) {
      this._updateAnim(speed, vx, vy);
    }
  }
}
