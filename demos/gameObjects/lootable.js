// PersonWithFSM.js - Example entity using the FSM system
// Demonstrates civilian behavior with IDLE and FLEEING states

import WEED from "/src/index.js";
import { NavGrid } from "../src/core/NavGrid.js";

import { Destination } from "./destination.js";
import { LootableComponent } from "../components/LootableComponent.js";

const {
    GameObject,
} = WEED;

export class Looteable extends GameObject {
    // Auto-detected by GameEngine
    static scriptUrl = import.meta.url;

    static components = [
        LootableComponent,
    ];


    tick(dtRatio) {
        const myHealth = LootableComponent.health[this.index];
        if (myHealth <= 0) {
            this.die()
        }

    }

    die() {

        this.despawn()
    }

}
