// PersonAnimationFSM.js - FSM for person animation states
// Handles locomotion (idle/walk/run) and action animations (shoot, melee, hurt, die)

import WEED from "/src/index.js";
import { PersonComponent, DIRECTION_NAMES } from "../components/personComponent.js";
import { LootableComponent } from "../components/lootableComponent.js";

const { FSM, FSMState, RigidBody, getDirectionFromAngle, SpriteSheetRegistry } = WEED;

// Animation durations in ms (frames * (1000 / (speed * 60)))
// Assumes animation speed of 0.2 for actions
const ACTION_ANIM_SPEED = 0.2;
const SHOOT_FRAMES = 13;
const SLASH_FRAMES = 6;      // For punch
const STICK_FRAMES = 13;     // 1h_slash for stick hit
const HURT_FRAMES = 6;
const LOCOMOTION_FRAMES = 8; // Walk/run cycle frames

const SHOOT_DURATION_MS = SHOOT_FRAMES * (1000 / (ACTION_ANIM_SPEED * 60));  // ~1083ms
const SLASH_DURATION_MS = SLASH_FRAMES * (1000 / (ACTION_ANIM_SPEED * 60));  // ~500ms
const STICK_DURATION_MS = STICK_FRAMES * (1000 / (ACTION_ANIM_SPEED * 60));  // ~1083ms
const HURT_DURATION_MS = HURT_FRAMES * (1000 / (ACTION_ANIM_SPEED * 60));    // ~500ms

// Speed threshold for running vs walking
const RUN_SPEED_THRESHOLD = 2;
const WALK_SPEED_THRESHOLD = 0.1
const RUN_ANIMATION_MULTIPLIER=0.15
const WALK_ANIMATION_MULTIPLIER=0.2

// Helper to calculate locomotion cycle duration based on current speed
function getLocomotionCycleDuration(speed, multiplier) {
    const animSpeed = speed * multiplier;
    return LOCOMOTION_FRAMES * (1000 / (animSpeed * 60));
}

// ==========================================
// IDLE STATE - standing still
// ==========================================

class IdleState extends FSMState {
    static onEnter(owner, i, fromState) {
        // Skip animation if no spritesheet set yet (FSM auto-init runs before onSpawned)
        if (!owner.spriteRenderer?.spritesheetId) return;

        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";
        owner.setAnimation(`idle_${facingDir}`);
        owner.setAnimationSpeed(WALK_ANIMATION_MULTIPLIER);
    }

    static onUpdate(owner, i, dt) {
        // Check for death first (highest priority)
        if (LootableComponent.health[i] <= 0) {
            console.log(`[IdleState ${i}] Health <= 0, changing to DYING`);
            this.fsm.changeState(i, this.fsm.states.DYING);
            return;
        }

        const speed = RigidBody.speed[i];

        if (speed > WALK_SPEED_THRESHOLD) {
            this.fsm.changeState(i, this.fsm.states.WALKING);
        }

        // Update idle animation if facing direction changed
        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";
        owner.setAnimation(`idle_${facingDir}`);
    }
}

// ==========================================
// WALKING STATE - slow movement
// ==========================================

class WalkingState extends FSMState {
    static onEnter(owner, i, fromState) {
        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";
        owner.setAnimation(`walk_${facingDir}`);
        owner.setAnimationSpeed(RigidBody.speed[i] * WALK_ANIMATION_MULTIPLIER);
    }

