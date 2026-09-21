// BoxPart - Invisible physics body for ConstraintBox
// Corner + center BoxParts linked by distance constraints

import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, CollisionListener } = WEED;

export class BoxPart extends GameObject {

    static collisionDamping = 0.35;
    static collisionEnterDamping = 0.1;

    static components = [RigidBody, Collider,
        //CollisionListener
    ];

    setup() {
        // Values set in onSpawned
    }
    // onCollisionEnter() {
    //     // this.scaleVelocity(BoxPart.collisionDamping)

    // }

    // onCollisionStay() {
    //     this.scaleVelocity(BoxPart.collisionEnterDamping)

    // }

    onSpawned(spawnConfig = {}) {
        const radius = spawnConfig.radius || 15;

        this.collider.radius = radius;
        this.collider.isTrigger = 0;
        this.collider.friction = 11// spawnConfig.friction ?? 0.4;
        this.collider.visualRange = radius * 3;
        // Same-box siblings share a negative groupIndex (set by ConstraintBox); default 0
        if (spawnConfig.collisionGroupIndex !== undefined) {
            this.collider.collisionGroupIndex = spawnConfig.collisionGroupIndex;
        }

        this.rigidBody.linearDamping = 0.001;

        this.rigidBody.sleeping = 0;
        this.rigidBody.stillnessTime = 0;
        this.rigidBody.static = 0;
    }

    onDespawned() {
        // Cleanup handled by ConstraintBox parent
    }

    tick(_dtRatio) {
        // Physics-only node
    }
}
