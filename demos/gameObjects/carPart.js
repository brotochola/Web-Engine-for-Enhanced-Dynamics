// CarPart.js - Invisible physics body for car simulation
// Two CarParts (front and back) are connected by a constraint to form a car
// This is a physics-only entity with no visual representation

import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, Transform, ParticleEmitter } = WEED;

export class CarPart extends GameObject {
    static scriptUrl = import.meta.url;

    // No SpriteRenderer - this is an invisible physics body
    static components = [RigidBody, Collider];

    setup() {
        // Basic setup - actual values set in onSpawned
    }

    onSpawned(spawnConfig = {}) {
        const radius = spawnConfig.radius || 15;

        // Configure collider
        this.collider.radius = radius;
        this.collider.isTrigger = 0; // Physical collision
        this.collider.visualRange = radius * 2;

        // Configure physics - tuned for arcade feel
        this.rigidBody.maxVel = 400;
        this.rigidBody.maxAcc = 3;
        this.rigidBody.minSpeed = 0;
        this.rigidBody.friction = 0.01;  // Slight coast drag when off gas

        // Ensure physics are active and awake
        this.rigidBody.sleeping = 0;
        this.rigidBody.stillnessTime = 0;
        this.rigidBody.static = 0;  // Not static - can move
    }

    onDespawned() {
        // Cleanup handled by Car parent
    }
    onCollisionEnter(otherEntityIndex) {
        // Soften acceleration on impact (was zeroing - too abrupt)
        this.rigidBody.ax *= 0.3;
        this.rigidBody.ay *= 0.3;

        // Emit sparks at collision point (midpoint between this part and other)
        const hitX = (this.x + Transform.x[otherEntityIndex]) / 2;
        const hitY = (this.y + Transform.y[otherEntityIndex]) / 2;
        const radius = this.collider.radius;
        const speed = RigidBody.speed[this.index];

        if (speed > 3) {
            const count = Math.floor(Math.random() * 3) + Math.min(4, Math.floor(speed * 0.5));
            ParticleEmitter.emit({
                count,
                x: hitX,
                y: hitY,
                z: -Math.random() * radius,
                angleXY: { min: 0, max: 360 },
                speed: { min: radius * 0.15, max: radius * 0.35 },
                rotation: { min: 0, max: 360 },
                vz: -Math.random() * 4 - 2,
                gravity: 0.6,
                lifespan: { min: 80, max: 200 },
                scale: { min: 0.3, max: 0.66 },
                texture: '_whiteCircle',
                tint: { min: 0xffff00, max: 0xffbb00 },
                alpha: { min: 0.8, max: 1 },
                stayOnTheFloor: false,
                despawnOnGroundContact: true,
            });
        }
    }

    tick(dtRatio) {
        // Controlled by parent Car - no per-part behavior
    }
}
