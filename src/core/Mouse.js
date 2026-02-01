// Mouse.js - Static mouse input interface
// Pure utility class like Camera and Keyboard - NOT a GameObject
// Zero allocations, direct SharedArrayBuffer access

/**
 * Static Mouse class for cross-worker mouse state access
 * Mouse data is stored in a SharedArrayBuffer:
 * [x, y, button0, button1, button2, isPresent, wheel]
 *
 * NOT an entity - does not participate in spatial grid or neighbor detection.
 * For spatial queries near mouse, use Grid.getEntitiesInRadius(Mouse.x, Mouse.y, radius)
 */
export class Mouse {
  // SharedArrayBuffer view: Float32Array [x, y, button0, button1, button2, isPresent, wheel]
  // Using Float32 for all to keep alignment simple and avoid multiple views
  static _data = null;

  // Canvas position for world coordinate calculation (main thread only)
  static _canvasX = 0;
  static _canvasY = 0;

  // Previous frame values (updated by logic worker at end of each frame)
  static _prevX = 0;
  static _prevY = 0;
  static _prevButton0 = 0;
  static _prevButton1 = 0;
  static _prevButton2 = 0;
  static _prevIsPresent = 0;
  static _prevWheel = 0;

  // Debug tool mode flag - when true, button state is consumed by DebugUI tools
  static isDebugToolActive = false;

  // Buffer layout indices (compile-time constants for zero-overhead access)
  static _X = 0;
  static _Y = 1;
  static _BUTTON0 = 2;
  static _BUTTON1 = 3;
  static _BUTTON2 = 4;
  static _IS_PRESENT = 5;
  static _WHEEL = 6;

  // Buffer size in bytes (7 Float32 values = 28 bytes)
  static BUFFER_SIZE = 7 * 4;

  // ============================================
  // INITIALIZATION
  // ============================================

  /**
   * Initialize mouse with shared data buffer
   * @param {SharedArrayBuffer|Float32Array} buffer - SharedArrayBuffer or Float32Array view
   */
  static initialize(buffer) {
    if (buffer instanceof SharedArrayBuffer) {
      this._data = new Float32Array(buffer);
    } else {
      this._data = buffer;
    }
  }

  /**
   * Check if mouse is initialized
   * @returns {boolean}
   */
  static get isInitialized() {
    return this._data !== null;
  }

  // ============================================
  // POSITION - getters and setters
  // ============================================

  static get x() {
    return this._data ? this._data[0] : 0;
  }

  static set x(value) {
    if (this._data) this._data[0] = value;
  }

  static get y() {
    return this._data ? this._data[1] : 0;
  }

  static set y(value) {
    if (this._data) this._data[1] = value;
  }

  // ============================================
  // BUTTON STATE - getters and setters
  // ============================================

  static get isButton0Down() {
    return this._data ? this._data[2] === 1 : false;
  }

  static set isButton0Down(value) {
    if (this._data) this._data[2] = value ? 1 : 0;
  }

  static get isButton1Down() {
    return this._data ? this._data[3] === 1 : false;
  }

  static set isButton1Down(value) {
    if (this._data) this._data[3] = value ? 1 : 0;
  }

  static get isButton2Down() {
    return this._data ? this._data[4] === 1 : false;
  }

  static set isButton2Down(value) {
    if (this._data) this._data[4] = value ? 1 : 0;
  }

  static get isPresent() {
    return this._data ? this._data[5] === 1 : false;
  }

  static set isPresent(value) {
    if (this._data) this._data[5] = value ? 1 : 0;
  }

  // ============================================
  // WHEEL - accumulated delta per frame
  // ============================================

  static get wheel() {
    return this._data ? this._data[6] : 0;
  }

  static set wheel(value) {
    if (this._data) this._data[6] = value;
  }

  // ============================================
  // ALIASES (getters only)
  // ============================================

  static get isInWorld() {
    return this.isPresent;
  }

  static get isDown() {
    return this.isButton0Down;
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

  // ============================================
  // PREVIOUS FRAME VALUES - getters
  // ============================================

  static get prevX() {
    return this._prevX;
  }

  static get prevY() {
    return this._prevY;
  }

  static get prevButton0() {
    return this._prevButton0 === 1;
  }

  static get prevButton1() {
    return this._prevButton1 === 1;
  }

  static get prevButton2() {
    return this._prevButton2 === 1;
  }

  static get prevIsPresent() {
    return this._prevIsPresent === 1;
  }

  static get prevWheel() {
    return this._prevWheel;
  }

  // Convenience aliases for previous values (matching current value aliases)
  static get prevIsDown() {
    return this.prevButton0;
  }

  static get prevLeftButtonDown() {
    return this.prevButton0;
  }

  static get prevMiddleButtonDown() {
    return this.prevButton1;
  }

  static get prevRightButtonDown() {
    return this.prevButton2;
  }

  static get prevIsInWorld() {
    return this.prevIsPresent;
  }

  /**
   * Update previous frame values (called by logic worker at end of each frame)
   * This allows entities to access previous mouse state in their tick() methods
   */
  static updatePreviousValues() {
    if (this._data) {
      this._prevX = this._data[0];
      this._prevY = this._data[1];
      this._prevButton0 = this._data[2];
      this._prevButton1 = this._data[3];
      this._prevButton2 = this._data[4];
      this._prevIsPresent = this._data[5];
      this._prevWheel = this._data[6];
    }
  }

  // ============================================
  // WORLD POSITION CALCULATION (for main thread)
  // ============================================

  /**
   * Update world position from canvas coordinates
   * Call this when mouse moves or camera changes
   * @param {Object} camera - Camera object with zoom, x, y
   */
  static updateWorldPosition(camera) {
    if (this._data && this._canvasX !== undefined) {
      this._data[0] = this._canvasX / camera.zoom + camera.x;
      this._data[1] = this._canvasY / camera.zoom + camera.y;
    }
  }

  /**
   * Set canvas coordinates and update world position
   * @param {number} canvasX - X position on canvas
   * @param {number} canvasY - Y position on canvas
   * @param {Object} camera - Camera object with zoom, x, y
   */
  static setCanvasPosition(canvasX, canvasY, camera) {
    this._canvasX = canvasX;
    this._canvasY = canvasY;
    this.updateWorldPosition(camera);
  }
}
