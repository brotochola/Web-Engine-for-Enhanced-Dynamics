// Keyboard.js - Static keyboard input interface
// Provides zero-overhead access to keyboard state from shared input data
// Supports held-state reads and per-frame press edges via SharedArrayBuffer-backed counters
// Supports all keys with both lowercase and uppercase access (e.g., Keyboard.a or Keyboard.A)

export class Keyboard {
  static _inputData = null; // Int32Array view of shared keyboard data
  static _keyIndexMap = null; // Map of key names to input buffer indices
  static _keyCount = 0;
  static _pressCounterOffset = -1; // Offset of press counters in _inputData
  static _lastPressCounts = null; // Per-thread snapshot of SAB press counters
  static _pressedThisFrame = null; // Stable edge flags updated once per frame

  /**
   * Initialize keyboard with shared input data and key mapping
   * @param {Int32Array} inputData - Shared input data array
   * @param {Object} keyIndexMap - Map of key names to buffer indices
   */
  static initialize(inputData, keyIndexMap) {
    this._inputData = inputData;
    this._keyIndexMap = keyIndexMap;

    if (!inputData || !keyIndexMap) {
      this._keyCount = 0;
      this._pressCounterOffset = -1;
      this._lastPressCounts = new Int32Array(0);
      this._pressedThisFrame = new Uint8Array(0);
      return;
    }

    let maxIndex = -1;
    for (const index of Object.values(keyIndexMap)) {
      if (index > maxIndex) maxIndex = index;
    }

    this._keyCount = maxIndex + 1;
    this._pressCounterOffset = inputData.length >= this._keyCount * 2 ? this._keyCount : -1;
    this._lastPressCounts = new Int32Array(this._keyCount);
    this._pressedThisFrame = new Uint8Array(this._keyCount);

    if (this._pressCounterOffset >= 0) {
      for (let i = 0; i < this._keyCount; i++) {
        this._lastPressCounts[i] = inputData[this._pressCounterOffset + i];
      }
    }
  }

  static _normalizeKeyName(key) {
    if (typeof key !== 'string') return null;

    const normalizedKey = key.toLowerCase();
    const specialKeys = {
      space: ' ',
      spacebar: ' ',
      ctrl: 'control',
      ctl: 'control',
      alt: 'alt',
      return: 'enter',
    };

    return specialKeys[normalizedKey] || normalizedKey;
  }

  static _getKeyIndex(key) {
    if (!this._inputData || !this._keyIndexMap) return undefined;
    const keyName = this._normalizeKeyName(key);
    return keyName == null ? undefined : this._keyIndexMap[keyName];
  }

  /**
   * Check if a key is currently pressed
   * @param {string} key - Key name (case-insensitive)
   * @returns {boolean} True if key is down
   */
  static isDown(key) {
    const index = this._getKeyIndex(key);
    return index !== undefined ? this._inputData[index] === 1 : false;
  }

  /**
   * Check if a key was just pressed this frame
   * Requires updateEdgeFlags() to be called once per frame in the current thread.
   * @param {string} key - Key name
   * @returns {boolean} True if key was just pressed
   */
  static isPressed(key) {
    const index = this._getKeyIndex(key);
    return index !== undefined ? this._pressedThisFrame[index] === 1 : false;
  }

  /**
   * Snapshot keyboard press counters for the current frame.
   * Call once per frame before scene/game logic runs.
   */
  static updateEdgeFlags() {
    if (!this._inputData || this._pressCounterOffset < 0 || !this._lastPressCounts || !this._pressedThisFrame) {
      return;
    }

    const input = this._inputData;
    const offset = this._pressCounterOffset;

    for (let i = 0; i < this._keyCount; i++) {
      const currentCount = input[offset + i];
      const wasPressed = currentCount !== this._lastPressCounts[i];
      this._pressedThisFrame[i] = wasPressed ? 1 : 0;
      this._lastPressCounts[i] = currentCount;
    }
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
    if (typeof prop === 'string') {
      const index = target._getKeyIndex(prop);
      return index !== undefined ? target._inputData[index] === 1 : false;
    }

    return undefined;
  },
});

export default KeyboardProxy;
