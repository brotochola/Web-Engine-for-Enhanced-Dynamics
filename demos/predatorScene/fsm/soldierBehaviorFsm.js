// SoldierBehaviorFSM.js - FSM component for soldier behavior
// States: IDLE, GOING_TO_DESTINATION, GOING_TO_ENEMY, CLOSE_ATTACKING, RANGED_ATTACKING
//
// The states work by entity index (E-530: Predator written static): positions, velocities and neighbours come from the
// columns and Grid's statics, the soldier's tuning from its class (GameObject.classByType). Only the actions (shoot,
// punch) go through the instance, which the FSM still hands every state as `owner`.

import WEED from '/src/index.js';
import { SHOOT_DURATION_MS, WALK_SPEED_THRESHOLD } from './personAnimationFsm.js';
import { Civilian } from '../gameObjects/civilian.js';
import { Destination } from '../gameObjects/destination.js';
import { Person } from '../gameObjects/person.js';
import { PersonComponent } from '../components/personComponent.js';

import { LootableComponent } from '../components/lootableComponent.js';

const { distanceSq2D, Ray, DebugDraw, FSM, FSMState, Transform, GameObject, Collider, NavGrid, Grid, RigidBody } = WEED;

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

/** An idle soldier whose scan found nobody scans again after this many logic frames (~67 ms at 60 fps). */
const IDLE_RESCAN_FRAMES = 4;

/** The frames MySoldier.tickAll ran on this worker: the clock of the caches below (each worker counts its own). */
let soldierFrame = 0;

/** Called by MySoldier.tickAll once a frame, before the soldiers tick. */
export function advanceSoldierFrame() {
  soldierFrame++;
}

/**
 * Per soldier, by entity index, on this worker (scratch each logic worker keeps for the soldiers it ticks, as the
 * instance fields they replace were): the target its last line-of-sight ray went to, whether that ray was clear, the
 * frame until which that answer holds, and the frame from which an idle soldier that found nobody scans again.
 */
let losTarget = new Int32Array(0);
let losClear = new Uint8Array(0);
let losUntilFrame = new Int32Array(0);
let idleScanAt = new Int32Array(0);

/** Grows the caches above to hold entity index i (soldiers' indices come as their pool grows). */
function ensureSoldierCaches(i) {
  if (i < idleScanAt.length) return;
  const size = Math.max(i + 1, idleScanAt.length * 2, 1024);
  const grow = (old, Type) => {
    const next = new Type(size);
    next.set(old);
    return next;
  };
  losTarget = grow(losTarget, Int32Array);
  losClear = grow(losClear, Uint8Array);
  losUntilFrame = grow(losUntilFrame, Int32Array);
  idleScanAt = grow(idleScanAt, Int32Array);
}

/** The soldier's class (MySoldier or a subclass of it): its tuning statics (punch range, chase and follow strength). */
function soldierClassOf(i) {
  return GameObject.classByType[Transform.entityType[i]];
}

// ==========================================
// HELPER: Find closest civilian in neighbors
// ==========================================

