
import WEED from "../../src/index.js";
const { Component } = WEED;

export class DropComponent extends Component {

    static ARRAY_SCHEMA = {
        type: Uint8Array,
        amount: Uint8Array,
    };
}
