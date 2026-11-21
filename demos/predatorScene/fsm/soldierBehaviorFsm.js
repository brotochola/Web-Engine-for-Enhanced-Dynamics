// SoldierBehaviorFSM.js - FSM component for soldier behavior
// States: IDLE, GOING_TO_DESTINATION, GOING_TO_ENEMY, CLOSE_ATTACKING, RANGED_ATTACKING
//
// The states work by entity index (E-530: Predator written static): positions, velocities and neighbours come from the
// columns and Grid's statics, the soldier's tuning from its class (GameObject.classByType). A state gets the index
// alone; the actions (shoot, punch) are the soldier class's statics (Person.shoot(i, target)), called on its class so
// its tuning (muzzle, punch damage) applies. No state makes an instance.

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

// E-543: the target's squared distance travels in a Float64Array. A double stored in a scratch object's field, or
// passed to a call TurboFan leaves out (canShootTarget, in a state that also inlines the shot), is boxed: the soldier
// states made about 5 KB of heap numbers a frame on each logic worker in the mixed battle.
const INF = Infinity;
/** [0]: the squared distance to the target the last scan found, or the one the shot check is asked about. */
const TARGET_DIST_SQ = new Float64Array(1);
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

/** The closest living civilian among the soldier's neighbours, or -1; its squared distance in TARGET_DIST_SQ[0]. */
function findClosestCivilian(i) {
  const civilianType = Civilian.entityType;
  let bestIndex = -1;
  let bestDistSq = INF;

  // The soldier's collider position (Transform + Collider.offset)
  const ownerX = Transform.x[i] + (Collider.offsetX[i] || 0);
  const ownerY = Transform.y[i] + (Collider.offsetY[i] || 0);
  // The neighbour row read straight (its count, then the ids): half the cost of Grid.getNeighbor per neighbour.
  const rows = Grid.neighborData;
  const row = Grid.getNeighborOffset(i);
  const neighborCount = rows[row];

  for (let n = 1; n <= neighborCount; n++) {
    const neighborIndex = rows[row + n];
    if (Transform.entityType[neighborIndex] !== civilianType) continue;
    if (LootableComponent.health[neighborIndex] <= 0) continue;

    // Calculate distance on-the-fly (collider positions)
    const neighborX = Transform.x[neighborIndex] + (Collider.offsetX[neighborIndex] || 0);
    const neighborY = Transform.y[neighborIndex] + (Collider.offsetY[neighborIndex] || 0);
    const dx = neighborX - ownerX;
    const dy = neighborY - ownerY;
    const distSq = dx * dx + dy * dy;

    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIndex = neighborIndex;
    }
  }

  TARGET_DIST_SQ[0] = bestDistSq;
  return bestIndex;
}

/** The closest living civilian in line of sight (of the K nearest), or -1; its squared distance in TARGET_DIST_SQ[0]. */
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

  // The neighbour row read straight (its count, then the ids): half the cost of Grid.getNeighbor per neighbour.
  const rows = Grid.neighborData;
  const row = Grid.getNeighborOffset(i);
  const neighborCount = rows[row];

  for (let n = 1; n <= neighborCount; n++) {
    const neighborIndex = rows[row + n];
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
    TARGET_DIST_SQ[0] = _shootCandDistSq[k];
    return neighborIndex;
  }
  return -1;
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

/** The scan's target and its squared distance (TARGET_DIST_SQ[0]) into the soldier's PersonComponent row. */
function storeTarget(i, targetIndex) {
  PersonComponent.closestEnemyIndex[i] = targetIndex;
  PersonComponent.closestEnemyDistanceSq[i] = TARGET_DIST_SQ[0];
}

function clearTarget(i) {
  PersonComponent.closestEnemyIndex[i] = -1;
  PersonComponent.closestEnemyDistanceSq[i] = Infinity;
}

// ==========================================
// HELPER: Check if soldier can shoot target
// ==========================================

