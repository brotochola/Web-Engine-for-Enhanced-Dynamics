// Collider.js - Collision component for entity collision detection
// Supports circles, boxes, and collision filtering

import { Component } from "../core/Component.js";

class Collider extends Component {
  // Array schema - defines all collision properties
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active

    // Shape type
    shapeType: Uint8Array, // 0=Circle, 1=Box, 2=Polygon

    // Offset from entity position
    offsetX: Float32Array,
    offsetY: Float32Array,

    // Circle shape
    radius: Float32Array,

    // Box shape
    width: Float32Array,
    height: Float32Array,

    // Polygon shape (TODO: future)
    // pointsOffset: Int32Array, // pointer/index to polygon points in SAB

    // Trigger mode
    isTrigger: Uint8Array, // trigger=only events, no physical response

    // Material properties
    restitution: Float32Array, // bounciness (0-1)

    // Collision filtering
    collisionLayer: Uint16Array,
    collisionMask: Uint16Array,

    // AABB cache (updated by physics system)
    aabbMinX: Float32Array,
    aabbMinY: Float32Array,
    aabbMaxX: Float32Array,
    aabbMaxY: Float32Array,

    // Perception (for spatial queries)
    visualRange: Float32Array,
  };
}

// ES6 module export
export { Collider };
