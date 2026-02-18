// Car.js - Base car class using Verlet physics with multiple connected circles
// The car consists of 2-4 CarPart entities connected by distance constraints.
// The visible sprite is rendered at the midpoint, with rotation based on the angle between parts.
// This base class has no input - extend it (like PlayerCar) for controllable cars.

import WEED from '/src/index.js';
import { CarComponent } from '../components/carComponent.js';
import { CarPart } from './carPart.js';

const { GameObject, RigidBody, SpriteRenderer, Transform, Constraint } = WEED;

// Physics constants
export const CAR_CONSTRAINT_STIFFNESS = 0.99;

// Movement constants (exported for subclasses)
export const ACCELERATION_FORCE = 0.1;  // Forward/backward thrust
export const TURN_FORCE = 0.05;          // Turning force on front wheel
export const SPRITE_SCALE = 1.5;
const TWO_PI = Math.PI * 2;

// Part indices in component arrays
const PART_KEYS = ['part0Index', 'part1Index', 'part2Index', 'part3Index'];
// Constraint keys for all pairs: 0-1, 0-2, 0-3, 1-2, 1-3, 2-3
const CONSTRAINT_KEYS = [
    'constraint0Index', 'constraint1Index', 'constraint2Index',
    'constraint3Index', 'constraint4Index', 'constraint5Index'
];

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
        const sprite = spawnConfig.sprite || 'car';
        const scale = spawnConfig.scale || SPRITE_SCALE;

        // Set up sprite from config (defaults to 'car')
        this.setSpritesheet(sprite);
        this.setAnimation('0'); // Start facing right (0°)
        this.setScale(scale, scale);

        // Calculate physics dimensions based on sprite size
        const carLength = this.spriteRenderer.originalWidth * scale;
        const carHeight = this.spriteRenderer.originalHeight * scale;

        // Circle radius = half the car height (so circles fit the car body vertically)
        const radius = carHeight / 3;

        // Determine number of circles based on car aspect ratio
        // More circles for longer cars to provide better collision coverage
        const aspectRatio = carLength / carHeight;
        let partCount;
        if (aspectRatio >= 2.5) {
            partCount = 4;
        } else if (aspectRatio >= 1.8) {
            partCount = 3;
        } else {
            partCount = 2;
        }

        // Allow override from spawn config
        if (spawnConfig.partCount) {
            partCount = Math.max(2, Math.min(4, spawnConfig.partCount));
        }

        this.carComponent.partCount = partCount;

        // Calculate spacing between circle centers
        // First and last circles are positioned so their outer edges touch car ends
        // Distance from car edge to first/last circle center = radius
        // Total span between first and last centers = carLength - 2*radius
        const totalSpan = carLength - 2 * radius;
        const spacing = totalSpan / (partCount - 1);

        // Spawn CarParts evenly distributed along the car
        const parts = [];
        const startX = x - totalSpan / 2; // Back of car

        for (let i = 0; i < partCount; i++) {
            const partX = startX + i * spacing;
            const part = CarPart.spawn({
                x: partX,
                y: y,
                radius: radius,
            });

            if (!part) {
                console.error(`Car: Failed to spawn CarPart ${i}`);
                // Clean up already spawned parts
                for (const p of parts) {
                    p.despawn();
                }
                return;
            }

            parts.push(part);
            this.carComponent[PART_KEYS[i]] = part.index;
        }

        // Create constraints between ALL pairs of parts (for rigid body)
        // This ensures the car maintains its shape under collision
        let constraintIndex = 0;
        for (let i = 0; i < partCount; i++) {
            for (let j = i + 1; j < partCount; j++) {
                // Distance between parts i and j = (j - i) * spacing
                const distance = (j - i) * spacing;
                const constraintIdx = Constraint.add(
                    parts[i].index,
                    parts[j].index,
                    distance,
                    CAR_CONSTRAINT_STIFFNESS
                );
                this.carComponent[CONSTRAINT_KEYS[constraintIndex]] = constraintIdx;
                constraintIndex++;
            }
        }
        this.carComponent.constraintCount = constraintIndex;
    }

    onDespawned() {
        const partCount = this.carComponent.partCount;
        const constraintCount = this.carComponent.constraintCount;

        // Remove all constraints first
        for (let i = 0; i < constraintCount; i++) {
            const constraintIdx = this.carComponent[CONSTRAINT_KEYS[i]];
            if (constraintIdx >= 0) {
                Constraint.remove(constraintIdx);
            }
            this.carComponent[CONSTRAINT_KEYS[i]] = -1;
        }

        // Despawn CarParts
        for (let i = 0; i < partCount; i++) {
            const partIdx = this.carComponent[PART_KEYS[i]];
            if (partIdx > 0 && Transform.active[partIdx]) {
                const part = GameObject.get(partIdx);
                if (part) part.despawn();
            }
            this.carComponent[PART_KEYS[i]] = 0;
        }

        this.carComponent.partCount = 0;
        this.carComponent.constraintCount = 0;
    }

    /**
     * Get front and back part indices (first and last parts)
     */
    _getFrontBackIndices() {
        const partCount = this.carComponent.partCount;
        const backIdx = this.carComponent.part0Index;
        const frontIdx = this.carComponent[PART_KEYS[partCount - 1]];
        return { frontIdx, backIdx };
    }

    tick(dtRatio) {
        const { frontIdx, backIdx } = this._getFrontBackIndices();

        // Validate that both end parts exist
        if (!Transform.active[frontIdx] || !Transform.active[backIdx]) {
            return;
        }

        // Get positions of front and back parts
        const frontX = Transform.x[frontIdx];
        const frontY = Transform.y[frontIdx];
        const backX = Transform.x[backIdx];
        const backY = Transform.y[backIdx];

        // Update car position to midpoint between front and back
        const centerX = (frontX + backX) / 2;
        const centerY = (frontY + backY) / 2;
        Transform.x[this.index] = centerX;
        Transform.y[this.index] = centerY;

        // Update sprite frame based on angle
        this._updateSpriteFrame();
    }

    /**
     * Apply acceleration forces to the car (used by subclasses for input or AI)
     * @param {number} forwardForce - Force along car direction (positive = forward)
     * @param {number} turnForce - Turning force (positive = right, negative = left)
     */
    applyForces(forwardForce, turnForce) {
        const { frontIdx, backIdx } = this._getFrontBackIndices();

        if (!Transform.active[frontIdx] || !Transform.active[backIdx]) {
            return;
        }

        // Get positions and calculate angle
        const frontX = Transform.x[frontIdx];
        const frontY = Transform.y[frontIdx];
        const backX = Transform.x[backIdx];
        const backY = Transform.y[backIdx];
        const angle = Math.atan2(frontY - backY, frontX - backX);

        // Calculate forward direction
        const forwardX = Math.cos(angle);
        const forwardY = Math.sin(angle);

        // Get current velocity for steering calculations (use front part as reference)
        const velX = RigidBody.vx[frontIdx];
        const velY = RigidBody.vy[frontIdx];
        const forwardSpeed = velX * forwardX + velY * forwardY;

        // Steering effectiveness scales with speed
        const maxSteerSpeed = 10;
        const steerFactor = Math.min(Math.abs(forwardSpeed) / maxSteerSpeed, 1.0);
        const steerDirection = forwardSpeed >= 0 ? 1 : -1;

        const partCount = this.carComponent.partCount;

        // Apply forward/backward force to all parts
        if (forwardForce !== 0) {
            for (let i = 0; i < partCount; i++) {
                const partIdx = this.carComponent[PART_KEYS[i]];
                RigidBody.ax[partIdx] += forwardX * forwardForce;
                RigidBody.ay[partIdx] += forwardY * forwardForce;
            }
        }

        // Apply turn force to front part only
        if (turnForce !== 0) {
            const effectiveTurn = turnForce * steerFactor * steerDirection;
            RigidBody.ax[frontIdx] += -forwardY * effectiveTurn;
            RigidBody.ay[frontIdx] += forwardX * effectiveTurn;
        }

        // Wake up all car parts if any force is applied
        if (forwardForce !== 0 || turnForce !== 0) {
            for (let i = 0; i < partCount; i++) {
                const partIdx = this.carComponent[PART_KEYS[i]];
                RigidBody.sleeping[partIdx] = 0;
                RigidBody.stillnessTime[partIdx] = 0;
            }
        }
    }

    /**
     * Update sprite based on car angle
     * Maps angle to one of 12 direction animations (0°, 30°, 60°, ..., 330°)
     */
    _updateSpriteFrame() {
        const { frontIdx, backIdx } = this._getFrontBackIndices();

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
