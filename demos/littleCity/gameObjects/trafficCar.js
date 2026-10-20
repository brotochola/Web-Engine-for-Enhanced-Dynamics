// TrafficCar — AI car that only follows the roads static flowfield (no player chase)

import WEED from '/src/index.js';
import { Car } from '/demos/carScene/gameObjects/car.js';
import { NavGrid } from '/src/core/navGrid.js';
import { CarComponent } from '/demos/carScene/components/carComponent.js';
import { CityPerson } from './cityPerson.js';
import { avoidTurnSign } from '../avoidSteer.js';
import { dot2 } from '/src/util/utils.js';

const { SpriteRenderer, RigidBody, Collider, CollisionListener, Transform } = WEED;

const _navVec = { x: 0, y: 0 };

// Probe offsets to recover onto road when the current cell is empty
const _PROBE = [
  [0, 0],
  [48, 0],
  [-48, 0],
  [0, 48],
  [0, -48],
  [48, 48],
  [48, -48],
  [-48, 48],
  [-48, -48],
  [96, 0],
  [-96, 0],
  [0, 96],
  [0, -96],
];

// Lane corridor: only dodge bodies that would actually be hit
const AVOID_PERSON_REACH = 140;
const AVOID_PERSON_CORRIDOR = 42;
const AVOID_CAR_REACH = 180;
const AVOID_CAR_CORRIDOR = 72;
const AVOID_STEER = 1.15;

export class TrafficCar extends Car {
  static components = [RigidBody, Collider, CollisionListener, SpriteRenderer, CarComponent];

  static aiTurnStrength = 0.8;
  static aiForwardStrength = 0.5;
  static aiForwardAlignmentThreshold = 0.15;
  static aiBrakeForwardSpeedThreshold = 60; // px/s
  /** Small throttle so minSteerSpeed can unlock when facing away from FF */
  static aiCreepForward = 0.45;
  static flowfieldName = 'roads';

  onSpawned(spawnConfig = {}) {
    const cfg = { ...spawnConfig };
    if (cfg.rotation == null) {
      NavGrid.requestVectorFromStaticFlowfield(
        this.constructor.flowfieldName,
        cfg.x || 0,
        cfg.y || 0,
        _navVec,
      );
      if (_navVec.x !== 0 || _navVec.y !== 0) {
        cfg.rotation = Math.atan2(_navVec.y, _navVec.x);
      }
    }
    super.onSpawned(cfg);
    // Allow slow-speed steering so a bad bump does not freeze the car
    this.carComponent.minSteerSpeed = 8;
    this._lastNavX = _navVec.x;
    this._lastNavY = _navVec.y;
  }

  _sampleFlowfield(worldX, worldY) {
    const name = this.constructor.flowfieldName;
    for (let i = 0; i < _PROBE.length; i++) {
      NavGrid.requestVectorFromStaticFlowfield(
        name,
        worldX + _PROBE[i][0],
        worldY + _PROBE[i][1],
        _navVec,
      );
      if (_navVec.x * _navVec.x + _navVec.y * _navVec.y >= 0.01) return true;
    }
    return false;
  }

  /**
   * Brake and steer off people and other traffic cars sitting in the lane ahead.
   * @returns {{ brake: number, steer: number }}
   */
  _avoidAhead(fx, fy) {
    const myX = this.x;
    const myY = this.y;
    const personType = CityPerson.entityType;
    const carType = this.entityType;
    let brake = 0;
    let steer = 0;

    for (let n = 0; n < this.neighborCount; n++) {
      const ni = this.getNeighbor(n);
      if (!Transform.active[ni]) continue;
      const type = Transform.entityType[ni];
      const isPerson = type === personType;
      const isCar = type === carType;
      if (!isPerson && !isCar) continue;

      const lead = isCar ? 0.2 : 0.12;
      const dx = Transform.x[ni] + RigidBody.vx[ni] * lead - myX;
      const dy = Transform.y[ni] + RigidBody.vy[ni] * lead - myY;
      const ahead = dx * fx + dy * fy;
      const reach = isCar ? AVOID_CAR_REACH : AVOID_PERSON_REACH;
      if (ahead <= 12 || ahead > reach) continue;

      const side = fx * dy - fy * dx;
      const absSide = side < 0 ? -side : side;
      const corridor = isCar ? AVOID_CAR_CORRIDOR : AVOID_PERSON_CORRIDOR;
      if (absSide > corridor) continue;

      const aheadU = 1 - ahead / reach;
      const sideU = 1 - absSide / corridor;
      const urgency = aheadU * (0.4 + 0.6 * sideU);
      if (urgency > brake) brake = urgency;
      // Turn away from the side they occupy (road-seek's sign turns toward).
      steer += avoidTurnSign(fx, fy, dx, dy) * urgency;
    }

    return {
      brake: brake > 1 ? 1 : brake,
      steer: steer > 1 ? 1 : steer < -1 ? -1 : steer,
    };
  }

  tick(dtRatio) {
    super.tick(dtRatio);

    const found = this._sampleFlowfield(this.x, this.y);
    if (!found) {
      // Stay on last known road heading so a brief off-road bump does not kill drive
      if (this._lastNavX * this._lastNavX + this._lastNavY * this._lastNavY < 0.01) return;
      _navVec.x = this._lastNavX;
      _navVec.y = this._lastNavY;
    } else {
      this._lastNavX = _navVec.x;
      this._lastNavY = _navVec.y;
    }

    const lenSq = _navVec.x * _navVec.x + _navVec.y * _navVec.y;
    if (lenSq < 0.01) return;

    const inv = 1 / Math.sqrt(lenSq);
    const nx = _navVec.x * inv;
    const ny = _navVec.y * inv;
    const fx = this.forwardX;
    const fy = this.forwardY;
    const cross = fx * ny - fy * nx;
    const alignment = fx * nx + fy * ny;
    let turnInput = Math.max(-1, Math.min(1, cross * 2)) * this.constructor.aiTurnStrength;

    const i = this.index;
    const forwardSpeed = dot2(RigidBody.vx[i], RigidBody.vy[i], fx, fy);

    let forwardInput = 0;
    if (alignment > this.constructor.aiForwardAlignmentThreshold) {
      forwardInput = this.constructor.aiForwardStrength;
    } else if (forwardSpeed > this.constructor.aiBrakeForwardSpeedThreshold) {
      forwardInput = 0;
    } else if (Math.abs(turnInput) > 0.05) {
      // Creep so applyForces can steer while nearly stopped / facing wrong way
      forwardInput = this.constructor.aiCreepForward;
    }

    const avoid = this._avoidAhead(fx, fy);
    if (avoid.brake > 0 || avoid.steer !== 0) {
      const blended = turnInput * (1 - avoid.brake * 0.65) + avoid.steer * AVOID_STEER;
      turnInput = blended > 1 ? 1 : blended < -1 ? -1 : blended;
      forwardInput = avoid.brake > 0.82 ? -0.35 : forwardInput * (1 - avoid.brake);
    }

    this.applyForces(forwardInput, turnInput);
  }
}
