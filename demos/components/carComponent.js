// CarComponent.js - Data for car entities
// Stores references to physics body parts and constraints

import { Component } from '/src/core/Component.js';

// Maximum of 4 circles per car (supports various car lengths)
// With 4 parts, we need up to 6 constraints (all pairs: 0-1, 0-2, 0-3, 1-2, 1-3, 2-3)
export class CarComponent extends Component {
    static ARRAY_SCHEMA = {
        // Entity indices for physics bodies (CarParts) - up to 4 parts
        part0Index: Uint16Array,
        part1Index: Uint16Array,
        part2Index: Uint16Array,
        part3Index: Uint16Array,
        // Constraint indices linking ALL pairs of parts (-1 if none)
        // For 4 parts: 6 constraints, for 3 parts: 3 constraints, for 2 parts: 1 constraint
        constraint0Index: Int16Array,  // 0-1
        constraint1Index: Int16Array,  // 0-2
        constraint2Index: Int16Array,  // 0-3
        constraint3Index: Int16Array,  // 1-2
        constraint4Index: Int16Array,  // 1-3
        constraint5Index: Int16Array,  // 2-3
        // How many parts this car actually uses (2, 3, or 4)
        partCount: Uint8Array,
        // How many constraints this car has
        constraintCount: Uint8Array,
    };

    // Virtual properties for TypeScript - these are auto-created from ARRAY_SCHEMA at runtime
    // Properties are created by Component._createInstanceProperties() based on ARRAY_SCHEMA
    /** @type {number} */ part0Index;
    /** @type {number} */ part1Index;
    /** @type {number} */ part2Index;
    /** @type {number} */ part3Index;
    /** @type {number} */ constraint0Index;
    /** @type {number} */ constraint1Index;
    /** @type {number} */ constraint2Index;
    /** @type {number} */ constraint3Index;
    /** @type {number} */ constraint4Index;
    /** @type {number} */ constraint5Index;
    /** @type {number} */ partCount;
    /** @type {number} */ constraintCount;
}
