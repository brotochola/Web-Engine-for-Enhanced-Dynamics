/**
 * @fileoverview Transform component for entity positioning
 * Handles position, rotation, and active state (every entity has this)
 * @see {@link WEED.types.TransformProperties} for property type definitions
 */

import { Component } from '../core/Component.js';

/**
 * @class Transform
 * @extends {Component}
 *
 * Static TypedArray properties (created by Component.initializeArrays() from ARRAY_SCHEMA):
 * @static {Uint8Array} active - Entity active state array
 * @static {Uint8Array} entityType - Entity type ID array
 * @static {Float32Array} x - Position X array
 * @static {Float32Array} y - Position Y array
 * @static {Float32Array} rotation - Rotation array
 */
export class Transform extends Component {
  // Array schema - defines all transform properties
  static ARRAY_SCHEMA = {
    // Entity state
    active: Uint8Array, // 0 = inactive, 1 = active
    entityType: Uint8Array, // Entity type ID (auto-assigned during registration)

    // Position and rotation (world space)
    x: Float32Array,
    y: Float32Array,
    rotation: Float32Array,
  };

  // Virtual static properties for TypeScript - these are created by Component.initializeArrays()
  /** @static @type {Uint8Array} */
  static active;
  /** @static @type {Uint8Array} */
  static entityType;
  /** @static @type {Float32Array} */
  static x;
  /** @static @type {Float32Array} */
  static y;
  /** @static @type {Float32Array} */
  static rotation;
}
