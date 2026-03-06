// CarComponent.js - Data for car entities
// Stores references to physics body parts and constraints
// Grid layout: cols x rows (3x2 or 4x2) - triangular mesh constraints

import { Component } from '/src/core/Component.js';

// Max 4 cols x 2 rows = 8 parts, triangular mesh gives ~13 constraints
// Default tuning values - hybrid: torque (rotation) + Godot-style velocity redirection (trajectory)
export const CAR_DEFAULTS = {
    accelerationForce: 0.25,
    turnForce: 0.36,
    steeringAngle: 0.5,     // Radians (~23°) for bicycle model
    brakeForce: 1.4,
    spriteScale: 1.5,
    constraintStiffness: 0.99,
    maxSteerSpeed: 4,
    minSteerFactor: 0.5,
    slipSpeed: 100,         // Speed above which traction drops (more drift)
    tractionTight: 10,      // At low speed
    tractionLoose: 2.5,     // At high speed (drift)
    lateralDampening: 0.2,
};

export class CarComponent extends Component {
    static ARRAY_SCHEMA = {
        gridCols: Uint8Array,
        gridRows: Uint8Array,
        partCount: Uint8Array,
        constraintCount: Uint8Array,

        // Car tuning (per-entity)
        accelerationForce: Float32Array,
        turnForce: Float32Array,
        steeringAngle: Float32Array,
        brakeForce: Float32Array,
        spriteScale: Float32Array,
        constraintStiffness: Float32Array,
        maxSteerSpeed: Float32Array,
        minSteerFactor: Float32Array,
        slipSpeed: Float32Array,
        tractionTight: Float32Array,
        tractionLoose: Float32Array,
        lateralDampening: Float32Array,
        vx: Float32Array,
        vy: Float32Array,

        angle: Float32Array,  // Car heading in radians (back-to-front), updated each tick

        part0Index: Uint16Array,
        part1Index: Uint16Array,
        part2Index: Uint16Array,
        part3Index: Uint16Array,
        part4Index: Uint16Array,
        part5Index: Uint16Array,
        part6Index: Uint16Array,
        part7Index: Uint16Array,

        constraint0Index: Int16Array,
        constraint1Index: Int16Array,
        constraint2Index: Int16Array,
        constraint3Index: Int16Array,
        constraint4Index: Int16Array,
        constraint5Index: Int16Array,
        constraint6Index: Int16Array,
        constraint7Index: Int16Array,
        constraint8Index: Int16Array,
        constraint9Index: Int16Array,
        constraint10Index: Int16Array,
        constraint11Index: Int16Array,
        constraint12Index: Int16Array,
    };
}

export const PART_KEYS = [
    'part0Index', 'part1Index', 'part2Index', 'part3Index',
    'part4Index', 'part5Index', 'part6Index', 'part7Index'
];
export const CONSTRAINT_KEYS = [
    'constraint0Index', 'constraint1Index', 'constraint2Index', 'constraint3Index',
    'constraint4Index', 'constraint5Index', 'constraint6Index', 'constraint7Index',
    'constraint8Index', 'constraint9Index', 'constraint10Index', 'constraint11Index',
    'constraint12Index',
];
