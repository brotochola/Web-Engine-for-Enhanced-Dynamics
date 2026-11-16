// PersonAnimationFSM.js - FSM for person animation states
// Handles locomotion (idle/walk/run) and action animations (shoot, melee, hurt, die)

import WEED from '/src/index.js';
import { LootableComponent } from '../components/lootableComponent.js';

const { FSM, FSMState, RigidBody } = WEED;

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
// const HURT_DURATION_MS = (2 * NATURAL_DURATION) / ACTION_ANIM_SPEED;
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
  static onEnter(owner, i, fromState) {
    // Skip animation if no spritesheet set yet (FSM auto-init runs before onSpawned)
    if (!owner.spriteRenderer?.spritesheetId) return;

    owner.directionalSprite.facingFrom = 'velocity';
    owner.setAnimation('idle');
    owner.setAnimationSpeed(IDLE_ANIMATION_MULTIPLIER);
  }

  static onUpdate(owner, i, dt) {
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
  static onEnter(owner, i, fromState) {
    if (!owner.spriteRenderer?.spritesheetId) return;
    owner.directionalSprite.facingFrom = 'velocity';
    owner.setAnimation('walk');
    owner.setAnimationSpeed(RigidBody.speed[i] * WALK_ANIMATION_MULTIPLIER);
  }

  static onUpdate(owner, i, dt) {
    // Check for death first (highest priority)
    if (LootableComponent.health[i] <= 0) {
      this.fsm.changeState(i, this.fsm.states.DYING);
      return;
    }

    const speed = RigidBody.speed[i];

    owner.setAnimationSpeed(speed * WALK_ANIMATION_MULTIPLIER);

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
  static onEnter(owner, i, fromState) {
    if (!owner.spriteRenderer?.spritesheetId) return;
    owner.directionalSprite.facingFrom = 'velocity';
    owner.setAnimation('run');
    owner.setAnimationSpeed(RigidBody.speed[i] * RUN_ANIMATION_MULTIPLIER);
  }

  static onUpdate(owner, i, dt) {
    // Check for death first (highest priority)
    if (LootableComponent.health[i] <= 0) {
      this.fsm.changeState(i, this.fsm.states.DYING);
      return;
    }

    const speed = RigidBody.speed[i];

    owner.setAnimationSpeed(speed * RUN_ANIMATION_MULTIPLIER);

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
  static onEnter(owner, i, fromState) {
    if (!owner) return console.warn("ShootingState.onEnter called without owner", this.constructor.name);
    owner.setAnimation('shoot', false);
    owner.setAnimationSpeed(ACTION_ANIM_SPEED);
  }

  static onUpdate(owner, i, dt) {
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
  static onEnter(owner, i, fromState) {
    if (!owner.spriteRenderer?.spritesheetId) return;
    owner.setAnimation('slash');
    owner.setAnimationSpeed(ACTION_ANIM_SPEED);
  }

  static onUpdate(owner, i, dt) {
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
  static onEnter(owner, i, fromState) {
    if (!owner.spriteRenderer?.spritesheetId) return;
    owner.setAnimation('1h_slash');
    owner.setAnimationSpeed(ACTION_ANIM_SPEED);
  }

  static onUpdate(owner, i, dt) {
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
  static onEnter(owner, i, fromState) {
    if (!owner.spriteRenderer?.spritesheetId) return;
    owner.setAnimation('hurt'); // No direction for hurt
    owner.setAnimationSpeed(ACTION_ANIM_SPEED);
  }

  static onUpdate(owner, i, dt) {
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

  static onEnter(owner, i, fromState) {
    if (!owner.spriteRenderer?.spritesheetId) return;
    // Use hurt animation for death (no direction variant) - don't loop

    owner.setAnimation('hurt', false);
    owner.setAnimationSpeed(DYING_ANIM_SPEED);
  }

  static onUpdate(owner, i, dt) {
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
  static onEnter(owner, i, fromState) {
    if (!owner.spriteRenderer?.spritesheetId) return;
    // Stop on final frame, fade out
    owner.setAnimationSpeed(0);
    owner.onDeathAnimationComplete();
  }

  static onUpdate(owner, i, dt) {
    // Do nothing - Lootable.tick() handles despawn via die()
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
