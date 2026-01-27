// PersonWithFSM.js - Example entity using the FSM system
// Demonstrates civilian behavior with IDLE and FLEEING states

import WEED from "/src/index.js";

import { NavGrid } from "../../src/core/NavGrid.js";

import { Destination } from "../gameObjects/destination.js";

import { Person } from "./person.js";

const {
    RigidBody,

    Transform,
    rng,
    getDirectionFromAngle,
} = WEED;

export class MySoldier extends Person {
    // Auto-detected by GameEngine
    static scriptUrl = import.meta.url;

    // Components: basic physics + rendering + our FSM
    static components = [
        ...Person.components,
    ];


    setup() {
        super.setup();

    }



    /**
     * LIFECYCLE: Called when spawned - runs EVERY spawn
     */
    onSpawned(spawnConfig = {}) {
        super.onSpawned(spawnConfig);

        this.setSpritesheet("poli");
        this.setAnimation("idle_down");


        this.lootableComponent.health = 1
        this.lootableComponent.resistance = 0.6
        this.lootableComponent.dropMoney = 100





    }

    /**
     * LIFECYCLE: Main update loop
     */
    tick(dtRatio) {

        super.tick(dtRatio);




        const destinationInstance = Destination.get(0)

        if (!destinationInstance) return
        if (destinationInstance.x == -1 || destinationInstance.y == -1) return

        let vec = { x: 0, y: 0 };
        NavGrid.requestVector(this.x, this.y, destinationInstance.x, destinationInstance.y, vec);
        // console.log(this.index, vec)
        this.addAcceleration(vec.x, vec.y);


    }
    onCollisionStay(other) {

        if (Transform.entityType[other] != Destination.entityType) return
        Destination.get(0).x = -1
        Destination.get(0).y = -1

    }


}
