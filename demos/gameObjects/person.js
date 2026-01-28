// Person.js - Base person entity with animation FSM
// Handles locomotion, actions (shoot, punch, stick hit), hurt, and death animations

import WEED from "/src/index.js";

import { NavGrid } from "../../src/core/NavGrid.js";

import { Destination } from "../gameObjects/destination.js";
import { Lootable } from "./lootable.js";
import { PersonComponent, DIRECTION_DOWN, DIRECTION_NAMES } from "../components/personComponent.js";
import { PersonAnimationFSM } from "../fsm/PersonAnimationFSM.js";
import { ParticleEmitter, SpriteSheetRegistry } from "../../src/index.js";

const {
    RigidBody,
    Collider,
    SpriteRenderer,
    ShadowCaster,
    Transform,
    rng,
} = WEED;

export class Person extends Lootable {

    static scriptUrl = import.meta.url;

    static components = [
        ...Lootable.components,
        RigidBody,
        Collider,
        SpriteRenderer,
        ShadowCaster,
        PersonComponent,
        PersonAnimationFSM,
    ];

    /**
     * LIFECYCLE: Configure entity TYPE properties - runs ONCE per instance
     */
    setup() {
        // Physics properties
        this.rigidBody.maxVel = 3;
        this.rigidBody.maxAcc = 0.15;
        this.rigidBody.minSpeed = 0;
        this.rigidBody.friction = 0.05;

        // Collision/perception
        this.collider.radius = 10;
        this.collider.visualRange = 150; // How far they can see predators

        // Sprite setup
        this.spriteRenderer.anchorX = 0.5;
        this.spriteRenderer.anchorY = 1.0;
        this.spriteRenderer.animationSpeed = 0.15;

        // Shadow
        this.shadowCaster.shadowRadius = 10;
        this.shadowCaster.height = 50;

        this.personComponent.minSquaredDistanceToGroup = 100**2;

    }

