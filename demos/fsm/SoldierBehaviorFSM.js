// SoldierBehaviorFSM.js - FSM component for soldier behavior
// States: IDLE, GOING_TO_DESTINATION, GOING_TO_ENEMY, CLOSE_ATTACKING, RANGED_ATTACKING

import WEED from '/src/index.js';
import { SHOOT_DURATION_MS, WALK_SPEED_THRESHOLD } from './PersonAnimationFSM.js';
import { Civilian } from '../gameObjects/civilian.js';
import { Destination } from '../gameObjects/destination.js';
import { NavGrid } from '../../src/core/NavGrid.js';
import { PersonComponent, DIRECTION_NAMES } from '../components/personComponent.js';
import { distanceSq2D, Ray } from '../../src/index.js';
import { LootableComponent } from '../components/lootableComponent.js';

const { FSM, FSMState, Transform, RigidBody, GameObject, getDirectionFromAngle } = WEED;

// ==========================================
// REUSABLE OBJECTS - Zero allocation
// ==========================================

const _closestResult = { index: -1, distSq: Infinity };
const _navVec = { x: 0, y: 0 };

// ==========================================
// HELPER: Find closest civilian in neighbors
// ==========================================

function findClosestCivilian(owner) {
  const civilianType = Civilian.entityType;
  _closestResult.index = -1;
  _closestResult.distSq = Infinity;

  for (let n = 0; n < owner.neighborCount; n++) {
    const neighborIndex = owner.getNeighbor(n);
    if (Transform.entityType[neighborIndex] !== civilianType) continue;
    if (LootableComponent.health[neighborIndex] <= 0) continue;
    if (!Ray.hasLineOfSight(owner.index, neighborIndex)) continue;

    const distSq = owner.getNeighborDistanceSq(n);
    if (distSq < _closestResult.distSq) {
      _closestResult.distSq = distSq;
      _closestResult.index = neighborIndex;
    }
  }

  return _closestResult.index === -1 ? null : _closestResult;
}

// ==========================================
// HELPER: Check if stored target is still valid
// ==========================================

function isStoredTargetValid(owner, i) {
  const targetIndex = PersonComponent.closestEnemyIndex[i];
  if (targetIndex < 0) return false;
  if (LootableComponent.health[targetIndex] <= 0) return false;
  if (!Ray.hasLineOfSight(owner.index, targetIndex)) return false;
  return true;
}

// ==========================================
// HELPER: Store target in PersonComponent
// ==========================================

function storeTarget(i, targetIndex, distSq) {
  PersonComponent.closestEnemyIndex[i] = targetIndex;
  PersonComponent.closestEnemyDistanceSq[i] = distSq;
}

function clearTarget(i) {
  PersonComponent.closestEnemyIndex[i] = -1;
  PersonComponent.closestEnemyDistanceSq[i] = Infinity;
}

// ==========================================
// HELPER: Check if soldier can shoot target
// ==========================================

function canShootTarget(owner, targetDistSq) {
  if (!owner.hasGun()) return false;
  const weapon = owner.getBestWeapon();
  return targetDistSq <= weapon.rangeSq;
}

// ==========================================
// HELPER: Get destination
// ==========================================

function getDestination() {
  return Destination.getFirstActiveInstance();
}

// ==========================================
// IDLE STATE - Scan for enemies, decide next action
// ==========================================

class IdleSoldierState extends FSMState {
  static onEnter(owner, i, fromState) {
    clearTarget(i);
  }

  static onUpdate(owner, i, dt) {
    // Scan for civilians
    const closest = findClosestCivilian(owner);

    if (closest) {
      // Store target in PersonComponent
      storeTarget(i, closest.index, closest.distSq);

      // Priority A: Can we shoot?
      if (canShootTarget(owner, closest.distSq)) {
        this.fsm.changeState(i, this.fsm.states.RANGED_ATTACKING);
        return;
      }

      // Priority B: Close enough to punch?
      const punchRangeSq = owner.constructor.punchRangeSq;
      if (closest.distSq <= punchRangeSq) {
        this.fsm.changeState(i, this.fsm.states.CLOSE_ATTACKING);
        return;
      }

      // Priority C: Chase the target
      this.fsm.changeState(i, this.fsm.states.GOING_TO_ENEMY);
      return;
    }

    // No enemies - flock with team
    owner.groupWithMyTeam();
    owner.separateFromTeam();

  }

}

