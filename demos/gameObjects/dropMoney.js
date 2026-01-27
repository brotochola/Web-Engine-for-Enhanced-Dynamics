

import WEED from "/src/index.js";


import { SpriteRenderer } from "../../src/components/SpriteRenderer.js";
import { Collider } from "../../src/components/Collider.js";
import { Drop, DROP_TYPES } from "./drop.js";
import { DropComponent } from "../components/dropComponent.js";

const {
    GameObject
} = WEED;



export class DropMoney extends Drop {

    static scriptUrl = import.meta.url;

    static components = [
        ...Drop.components,
        DropComponent
    ];


    onSpawned(config) {

        this.dropComponent.type = DROP_TYPES.MONEY;
        this.dropComponent.amount = config.amount;

        this.collider.radius = 10
        this.collider.isTrigger = 0;
        this.collider.visualRange = 0

        this.setScale(0.2, 0.2)
        this.setSprite("money");


        setTimeout(() => {
            this.collider.isTrigger = 1;
        }, 200)


    }

    onCollisionEnter(other) {
        const entityType = Transform.entityType[other];
        if (entityType === Player.entityType || entityType === MySoldier.entityType) {
            console.log("money grabbed");
            this.despawn()

        }
    }






}