    getRandomTint() {
        let r = 0.8 + rng() * 0.2;
        let g = 0.8 + rng() * 0.2;
        let b = 0.8 + rng() * 0.2;

        return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);

    }

    /**
     * LIFECYCLE: Called when spawned - runs EVERY spawn
     */
    onSpawned(spawnConfig = {}) {
        this.setup()

        // this.setSpritesheet("poli");
        // this.setAnimation("idle_down");

        this.setTint(this.getRandomTint());

        // Random scale
        const scale = 0.9 + rng() * 0.2;
        this.setScale(scale, scale);

        this.collider.radius = 10 * scale;
        this.shadowCaster.shadowRadius = this.collider.radius;
        this.shadowCaster.height = this.collider.radius * 5;

        this.lootableComponent.health = 1
        this.lootableComponent.resistance = 0.5
        this.lootableComponent.dropMoney = 100

        // Initialize facing direction (default: down)
        PersonComponent.facingDirection[this.index] = DIRECTION_DOWN;

        // Reset dead flag (entity indices are reused)
        PersonComponent.dead[this.index] = 0;

        // Initialize animation FSM
        PersonAnimationFSM.initializeEntity(this.index, this);

        this.setScale(scale, scale);
    }

    recieveDamage(damage) {
        // Don't process damage if already dead
        if (PersonComponent.dead[this.index] === 1) return;

        super.recieveDamage(damage);

        if (damage < 0.1) return;

        // // Trigger hurt animation immediately (if not already dying)
        // if (!PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.DYING) &&
        //     !PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.DEAD)) {
        //     PersonAnimationFSM.forceChangeState(this.index, PersonAnimationFSM.states.HURT, this);
        // }

        ParticleEmitter.emit({
            count: Math.floor(damage * 10),
            texture: "blood",
            x: this.x,
            y: this.y,
            z: -30,
            angleXY: { min: 0, max: 360 },
            speed: { min: 0.7, max: 1.66 },
            vz: { min: -4, max: 0 },
            lifespan: 2000,
            gravity: 0.15,
            scale: { min: 0.1, max: 0.2 },
            alpha: { min: 0.4, max: 0.9 },
            tint: { min: 0xaaaaaa, max: 0xffffff },
            stayOnTheFloor: true,
        });
    }

    tick(dtRatio) {
        const isDead = PersonComponent.dead[this.index] === 1;
        const animBefore = SpriteRenderer.animationState[this.index];

        // Skip Lootable.tick() if already dead (prevents re-triggering die())
        if (!isDead) {
            super.tick(dtRatio);
        }

        this.keepWithinBounds(dtRatio);

        const animAfterDie = SpriteRenderer.animationState[this.index];

        // Animation FSM handles all animation state
        this.personAnimationFSM.tick(dtRatio, this);

        const animAfterFSM = SpriteRenderer.animationState[this.index];

        // Debug: track animation state changes for dying entities
        if (isDead && animBefore !== animAfterFSM) {
            console.log(`[Person ${this.index}] DYING - Anim changed! Before:${animBefore} AfterDie:${animAfterDie} AfterFSM:${animAfterFSM}`);
        }

        // Check if dying animation finished (FSM transitioned to DEAD)
        if (PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.DEAD)) {
            this.onDeathAnimationComplete();
        }
    }

    updateTeamData() {
        const neighborCount = this.neighborCount;
        const myX = this.x;
        const myY = this.y;
        const radius = this.collider.radius;
        const separationRadius = 3 * radius;
        const separationRadiusSq = separationRadius * separationRadius;

        let myTeamAvgX = 0;
        let myTeamAvgY = 0;
        let myTeamMemberCount = 0;
        let separateX = 0;
        let separateY = 0;

        for (let n = 0; n < neighborCount; n++) {
            const neighborIndex = this.getNeighbor(n);
            if (Transform.entityType[neighborIndex] !== this.entityType) continue;

            const nx = Transform.x[neighborIndex];
            const ny = Transform.y[neighborIndex];

            // Cohesion: accumulate for average
            myTeamAvgX += nx;
            myTeamAvgY += ny;
            myTeamMemberCount++;

            // Separation: check if too close
            const dx = myX - nx;
            const dy = myY - ny;
            const distSq = dx * dx + dy * dy;

            if (distSq < separationRadiusSq && distSq > 0) {
                const dist = Math.sqrt(distSq);
                const strength = (separationRadius - dist) / separationRadius;
                separateX += (dx / dist) * strength;
                separateY += (dy / dist) * strength;
            }
        }

        const i = this.index;
        PersonComponent.separateX[i] = separateX;
        PersonComponent.separateY[i] = separateY;

        if (myTeamMemberCount > 0) {
            myTeamAvgX /= myTeamMemberCount;
            myTeamAvgY /= myTeamMemberCount;
            PersonComponent.myTeamAvgX[i] = myTeamAvgX;
            PersonComponent.myTeamAvgY[i] = myTeamAvgY;
            PersonComponent.numberOfTeamMembersICanSee[i] = myTeamMemberCount;
            PersonComponent.squaredDistanceToGroup[i] = (myTeamAvgX - myX) ** 2 + (myTeamAvgY - myY) ** 2;
        } else {
            PersonComponent.myTeamAvgX[i] = -1;
            PersonComponent.myTeamAvgY[i] = -1;
            PersonComponent.numberOfTeamMembersICanSee[i] = 0;
            PersonComponent.squaredDistanceToGroup[i] = -1;
        }
    }

    groupWithMyTeam() {
        this.updateTeamData();
        if (PersonComponent.numberOfTeamMembersICanSee[this.index] == 0) return;

        const dist = PersonComponent.squaredDistanceToGroup[this.index];
        const minDist = PersonComponent.minSquaredDistanceToGroup[this.index];
        const groupingForce = PersonComponent.groupingForce[this.index];

        if (groupingForce == 0) return;
        if (dist < minDist) return;

        this.accelerateTowards(PersonComponent.myTeamAvgX[this.index], PersonComponent.myTeamAvgY[this.index], groupingForce);
    }

    separateFromTeam() {
        const separationForce = PersonComponent.separationForce[this.index];
        if (separationForce == 0) return;

        const separateX = PersonComponent.separateX[this.index];
        const separateY = PersonComponent.separateY[this.index];

        if (separateX !== 0 || separateY !== 0) {
            RigidBody.ax[this.index] += separateX * separationForce;
            RigidBody.ay[this.index] += separateY * separationForce;
        }
    }

    // ==========================================
    // ACTION TRIGGERS - Call these to trigger animations
    // ==========================================

    /**
     * Trigger shoot animation
     * @returns {boolean} True if action started, false if busy or dead
     */
    shoot() {
        if (PersonComponent.dead[this.index] === 1) return false;
        if (this.isPerformingAction()) return false;
        PersonAnimationFSM.changeState(this.index, PersonAnimationFSM.states.SHOOTING);
        return true;
    }

    /**
     * Trigger punch animation
     * @returns {boolean} True if action started, false if busy or dead
     */
    punch() {
        if (PersonComponent.dead[this.index] === 1) return false;
        if (this.isPerformingAction()) return false;
        PersonAnimationFSM.changeState(this.index, PersonAnimationFSM.states.PUNCHING);
        return true;
    }

    /**
     * Trigger stick hit animation
     * @returns {boolean} True if action started, false if busy or dead
     */
    hitWithStick() {
        if (PersonComponent.dead[this.index] === 1) return false;
        if (this.isPerformingAction()) return false;
        PersonAnimationFSM.changeState(this.index, PersonAnimationFSM.states.STICK_HIT);
        return true;
    }

    /**
     * Check if currently performing a one-shot action
     * @returns {boolean} True if busy with an action
     */
    isPerformingAction() {
        const state = PersonAnimationFSM.state[this.index];
        const idleIndex = PersonAnimationFSM.states.IDLE.stateIndex;
        const walkingIndex = PersonAnimationFSM.states.WALKING.stateIndex;
        const runningIndex = PersonAnimationFSM.states.RUNNING.stateIndex;
        // Not performing action if in any locomotion state
        return state !== idleIndex && state !== walkingIndex && state !== runningIndex;
    }

    /**
     * Check if dead
     * @returns {boolean} True if in DEAD state
     */
    isDead() {
        return PersonAnimationFSM.isInState(this.index, PersonAnimationFSM.states.DEAD);
    }

    /**
     * Keep entity within world boundaries
     */
    keepWithinBounds(dtRatio) {
        const margin = 50;
        const turnFactor = 0.1;
        const i = this.index;

        const x = Transform.x[i];
        const y = Transform.y[i];
        const worldWidth = this.config.worldWidth || 1000;
        const worldHeight = this.config.worldHeight || 1000;

        if (x < margin) {
            RigidBody.ax[i] += turnFactor * dtRatio;
        }
        if (x > worldWidth - margin) {
            RigidBody.ax[i] -= turnFactor * dtRatio;
        }
        if (y < margin) {
            RigidBody.ay[i] += turnFactor * dtRatio;
        }
        if (y > worldHeight - margin) {
            RigidBody.ay[i] -= turnFactor * dtRatio;
        }
    }

    die() {
        // Already dead? Don't trigger again
        if (PersonComponent.dead[this.index] === 1) return;
        this.rigidBody.friction=0.5
        // Mark as dead immediately - prevents firing and other actions
        PersonComponent.dead[this.index] = 1;

        // Emit blood particles
        ParticleEmitter.emit({
            count: Math.floor(10 + Math.random() * 5),
            texture: "blood",
            x: this.x,
            y: this.y,
            z: -30,
            angleXY: { min: 0, max: 360 },
            speed: { min: 0.7, max: 1.66 },
            vz: { min: -4, max: 0 },
            lifespan: 2000,
            gravity: 0.15,
            scale: { min: 0.1, max: 0.2 },
            alpha: { min: 0.4, max: 0.9 },
            tint: { min: 0xaaaaaa, max: 0xffffff },
            stayOnTheFloor: true,
        });

        // Start dying animation IMMEDIATELY - forceChangeState executes transition now
        // (changeState only queues for next tick, which can cause animation issues)
        console.log(`[Person ${this.index}] die() called, forcing DYING state. AnimState BEFORE:`, SpriteRenderer.animationState[this.index]);
        PersonAnimationFSM.forceChangeState(this.index, PersonAnimationFSM.states.DYING, this);
        console.log(`[Person ${this.index}] After forceChangeState, FSM state:`, PersonAnimationFSM.getStateName(this.index), `AnimState AFTER:`, SpriteRenderer.animationState[this.index]);
    }

    /**
     * Called when the DYING animation finishes (FSM enters DEAD state)
     * Stamps corpse decal, spawns loot, and despawns entity
     */
    onDeathAnimationComplete() {
        // Get visual state for stamping
        const stampX = this.x;
        const stampY = this.y;
        const stampScale = this.spriteRenderer.scaleX;
        const stampTint = this.spriteRenderer.baseTint;

        // Get the spritesheet name this person uses (e.g., "civil1")
        const spritesheetId = this.spriteRenderer.spritesheetId;
        const spritesheetName = SpriteSheetRegistry.getSpritesheetName(spritesheetId);

        // Get the last frame of the hurt animation for stamping the dead body
        const bodyTexture = SpriteSheetRegistry.getBigAtlasFrameName(
            spritesheetName,
            "hurt",
            -1  // Last frame
        );

        // Stamp the body texture on the floor as a decal
        ParticleEmitter.stampDecal({
            texture: bodyTexture,
            x: stampX,
            y: stampY,
            scaleX: stampScale,
            scaleY: stampScale,
            tint: stampTint,
            alpha: 0.9,
        });

        // Spawn loot drops (from Lootable.die())
        super.die();

        // Remove the entity
        this.despawn();
    }
}
