// SoldierBehaviorFSM.js - FSM component for soldier behavior
// States: IDLE, GOING_TO_DESTINATION, GOING_TO_ENEMY, CLOSE_ATTACKING

import WEED from "/src/index.js";

import { Civilian } from "../gameObjects/civilian.js";
import { Destination } from "../gameObjects/destination.js";
import { NavGrid } from "../../src/core/NavGrid.js";
import { PersonComponent, DIRECTION_NAMES } from "../components/personComponent.js";
import { distanceSq2D } from "../../src/index.js";

const { FSM, FSMState, Transform, RigidBody, GameObject, getDirectionFromAngle } = WEED;

// ==========================================
// HELPER: Find closest civilian in neighbors
// ==========================================

function findClosestCivilian(owner) {
  const civilianType = Civilian.entityType;
  let closestIndex = -1;
  let closestDistSq = Infinity;

  for (let n = 0; n < owner.neighborCount; n++) {
    const neighborIndex = owner.getNeighbor(n);
    if (Transform.entityType[neighborIndex] !== civilianType) continue;

    const distSq = owner.getNeighborDistanceSq(n);
    if (distSq < closestDistSq) {
      closestDistSq = distSq;
      closestIndex = neighborIndex;
    }
  }

  return closestIndex === -1 ? null : { index: closestIndex, distSq: closestDistSq };
}

// ==========================================
// HELPER: Get destination info
// ==========================================

function getDestination() {
 return Destination.getFirstActiveInstance();

}

// ==========================================
// IDLE STATE - Waiting, scanning for civilians
// ==========================================

class IdleSoldierState extends FSMState {
  static onEnter(owner, i, fromState) {}

  static onUpdate(owner, i, dt) {
    // Priority 1: Check for destination
    // const dest = getDestination();
    // if (dest) {
    //   this.fsm.changeState(i, this.fsm.states.GOING_TO_DESTINATION);
    //   return;
    // }

    // Priority 2: Scan for civilians
    const closest = findClosestCivilian(owner);
    if (closest) {
      const punchRangeSq = owner.constructor.punchRangeSq;
      if (closest.distSq <= punchRangeSq) {
        this.fsm.changeState(i, this.fsm.states.CLOSE_ATTACKING);
      } else {
        this.fsm.changeState(i, this.fsm.states.GOING_TO_ENEMY);
      }
    }else{
      owner.groupWithMyTeam();
      owner.separateFromTeam();
    }

  }
}

// ==========================================
// GOING_TO_DESTINATION STATE - Following orders
// ==========================================

class GoingToDestinationState extends FSMState {
  static onEnter(owner, i, fromState) {}

  static onUpdate(owner, i, dt) {
    const dest = getDestination();

    // No destination? Stay in this state (or go idle if you prefer)
    if (!dest) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    owner.groupWithMyTeam();
    owner.separateFromTeam();

    // Check if reached destination
    const distSqToDest = distanceSq2D(owner.x, owner.y, dest.x, dest.y);
    if (distSqToDest < dest.collider.radius**2) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // Follow flowfield toward destination
    let vec = { x: 0, y: 0 };
    NavGrid.requestVector(owner.x, owner.y, dest.x, dest.y, vec);

    const followStrength = 0.1;
    owner.addAcceleration(vec.x * followStrength, vec.y * followStrength);
  }
}

// ==========================================
// GOING_TO_ENEMY STATE - Chasing closest civilian
// ==========================================

class GoingToEnemyState extends FSMState {
  static onEnter(owner, i, fromState) {}

  static onUpdate(owner, i, dt) {
    const closest = findClosestCivilian(owner);

    // Lost sight of all civilians
    if (!closest) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    owner.groupWithMyTeam();
    owner.separateFromTeam();

    const punchRangeSq = owner.constructor.punchRangeSq;

    // Close enough to attack?
    if (closest.distSq <= punchRangeSq) {
      this.fsm.changeState(i, this.fsm.states.CLOSE_ATTACKING);
      return;
    }

    // Chase toward closest civilian
    const targetX = Transform.x[closest.index];
    const targetY = Transform.y[closest.index];

    const dx = targetX - owner.x;
    const dy = targetY - owner.y;
    const dist = Math.sqrt(closest.distSq);

    if (dist > 0) {
      const chaseStrength = 0.15;
      RigidBody.ax[i] += (dx / dist) * chaseStrength;
      RigidBody.ay[i] += (dy / dist) * chaseStrength;
    }
  }
}

// ==========================================
// CLOSE_ATTACKING STATE - Punching civilians
// ==========================================

class CloseAttackingState extends FSMState {
  static onEnter(owner, i, fromState) {}

  static onUpdate(owner, i, dt) {
    const closest = findClosestCivilian(owner);

    // No target
    if (!closest) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    const punchRangeSq = owner.constructor.punchRangeSq;

    // Target backed away?
    if (closest.distSq > punchRangeSq) {
      this.fsm.changeState(i, this.fsm.states.GOING_TO_ENEMY);
      return;
    }

    // Face the target
    const targetX = Transform.x[closest.index];
    const targetY = Transform.y[closest.index];
    const angle = Math.atan2(targetY - owner.y, targetX - owner.x);
    const direction = getDirectionFromAngle(angle);
    const dirIndex = DIRECTION_NAMES.indexOf(direction);
    if (dirIndex >= 0) {
      PersonComponent.facingDirection[i] = dirIndex;
    }

    // Try to punch (returns false if already punching)
    // Deal damage when punch starts (punchStarted = true)
    const punchStarted = owner.punch();

    if (punchStarted) {
      const target = GameObject.get(closest.index);
      if (target && target.recieveDamage) {
        const damage = owner.constructor.punchDamage;
        target.recieveDamage(damage);
      }
    }
  }
}

// ==========================================
// FSM COMPONENT
// ==========================================

export class SoldierBehaviorFSM extends FSM {
  static states = {
    IDLE: IdleSoldierState,
    GOING_TO_DESTINATION: GoingToDestinationState,
    GOING_TO_ENEMY: GoingToEnemyState,
    CLOSE_ATTACKING: CloseAttackingState,
  };

  static initial = this.states.IDLE;
}
