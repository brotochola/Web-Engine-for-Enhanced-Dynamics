// CivilianBehaviorFSM.js - FSM component for civilian behavior
// States: IDLE (do nothing) and FLEEING (run away from predators)

import WEED from '/src/index.js';

import { Player } from '../gameObjects/player.js';
import { MySoldier } from '../gameObjects/mySoldier.js';

const { FSM, FSMState, Transform, RigidBody } = WEED;

// ==========================================
// IDLE STATE - Do nothing, watch for predators
// ==========================================

class IdleCivilianBehaviorState extends FSMState {
  static onEnter(owner, i, fromState) { }

  static onUpdate(owner, i, dt) {
    // Check if any neighbor is a predator
    const playerEntityType = Player.entityType;
    const mySoldierEntityType = MySoldier.entityType;
    const neighborCount = owner.neighborCount;

    for (let n = 0; n < neighborCount; n++) {
      const neighborIndex = owner.getNeighbor(n);
      const neighBorEntityType = Transform.entityType[neighborIndex];
      if (neighBorEntityType === playerEntityType || neighBorEntityType === mySoldierEntityType) {
        // Player or my soldier detected! Flee!
        this.fsm.changeState(i, this.fsm.states.FLEEING);
        return;
      }
    }
    // owner.updateTeamData();
    // owner.groupWithMyTeam();
  }
}

// ==========================================
// FLEEING STATE - Run away from predators
// ==========================================

class FleeingCivilianBehaviorState extends FSMState {
  static onEnter(owner, i, fromState) {
    // Will set run animation in onUpdate based on direction
  }

  static onUpdate(owner, i, dt) {
    const playerEntityType = Player.entityType;

    const mySoldierEntityType = MySoldier.entityType;
    const neighborCount = owner.neighborCount;

    // Accumulate flee direction from all visible predators
    let fleeX = 0;
    let fleeY = 0;
    let predatorCount = 0;

    const myX = Transform.x[i];
    const myY = Transform.y[i];

    for (let n = 0; n < neighborCount; n++) {
      const neighborIndex = owner.getNeighbor(n);

      const neighBorEntityType = Transform.entityType[neighborIndex];
      if (neighBorEntityType === playerEntityType || neighBorEntityType === mySoldierEntityType) {
        // Calculate direction away from predator
        const dx = myX - Transform.x[neighborIndex];
        const dy = myY - Transform.y[neighborIndex];
        const dist2 = dx * dx + dy * dy;

        if (dist2 > 0) {
          // Inverse square for panic effect (closer = stronger flee)
          fleeX += dx / dist2;
          fleeY += dy / dist2;
          predatorCount++;
        }
      }
    }

    // If no predators visible, return to idle
    if (predatorCount === 0) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // Apply flee acceleration
    const fleeFactor = 50; // How strongly to flee
    RigidBody.ax[i] += fleeX * fleeFactor * dt;
    RigidBody.ay[i] += fleeY * fleeFactor * dt;
  }

  static onExit(owner, i, toState) {
    // Could play relief sound, slow down animation, etc.
  }
}

// ==========================================
// FSM COMPONENT
// ==========================================

export class CivilianBehaviorFSM extends FSM {
  static states = {
    IDLE: IdleCivilianBehaviorState,
    FLEEING: FleeingCivilianBehaviorState,
  };

  static initial = this.states.IDLE;
}
