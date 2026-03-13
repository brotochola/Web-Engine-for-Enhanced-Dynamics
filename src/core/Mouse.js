// Mouse.js - Static mouse input interface
// Pure utility class like Camera and Keyboard - NOT a GameObject
// Zero allocations, direct SharedArrayBuffer access

/**
 * Static Mouse class for cross-worker mouse state access.
 *
 * SharedArrayBuffer layout (13 Float32 values):
 *   [0] x              - world X
 *   [1] y              - world Y
 *   [2] button0        - left button held (1/0)
 *   [3] button1        - middle button held (1/0)
 *   [4] button2        - right button held (1/0)
 *   [5] isPresent      - cursor is over the canvas (1/0)
 *   [6] wheel          - accumulated wheel delta this frame
 *   [7] btn0PressCount - incremented on every left mousedown
 *   [8] btn0ReleaseCount - incremented on every left mouseup
 *   [9] btn1PressCount
 *  [10] btn1ReleaseCount
 *  [11] btn2PressCount
 *  [12] btn2ReleaseCount
 *
 * Edge detection (isButton0Pressed / isButton0Released):
 *   The main thread increments press/release counters in the SAB on each
 *   DOM event. Each worker keeps its own local "last seen" counter. At the
 *   start of each frame the worker calls updateEdgeFlags(), which compares
 *   SAB counters to local counters and sets stable boolean flags for the
 *   entire frame. This avoids the race conditions inherent in comparing
 *   current vs previous boolean state across threads.
 *
 * NOT an entity - does not participate in spatial grid or neighbor detection.
 * For spatial queries near mouse, use Grid.getEntitiesInRadius(Mouse.x, Mouse.y, radius)
 */
export class Mouse {
  static _data = null;

  // Canvas position for world coordinate calculation (main thread only)
  static _canvasX = 0;
  static _canvasY = 0;

  // Debug tool mode flag - when true, button state is consumed by DebugUI tools
  static isDebugToolActive = false;

  // ============================================
  // SAB LAYOUT
  // ============================================

  static _X = 0;
  static _Y = 1;
  static _BUTTON0 = 2;
  static _BUTTON1 = 3;
  static _BUTTON2 = 4;
  static _IS_PRESENT = 5;
  static _WHEEL = 6;
  static _BTN0_PRESS = 7;
  static _BTN0_RELEASE = 8;
  static _BTN1_PRESS = 9;
  static _BTN1_RELEASE = 10;
  static _BTN2_PRESS = 11;
  static _BTN2_RELEASE = 12;

  /** SAB size in bytes (13 Float32 values = 52 bytes) */
  static BUFFER_SIZE = 13 * 4;

  // ============================================
  // PER-WORKER EDGE DETECTION STATE
  // ============================================

  // Last-seen counter values (local to each thread/worker)
  static _lastPress0 = 0;
  static _lastRelease0 = 0;
  static _lastPress1 = 0;
  static _lastRelease1 = 0;
  static _lastPress2 = 0;
  static _lastRelease2 = 0;

  // Stable edge flags computed once per frame by updateEdgeFlags()
  static _button0JustPressed = false;
  static _button0JustReleased = false;
  static _button1JustPressed = false;
  static _button1JustReleased = false;
  static _button2JustPressed = false;
  static _button2JustReleased = false;

  // Previous position/presence (per-worker, updated by updateEdgeFlags)
  static _prevX = 0;
  static _prevY = 0;
  static _prevWheel = 0;

  // ============================================
  // INITIALIZATION
  // ============================================

  /**
   * Initialize mouse with shared data buffer.
   * Called once per thread (main thread and each worker).
   * @param {SharedArrayBuffer|Float32Array} buffer
   */
  static initialize(buffer) {
    if (buffer instanceof SharedArrayBuffer) {
      this._data = new Float32Array(buffer);
    } else {
      this._data = buffer;
    }
    // Sync local counters so we don't fire spurious edges on first frame
    this._lastPress0 = this._data[7];
    this._lastRelease0 = this._data[8];
    this._lastPress1 = this._data[9];
    this._lastRelease1 = this._data[10];
    this._lastPress2 = this._data[11];
    this._lastRelease2 = this._data[12];
  }

  /** @returns {boolean} */
  static get isInitialized() {
    return this._data !== null;
  }

  // ============================================
  // POSITION
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

  static get prevX() { return this._prevX; }
  static get prevY() { return this._prevY; }

  // ============================================
  // BUTTON HELD STATE (true every frame while held)
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

  // ============================================
  // BUTTON EDGE DETECTION (true only on the frame the event occurred)
  //
  // Call updateEdgeFlags() once per frame BEFORE entity ticks.
  // After that, these getters return a stable value for the whole frame.
  // ============================================

