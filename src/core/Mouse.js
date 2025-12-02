// Mouse.js - Static mouse input interface
// Provides zero-overhead access to mouse state from shared input data

export class Mouse {
  static _inputData = null; // Int32Array from logic worker

  /**
   * Initialize mouse with shared input data
   * @param {Int32Array} inputData - Shared input data array
   */
  static initialize(inputData) {
    this._inputData = inputData;
  }

  // Position getters
  static get x() {
    return this._inputData ? this._inputData[0] : 0;
  }

  static get y() {
    return this._inputData ? this._inputData[1] : 0;
  }

  // State getters
  static get isInWorld() {
    return this._inputData ? this._inputData[2] === 1 : false;
  }

  static get isButton0Down() {
    return this._inputData ? this._inputData[3] === 1 : false;
  }

  static get isButton1Down() {
    return this._inputData ? this._inputData[4] === 1 : false;
  }

  static get isButton2Down() {
    return this._inputData ? this._inputData[5] === 1 : false;
  }

  // Aliases for convenience
  static get isDown() {
    return this.isButton0Down; // Left button (most common)
  }

  static get isLeftButtonDown() {
    return this.isButton0Down;
  }

  static get isMiddleButtonDown() {
    return this.isButton1Down;
  }

  static get isRightButtonDown() {
    return this.isButton2Down;
  }
}
