// AbstractLightSourceEntity.js - Base class for entities that emit light
// Extends GameObject to add light emission properties (lumens, color)

class AbstractLightSourceEntity extends GameObject {
  // Light-specific properties schema (separate from GameObject)
  static ARRAY_SCHEMA = {
    lumens: Float32Array, // Light power (0-1000+)
    colorR: Uint8Array, // Red component (0-255)
    colorG: Uint8Array, // Green component (0-255)
    colorB: Uint8Array, // Blue component (0-255)
  };

  // Shared memory buffer for light-specific data
  static sharedBuffer = null;
  static entityCount = 0;
  static instances = [];
  static lightSourceIndices = []; // Array of GameObject indices for all light sources (in order)

  /**
   * Initialize light-specific arrays from SharedArrayBuffer
   * @param {SharedArrayBuffer} buffer - The shared memory for light data
   * @param {number} count - Number of light sources
   */
  static initializeArrays(buffer, count, lightSourceIndices = null) {
    this.sharedBuffer = buffer;
    this.entityCount = count;

    // Store light source indices if provided (used to calculate lightIndex)
    if (lightSourceIndices) {
      this.lightSourceIndices = lightSourceIndices;
    }

    let offset = 0;

    // Create typed array views for each property defined in schema
    for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;
      this[name] = new type(buffer, offset, count);
      offset += count * bytesPerElement;
    }

    console.log(
      `AbstractLightSourceEntity: Initialized ${
        Object.keys(this.ARRAY_SCHEMA).length
      } arrays for ${count} light sources (${offset} bytes total)`
    );
    console.log(`AbstractLightSourceEntity.lumens exists:`, !!this.lumens);
  }

  /**
   * Calculate total buffer size needed for light-specific data
   * @param {number} count - Number of light sources
   * @returns {number} Buffer size in bytes
   */
  static getBufferSize(count) {
    return Object.values(this.ARRAY_SCHEMA).reduce((total, type) => {
      return total + count * type.BYTES_PER_ELEMENT;
    }, 0);
  }

  /**
   * Constructor - initializes this light source's properties
   * Subclasses should call super(index) and set their own lumens/color values
   *
   * @param {number} index - Position in GameObject shared arrays
   */
  constructor(index) {
    super(index);

    AbstractLightSourceEntity.instances.push(this);

    // Calculate light index by finding this instance's position in lightSourceIndices array
    // This ensures consistent indexing across main thread and workers
    const lightIndex =
      AbstractLightSourceEntity.lightSourceIndices.indexOf(index);
    if (lightIndex === -1) {
      console.error(
        `GameObject index ${index} not found in lightSourceIndices. This entity may not be a light source, or lightSourceIndices was not set during initialization.`
      );
      this.lightIndex = undefined;
    } else {
      this.lightIndex = lightIndex;
      if (this.lightIndex >= AbstractLightSourceEntity.entityCount) {
        console.error(
          `Light index ${this.lightIndex} exceeds entityCount ${AbstractLightSourceEntity.entityCount}. Make sure AbstractLightSourceEntity.initializeArrays() was called with the correct count.`
        );
      }
    }

    // Default light properties (subclasses should override)
    if (this.lightIndex !== undefined && AbstractLightSourceEntity.lumens) {
      const li = this.lightIndex;
      AbstractLightSourceEntity.lumens[li] = 100; // Default: 100 lumens
      AbstractLightSourceEntity.colorR[li] = 255; // Default: white light
      AbstractLightSourceEntity.colorG[li] = 255;
      AbstractLightSourceEntity.colorB[li] = 255;
    }
  }

  // Auto-generated getters/setters for light-specific properties
  static {
    Object.entries(this.ARRAY_SCHEMA).forEach(([name, type]) => {
      Object.defineProperty(this.prototype, name, {
        get() {
          if (!AbstractLightSourceEntity[name]) {
            console.error(
              `AbstractLightSourceEntity.${name} is not initialized. Make sure AbstractLightSourceEntity.initializeArrays() has been called.`
            );
            return undefined;
          }
          if (this.lightIndex === undefined) {
            console.error(
              `Light source instance does not have a lightIndex. This should be set in the constructor.`
            );
            return undefined;
          }
          return AbstractLightSourceEntity[name][this.lightIndex];
        },
        set(value) {
          if (!AbstractLightSourceEntity[name]) {
            console.error(
              `AbstractLightSourceEntity.${name} is not initialized. Make sure AbstractLightSourceEntity.initializeArrays() has been called.`
            );
            return;
          }
          if (this.lightIndex === undefined) {
            console.error(
              `Light source instance does not have a lightIndex. This should be set in the constructor.`
            );
            return;
          }
          AbstractLightSourceEntity[name][this.lightIndex] =
            type === Uint8Array ? Math.round(value) : value;
        },
        enumerable: true,
        configurable: true,
      });
    });

    // Convenience getter/setter for color as hex
    Object.defineProperty(this.prototype, "color", {
      get() {
        if (this.lightIndex === undefined) {
          console.error(
            `Light source instance does not have a lightIndex. This should be set in the constructor.`
          );
          return 0;
        }
        const r = AbstractLightSourceEntity.colorR[this.lightIndex];
        const g = AbstractLightSourceEntity.colorG[this.lightIndex];
        const b = AbstractLightSourceEntity.colorB[this.lightIndex];
        return (r << 16) | (g << 8) | b;
      },
      set(hex) {
        if (this.lightIndex === undefined) {
          console.error(
            `Light source instance does not have a lightIndex. This should be set in the constructor.`
          );
          return;
        }
        AbstractLightSourceEntity.colorR[this.lightIndex] = (hex >> 16) & 0xff;
        AbstractLightSourceEntity.colorG[this.lightIndex] = (hex >> 8) & 0xff;
        AbstractLightSourceEntity.colorB[this.lightIndex] = hex & 0xff;
      },
      enumerable: true,
      configurable: true,
    });
  }

  /**
   * Main update method - override in subclasses to add light-specific behavior
   * (e.g., flickering for candles, pulsing for magic lights, etc.)
   */
  tick(dtRatio, neighborData, inputData) {
    // Override in subclasses if needed
  }
}

// Export for use in workers and make globally accessible
if (typeof module !== "undefined" && module.exports) {
  module.exports = AbstractLightSourceEntity;
}

// Ensure class is accessible in worker global scope
if (typeof self !== "undefined") {
  self.AbstractLightSourceEntity = AbstractLightSourceEntity;
}