  /**
   * True on the frame the left button was pressed (mousedown edge).
   * Reliable across all workers — uses SAB event counters.
   */
  static get isButton0Pressed() { return this._button0JustPressed; }

  /** True on the frame the left button was released (mouseup edge). */
  static get isButton0Released() { return this._button0JustReleased; }

  /** True on the frame the middle button was pressed. */
  static get isButton1Pressed() { return this._button1JustPressed; }

  /** True on the frame the middle button was released. */
  static get isButton1Released() { return this._button1JustReleased; }

  /** True on the frame the right button was pressed. */
  static get isButton2Pressed() { return this._button2JustPressed; }

  /** True on the frame the right button was released. */
  static get isButton2Released() { return this._button2JustReleased; }

  // ============================================
  // PRESENCE & WHEEL
  // ============================================

  static get isPresent() {
    return this._data ? this._data[5] === 1 : false;
  }
  static set isPresent(value) {
    if (this._data) this._data[5] = value ? 1 : 0;
  }

  static get wheel() {
    return this._data ? this._data[6] : 0;
  }
  static set wheel(value) {
    if (this._data) this._data[6] = value;
  }

  static get prevWheel() { return this._prevWheel; }

  // ============================================
  // ALIASES
  // ============================================

  // Held state aliases
  static get isDown() { return this.isButton0Down; }
  static get isInWorld() { return this.isPresent; }
  static get isLeftButtonDown() { return this.isButton0Down; }
  static get isMiddleButtonDown() { return this.isButton1Down; }
  static get isRightButtonDown() { return this.isButton2Down; }

  // Edge detection aliases
  /** Alias for isButton0Pressed — true on click frame. */
  static get clicked() { return this._button0JustPressed; }
  static get isLeftButtonPressed() { return this._button0JustPressed; }
  static get isLeftButtonReleased() { return this._button0JustReleased; }
  static get isMiddleButtonPressed() { return this._button1JustPressed; }
  static get isMiddleButtonReleased() { return this._button1JustReleased; }
  static get isRightButtonPressed() { return this._button2JustPressed; }
  static get isRightButtonReleased() { return this._button2JustReleased; }

  // ============================================
  // SAB COUNTER INCREMENTS (called by Scene on DOM events — main thread only)
  // ============================================

  /** @internal Increment left-button press counter in SAB. */
  static incrementPress0() { if (this._data) this._data[7]++; }
  /** @internal Increment left-button release counter in SAB. */
  static incrementRelease0() { if (this._data) this._data[8]++; }
  /** @internal Increment middle-button press counter in SAB. */
  static incrementPress1() { if (this._data) this._data[9]++; }
  /** @internal Increment middle-button release counter in SAB. */
  static incrementRelease1() { if (this._data) this._data[10]++; }
  /** @internal Increment right-button press counter in SAB. */
  static incrementPress2() { if (this._data) this._data[11]++; }
  /** @internal Increment right-button release counter in SAB. */
  static incrementRelease2() { if (this._data) this._data[12]++; }

  // ============================================
  // FRAME UPDATE (called once per frame per worker, BEFORE entity ticks)
  // ============================================

  /**
   * Compare SAB event counters against this worker's local counters and
   * set stable edge-detection flags for the current frame. Also snapshots
   * previous position/wheel values.
   *
   * Replaces the old updatePreviousValues() — works correctly across all
   * logic workers, not just worker 0.
   */
  static updateEdgeFlags() {
    if (!this._data) return;

    const d = this._data;

    // Edge detection via counter comparison
    this._button0JustPressed = d[7] !== this._lastPress0;
    this._button0JustReleased = d[8] !== this._lastRelease0;
    this._button1JustPressed = d[9] !== this._lastPress1;
    this._button1JustReleased = d[10] !== this._lastRelease1;
    this._button2JustPressed = d[11] !== this._lastPress2;
    this._button2JustReleased = d[12] !== this._lastRelease2;

    this._lastPress0 = d[7];
    this._lastRelease0 = d[8];
    this._lastPress1 = d[9];
    this._lastRelease1 = d[10];
    this._lastPress2 = d[11];
    this._lastRelease2 = d[12];

    // Snapshot position/wheel for delta calculations
    this._prevX = d[0];
    this._prevY = d[1];
    this._prevWheel = d[6];
  }

  // ============================================
  // WORLD POSITION CALCULATION (main thread only)
  // ============================================

  /**
   * Update world position from canvas coordinates.
   * @param {Object} camera - Camera object with zoom, x, y
   */
  static updateWorldPosition(camera) {
    if (this._data && this._canvasX !== undefined) {
      this._data[0] = this._canvasX / camera.zoom + camera.x;
      this._data[1] = this._canvasY / camera.zoom + camera.y;
    }
  }

  /**
   * Set canvas coordinates and update world position.
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
