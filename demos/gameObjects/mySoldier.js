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
    static scriptUrl = import.meta.url;

    static components = [
        ...Person.components,
    ];

    onSpawned(spawnConfig = {}) {
        super.onSpawned(spawnConfig);

        this.setSpritesheet("poli");
        this.setAnimation("idle_down");

        this.lootableComponent.health = 1
        this.lootableComponent.resistance = 0.6
        this.lootableComponent.dropMoney = 100

        this.personComponent.groupingForce = 3

    }

    /**
     * LIFECYCLE: Main update loop
     */
    tick(dtRatio) {

        super.tick(dtRatio);

        this.groupWithMyTeam()

        const destinationIndex = Destination.getAllActiveIndices()[0]
        if (isNaN(destinationIndex)) return

        const destinationX = Transform.x[destinationIndex]
        const destinationY = Transform.y[destinationIndex]

        if (destinationX == -1 || destinationY == -1) return

        let vec = { x: 0, y: 0 };
        NavGrid.requestVector(this.x, this.y, destinationX, destinationY, vec);
        // console.log(this.index, vec)
        this.addAcceleration(vec.x*0.1, vec.y*0.1);

        // go to my homies:

    }
    onCollisionStay(other) {

        // if (Transform.entityType[other] != Destination.entityType) return
        // Destination.get(0).x = -1
        // Destination.get(0).y = -1

    }

}
