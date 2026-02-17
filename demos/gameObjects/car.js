// Car.js - Player-controlled car using Verlet physics with two connected circles
// The car consists of two CarPart entities (front/back) connected by a distance constraint.
// The visible sprite is rendered at the midpoint, with rotation based on the angle between parts.

import WEED from '/src/index.js';
import { CarComponent } from '../components/carComponent.js';
import { CarPart } from './carPart.js';

const { GameObject, Keyboard, RigidBody, Collider, SpriteRenderer, Transform, Constraint } = WEED;

// Physics constants
const CAR_PART_RADIUS = 15;
const CAR_CONSTRAINT_DISTANCE = CAR_PART_RADIUS * 2 + 1;
const CAR_CONSTRAINT_STIFFNESS = 1.0;

// Control constants
const ACCELERATION_FORCE = 0.5;  // Forward/backward thrust
const TURN_FORCE = 0.1;          // Turning force on front wheel
const SPRITE_SCALE = 1.5;
const TWO_PI = Math.PI * 2;

export class Car extends GameObject {
    static scriptUrl = import.meta.url;

    // Car uses SpriteRenderer for visuals and CarComponent for physics references
    static components = [SpriteRenderer, CarComponent];

    setup() {
        // Configure sprite anchors
        this.spriteRenderer.anchorX = 0.5;
        this.spriteRenderer.anchorY = 0.5;
    }

    onSpawned(spawnConfig = {}) {
        const x = spawnConfig.x || 0;
        const y = spawnConfig.y || 0;

        // Spawn front CarPart (ahead of car position)
        const frontPart = CarPart.spawn({
            x: x + CAR_CONSTRAINT_DISTANCE / 2,
            y: y,
            radius: CAR_PART_RADIUS,
        });

        // Spawn back CarPart (behind car position)
        const backPart = CarPart.spawn({
            x: x - CAR_CONSTRAINT_DISTANCE / 2,
            y: y,
            radius: CAR_PART_RADIUS,
        });

        if (!frontPart || !backPart) {
            console.error('Car: Failed to spawn CarParts');
            return;
        }

        // Store entity indices
        this.carComponent.frontEntityIndex = frontPart.index;
        this.carComponent.backEntityIndex = backPart.index;

        // Create constraint between front and back parts
        const constraintIdx = Constraint.add(
            frontPart.index,
            backPart.index,
            CAR_CONSTRAINT_DISTANCE,
            CAR_CONSTRAINT_STIFFNESS
        );
        this.carComponent.constraintIndex = constraintIdx;

        // Set up sprite
        this.setSpritesheet('car');
        this.setAnimation('0'); // Start facing right (0°)

        // Set scale
        this.setScale(SPRITE_SCALE, SPRITE_SCALE);
    }

    onDespawned() {
        const frontIdx = this.carComponent.frontEntityIndex;
        const backIdx = this.carComponent.backEntityIndex;
        const constraintIdx = this.carComponent.constraintIndex;

        // Remove constraint first
        if (constraintIdx >= 0) {
            Constraint.remove(constraintIdx);
        }

        // Despawn CarParts
        if (frontIdx > 0 && Transform.active[frontIdx]) {
            const frontPart = GameObject.get(frontIdx);
            if (frontPart) frontPart.despawn();
        }
        if (backIdx > 0 && Transform.active[backIdx]) {
            const backPart = GameObject.get(backIdx);
            if (backPart) backPart.despawn();
        }

        // Clear references
        this.carComponent.frontEntityIndex = 0;
        this.carComponent.backEntityIndex = 0;
        this.carComponent.constraintIndex = -1;
    }

