// PersonAnimationFSM.js - FSM for person animation states
// Handles locomotion (idle/walk/run) and action animations (shoot, melee, hurt, die)
//
// The states work by entity index (E-530): the animation and the facing are set through SpriteRenderer's and
// DirectionalSprite's statics, which work whether the entity is written as objects or ECS-style, and the end of a death
// goes to the person's class (its static onDeathAnimationComplete), so no state makes an instance for Predator's people.
// carScene's walkers share it too: they are written as objects, so their death ends on their instance (DEAD's fallback).

import WEED from '/src/index.js';
import { LootableComponent } from '../components/lootableComponent.js';

const { FSM, FSMState, RigidBody, SpriteRenderer, DirectionalSprite, Transform, GameObject } = WEED;

const ACTION_ANIM_SPEED = 0.25;
const DYING_ANIM_SPEED = 0.5;
const NATURAL_DURATION = 16.667;
const SHOOT_FRAMES = 4;
const SLASH_FRAMES = 6; // For punch
const STICK_FRAMES = 13; // 1h_slash for stick hit
const HURT_FRAMES = 6;
const WALK_CYCLE_FRAMES = 9; // Walk cycle frames
const RUN_CYCLE_FRAMES = 8; // Run cycle frames

export const SHOOT_DURATION_MS = (SHOOT_FRAMES * NATURAL_DURATION) / ACTION_ANIM_SPEED
export const SLASH_DURATION_MS = (SLASH_FRAMES * NATURAL_DURATION)
export const STICK_DURATION_MS = (STICK_FRAMES * NATURAL_DURATION) / ACTION_ANIM_SPEED;
export const HURT_DURATION_MS = (2 * NATURAL_DURATION) / ACTION_ANIM_SPEED;
export const DYING_DURATION_MS = (HURT_FRAMES * NATURAL_DURATION) / DYING_ANIM_SPEED;

// Speed thresholds / anim rates — RigidBody.speed is px/s (was frame-vel)
export const RUN_SPEED_THRESHOLD = 105; // was 1.75 frame → ×60
export const WALK_SPEED_THRESHOLD = 4; // was 0.066 frame → ×60 (~3.96)
const RUN_ANIMATION_MULTIPLIER = 0.002; // was 0.12 / 60
const WALK_ANIMATION_MULTIPLIER = 0.00277; // was 0.166 / 60
const IDLE_ANIMATION_MULTIPLIER = 0.05; // idle is not speed-scaled

// Directions: each animation is played by its directionless name ('walk', 'shoot'); the person's DirectionalSprite draws the
// direction it faces. Moving states face where the body goes (facingFrom 'velocity': under 4 px/s, WALK_SPEED_THRESHOLD, it
// keeps its facing); the actions face their target (Person.shoot / punch set it, manual).

// ==========================================
// IDLE STATE - standing still
// ==========================================

class IdleState extends FSMState {
  static onEnter(i, fromState) {
    // Skip animation if no spritesheet set yet (nothing to play)
    if (SpriteRenderer.spritesheetId[i] === 0) return;

    DirectionalSprite.setFacingFrom(i, 'velocity');
    SpriteRenderer.setAnimation(i, 'idle');
    SpriteRenderer.setAnimationSpeed(i, IDLE_ANIMATION_MULTIPLIER);
  }

  static onUpdate(i, dt) {
    // Check for death first (highest priority)
    if (LootableComponent.health[i] <= 0) {

      this.fsm.changeState(i, this.fsm.states.DYING);
      return;
    }

    const speed = RigidBody.speed[i];

    if (speed > WALK_SPEED_THRESHOLD) {
      this.fsm.changeState(i, this.fsm.states.WALKING);
    }

  }
}

// ==========================================
// WALKING STATE - slow movement
// ==========================================

