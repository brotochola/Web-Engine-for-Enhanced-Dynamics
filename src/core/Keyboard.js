// Keyboard.js - Static keyboard input interface
// Provides zero-overhead access to keyboard state from shared input data
// Supports all keys with both lowercase and uppercase access (e.g., Keyboard.a or Keyboard.A)

export class Keyboard {
  static _inputData = null; // Int32Array from logic worker
  static _keyIndexMap = null; // Map of key names to input buffer indices

  /**
   * Initialize keyboard with shared input data and key mapping
   * @param {Int32Array} inputData - Shared input data array
   * @param {Object} keyIndexMap - Map of key names to buffer indices
   */
  static initialize(inputData, keyIndexMap) {
    this._inputData = inputData;
    this._keyIndexMap = keyIndexMap;
  }

  /**
   * Check if a key is currently pressed
   * @param {string} key - Key name (case-insensitive)
   * @returns {boolean} True if key is down
   */
  static isDown(key) {
    if (!this._inputData || !this._keyIndexMap) return false;
    const normalizedKey = key.toLowerCase();
    const index = this._keyIndexMap[normalizedKey];
    return index !== undefined ? this._inputData[6 + index] === 1 : false;
  }

  /**
   * Check if a key was just pressed this frame
   * Note: This requires frame-by-frame state tracking - not implemented yet
   * @param {string} key - Key name
   * @returns {boolean} True if key was just pressed
   */
  static isPressed(key) {
    // TODO: Implement frame-by-frame tracking
    return this.isDown(key);
  }
}

// Create a Proxy to allow direct property access (e.g., Keyboard.a, Keyboard.Space)
// This works for both lowercase and uppercase property access
const KeyboardProxy = new Proxy(Keyboard, {
  get(target, prop, receiver) {
    // First check if it's an existing static property/method
    if (prop in target) {
      return Reflect.get(target, prop, receiver);
    }

    // Handle key property access (e.g., Keyboard.a, Keyboard.Tab, Keyboard.SPACE)
    if (typeof prop === "string") {
      const normalizedKey = prop.toLowerCase();

      // Special case mappings for common keys
      const specialKeys = {
        space: " ",
        spacebar: " ",
        ctrl: "control",
        ctl: "control",
        alt: "alt",
        return: "enter",
      };

      const keyName = specialKeys[normalizedKey] || normalizedKey;

      if (!target._inputData || !target._keyIndexMap) return false;
      const index = target._keyIndexMap[keyName];
      return index !== undefined ? target._inputData[6 + index] === 1 : false;
    }

    return undefined;
  },
});

export default KeyboardProxy;