// ==========================================
// GOING_TO_DESTINATION STATE - Following orders
// ==========================================

class GoingToDestinationState extends FSMState {
  static onEnter(owner, i, fromState) { }

  static onUpdate(owner, i, dt) {
    const dest = getDestination();

    if (!dest) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    owner.groupWithMyTeam();
    owner.separateFromTeam();

    // Check if reached destination
    const distSqToDest = distanceSq2D(owner.x, owner.y, dest.x, dest.y);
    if (distSqToDest < dest.collider.radius ** 2) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // Follow flowfield toward destination
    NavGrid.requestVector(owner.x, owner.y, dest.x, dest.y, _navVec);

    const followStrength = 0.1;
    owner.addAcceleration(_navVec.x * followStrength, _navVec.y * followStrength);
  }
}

// ==========================================
// GOING_TO_ENEMY STATE - Chase stored target, rescan if needed
// ==========================================

class GoingToEnemyState extends FSMState {
  static onEnter(owner, i, fromState) { }

  static onUpdate(owner, i, dt) {
    const punchRangeSq = owner.constructor.punchRangeSq;

    // 1. Try to use stored target first
    if (isStoredTargetValid(owner, i)) {
      const targetIndex = PersonComponent.closestEnemyIndex[i];
      const targetX = Transform.x[targetIndex];
      const targetY = Transform.y[targetIndex];
      const distSq = distanceSq2D(owner.x, owner.y, targetX, targetY);

      // Update stored distance
      PersonComponent.closestEnemyDistanceSq[i] = distSq;

      // Can we shoot?
      if (canShootTarget(owner, distSq)) {
        this.fsm.changeState(i, this.fsm.states.RANGED_ATTACKING);
        return;
      }

      // Can we punch?
      if (distSq <= punchRangeSq) {
        this.fsm.changeState(i, this.fsm.states.CLOSE_ATTACKING);
        return;
      }

      // Chase toward stored target
      owner.groupWithMyTeam();
      owner.separateFromTeam();

      const chaseStrength = 0.15;
      const dist = Math.sqrt(distSq);
      if (dist > 0) {
        const dx = targetX - owner.x;
        const dy = targetY - owner.y;
        RigidBody.ax[i] += (dx / dist) * chaseStrength;
        RigidBody.ay[i] += (dy / dist) * chaseStrength;
      }
      return;
    }

    // 2. Stored target invalid - rescan
    const closest = findClosestCivilian(owner);

    if (closest) {
      // Update stored target, stay in GOING_TO_ENEMY
      storeTarget(i, closest.index, closest.distSq);
      // Next tick will use new target
    } else {
      // No enemies found
      clearTarget(i);
      this.fsm.changeState(i, this.fsm.states.IDLE);
    }
  }
}

// ==========================================
// RANGED_ATTACKING STATE - Fire once, wait, return to IDLE
// ==========================================

class RangedAttackingState extends FSMState {
  static onEnter(owner, i, fromState) {

  }

  static onUpdate(owner, i, dt, totalTime) {

    const targetIndex = PersonComponent.closestEnemyIndex[i];
    if (targetIndex < 0) return;

    // Try to shoot (handles cooldown, animation, muzzle flash)

    owner.shoot(targetIndex);

    if (totalTime > SHOOT_DURATION_MS) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
    }
  }
}

// ==========================================
// CLOSE_ATTACKING STATE - Punch once, wait, return to IDLE
// ==========================================

class CloseAttackingState extends FSMState {
  static onEnter(owner, i, fromState) {
    const targetIndex = PersonComponent.closestEnemyIndex[i];
    if (targetIndex < 0) return;

    owner.punch(targetIndex);

  }

  static onUpdate(owner, i, dt) {
    // Wait for punch animation to finish
    if (!owner.isPerformingAction()) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
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
    RANGED_ATTACKING: RangedAttackingState,
    CLOSE_ATTACKING: CloseAttackingState,
  };

  static initial = this.states.IDLE;
}