class WalkingState extends FSMState {
  static onEnter(i, fromState) {
    if (SpriteRenderer.spritesheetId[i] === 0) return;
    DirectionalSprite.setFacingFrom(i, 'velocity');
    SpriteRenderer.setAnimation(i, 'walk');
    SpriteRenderer.setAnimationSpeed(i, RigidBody.speed[i] * WALK_ANIMATION_MULTIPLIER);
  }

  static onUpdate(i, dt) {
    // Check for death first (highest priority)
    if (LootableComponent.health[i] <= 0) {
      this.fsm.changeState(i, this.fsm.states.DYING);
      return;
    }

    const speed = RigidBody.speed[i];

    SpriteRenderer.setAnimationSpeed(i, speed * WALK_ANIMATION_MULTIPLIER);

    // Stopped moving? -> Idle immediately
    if (speed <= WALK_SPEED_THRESHOLD) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
      return;
    }

    // Want to run? Wait for one walk cycle to complete
    if (speed > RUN_SPEED_THRESHOLD) {
      // const cycleDuration = WALK_CYCLE_FRAMES * (1000 / (speed * WALK_ANIMATION_MULTIPLIER * 60));
      // if (this.fsm.time[i] >= cycleDuration) {
      this.fsm.changeState(i, this.fsm.states.RUNNING);
      // }
    }
  }
}

// ==========================================
// RUNNING STATE - fast movement
// ==========================================

class RunningState extends FSMState {
  static onEnter(i, fromState) {
    if (SpriteRenderer.spritesheetId[i] === 0) return;
    DirectionalSprite.setFacingFrom(i, 'velocity');
    SpriteRenderer.setAnimation(i, 'run');
    SpriteRenderer.setAnimationSpeed(i, RigidBody.speed[i] * RUN_ANIMATION_MULTIPLIER);
  }

  static onUpdate(i, dt) {
    // Check for death first (highest priority)
    if (LootableComponent.health[i] <= 0) {
      this.fsm.changeState(i, this.fsm.states.DYING);
      return;
    }

    const speed = RigidBody.speed[i];

    SpriteRenderer.setAnimationSpeed(i, speed * RUN_ANIMATION_MULTIPLIER);

    // Want to walk? Wait for one run cycle to complete
    if (speed < RUN_SPEED_THRESHOLD) {
      // const cycleDuration = RUN_CYCLE_FRAMES * (1000 / (speed * RUN_ANIMATION_MULTIPLIER * 60));
      // if (this.fsm.time[i] >= cycleDuration) {
      this.fsm.changeState(i, this.fsm.states.WALKING);
      // }
    }
  }
}

// ==========================================
// SHOOTING STATE - one-shot shoot animation
// ==========================================

class ShootingState extends FSMState {
  static onEnter(i, fromState) {
    SpriteRenderer.setAnimation(i, 'shoot', false);
    SpriteRenderer.setAnimationSpeed(i, ACTION_ANIM_SPEED);
  }

  static onUpdate(i, dt) {
    if (LootableComponent.health[i] <= 0) {
      this.fsm.changeState(i, this.fsm.states.DYING);
      return;
    }

    if (this.fsm.time[i] >= SHOOT_DURATION_MS) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
    }
  }
}

// ==========================================
// PUNCHING STATE - one-shot slash animation
// ==========================================

class PunchingState extends FSMState {
  static onEnter(i, fromState) {
    if (SpriteRenderer.spritesheetId[i] === 0) return;
    SpriteRenderer.setAnimation(i, 'slash');
    SpriteRenderer.setAnimationSpeed(i, ACTION_ANIM_SPEED);
  }

  static onUpdate(i, dt) {
    // Death interrupts
    if (LootableComponent.health[i] <= 0) {
      this.fsm.changeState(i, this.fsm.states.DYING);
      return;
    }

    // Animation complete?
    if (this.fsm.time[i] >= SLASH_DURATION_MS) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
    }
  }
}

// ==========================================
// STICK HIT STATE - one-shot 1h_slash animation
// ==========================================

