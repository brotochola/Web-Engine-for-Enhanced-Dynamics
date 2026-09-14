// CarComponent.js - Data for single-body car entities (Box2D-first drive)

import { Component } from '/src/core/component.js';

// Constant accel while input held; Box2D linearDamping sets top speed
export const CAR_DEFAULTS = {
    driveForce: 1200, // px/s² along forward while W/S held
    lateralFriction: 8, // px/s² per (px/s) lateral — soft tire grip
    turnTorque: 12, // yaw alpha rad/s² when A/D held (via angularAccel → torque)
    minSteerSpeed: 40, // px/s — no turn when nearly stopped
    minSteerFactor: 0.5, // steer strength at low speed
    maxSteerSpeed: 240, // px/s — full steer at/above this forward speed
    spriteScale: 1.5,
};

export class CarComponent extends Component {
    static ARRAY_SCHEMA = {
        active: Uint8Array,

        driveForce: Float32Array,
        lateralFriction: Float32Array,
        turnTorque: Float32Array,
        minSteerSpeed: Float32Array,
        minSteerFactor: Float32Array,
        maxSteerSpeed: Float32Array,
    };
}
