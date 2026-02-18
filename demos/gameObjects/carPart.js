// CarPart.js - Invisible physics body for car simulation
// Two CarParts (front and back) are connected by a constraint to form a car
// This is a physics-only entity with no visual representation

import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider } = WEED;

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

        // Configure physics - car parts need high limits for responsive control
        this.rigidBody.maxVel = 500;  // High max velocity for driving
        this.rigidBody.maxAcc = 100;  // High max acceleration for responsive input
        this.rigidBody.minSpeed = 0;
        this.rigidBody.friction = 0.04; // Low friction for smooth rolling

        // Ensure physics are active and awake
        this.rigidBody.sleeping = 0;
        this.rigidBody.stillnessTime = 0;
        this.rigidBody.static = 0;  // Not static - can move
    }

    onDespawned() {
        // Cleanup handled by Car parent
    }

    tick(dtRatio) {
        // No behavior - controlled by parent Car entity
    }
}
