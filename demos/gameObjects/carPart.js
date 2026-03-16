// CarPart.js - Invisible physics body for car simulation
// Two CarParts (front and back) are connected by a constraint to form a car
// This is a physics-only entity with no visual representation

import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, CollisionListener, Transform, ParticleEmitter } = WEED;

export class CarPart extends GameObject {
    static scriptUrl = import.meta.url;

    // No SpriteRenderer - this is an invisible physics body
    static components = [RigidBody, Collider, CollisionListener];

    setup() {
        // Basic setup - actual values set in onSpawned
    }

    onSpawned(spawnConfig = {}) {
        const radius = spawnConfig.radius || 15;

        // Configure collider
        this.collider.radius = radius;
        this.collider.isTrigger = 0; // Physical collision
        this.collider.visualRange = radius * 3;

        // Configure physics - tuned for arcade feel
        this.rigidBody.maxVel = 400;
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

        const numSparks = Math.floor(Math.abs(RigidBody.vx[otherEntityIndex] - RigidBody.vx[this.index]) + Math.abs(RigidBody.vy[otherEntityIndex] - RigidBody.vy[this.index]));

        if (speed > 3) {

            ParticleEmitter.emit({
                count: numSparks,
                x: hitX,
                y: hitY,
                z: -Math.random() * radius,
                angleXY: { min: 0, max: 360 },
                speed: { min: radius * 0.15, max: radius * 0.35 },
                rotation: { min: 0, max: 360 },
                vz: -Math.random() * 4 - 2,
                gravity: 0.6,
                lifespan: { min: 200, max: 1200 },
                scale: { min: 0.3, max: 0.66 },
                texture: '_whiteCircle',
                tint: { min: 0xffff00, max: 0xffbb00 },
                alpha: { min: 0.8, max: 1 },
                stayOnTheFloor: false,
                despawnOnGroundContact: true,
            });

            ParticleEmitter.emit({
                count: numSparks,
                x: hitX,
                y: hitY + Math.random() * 8,
                z: -5 - Math.random() * 10,
                angleXY: 0,
                speed: { min: 0.2, max: 1.2 },
                vz: -Math.random() * 1.5,
                gravity: 0,
                rotation: { min: 0, max: 360 },
                flipX: Math.random() > 0.5,
                flipY: Math.random() > 0.5,
                lifespan: { min: 300, max: 1800 },
                scale: { min: 0.4, max: 1.5 },
                texture: 'smoke',
                tint: { min: 0x999999, max: 0xbbbbbb },
                alpha: { min: 0.05, max: 0.1 },
                tweenToAlpha0: true,
            });
        }
    }

    tick(dtRatio) {
        // When very slow, gentle drag to prevent endless sliding
        // const i = this.index;
        // const spd = RigidBody.speed[i];
        // if (spd < 25 && spd > 0.5) {
        //     RigidBody.ax[i] -= RigidBody.vx[i] * 0.06;
        //     RigidBody.ay[i] -= RigidBody.vy[i] * 0.06;
        // }
    }
}
