import WEED from '../../src/index.js';
const { Component } = WEED;

export class PlatformerCharacterComponent extends Component {
    static ARRAY_SCHEMA = {
        isItStandingOnPlatform: Int16Array,
        // amount: Uint8Array,
    };
}
