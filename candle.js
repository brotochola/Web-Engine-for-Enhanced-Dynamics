// Candle.js - A simple candle light source with flickering effect
// Extends AbstractLightSourceEntity to implement a warm, flickering candle

class Candle extends AbstractLightSourceEntity {
  // Candle-specific properties (flickering parameters)
  static ARRAY_SCHEMA = {
    baseIntensity: Float32Array, // Base lumens before flicker
    flickerSpeed: Float32Array, // Speed of flicker animation
    flickerAmount: Float32Array, // Amount of flicker (0-1)
    flickerPhase: Float32Array, // Current phase in flicker cycle
  };

  // Shared memory buffer for candle-specific data
  static sharedBuffer = null;
  static entityCount = 0;
  static instances = [];

  /**
   * Initialize candle-specific arrays from SharedArrayBuffer
   * @param {SharedArrayBuffer} buffer - The shared memory for candle data
   * @param {number} count - Number of candles
   */
  static initializeArrays(buffer, count) {
    this.sharedBuffer = buffer;
    this.entityCount = count;

    let offset = 0;

    // Create typed array views for each property defined in schema
    for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;
      this[name] = new type(buffer, offset, count);
      offset += count * bytesPerElement;
    }

    // console.log(
    //   `Candle: Initialized ${Object.keys(this.ARRAY_SCHEMA).length} arrays for ${count} candles (${offset} bytes total)`
    // );
  }

  /**
   * Calculate total buffer size needed for candle-specific data
   * @param {number} count - Number of candles
   * @returns {number} Buffer size in bytes
   */
  static getBufferSize(count) {
    return Object.values(this.ARRAY_SCHEMA).reduce((total, type) => {
      return total + count * type.BYTES_PER_ELEMENT;
    }, 0);
  }

  /**
   * Candle constructor - initializes this candle's properties
   *
   * @param {number} index - Position in shared arrays
   */
  constructor(index) {
    super(index);

    Candle.instances.push(this);

    const i = index;

    // Initialize GameObject transform properties (random position for demo)
    GameObject.x[i] = Math.random() * WIDTH;
    GameObject.y[i] = Math.random() * HEIGHT;
    GameObject.vx[i] = 0;
    GameObject.vy[i] = 0;
    GameObject.ax[i] = 0;
    GameObject.ay[i] = 0;
    GameObject.rotation[i] = 0;
    GameObject.scale[i] = 0.5; // Small sprite for candle

    // Initialize GameObject physics properties
    GameObject.maxVel[i] = 0; // Stationary
    GameObject.maxAcc[i] = 0;
    GameObject.friction[i] = 0;
    GameObject.radius[i] = 5; // Small collision radius

    // Initialize GameObject perception (not used for candles)
    GameObject.visualRange[i] = 0;

    // Initialize light properties (warm yellow-orange candle light)
    // Use lightIndex for AbstractLightSourceEntity arrays
    const li = this.lightIndex;
    const baseIntensity = 80 + Math.random() * 40; // 80-120 lumens
    if (AbstractLightSourceEntity.lumens) {
      AbstractLightSourceEntity.lumens[li] = baseIntensity;
      AbstractLightSourceEntity.colorR[li] = 255; // Warm yellow-orange
      AbstractLightSourceEntity.colorG[li] = 200;
      AbstractLightSourceEntity.colorB[li] = 100;
    }

    // Initialize candle-specific flicker properties
    // Candle arrays are also indexed by lightIndex (since candles are light sources)
    const ci = this.lightIndex;
    if (Candle.baseIntensity) {
      Candle.baseIntensity[ci] = baseIntensity;
      Candle.flickerSpeed[ci] = 0.05 + Math.random() * 0.05; // 0.05-0.1
      Candle.flickerAmount[ci] = 0.15 + Math.random() * 0.1; // 15-25% flicker
      Candle.flickerPhase[ci] = Math.random() * Math.PI * 2; // Random start phase
    }
  }

  // Auto-generated getters/setters for candle-specific properties
  static {
    Object.entries(this.ARRAY_SCHEMA).forEach(([name, type]) => {
      Object.defineProperty(this.prototype, name, {
        get() {
          if (!Candle[name]) {
            console.error(
              `Candle.${name} is not initialized. Make sure Candle.initializeArrays() has been called.`
            );
            return undefined;
          }
          if (this.lightIndex === undefined) {
            console.error(
              `Candle instance does not have a lightIndex. This should be set in the AbstractLightSourceEntity constructor.`
            );
            return undefined;
          }
          // Use lightIndex since Candle arrays are sized for candle count
          return Candle[name][this.lightIndex];
        },
        set(value) {
          if (!Candle[name]) {
            console.error(
              `Candle.${name} is not initialized. Make sure Candle.initializeArrays() has been called.`
            );
            return;
          }
          if (this.lightIndex === undefined) {
            console.error(
              `Candle instance does not have a lightIndex. This should be set in the AbstractLightSourceEntity constructor.`
            );
            return;
          }
          // Use lightIndex since Candle arrays are sized for candle count
          Candle[name][this.lightIndex] =
            type === Uint8Array ? (value ? 1 : 0) : value;
        },
        enumerable: true,
        configurable: true,
      });
    });
  }

  /**
   * Main update - animate flickering effect
   */
  tick(dtRatio, neighborData, inputData) {
    const ci = this.lightIndex; // Candle index (same as light index)

    // console.log(AbstractLightSourceEntity.lumens[ci]);

    // Advance flicker phase
    if (Candle.flickerPhase && Candle.flickerSpeed) {
      Candle.flickerPhase[ci] += Candle.flickerSpeed[ci] * dtRatio;
      if (Candle.flickerPhase[ci] > Math.PI * 2) {
        Candle.flickerPhase[ci] -= Math.PI * 2;
      }

      // Calculate flicker using sine wave (smooth, organic feel)
      const flicker =
        Math.sin(Candle.flickerPhase[ci]) * Candle.flickerAmount[ci];

      // Apply flicker to lumens (always positive)
      const flickerMultiplier = 1.0 + flicker;
      AbstractLightSourceEntity.lumens[ci] =
        Candle.baseIntensity[ci] * flickerMultiplier;
    }

    // console.log(AbstractLightSourceEntity.lumens[ci]);
  }
}

// Export for use in workers and make globally accessible
if (typeof module !== "undefined" && module.exports) {
  module.exports = Candle;
}

// Ensure class is accessible in worker global scope
if (typeof self !== "undefined") {
  self.Candle = Candle;
}