function findClosestCivilian(i) {
  const civilianType = Civilian.entityType;
  _closestResult.index = -1;
  _closestResult.distSq = Infinity;

  // The soldier's collider position (Transform + Collider.offset)
  const ownerX = Transform.x[i] + (Collider.offsetX[i] || 0);
  const ownerY = Transform.y[i] + (Collider.offsetY[i] || 0);
  const neighborCount = Grid.getNeighborCount(i);

  for (let n = 0; n < neighborCount; n++) {
    const neighborIndex = Grid.getNeighbor(i, n);
    if (Transform.entityType[neighborIndex] !== civilianType) continue;
    if (LootableComponent.health[neighborIndex] <= 0) continue;

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

function findACivilianToShoot(i) {
  const civilianType = Civilian.entityType;
  const ownerX = Transform.x[i] + (Collider.offsetX[i] || 0);
  const ownerY = Transform.y[i] + (Collider.offsetY[i] || 0);

  // Pass 1: keep K nearest living civilians (no LOS yet)
  let candCount = 0;
  for (let k = 0; k < SHOOT_LOS_CANDIDATE_K; k++) {
    _shootCandDistSq[k] = Infinity;
    _shootCandIndex[k] = -1;
  }

  const neighborCount = Grid.getNeighborCount(i);

  for (let n = 0; n < neighborCount; n++) {
    const neighborIndex = Grid.getNeighbor(i, n);
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
    if (!Ray.hasLineOfSight(i, neighborIndex)) continue;
    _closestResult.index = neighborIndex;
    _closestResult.distSq = _shootCandDistSq[k];
    return _closestResult;
  }
  return null;
}

// ==========================================
// HELPER: Check if stored target is still valid
// ==========================================

function isStoredTargetValid(i) {
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

function canShootTarget(i, targetIndex, targetDistSq) {
  const weapon = Person.bestWeapon(i);
  if (weapon === null) return false;
  if (targetDistSq > weapon.rangeSq) return false;

  ensureSoldierCaches(i);
  const frame = soldierFrame;
  if (losTarget[i] === targetIndex && frame < losUntilFrame[i]) {
    return losClear[i] === 1;
  }

  const hasLOS = Ray.hasLineOfSight(i, targetIndex);
  losTarget[i] = targetIndex;
  losClear[i] = hasLOS ? 1 : 0;
  losUntilFrame[i] = frame + LOS_CACHE_FRAMES;
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
    ensureSoldierCaches(i);
    idleScanAt[i] = 0;
  }

  static onUpdate(owner, i, dt) {
    // A scan walks every neighbour (and casts rays with a gun): when the last one found nobody, wait a few frames.
    ensureSoldierCaches(i);
    const frame = soldierFrame;
    if (frame < idleScanAt[i]) return;

    // Scan for civilians: gun → need LOS; no gun → closest (melee)
    const closest = Person.hasGun(i) ? findACivilianToShoot(i) : findClosestCivilian(i);

    if (closest) {
      // Store target in PersonComponent
      storeTarget(i, closest.index, closest.distSq);

      // Priority A: Can we shoot?
      if (canShootTarget(i, closest.index, closest.distSq)) {
        this.fsm.changeState(i, this.fsm.states.RANGED_ATTACKING);
        return;
      }

      // Priority B: Close enough to punch?
      if (closest.distSq <= soldierClassOf(i).punchRangeSq) {
        this.fsm.changeState(i, this.fsm.states.CLOSE_ATTACKING);
        return;
      }

      // Priority C: Chase the target
      this.fsm.changeState(i, this.fsm.states.GOING_TO_ENEMY);
      return;
    }

    idleScanAt[i] = frame + IDLE_RESCAN_FRAMES;
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

    // Check if reached destination
    const x = Transform.x[i];
    const y = Transform.y[i];
    const distSqToDest = distanceSq2D(x, y, dest.x, dest.y);
    if (distSqToDest < dest.collider.radius ** 2) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // Follow flowfield toward destination
    NavGrid.requestVector(x, y, dest.x, dest.y, _navVec);

    const followStrength = soldierClassOf(i).followDestinationStrength;
    RigidBody.ax[i] += _navVec.x * followStrength;
    RigidBody.ay[i] += _navVec.y * followStrength;
  }
}

// ==========================================
// GOING_TO_ENEMY STATE - Chase stored target, rescan if needed
// ==========================================

class GoingToEnemyState extends FSMState {
  static onEnter(owner, i, fromState) { }

  static onUpdate(owner, i, dt) {
    // 1. Try to use stored target first
    if (isStoredTargetValid(i)) {
      const targetIndex = PersonComponent.closestEnemyIndex[i];

      const x = Transform.x[i];
      const y = Transform.y[i];
      const targetX = Transform.x[targetIndex];
      const targetY = Transform.y[targetIndex];
      const distSq = distanceSq2D(x, y, targetX, targetY);

      //todo: optimizar esto
      const destinationInstance = Destination.getFirstActiveInstance()
      if (distanceSq2D(x, y, destinationInstance.x, destinationInstance.y) > 600 ** 2) {
        this.fsm.changeState(i, this.fsm.states.GOING_TO_DESTINATION);
        return
      }

      // Update stored distance
      PersonComponent.closestEnemyDistanceSq[i] = distSq;

      // Can we shoot?
      if (canShootTarget(i, targetIndex, distSq)) {
        this.fsm.changeState(i, this.fsm.states.RANGED_ATTACKING);
        return;
      }

      // Can we punch?
      const Soldier = soldierClassOf(i);
      const punchRangeSq = Soldier.punchRangeSq;
      if (distSq <= punchRangeSq) {
        this.fsm.changeState(i, this.fsm.states.CLOSE_ATTACKING);
        return;
      }

      // Chase toward stored target
      // 1/r, no sqrt: |a| = chaseStrength / dist. Floor distSq so close range can't rocket.
      if (distSq > 1) {
        const chaseStrength = Soldier.chaseStrength;
        const dx = targetX - x;
        const dy = targetY - y;
        const d2 = distSq < punchRangeSq ? punchRangeSq : distSq;
        RigidBody.ax[i] += (dx / d2) * chaseStrength;
        RigidBody.ay[i] += (dy / d2) * chaseStrength;
      }
      return;
    }

    // 2. Stored target invalid - rescan
    const closest = findClosestCivilian(i);

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
    RigidBody.setVelocity(i, 0, 0);
  }

  static onUpdate(owner, i, dt, totalTime) {
    const targetIndex = PersonComponent.closestEnemyIndex[i];
    if (targetIndex < 0) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    const distSq = distanceSq2D(Transform.x[i], Transform.y[i], Transform.x[targetIndex], Transform.y[targetIndex]);
    if (!canShootTarget(i, targetIndex, distSq)) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // The shot itself (bullet, flash, sound, particles) is the instance's action.
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
    if (!Person.isPerformingAction(i)) {
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
