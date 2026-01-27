// ExplosionComponent.js - Data for explosion entities
// Tracks lifecycle, intensity, radius growth/shrink, and visual state

import { Component } from "/src/core/Component.js";

export class LootableComponent extends Component {
    static ARRAY_SCHEMA = {
        health: Float32Array,
        resistance: Float32Array,
        dropMoney: Float32Array,
        dropPistol: Float32Array,
        dropMachineGun: Float32Array,
        dropStick: Float32Array,
        dropArmor: Float32Array,
        explosionPower: Float32Array

    };
}
