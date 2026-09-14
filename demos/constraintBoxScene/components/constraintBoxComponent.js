// ConstraintBoxComponent - Data for car-style square boxes
// 4 corner parts + 1 center part; 4 sides + 2 diagonals + 4 spokes = 10 constraints

import { Component } from '/src/core/component.js';

export const CONSTRAINT_BOX_DEFAULTS = {
    size: 100,
    constraintStiffness: 0.9,
    angularDamping: 1, // 0–1: fraction of tangential velocity removed per tick
};

export class ConstraintBoxComponent extends Component {
    static ARRAY_SCHEMA = {
        partCount: Uint8Array,
        constraintCount: Uint8Array,

        size: Float32Array,
        constraintStiffness: Float32Array,
        angle: Float32Array,
        angularDamping: Float32Array,

        part0Index: Uint16Array,
        part1Index: Uint16Array,
        part2Index: Uint16Array,
        part3Index: Uint16Array,
        part4Index: Uint16Array,

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
    };
}

export const PART_KEYS = [
    'part0Index', 'part1Index', 'part2Index', 'part3Index', 'part4Index',
];

export const CONSTRAINT_KEYS = [
    'constraint0Index', 'constraint1Index', 'constraint2Index',
    'constraint3Index', 'constraint4Index', 'constraint5Index',
    'constraint6Index', 'constraint7Index', 'constraint8Index',
    'constraint9Index',
];
