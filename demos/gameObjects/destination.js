// PersonWithFSM.js - Example entity using the FSM system
// Demonstrates civilian behavior with IDLE and FLEEING states

import WEED from "/src/index.js";

import { Mouse } from "../../src/core/Mouse.js";


const {
    GameObject,

    Collider,
    SpriteRenderer,

} = WEED;

export class Destination extends GameObject {
    // Auto-detected by GameEngine
    static scriptUrl = import.meta.url;

    // Components: basic physics + rendering + our FSM
    static components = [
        Collider,
        SpriteRenderer,
    ];

    /**
     * LIFECYCLE: Configure entity TYPE properties - runs ONCE per instance
     */
    setup() {


        // Collision/perception
        this.collider.radius = 100;
        this.collider.visualRange = 0
        this.collider.isTrigger = 1

        // Sprite setup
        this.spriteRenderer.anchorX = 0.5;
        this.spriteRenderer.anchorY = 0.5;

        this.setSprite("target");

    }



    onSpawned(spawnConfig = {}) {


        this.setup()
    }

    /**
     * LIFECYCLE: Main update loop
     */
    tick(dt) {
        if (Mouse.isDown) {
            // this.destinationComponent.haveMyGuysArrived = 0;
            this.x = Mouse.x
            this.y = Mouse.y
        }

    }



}