    static onUpdate(owner, i, dt) {
        // Check for death first (highest priority)
        if (LootableComponent.health[i] <= 0) {
            this.fsm.changeState(i, this.fsm.states.DYING);
            return;
        }

        const velocityAngle = RigidBody.velocityAngle[i];
        const speed = RigidBody.speed[i];

        // Update facing direction from velocity
        if (speed > WALK_SPEED_THRESHOLD) {
            const direction = getDirectionFromAngle(velocityAngle);
            const dirIndex = DIRECTION_NAMES.indexOf(direction);
            if (dirIndex >= 0) {
                PersonComponent.facingDirection[i] = dirIndex;
            }
        }

        // Update animation
        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";
        owner.setAnimation(`walk_${facingDir}`);
        owner.setAnimationSpeed(speed * WALK_ANIMATION_MULTIPLIER);

        // Stopped moving? -> Idle immediately
        if (speed <= WALK_SPEED_THRESHOLD) {
            this.fsm.changeState(i, this.fsm.states.IDLE);
            return;
        }

        // Want to run? Wait for one walk cycle to complete
        if (speed > RUN_SPEED_THRESHOLD) {
            const cycleDuration = getLocomotionCycleDuration(speed, WALK_ANIMATION_MULTIPLIER);
            if (this.fsm.time[i] >= cycleDuration) {
                this.fsm.changeState(i, this.fsm.states.RUNNING);
            }
        }
    }
}

// ==========================================
// RUNNING STATE - fast movement
// ==========================================

class RunningState extends FSMState {
    static onEnter(owner, i, fromState) {
        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";
        owner.setAnimation(`run_${facingDir}`);
        owner.setAnimationSpeed(RigidBody.speed[i] * RUN_ANIMATION_MULTIPLIER);
    }

    static onUpdate(owner, i, dt) {
        // Check for death first (highest priority)
        if (LootableComponent.health[i] <= 0) {
            this.fsm.changeState(i, this.fsm.states.DYING);
            return;
        }

        const velocityAngle = RigidBody.velocityAngle[i];
        const speed = RigidBody.speed[i];

        // Update facing direction from velocity
        if (speed > WALK_SPEED_THRESHOLD) {
            const direction = getDirectionFromAngle(velocityAngle);
            const dirIndex = DIRECTION_NAMES.indexOf(direction);
            if (dirIndex >= 0) {
                PersonComponent.facingDirection[i] = dirIndex;
            }
        }

        // Update animation
        const facingDir = DIRECTION_NAMES[PersonComponent.facingDirection[i]] || "down";
        owner.setAnimation(`run_${facingDir}`);
        owner.setAnimationSpeed(speed * RUN_ANIMATION_MULTIPLIER);

        // Stopped moving? -> Idle immediately
        if (speed <= WALK_SPEED_THRESHOLD) {
            this.fsm.changeState(i, this.fsm.states.IDLE);
            return;
        }

        // Want to walk? Wait for one run cycle to complete
        if (speed <= RUN_SPEED_THRESHOLD) {
            const cycleDuration = getLocomotionCycleDuration(speed, RUN_ANIMATION_MULTIPLIER);
            if (this.fsm.time[i] >= cycleDuration) {
                this.fsm.changeState(i, this.fsm.states.WALKING);
            }
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
            this.fsm.changeState(i, this.fsm.states.IDLE);
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
            this.fsm.changeState(i, this.fsm.states.IDLE);
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
            this.fsm.changeState(i, this.fsm.states.IDLE);
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
            this.fsm.changeState(i, this.fsm.states.IDLE);
        }
    }
}

// ==========================================
// DYING STATE - death animation
// ==========================================

class DyingState extends FSMState {
    // Death animation speed (slower for dramatic effect)
    static DYING_ANIM_SPEED = 0.2;
    // Duration = frames * ms per frame = 6 * (1000 / (speed * 60))
    // At speed 0.15: 6 * (1000 / 9) = 667ms
    static DYING_DURATION_MS = (HURT_FRAMES -1)* (1000 / (DyingState.DYING_ANIM_SPEED * 60))

    static onEnter(owner, i, fromState) {
        // Use hurt animation for death (no direction variant)
        owner.setAnimation("hurt");
        owner.setAnimationSpeed(DyingState.DYING_ANIM_SPEED);
    }

    static onUpdate(owner, i, dt) {
        // Animation complete? Transition to DEAD
        if (this.fsm.time[i] >= DyingState.DYING_DURATION_MS) {
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
