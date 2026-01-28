import WEED from "/src/index.js";

import { LootableComponent } from "../components/lootableComponent.js";
import { DropMoney } from "./dropMoney.js";

const {
    GameObject,
} = WEED;

export class Lootable extends GameObject {
    // Auto-detected by GameEngine
    static scriptUrl = import.meta.url;

    static components = [
        LootableComponent,
    ];

    tick(dtRatio) {
        const myHealth = LootableComponent.health[this.index];

        if (myHealth <= 0) this.die()
    }

    recieveDamage(damage) {
        const resistance = LootableComponent.resistance[this.index];
        LootableComponent.health[this.index] -= damage * (1 - resistance);

    }

    die() {

        const amountOfMoney = LootableComponent.dropMoney[this.index];
        if (amountOfMoney > 0) {
            DropMoney.spawn({
                amount: amountOfMoney,
                x: this.x,
                y: this.y,
            })
        }

        // this.despawn()
    }

}
