// SoldierBehaviorFSM.js - FSM component for soldier behavior
// States: IDLE, GOING_TO_DESTINATION, GOING_TO_ENEMY, CLOSE_ATTACKING, RANGED_ATTACKING

import WEED from '/src/index.js';
import { SHOOT_DURATION_MS, WALK_SPEED_THRESHOLD } from './personAnimationFSM.js';
import { Civilian } from '../gameObjects/civilian.js';
import { Destination } from '../gameObjects/destination.js';
import { NavGrid } from '/src/core/NavGrid.js';
import { PersonComponent, DIRECTION_NAMES } from '../components/personComponent.js';

import { LootableComponent } from '../components/lootableComponent.js';

const { distanceSq2D, Ray, DebugDraw, FSM, FSMState, Transform, GameObject, Collider } = WEED;

// ==========================================
// REUSABLE OBJECTS - Zero allocation
// ==========================================

const _closestResult = { index: -1, distSq: Infinity };
const _navVec = { x: 0, y: 0 };

/** Max LOS rays per findACivilianToShoot scan (closest-first). */
const SHOOT_LOS_CANDIDATE_K = 4;
const _shootCandIndex = new Int32Array(SHOOT_LOS_CANDIDATE_K);
const _shootCandDistSq = new Float64Array(SHOOT_LOS_CANDIDATE_K);

/** Reuse LOS for same target this many logic frames. */
const LOS_CACHE_FRAMES = 4;

// ==========================================
// HELPER: Find closest civilian in neighbors
// ==========================================

function findClosestCivilian(owner) {
  const civilianType = Civilian.entityType;
  _closestResult.index = -1;
  _closestResult.distSq = Infinity;

  // Get owner's collider position (Transform + Collider.offset)
  const ownerX = Transform.x[owner.index] + (Collider.offsetX[owner.index] || 0);
  const ownerY = Transform.y[owner.index] + (Collider.offsetY[owner.index] || 0);
  const neighborCount = owner.neighborCount;

  for (let n = 0; n < neighborCount; n++) {
    const neighborIndex = owner.getNeighbor(n);
    if (Transform.entityType[neighborIndex] !== civilianType) continue;
    if (LootableComponent.health[neighborIndex] <= 0) continue;
    // if (!Ray.hasLineOfSight(owner.index, neighborIndex)) continue;

    // Calculate distance on-the-fly (collider positions)
    const neighborX = Transform.x[neighborIndex] + (Collider.offsetX[neighborIndex] || 0);
    const neighborY = Transform.y[neighborIndex] + (Collider.offsetY[neighborIndex] || 0);
    const dx = neighborX - ownerX;
    const dy = neighborY - ownerY;
    const distSq = dx * dx + dy * dy;

    if (distSq < _closestResult.distSq) {
      _closestResult.distSq = distSq;
      _closestResult.index = neighborIndex;
    }
  }

  return _closestResult.index === -1 ? null : _closestResult;
}

function findACivilianToShoot(owner) {
  const civilianType = Civilian.entityType;
  const ownerX = Transform.x[owner.index] + (Collider.offsetX[owner.index] || 0);
  const ownerY = Transform.y[owner.index] + (Collider.offsetY[owner.index] || 0);

  // Pass 1: keep K nearest living civilians (no LOS yet)
  let candCount = 0;
  for (let k = 0; k < SHOOT_LOS_CANDIDATE_K; k++) {
    _shootCandDistSq[k] = Infinity;
    _shootCandIndex[k] = -1;
  }

  const neighborCount = owner.neighborCount;

  for (let n = 0; n < neighborCount; n++) {
    const neighborIndex = owner.getNeighbor(n);
    if (Transform.entityType[neighborIndex] !== civilianType) continue;
    if (LootableComponent.health[neighborIndex] <= 0) continue;

    const neighborX = Transform.x[neighborIndex] + (Collider.offsetX[neighborIndex] || 0);
    const neighborY = Transform.y[neighborIndex] + (Collider.offsetY[neighborIndex] || 0);
    const dx = neighborX - ownerX;
    const dy = neighborY - ownerY;
    const distSq = dx * dx + dy * dy;

    // Insert into sorted ascending distSq (small fixed K)
    if (candCount < SHOOT_LOS_CANDIDATE_K) {
      let slot = candCount++;
      while (slot > 0 && distSq < _shootCandDistSq[slot - 1]) {
        _shootCandDistSq[slot] = _shootCandDistSq[slot - 1];
        _shootCandIndex[slot] = _shootCandIndex[slot - 1];
        slot--;
      }
      _shootCandDistSq[slot] = distSq;
      _shootCandIndex[slot] = neighborIndex;
    } else if (distSq < _shootCandDistSq[SHOOT_LOS_CANDIDATE_K - 1]) {
      let slot = SHOOT_LOS_CANDIDATE_K - 1;
      while (slot > 0 && distSq < _shootCandDistSq[slot - 1]) {
        _shootCandDistSq[slot] = _shootCandDistSq[slot - 1];
        _shootCandIndex[slot] = _shootCandIndex[slot - 1];
        slot--;
      }
      _shootCandDistSq[slot] = distSq;
      _shootCandIndex[slot] = neighborIndex;
    }
  }

  // Pass 2: LOS only on closest-first shortlist (≤ K rays)
  for (let k = 0; k < candCount; k++) {
    const neighborIndex = _shootCandIndex[k];
    if (!Ray.hasLineOfSight(owner.index, neighborIndex)) continue;
    _closestResult.index = neighborIndex;
    _closestResult.distSq = _shootCandDistSq[k];
    return _closestResult;
  }
  return null;
}

