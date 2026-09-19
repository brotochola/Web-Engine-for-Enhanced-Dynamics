import { Component } from '/src/core/component.js';

export class BunnyMotion extends Component {
    static ARRAY_SCHEMA = {
        vx: Float32Array,
        vy: Float32Array,
    };
}
