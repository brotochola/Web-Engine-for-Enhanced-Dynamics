// Collider.js - Collision component for entity collision detection
// Supports circles, boxes, and collision filtering

import WEED from "/src/index.js";

export class DestinationComponent extends WEED.Component {
    static ARRAY_SCHEMA = {
        haveMyGuysArrived: Uint8Array,
    };
}

