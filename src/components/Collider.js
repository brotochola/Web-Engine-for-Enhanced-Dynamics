// Collider.js - Collision component for entity collision detection
// Supports circles, boxes, and collision filtering

import { Component } from "../core/Component.js";

class Collider extends Component {
  // Array schema - defines all collision properties
  static ARRAY_SCHEMA = {
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

  /**
   * Constructor - creates a component instance for a specific entity index
   * @param {number} index - Index in the component arrays
   */
  constructor(index) {
    super();
    this.index = index;
  }

  // Instance getters/setters that forward to static arrays
  get shapeType() {
    return Collider.shapeType[this.index];
  }
  set shapeType(v) {
    Collider.shapeType[this.index] = v;
  }

  get offsetX() {
    return Collider.offsetX[this.index];
  }
  set offsetX(v) {
    Collider.offsetX[this.index] = v;
  }

  get offsetY() {
    return Collider.offsetY[this.index];
  }
  set offsetY(v) {
    Collider.offsetY[this.index] = v;
  }

  get radius() {
    return Collider.radius[this.index];
  }
  set radius(v) {
    Collider.radius[this.index] = v;
  }

  get width() {
    return Collider.width[this.index];
  }
  set width(v) {
    Collider.width[this.index] = v;
  }

  get height() {
    return Collider.height[this.index];
  }
  set height(v) {
    Collider.height[this.index] = v;
  }

  get isTrigger() {
    return Collider.isTrigger[this.index];
  }
  set isTrigger(v) {
    Collider.isTrigger[this.index] = v ? 1 : 0;
  }

  get restitution() {
    return Collider.restitution[this.index];
  }
  set restitution(v) {
    Collider.restitution[this.index] = v;
  }

  get collisionLayer() {
    return Collider.collisionLayer[this.index];
  }
  set collisionLayer(v) {
    Collider.collisionLayer[this.index] = v;
  }

  get collisionMask() {
    return Collider.collisionMask[this.index];
  }
  set collisionMask(v) {
    Collider.collisionMask[this.index] = v;
  }

  get aabbMinX() {
    return Collider.aabbMinX[this.index];
  }
  set aabbMinX(v) {
    Collider.aabbMinX[this.index] = v;
  }

  get aabbMinY() {
    return Collider.aabbMinY[this.index];
  }
  set aabbMinY(v) {
    Collider.aabbMinY[this.index] = v;
  }

  get aabbMaxX() {
    return Collider.aabbMaxX[this.index];
  }
  set aabbMaxX(v) {
    Collider.aabbMaxX[this.index] = v;
  }

  get aabbMaxY() {
    return Collider.aabbMaxY[this.index];
  }
  set aabbMaxY(v) {
    Collider.aabbMaxY[this.index] = v;
  }

  get visualRange() {
    return Collider.visualRange[this.index];
  }
  set visualRange(v) {
    Collider.visualRange[this.index] = v;
  }
}

// ES6 module export
export { Collider };