/** Whether soldier i can shoot targetIndex, at the squared distance in TARGET_DIST_SQ[0]: in range and in sight. */
function canShootTarget(i, targetIndex) {
  const targetDistSq = TARGET_DIST_SQ[0];
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

/** The destination's entity index (the scene spawns one), or -1 while none is active. */
function destinationIndex() {
  const index = Destination.getFirstActiveIndex();
  return index === null ? -1 : index;
}

// ==========================================
// IDLE STATE - Scan for enemies, decide next action
// ==========================================

class IdleSoldierState extends FSMState {
  static onEnter(i, fromState) {
    clearTarget(i);
    ensureSoldierCaches(i);
    idleScanAt[i] = 0;
  }

  static onUpdate(i, dt) {
    // A scan walks every neighbour (and casts rays with a gun): when the last one found nobody, wait a few frames.
    ensureSoldierCaches(i);
    const frame = soldierFrame;
    if (frame < idleScanAt[i]) return;

    // Scan for civilians: gun → need LOS; no gun → closest (melee)
    const closest = Person.hasGun(i) ? findACivilianToShoot(i) : findClosestCivilian(i);

    if (closest >= 0) {
      // Store target in PersonComponent
      storeTarget(i, closest);

      // Priority A: Can we shoot?
      if (canShootTarget(i, closest)) {
        this.fsm.changeState(i, this.fsm.states.RANGED_ATTACKING);
        return;
      }

      // Priority B: Close enough to punch?
      if (TARGET_DIST_SQ[0] <= soldierClassOf(i).punchRangeSq) {
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
  static onUpdate(i, dt) {
    const dest = destinationIndex();

    if (dest < 0) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // Check if reached destination (inside its trigger circle)
    const x = Transform.x[i];
    const y = Transform.y[i];
    const destX = Transform.x[dest];
    const destY = Transform.y[dest];
    const distSqToDest = distanceSq2D(x, y, destX, destY);
    if (distSqToDest < Collider.radius[dest] ** 2) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // Follow flowfield toward destination
    NavGrid.requestVector(x, y, destX, destY, _navVec);

    const followStrength = soldierClassOf(i).followDestinationStrength;
    RigidBody.ax[i] += _navVec.x * followStrength;
    RigidBody.ay[i] += _navVec.y * followStrength;
  }
}

// ==========================================
// GOING_TO_ENEMY STATE - Chase stored target, rescan if needed
// ==========================================

class GoingToEnemyState extends FSMState {
  static onEnter(i, fromState) { }

  static onUpdate(i, dt) {
    // 1. Try to use stored target first
    if (isStoredTargetValid(i)) {
      const targetIndex = PersonComponent.closestEnemyIndex[i];

      const x = Transform.x[i];
      const y = Transform.y[i];
      const targetX = Transform.x[targetIndex];
      const targetY = Transform.y[targetIndex];
      const distSq = distanceSq2D(x, y, targetX, targetY);

      // A soldier that chased too far (600 px) from the destination goes back to it; with no destination, no leash.
      const dest = destinationIndex();
      if (dest >= 0 && distanceSq2D(x, y, Transform.x[dest], Transform.y[dest]) > 600 ** 2) {
        this.fsm.changeState(i, this.fsm.states.GOING_TO_DESTINATION);
        return;
      }

      // Update stored distance
      PersonComponent.closestEnemyDistanceSq[i] = distSq;

      // Can we shoot?
      TARGET_DIST_SQ[0] = distSq;
      if (canShootTarget(i, targetIndex)) {
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

    if (closest >= 0) {
      // Update stored target, stay in GOING_TO_ENEMY
      storeTarget(i, closest);
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
  static onEnter(i, fromState) {
    // Stop running momentum when entering shoot stance; allows external pushes afterward
    RigidBody.setVelocity(i, 0, 0);
  }

  static onUpdate(i, dt, totalTime) {
    const targetIndex = PersonComponent.closestEnemyIndex[i];
    if (targetIndex < 0) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    TARGET_DIST_SQ[0] = distanceSq2D(Transform.x[i], Transform.y[i], Transform.x[targetIndex], Transform.y[targetIndex]);
    if (!canShootTarget(i, targetIndex)) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // The shot itself (bullet, flash, sound, particles): the soldier's class fires it, by index.
    soldierClassOf(i).shoot(i, targetIndex);

    if (totalTime > SHOOT_DURATION_MS) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
    }
  }
}

// ==========================================
// CLOSE_ATTACKING STATE - Punch once, wait, return to IDLE
// ==========================================

class CloseAttackingState extends FSMState {
  static onEnter(i, fromState) {
    const targetIndex = PersonComponent.closestEnemyIndex[i];
    if (targetIndex < 0) return;

    // The soldier's class throws the punch, with its punchDamage.
    soldierClassOf(i).punch(i, targetIndex);
  }

  static onUpdate(i, dt) {
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
