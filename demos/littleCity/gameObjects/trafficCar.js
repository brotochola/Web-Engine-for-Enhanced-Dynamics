// TrafficCar — AI car that only follows the roads static flowfield (no player chase)

import WEED from '/src/index.js';
import { Car } from '/demos/carScene/gameObjects/car.js';
import { NavGrid } from '/src/core/navGrid.js';
import { CarComponent } from '/demos/carScene/components/carComponent.js';
import { dot2 } from '/src/util/utils.js';

const { SpriteRenderer, RigidBody, Collider, CollisionListener } = WEED;

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

export class TrafficCar extends Car {
  static components = [RigidBody, Collider, CollisionListener, SpriteRenderer, CarComponent];

  static aiTurnStrength = 0.8;
  static aiForwardStrength = 0.9;
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
    const turnInput = Math.max(-1, Math.min(1, cross * 2)) * this.constructor.aiTurnStrength;

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

    this.applyForces(forwardInput, turnInput);
  }
}
