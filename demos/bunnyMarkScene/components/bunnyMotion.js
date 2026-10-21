import WEED from '/src/index.js';

const { Component } = WEED;

export class BunnyMotion extends Component {
    static ARRAY_SCHEMA = {
        vx: Float32Array,
        vy: Float32Array,
    };
}