    tick(dtRatio) {
        const frontIdx = this.carComponent.frontEntityIndex;
        const backIdx = this.carComponent.backEntityIndex;

        // Validate that both parts exist
        if (!Transform.active[frontIdx] || !Transform.active[backIdx]) {
            return;
        }

        // Get positions of front and back parts
        const frontX = Transform.x[frontIdx];
        const frontY = Transform.y[frontIdx];
        const backX = Transform.x[backIdx];
        const backY = Transform.y[backIdx];

        // Calculate car angle (direction from back to front)
        const angle = Math.atan2(frontY - backY, frontX - backX);

        // Handle keyboard input
        this._handleInput(dtRatio, angle, frontIdx, backIdx);

        // DEBUG: Log when any key is pressed (remove after testing)
        if (Keyboard.w || Keyboard.a || Keyboard.s || Keyboard.d) {
            console.log('Car input:', { w: Keyboard.w, a: Keyboard.a, s: Keyboard.s, d: Keyboard.d });
        }

        // Update car position to midpoint between front and back
        const centerX = (frontX + backX) / 2;
        const centerY = (frontY + backY) / 2;
        Transform.x[this.index] = centerX;
        Transform.y[this.index] = centerY;

        // Update sprite frame based on angle
        this._updateSpriteFrame();
    }

    /**
     * Handle keyboard input for car controls
     * W/S = accelerate/brake (apply force along car direction)
     * A/D = turn (apply perpendicular force to front part)
     */
    _handleInput(dtRatio, angle, frontIdx, backIdx) {
        const force = ACCELERATION_FORCE;
        const turnForce = TURN_FORCE;

        // Calculate forward direction
        const forwardX = Math.cos(angle);
        const forwardY = Math.sin(angle);

        // Initialize acceleration
        let frontAx = 0, frontAy = 0;
        let backAx = 0, backAy = 0;

        // W - Accelerate forward
        if (Keyboard.w || Keyboard.arrowup) {
            frontAx += forwardX * force;
            frontAy += forwardY * force;
            backAx += forwardX * force;
            backAy += forwardY * force;
        }

        // S - Brake/Reverse
        if (Keyboard.s || Keyboard.arrowdown) {
            frontAx -= forwardX * force;
            frontAy -= forwardY * force;
            backAx -= forwardX * force;
            backAy -= forwardY * force;
        }

        // A - Turn left (apply perpendicular force to front part only)
        if (Keyboard.d || Keyboard.arrowright) {
            frontAx += -forwardY * turnForce;
            frontAy += forwardX * turnForce;
        }

        // D - Turn right (apply perpendicular force to front part only)
        if (Keyboard.a || Keyboard.arrowleft) {
            frontAx += forwardY * turnForce;
            frontAy += -forwardX * turnForce;
        }

        // Apply accelerations (direct assignment, physics clears each frame)
        RigidBody.ax[frontIdx] = frontAx;
        RigidBody.ay[frontIdx] = frontAy;
        RigidBody.ax[backIdx] = backAx;
        RigidBody.ay[backIdx] = backAy;

        // Wake up car parts if any input is detected
        if (frontAx !== 0 || frontAy !== 0 || backAx !== 0 || backAy !== 0) {
            RigidBody.sleeping[frontIdx] = 0;
            RigidBody.sleeping[backIdx] = 0;
            RigidBody.stillnessTime[frontIdx] = 0;
            RigidBody.stillnessTime[backIdx] = 0;
        }
    }

    /**
     * Update sprite based on car angle
     * Maps angle to one of 12 direction animations (0°, 30°, 60°, ..., 330°)
     */
    _updateSpriteFrame() {
        const frontIdx = this.carComponent.frontEntityIndex;
        const backIdx = this.carComponent.backEntityIndex;

        if (!Transform.active[frontIdx] || !Transform.active[backIdx]) {
            return;
        }

        const frontX = Transform.x[frontIdx];
        const frontY = Transform.y[frontIdx];
        const backX = Transform.x[backIdx];
        const backY = Transform.y[backIdx];

        // Calculate angle from back to front
        let angle = Math.atan2(frontY - backY, frontX - backX);

        // Normalize angle to [0, 2π)
        if (angle < 0) {
            angle += TWO_PI;
        }

        // Convert radians to degrees and snap to nearest 30°
        const degrees = (angle * 180) / Math.PI;
        const snappedDegrees = Math.round(degrees / 30) * 30 % 360;

        // Set animation by angle name (e.g., "0", "30", "60", ..., "330")
        this.setAnimation(String(snappedDegrees));
    }
}
