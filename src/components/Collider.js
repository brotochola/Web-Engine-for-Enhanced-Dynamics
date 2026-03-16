// Collider.js - Collision component for entity collision detection
// Supports circles, boxes, and collision filtering
//
// CUSTOM SETTERS FOR MASS AUTO-COMPUTATION:
// This component defines custom setters for radius, width, and height that
// automatically compute mass and invMass in the RigidBody component.
//
// This enables mass-weighted collision response in the physics system:
// - Larger objects (more mass) move less when hit
// - Smaller objects (less mass) move more when hit
//
// Mass formulas:
// - Circle: mass = π * radius²  (area)
// - Box:    mass = width * height (area)
//
// Usage - both of these now auto-compute mass:
//   this.collider.radius = 20;  // mass = π * 20² ≈ 1257
//   this.collider.width = 100;  // mass = 100 * height

import { Component } from '../core/Component.js';
import { RigidBody } from './RigidBody.js';
import { updateMassFromCircle, updateMassFromBox } from '../core/utils.js';

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

    // Collision filtering (32 layers max; layer is index 0-31, mask is bitmask)
    collisionLayer: Uint8Array,
    collisionMask: Uint32Array,

    // Perception (for spatial queries)
    visualRange: Float32Array,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // CUSTOM GETTERS/SETTERS
  // These override the auto-generated accessors from Component._createInstanceProperties()
  // The base Component class detects these and preserves them (doesn't overwrite).
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Circle radius - custom setter that auto-computes mass
   * Mass = π * radius² (circle area)
   *
   * Example:
   *   this.collider.radius = 20;  // Also sets mass ≈ 1257, invMass ≈ 0.0008
   */
  get radius() {
    return Collider.radius[this.index];
  }
  set radius(value) {
    // 1. Store the radius value in the shared array
    Collider.radius[this.index] = value;

    // 2. Auto-compute mass from circle area (π * r²) if entity has RigidBody
    //    Check RigidBody.active exists (arrays initialized) AND entity has component
    if (RigidBody.active && RigidBody.active[this.index]) {
      updateMassFromCircle(this.index, value, RigidBody);
    }
  }

  /**
   * Box width - custom setter that auto-computes mass
   * Mass = width * height (box area)
   *
   * Example:
   *   this.collider.width = 100;   // mass = 100 * height
   *   this.collider.height = 50;   // mass = 100 * 50 = 5000
   */
  get width() {
    return Collider.width[this.index];
  }
  set width(value) {
    // 1. Store the width value
    Collider.width[this.index] = value;

    // 2. Recompute mass from box area (width * height)
    //    Use existing height, default to 1 if not set yet
    if (RigidBody.active && RigidBody.active[this.index]) {
      const h = Collider.height[this.index] || 1;
      updateMassFromBox(this.index, value, h, RigidBody);
    }
  }

  /**
   * Box height - custom setter that auto-computes mass
   * Mass = width * height (box area)
   */
  get height() {
    return Collider.height[this.index];
  }
  set height(value) {
    Collider.height[this.index] = value;

    if (RigidBody.active && RigidBody.active[this.index]) {
      const w = Collider.width[this.index] || 1;
      updateMassFromBox(this.index, w, value, RigidBody);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COLLISION LAYER / MASK
  // Layer = which layer this entity is on (0-31, stored as Uint8)
  // Mask  = which layers this entity collides with (bitmask, stored as Uint32)
  // Two entities collide only if each entity's layer bit is set in the other's mask.
  // ═══════════════════════════════════════════════════════════════════════════

  get collisionLayer() {
    return Collider.collisionLayer[this.index];
  }
  set collisionLayer(value) {
    Collider.collisionLayer[this.index] = value & 31;
  }

  get collisionMask() {
    return Collider.collisionMask[this.index];
  }
  set collisionMask(value) {
    Collider.collisionMask[this.index] = value;
  }

  addLayerToMask(layer) {
    Collider.collisionMask[this.index] |= (1 << (layer & 31));
  }

  removeLayerFromMask(layer) {
    Collider.collisionMask[this.index] &= ~(1 << (layer & 31));
  }

  collidesWithLayer(layer) {
    return !!(Collider.collisionMask[this.index] & (1 << (layer & 31)));
  }
}

// ES6 module export
export { Collider };
