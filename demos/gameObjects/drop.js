

import WEED from "/src/index.js";


import { SpriteRenderer } from "../../src/components/SpriteRenderer.js";
import { Collider } from "../../src/components/Collider.js";

const {
    GameObject
} = WEED;


export const DROP_TYPES = {
    MONEY: 0,
    STICK: 1,
    PISTOL: 2,
    AK47: 3,
    SHOTGUN: 4,
    ARMOR: 4
}


export class Drop extends GameObject {
    static scriptUrl = import.meta.url;

    static components = [
        SpriteRenderer,
        Collider,
    ];




}