// ==========================================
// HELPER: Check if stored target is still valid
// ==========================================

function isStoredTargetValid(owner, i) {
  const targetIndex = PersonComponent.closestEnemyIndex[i];
  if (targetIndex < 0) return false;
  if (LootableComponent.health[targetIndex] <= 0) return false;
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

function canShootTarget(owner, targetIndex, targetDistSq) {
  if (!owner.hasGun()) return false;
  const weapon = owner.getBestWeapon();
  if (targetDistSq > weapon.rangeSq) return false;

  const frame = owner._logicFrame | 0;
  if (
    owner._losCacheTarget === targetIndex &&
    frame < (owner._losCacheUntilFrame | 0)
  ) {
    return owner._losCacheClear === 1;
  }

  const hasLOS = Ray.hasLineOfSight(owner.index, targetIndex);
  owner._losCacheTarget = targetIndex;
  owner._losCacheClear = hasLOS ? 1 : 0;
  owner._losCacheUntilFrame = frame + LOS_CACHE_FRAMES;
  return hasLOS;
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
    // Scan for civilians: gun → need LOS; no gun → closest (melee)
    const closest = owner.hasGun() ? findACivilianToShoot(owner) : findClosestCivilian(owner);

    if (closest) {
      // Store target in PersonComponent
      storeTarget(i, closest.index, closest.distSq);

      // Priority A: Can we shoot?
      if (canShootTarget(owner, closest.index, closest.distSq)) {
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

    // No enemies — flock apply (group/separate) disabled; skip updateTeamData neighbor walk
    // owner.updateTeamData();
    // owner.groupWithMyTeam();
    // owner.separateFromTeam();

  }

}

// ==========================================
// GOING_TO_DESTINATION STATE - Following orders
// ==========================================

class GoingToDestinationState extends FSMState {
  static onUpdate(owner, i, dt) {
    const dest = getDestination();

    if (!dest) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // owner.updateTeamData();
    // // owner.groupWithMyTeam();
    // owner.separateFromTeam();

    // Check if reached destination
    const distSqToDest = distanceSq2D(owner.x, owner.y, dest.x, dest.y);
    if (distSqToDest < dest.collider.radius ** 2) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // Follow flowfield toward destination
    NavGrid.requestVector(owner.x, owner.y, dest.x, dest.y, _navVec);

    const followStrength = owner.constructor.followDestinationStrength;

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

      //todo: optimizar esto
      const destinationInstance = Destination.getFirstActiveInstance()
      if (distanceSq2D(owner.x, owner.y, destinationInstance.x, destinationInstance.y) > 600 ** 2) {
        this.fsm.changeState(i, this.fsm.states.GOING_TO_DESTINATION);
        return
      }

      // Update stored distance
      PersonComponent.closestEnemyDistanceSq[i] = distSq;

      // Can we shoot?
      if (canShootTarget(owner, targetIndex, distSq)) {
        this.fsm.changeState(i, this.fsm.states.RANGED_ATTACKING);
        return;
      }

      // Can we punch?
      if (distSq <= punchRangeSq) {
        this.fsm.changeState(i, this.fsm.states.CLOSE_ATTACKING);
        return;
      }

      // Chase toward stored target
      // owner.groupWithMyTeam();
      // owner.separateFromTeam();

      const chaseStrength = owner.constructor.chaseStrength;
      // 1/r, no sqrt: |a| = chaseStrength / dist. Floor distSq so close range can't rocket.
      if (distSq > 1) {
        const dx = targetX - owner.x;
        const dy = targetY - owner.y;
        const floorSq = owner.constructor.punchRangeSq;
        const d2 = distSq < floorSq ? floorSq : distSq;
        owner.addAcceleration((dx / d2) * chaseStrength, (dy / d2) * chaseStrength);
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
    // Stop running momentum when entering shoot stance; allows external pushes afterward
    owner.setVelocity(0, 0);
  }

  static onUpdate(owner, i, dt, totalTime) {
    const targetIndex = PersonComponent.closestEnemyIndex[i];
    if (targetIndex < 0) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    const distSq = distanceSq2D(owner.x, owner.y, Transform.x[targetIndex], Transform.y[targetIndex]);
    if (!canShootTarget(owner, targetIndex, distSq)) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

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
