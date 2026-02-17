// CarComponent.js - Data for car entities
// Stores references to front/back physics bodies and constraint

import { Component } from '/src/core/Component.js';

export class CarComponent extends Component {
    static ARRAY_SCHEMA = {
        // Entity indices for front and back physics bodies (CarParts)
        frontEntityIndex: Uint16Array,
        backEntityIndex: Uint16Array,
        // Constraint index linking front and back (-1 if none)
        constraintIndex: Int16Array,
    };
}
