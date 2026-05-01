// Component.js - Base class for all ECS components
// Provides shared array functionality via Structure of Arrays (SoA)
//
// CUSTOM GETTERS/SETTERS:
// Subclasses can define custom getters/setters for any property in ARRAY_SCHEMA.
// These custom accessors will be preserved and NOT overwritten by auto-generation.
//
// Example - Adding a custom setter to Collider that syncs RigidBody mass:
//
//   class Collider extends Component {
//     static ARRAY_SCHEMA = { radius: Float32Array, ... };
//
//     // Custom setter - auto-generates when _createInstanceProperties() runs
//     get radius() { return Collider.radius[this.index]; }
//     set radius(value) {
//       Collider.radius[this.index] = value;
//       // Custom logic: also update RigidBody mass
//       if (RigidBody.active[this.index]) {
//         RigidBody.syncMassFromCollider(this.index);
//       }
//     }
//   }
//
// The custom radius getter/setter will be detected and preserved by
// _createInstanceProperties(), while other properties (offsetX, offsetY, etc.)
// will still get auto-generated accessors.

export class Component {
  // Shared memory buffer for this component type
  static sharedBuffer = null;
  static globalEntityCount = 0;
  static componentId = null;

  // Array schema - defines all shared arrays and their types
  // Must be overridden in subclasses
  static ARRAY_SCHEMA = {};

  /**
   * Initialize static arrays from SharedArrayBuffer
   * Called by GameEngine and by each worker
   *
   * @param {SharedArrayBuffer} buffer - The shared memory
   * @param {number} count - Total number of component instances
   */
  static initializeArrays(buffer, count) {
    this.sharedBuffer = buffer;
    this.globalEntityCount = count;

    let offset = 0;

    // Create typed array views for each property defined in schema
    for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;

      // Ensure proper alignment for this typed array
      const remainder = offset % bytesPerElement;
      if (remainder !== 0) {
        offset += bytesPerElement - remainder;
      }

      this[name] = new type(buffer, offset, count);
      offset += count * bytesPerElement;
    }

    // Auto-generate instance getters/setters on prototype
    this._createInstanceProperties();
  }

  /**
   * Automatically create instance getters/setters from ARRAY_SCHEMA
   * This makes component instances have properties that forward to static arrays
   * Skips properties that already have custom getters/setters defined in subclasses
   */
  static _createInstanceProperties() {
    const ComponentClass = this;

    // Skip if already created (avoid duplicate property definitions)
    if (ComponentClass.prototype._propertiesCreated) return;

    Object.entries(ComponentClass.ARRAY_SCHEMA).forEach(([name, type]) => {
      // Skip if custom getter/setter already defined in subclass
      // This allows components like Collider to have custom setters (e.g., auto-compute mass)
      if (Object.getOwnPropertyDescriptor(ComponentClass.prototype, name)) {
        return;
      }

      Object.defineProperty(ComponentClass.prototype, name, {
        get() {
          return ComponentClass[name][this.index];
        },
        set(value) {
          // Store value directly - no boolean conversion
          // Uint8Array can store 0-255, so animationState and other numeric fields work correctly
          ComponentClass[name][this.index] = value;
        },
        enumerable: true,
        configurable: true,
      });
    });

    ComponentClass.prototype._propertiesCreated = true;
  }

  /**
   * Calculate total buffer size needed
   * @param {number} count - Number of component instances
   * @returns {number} Buffer size in bytes
   */
  static getBufferSize(count) {
    let offset = 0;

    for (const type of Object.values(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;

      // Add alignment padding
      const remainder = offset % bytesPerElement;
      if (remainder !== 0) {
        offset += bytesPerElement - remainder;
      }

      offset += count * bytesPerElement;
    }

    return offset;
  }

  constructor(index) {
    this.index = index;
  }
}