class StickHitState extends FSMState {
  static onEnter(i, fromState) {
    if (SpriteRenderer.spritesheetId[i] === 0) return;
    SpriteRenderer.setAnimation(i, '1h_slash');
    SpriteRenderer.setAnimationSpeed(i, ACTION_ANIM_SPEED);
  }

  static onUpdate(i, dt) {
    // Death interrupts
    if (LootableComponent.health[i] <= 0) {
      this.fsm.changeState(i, this.fsm.states.DYING);
      return;
    }

    // Animation complete?
    if (this.fsm.time[i] >= STICK_DURATION_MS) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
    }
  }
}

// ==========================================
// HURT STATE - one-shot hurt animation
// ==========================================

class HurtState extends FSMState {
  static onEnter(i, fromState) {
    if (SpriteRenderer.spritesheetId[i] === 0) return;
    SpriteRenderer.setAnimation(i, 'hurt'); // No direction for hurt
    SpriteRenderer.setAnimationSpeed(i, ACTION_ANIM_SPEED);
  }

  static onUpdate(i, dt) {
    // Death during hurt
    if (LootableComponent.health[i] <= 0) {
      this.fsm.changeState(i, this.fsm.states.DYING);
      return;
    }

    // Animation complete?
    if (this.fsm.time[i] >= HURT_DURATION_MS) {
      this.fsm.changeState(i, this.fsm.states.IDLE);
    }
  }
}

// ==========================================
// DYING STATE - death animation
// ==========================================

class DyingState extends FSMState {
  // Death animation speed (slower for dramatic effect)
  // static DYING_ANIM_SPEED = 0.2;
  // Duration = frames * ms per frame = 6 * (1000 / (speed * 60))
  // At speed 0.15: 6 * (1000 / 9) = 667ms
  // static DYING_DURATION_MS = 100//(HURT_FRAMES -1)* (1000 / (DyingState.DYING_ANIM_SPEED * 60))

  static onEnter(i, fromState) {
    if (SpriteRenderer.spritesheetId[i] === 0) return;
    // Use hurt animation for death (no direction variant) - don't loop
    SpriteRenderer.setAnimation(i, 'hurt', false);
    SpriteRenderer.setAnimationSpeed(i, DYING_ANIM_SPEED);
  }

  static onUpdate(i, dt) {
    // Animation complete? Transition to DEAD

    if (this.fsm.time[i] >= DYING_DURATION_MS) {
      this.fsm.changeState(i, this.fsm.states.DEAD);
    }
  }
}

// ==========================================
// DEAD STATE - final state
// ==========================================

class DeadState extends FSMState {
  static onEnter(i, fromState) {
    if (SpriteRenderer.spritesheetId[i] === 0) return;
    // Stop on final frame
    SpriteRenderer.setAnimationSpeed(i, 0);
    // The person's class ends it, by index (Person's static stamps the corpse, drops the loot and despawns).
    const PersonClass = GameObject.classByType[Transform.entityType[i]];
    if (typeof PersonClass.onDeathAnimationComplete === 'function') {
      PersonClass.onDeathAnimationComplete(i);
    } else {
      // Fallback for an object-style class that shares this FSM (carScene's PersonThatFollowsAFlowfield, whose
      // onDeathAnimationComplete is an instance method), never Predator's people: their static form is above.
      GameObject.get(i).onDeathAnimationComplete();
    }
  }

  static onUpdate(i, dt) {
    // Do nothing - onDeathAnimationComplete despawned the entity
  }
}

// ==========================================
// FSM COMPONENT
// ==========================================

export class PersonAnimationFSM extends FSM {
  static states = {
    IDLE: IdleState,
    WALKING: WalkingState,
    RUNNING: RunningState,
    SHOOTING: ShootingState,
    PUNCHING: PunchingState,
    STICK_HIT: StickHitState,
    HURT: HurtState,
    DYING: DyingState,
    DEAD: DeadState,
  };

  static initial = this.states.IDLE;
}
