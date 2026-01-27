

import WEED from "/src/index.js";


import { SpriteRenderer } from "../../src/components/SpriteRenderer.js";
import { Collider } from "../../src/components/Collider.js";
import { Drop, DROP_TYPES } from "./drop.js";
import { DropComponent } from "../components/dropComponent.js";
import { ShadowCaster } from "../../src/index.js";

const {
    GameObject
} = WEED;



export class DropShotgun extends Drop {

    static scriptUrl = import.meta.url;

    static components = [
        ...Drop.components,
        DropComponent
    ];


    onSpawned(config) {
        super.onSpawned(config);
        this.dropComponent.type = DROP_TYPES.SHOTGUN;
        this.dropComponent.amount = 1
        this.setScale(0.2, 0.2)
        this.setSprite("shotgun");

    }








}
