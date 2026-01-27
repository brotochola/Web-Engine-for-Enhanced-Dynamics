// PersonWithFSM.js - Example entity using the FSM system
// Demonstrates civilian behavior with IDLE and FLEEING states

import WEED from "/src/index.js";

import { NavGrid } from "../../src/core/NavGrid.js";

import { Destination } from "../gameObjects/destination.js";
import { Lootable } from "./lootable.js";

const {

    RigidBody,
    Collider,
    SpriteRenderer,
    ShadowCaster,
    Transform,
    rng,
    getDirectionFromAngle,
} = WEED;

export class Person extends Lootable {

    static scriptUrl = import.meta.url;

    // Components: basic physics + rendering + our FSM
    static components = [
        ...Lootable.components,
        RigidBody,
        Collider,
        SpriteRenderer,
        ShadowCaster,
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


        // this.setSpritesheet("poli");
        // this.setAnimation("idle_down");

        this.setTint(this.getRandomTint());

        // Random scale
        const scale = 0.8 + rng() * 0.4;
        this.setScale(scale, scale);

        this.collider.radius = 10 * scale;
        this.shadowCaster.shadowRadius = this.collider.radius;
        this.shadowCaster.height = this.collider.radius * 5;

        this.lootableComponent.health = 1
        this.lootableComponent.resistance = 0.5
        this.lootableComponent.dropMoney = 100




        this.setScale(scale, scale);
    }

    /**
     * LIFECYCLE: Main update loop
     */
    tick(dtRatio) {

        super.tick(dtRatio);

        this.keepWithinBounds(dtRatio);



        this.updateAnimation();


    }





    updateAnimation() {
        // Cache array references for reading

        const velocityAngle = this.rigidBody.velocityAngle;

        const speed = this.rigidBody.speed;


        const direction = getDirectionFromAngle(velocityAngle);


        if (speed > 0.1) {
            // Choose walk or run based on speed threshold
            const isRunning = speed > 2;
            const animPrefix = isRunning ? "run" : "walk";

            // Set animation and speed
            this.setAnimation(`${animPrefix}_${direction}`);
            this.setAnimationSpeed(speed * 0.07);
        } else {
            // Use idle animation in last facing direction
            this.setAnimation(`idle_${direction}`);
        }
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
}
