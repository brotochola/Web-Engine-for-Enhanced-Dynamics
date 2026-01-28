// PersonAnimationFSM.js - FSM for person animation states
// Handles locomotion (idle/walk/run) and action animations (shoot, melee, hurt, die)

import WEED from "/src/index.js";
import { PersonComponent, DIRECTION_NAMES } from "../components/personComponent.js";
import { LootableComponent } from "../components/lootableComponent.js";

const { FSM, FSMState, RigidBody, getDirectionFromAngle } = WEED;

// Animation durations in ms (frames * (1000 / (speed * 60)))
// Assumes animation speed of 0.2 for actions
const ACTION_ANIM_SPEED = 0.2;
const SHOOT_FRAMES = 13;
const SLASH_FRAMES = 6;      // For punch
const STICK_FRAMES = 13;     // 1h_slash for stick hit
const HURT_FRAMES = 6;

const SHOOT_DURATION_MS = SHOOT_FRAMES * (1000 / (ACTION_ANIM_SPEED * 60));  // ~1083ms
const SLASH_DURATION_MS = SLASH_FRAMES * (1000 / (ACTION_ANIM_SPEED * 60));  // ~500ms
const STICK_DURATION_MS = STICK_FRAMES * (1000 / (ACTION_ANIM_SPEED * 60));  // ~1083ms
const HURT_DURATION_MS = HURT_FRAMES * (1000 / (ACTION_ANIM_SPEED * 60));    // ~500ms

// ==========================================
// LOCOMOTION STATE - idle/walk/run based on velocity
// ==========================================

class LocomotionState extends FSMState {
    static onEnter(owner, i, fromState) {
        // Nothing special on enter - onUpdate will set correct animation
    }

    static onUpdate(owner, i, dt) {
        // Check for death first (highest priority)
        if (LootableComponent.health[i] <= 0) {
            this.fsm.changeState(i, this.fsm.states.DYING);
            return;
        }

        // Get velocity info
        const velocityAngle = RigidBody.velocityAngle[i];
        const speed = RigidBody.speed[i];

        // Update facing direction from velocity (only when moving)
        if (speed > 0.1) {
            const direction = getDirectionFromAngle(velocityAngle);
            // Convert direction string to index
            const dirIndex = DIRECTION_NAMES.indexOf(direction);
            if (dirIndex >= 0) {
                PersonComponent.facingDirection[i] = dirIndex;
            }
        }

        // Get current facing direction name
        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";

        if (speed > 0.1) {
            // Moving - choose walk or run based on speed threshold
            const isRunning = speed > 2;
            const animPrefix = isRunning ? "run" : "walk";
            owner.setAnimation(`${animPrefix}_${facingDir}`);
            owner.setAnimationSpeed(speed * 0.07);
        } else {
            // Idle
            owner.setAnimation(`idle_${facingDir}`);
            owner.setAnimationSpeed(0.15);
        }
    }
}

// ==========================================
// SHOOTING STATE - one-shot shoot animation
// ==========================================

class ShootingState extends FSMState {
    static onEnter(owner, i, fromState) {
        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";
        owner.setAnimation(`shoot_${facingDir}`);
        owner.setAnimationSpeed(ACTION_ANIM_SPEED);
    }

    static onUpdate(owner, i, dt) {
        // Death interrupts
        if (LootableComponent.health[i] <= 0) {
            this.fsm.changeState(i, this.fsm.states.DYING);
            return;
        }

        // Animation complete?
        if (this.fsm.time[i] >= SHOOT_DURATION_MS) {
            this.fsm.changeState(i, this.fsm.states.LOCOMOTION);
        }
    }
}

// ==========================================
// PUNCHING STATE - one-shot slash animation
// ==========================================

class PunchingState extends FSMState {
    static onEnter(owner, i, fromState) {
        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";
        owner.setAnimation(`slash_${facingDir}`);
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
            this.fsm.changeState(i, this.fsm.states.LOCOMOTION);
        }
    }
}

// ==========================================
// STICK HIT STATE - one-shot 1h_slash animation
// ==========================================

class StickHitState extends FSMState {
    static onEnter(owner, i, fromState) {
        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";
        owner.setAnimation(`1h_slash_${facingDir}`);
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
            this.fsm.changeState(i, this.fsm.states.LOCOMOTION);
        }
    }
}

// ==========================================
// HURT STATE - one-shot hurt animation
// ==========================================

class HurtState extends FSMState {
    static onEnter(owner, i, fromState) {
        owner.setAnimation("hurt"); // No direction for hurt
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
            this.fsm.changeState(i, this.fsm.states.LOCOMOTION);
        }
    }
}

// ==========================================
// DYING STATE - death animation
// ==========================================

class DyingState extends FSMState {
    static onEnter(owner, i, fromState) {
        // Use hurt animation for death (no dedicated die animation)
        owner.setAnimation("hurt");
        owner.setAnimationSpeed(ACTION_ANIM_SPEED * 0.5); // Slower for dramatic effect
    }

    static onUpdate(owner, i, dt) {
        // Animation complete? Transition to DEAD
        if (this.fsm.time[i] >= HURT_DURATION_MS * 2) {
            this.fsm.changeState(i, this.fsm.states.DEAD);
        }
    }
}

// ==========================================
// DEAD STATE - final state
// ==========================================

class DeadState extends FSMState {
    static onEnter(owner, i, fromState) {
        // Stop on final frame, fade out
        owner.setAnimationSpeed(0);
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
        LOCOMOTION: LocomotionState,
        SHOOTING: ShootingState,
        PUNCHING: PunchingState,
        STICK_HIT: StickHitState,
        HURT: HurtState,
        DYING: DyingState,
        DEAD: DeadState,
    };

    static initial = this.states.LOCOMOTION;
}
