// CivilianBehaviorFSM.js - FSM component for civilian behavior
// States: IDLE (do nothing) and FLEEING (run away from predators)
//
// The states work by entity index (E-530: Predator written static): positions and neighbours come from the columns and
// Grid's statics, the civilian's tuning from its class (GameObject.classByType), and no state touches the instance.

import WEED from '/src/index.js';

// import { Player } from '../gameObjects/player.js';
import { MySoldier } from '../gameObjects/mySoldier.js';
import { CivilianComponent } from '../components/civilianComponent.js';
import { SoldierBehaviorFSM } from './soldierBehaviorFsm.js';

const { FSM, FSMState, Transform, GameObject, Grid, RigidBody } = WEED;

/** The civilian's class (Civilian or a subclass of it): its tuning statics (accelDistFloorSq, panicFleeFactor). */
function civilianClassOf(i) {
  return GameObject.classByType[Transform.entityType[i]];
}

/** Attacking soldier → panic (updates origin). Returns true if panic handled. */
function tryPanicFromAttackingSoldier(i, neighborIndex, soldierType) {
  if (Transform.entityType[neighborIndex] !== soldierType) return false;
  const stateIndex = SoldierBehaviorFSM.state[neighborIndex];
  const ranged = SoldierBehaviorFSM.states.RANGED_ATTACKING.stateIndex;
  const close = SoldierBehaviorFSM.states.CLOSE_ATTACKING.stateIndex;
  if (stateIndex !== ranged && stateIndex !== close) return false;

  CivilianComponent.panicOriginX[i] = Transform.x[neighborIndex];
  CivilianComponent.panicOriginY[i] = Transform.y[neighborIndex];

  const PANIC = CivilianBehaviorFSM.states.PANIC;
  if (!CivilianBehaviorFSM.isInState(i, PANIC)) {
    CivilianBehaviorFSM.changeState(i, PANIC);
  }
  return true;
}

// ==========================================
// IDLE STATE - Do nothing, watch for predators
// ==========================================

class IdleCivilianBehaviorState extends FSMState {
  static onEnter(owner, i, fromState) { }

  static onUpdate(owner, i, dt) {
    // const playerEntityType = Player.entityType;
    const mySoldierEntityType = MySoldier.entityType;
    const rows = Grid.neighborData; // the neighbour row, read straight: its count, then the ids
    const row = Grid.getNeighborOffset(i);
    const neighborCount = rows[row];

    for (let n = 1; n <= neighborCount; n++) {
      const neighborIndex = rows[row + n];
      // Violence/panic wins over plain flee (same priority as old post-FSM scan)
      if (tryPanicFromAttackingSoldier(i, neighborIndex, mySoldierEntityType)) {
        return;
      }
      const neighBorEntityType = Transform.entityType[neighborIndex];
      if (neighBorEntityType === mySoldierEntityType) {
        this.fsm.changeState(i, this.fsm.states.FLEEING);
        return;
      }
    }
  }
}

// ==========================================
// FLEEING STATE - Run away from predators
// ==========================================

class FleeingCivilianBehaviorState extends FSMState {
  static onUpdate(owner, i, dt) {
    // const playerEntityType = Player.entityType;
    const mySoldierEntityType = MySoldier.entityType;
    const rows = Grid.neighborData; // the neighbour row, read straight: its count, then the ids
    const row = Grid.getNeighborOffset(i);
    const neighborCount = rows[row];
    const floorSq = civilianClassOf(i).accelDistFloorSq;

    let fleeX = 0;
    let fleeY = 0;
    let predatorCount = 0;

    const myX = Transform.x[i];
    const myY = Transform.y[i];

    for (let n = 1; n <= neighborCount; n++) {
      const neighborIndex = rows[row + n];

      if (tryPanicFromAttackingSoldier(i, neighborIndex, mySoldierEntityType)) {
        return;
      }

      const neighBorEntityType = Transform.entityType[neighborIndex];
      if (neighBorEntityType === mySoldierEntityType) {
        const dx = myX - Transform.x[neighborIndex];
        const dy = myY - Transform.y[neighborIndex];
        const dist2 = dx * dx + dy * dy;

        if (dist2 > 1) {
          const d2 = dist2 < floorSq ? floorSq : dist2;
          fleeX += dx / d2;
          fleeY += dy / d2;
          predatorCount++;
        }
      }
    }

    if (predatorCount === 0) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    const fleeFactor = 40500 / predatorCount;
    RigidBody.ax[i] += fleeX * fleeFactor;
    RigidBody.ay[i] += fleeY * fleeFactor;
  }

  static onExit(owner, i, toState) {
  }
}

const PANIC_DURATION_MS = 20_000;

class PanicCivilianBehaviorState extends FSMState {
  static onUpdate(owner, i, dt, totalTime) {
    if (totalTime >= PANIC_DURATION_MS) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // Refresh panic origin from nearby attackers (one walk; was separate violence scan)
    const mySoldierEntityType = MySoldier.entityType;
    const rows = Grid.neighborData; // the neighbour row, read straight: its count, then the ids
    const row = Grid.getNeighborOffset(i);
    const neighborCount = rows[row];
    for (let n = 1; n <= neighborCount; n++) {
      const neighborIndex = rows[row + n];
      if (tryPanicFromAttackingSoldier(i, neighborIndex, mySoldierEntityType)) {
        break;
      }
    }

    const ox = CivilianComponent.panicOriginX[i];
    const oy = CivilianComponent.panicOriginY[i];
    const dx = Transform.x[i] - ox;
    const dy = Transform.y[i] - oy;
    const dist2 = dx * dx + dy * dy;

    if (dist2 > 1) {
      const Civilian = civilianClassOf(i);
      const floorSq = Civilian.accelDistFloorSq;
      const d2 = dist2 < floorSq ? floorSq : dist2;
      const panicFleeFactor = Civilian.panicFleeFactor;
      RigidBody.ax[i] += (dx / d2) * panicFleeFactor;
      RigidBody.ay[i] += (dy / d2) * panicFleeFactor;
    }
  }

  static onExit(owner, i, toState) {
  }
}

// ==========================================
// FSM COMPONENT
// ==========================================

export class CivilianBehaviorFSM extends FSM {
  static states = {
    IDLE: IdleCivilianBehaviorState,
    FLEEING: FleeingCivilianBehaviorState,
    PANIC: PanicCivilianBehaviorState,
  };

  static initial = this.states.IDLE;
}
