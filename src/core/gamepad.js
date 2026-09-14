// Gamepad.js - Static multipad gamepad input interface
// Pure utility class like Mouse and Keyboard - NOT a GameObject
// Main thread polls navigator.getGamepads(); workers read SharedArrayBuffer

/**
 * Static Gamepad class for cross-worker gamepad state access.
 *
 * SharedArrayBuffer layout (Float32, MAX_PADS strides):
 *   Per pad (STRIDE floats):
 *     [0]     connected (1/0)
 *     [1..4]  axes leftX, leftY, rightX, rightY
 *     [5..21] button values 0..16 (0-1; digital usually 0/1)
 *     [22..38] press counters (incremented on rising edge in poll)
 *
 * Edge detection (isButtonPressed):
 *   Main thread bumps press counters in poll(). Each worker keeps local
 *   last-seen counters. updateEdgeFlags() compares and sets stable flags
 *   for the frame (same pattern as Mouse / Keyboard).
 *
 * Named Gamepad to match Mouse/Keyboard. Lives under WEED.Gamepad /
 * named import — does not replace window.Gamepad.
 */
export class Gamepad {
  static _data = null;

  static MAX_PADS = 4;
  static AXES_PER_PAD = 4;
  static BUTTONS_PER_PAD = 17;

  /** Floats per pad: connected + axes + buttons + pressCounters */
  static STRIDE = 1 + 4 + 17 + 17; // 39

  /** SAB size in bytes */
  static BUFFER_SIZE = 4 * 39 * 4; // MAX_PADS * STRIDE * 4

  static _CONNECTED = 0;
  static _AXIS0 = 1;
  static _BUTTON0 = 5;
  static _PRESS0 = 22;

  /** Stick deadzone applied in poll() */
  static DEADZONE = 0.15;

  /** Digital / press threshold */
  static BUTTON_DOWN_THRESHOLD = 0.5;

  // W3C standard gamepad button indices
  static A = 0;
  static B = 1;
  static X = 2;
  static Y = 3;
  static LB = 4;
  static RB = 5;
  static LT = 6;
  static RT = 7;
  static SELECT = 8;
  static START = 9;
  static L3 = 10;
  static R3 = 11;
  static UP = 12;
  static DOWN = 13;
  static LEFT = 14;
  static RIGHT = 15;
  static HOME = 16;

  // Per-thread edge state: last-seen counters + pressed-this-frame flags
  static _lastPressCounts = null;
  static _pressedThisFrame = null;

  /**
   * Initialize with shared data buffer.
   * Called once per thread (main + each worker).
   * @param {SharedArrayBuffer|Float32Array|null} buffer
   */
  static initialize(buffer) {
    if (!buffer) {
      this._data = null;
      this._lastPressCounts = new Float32Array(0);
      this._pressedThisFrame = new Uint8Array(0);
      return;
    }

    if (buffer instanceof SharedArrayBuffer) {
      this._data = new Float32Array(buffer);
    } else {
      this._data = buffer;
    }

    const count = this.MAX_PADS * this.BUTTONS_PER_PAD;
    this._lastPressCounts = new Float32Array(count);
    this._pressedThisFrame = new Uint8Array(count);

    // Sync local counters so first frame does not fire spurious edges
    for (let pad = 0; pad < this.MAX_PADS; pad++) {
      const base = pad * this.STRIDE + this._PRESS0;
      const offset = pad * this.BUTTONS_PER_PAD;
      for (let b = 0; b < this.BUTTONS_PER_PAD; b++) {
        this._lastPressCounts[offset + b] = this._data[base + b];
      }
    }
  }

  /** @returns {boolean} */
  static get isInitialized() {
    return this._data !== null;
  }

  static _padBase(pad) {
    return pad * this.STRIDE;
  }

  static _clampPad(pad) {
    const p = pad | 0;
    return p >= 0 && p < this.MAX_PADS ? p : -1;
  }

  static _clampButton(button) {
    const b = button | 0;
    return b >= 0 && b < this.BUTTONS_PER_PAD ? b : -1;
  }

  static _clampAxis(axis) {
    const a = axis | 0;
    return a >= 0 && a < this.AXES_PER_PAD ? a : -1;
  }

  static _applyDeadzone(value) {
    const dz = this.DEADZONE;
    return value > -dz && value < dz ? 0 : value;
  }

  /**
   * Poll navigator.getGamepads() into the SAB.
   * Main thread only — no-op in workers / Node without navigator.
   */
  static poll() {
    if (!this._data) return;
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return;
    }

    const pads = navigator.getGamepads();
    const data = this._data;
    const threshold = this.BUTTON_DOWN_THRESHOLD;

    for (let pad = 0; pad < this.MAX_PADS; pad++) {
      const base = this._padBase(pad);
      const gp = pads && pads[pad] ? pads[pad] : null;

      if (!gp) {
        data[base + this._CONNECTED] = 0;
        for (let a = 0; a < this.AXES_PER_PAD; a++) {
          data[base + this._AXIS0 + a] = 0;
        }
        for (let b = 0; b < this.BUTTONS_PER_PAD; b++) {
          data[base + this._BUTTON0 + b] = 0;
        }
        // Press counters intentionally left alone (no false edges on disconnect)
        continue;
      }

      data[base + this._CONNECTED] = 1;

      for (let a = 0; a < this.AXES_PER_PAD; a++) {
        const raw = gp.axes && a < gp.axes.length ? gp.axes[a] : 0;
        data[base + this._AXIS0 + a] = this._applyDeadzone(raw || 0);
      }

      for (let b = 0; b < this.BUTTONS_PER_PAD; b++) {
        const btnIndex = base + this._BUTTON0 + b;
        const prev = data[btnIndex];
        let value = 0;
        if (gp.buttons && b < gp.buttons.length) {
          const btn = gp.buttons[b];
          value = btn ? (typeof btn.value === 'number' ? btn.value : btn.pressed ? 1 : 0) : 0;
        }
        data[btnIndex] = value;

        // Rising edge while connected
        if (prev < threshold && value >= threshold) {
          data[base + this._PRESS0 + b]++;
        }
      }
    }
  }

  /**
   * Snapshot press counters for the current frame.
   * Call once per frame before scene/entity logic.
   */
  static updateEdgeFlags() {
    if (!this._data || !this._lastPressCounts || !this._pressedThisFrame) return;

    const data = this._data;
    for (let pad = 0; pad < this.MAX_PADS; pad++) {
      const base = this._padBase(pad) + this._PRESS0;
      const offset = pad * this.BUTTONS_PER_PAD;
      for (let b = 0; b < this.BUTTONS_PER_PAD; b++) {
        const idx = offset + b;
        const count = data[base + b];
        this._pressedThisFrame[idx] = count !== this._lastPressCounts[idx] ? 1 : 0;
        this._lastPressCounts[idx] = count;
      }
    }
  }

  /**
   * @param {number} [pad=0]
   * @returns {boolean}
   */
  static isConnected(pad = 0) {
    const p = this._clampPad(pad);
    if (p < 0 || !this._data) return false;
    return this._data[this._padBase(p) + this._CONNECTED] === 1;
  }

  /**
   * @param {number} pad
   * @param {number} axis - 0..3
   * @returns {number}
   */
  static getAxis(pad, axis) {
    const p = this._clampPad(pad);
    const a = this._clampAxis(axis);
    if (p < 0 || a < 0 || !this._data) return 0;
    return this._data[this._padBase(p) + this._AXIS0 + a];
  }

  /**
   * Analog button value 0..1 (triggers use full range).
   * @param {number} pad
   * @param {number} button - 0..16
   * @returns {number}
   */
  static getButton(pad, button) {
    const p = this._clampPad(pad);
    const b = this._clampButton(button);
    if (p < 0 || b < 0 || !this._data) return 0;
    return this._data[this._padBase(p) + this._BUTTON0 + b];
  }

  /**
   * @param {number} pad
   * @param {number} button
   * @returns {boolean}
   */
  static isButtonDown(pad, button) {
    return this.getButton(pad, button) >= this.BUTTON_DOWN_THRESHOLD;
  }

  /**
   * True on the frame the button was pressed. Requires updateEdgeFlags().
   * @param {number} pad
   * @param {number} button
   * @returns {boolean}
   */
  static isButtonPressed(pad, button) {
    const p = this._clampPad(pad);
    const b = this._clampButton(button);
    if (p < 0 || b < 0 || !this._pressedThisFrame) return false;
    return this._pressedThisFrame[p * this.BUTTONS_PER_PAD + b] === 1;
  }

  // ============================================
  // PAD-0 ERGONOMICS (Mouse-style)
  // ============================================

  static get leftX() {
    return this.getAxis(0, 0);
  }
  static get leftY() {
    return this.getAxis(0, 1);
  }
  static get rightX() {
    return this.getAxis(0, 2);
  }
  static get rightY() {
    return this.getAxis(0, 3);
  }

  static get isADown() {
    return this.isButtonDown(0, this.A);
  }
  static get isBDown() {
    return this.isButtonDown(0, this.B);
  }
  static get isXDown() {
    return this.isButtonDown(0, this.X);
  }
  static get isYDown() {
    return this.isButtonDown(0, this.Y);
  }
  static get isLBDown() {
    return this.isButtonDown(0, this.LB);
  }
  static get isRBDown() {
    return this.isButtonDown(0, this.RB);
  }
  static get isLTDown() {
    return this.isButtonDown(0, this.LT);
  }
  static get isRTDown() {
    return this.isButtonDown(0, this.RT);
  }
  static get isSelectDown() {
    return this.isButtonDown(0, this.SELECT);
  }
  static get isStartDown() {
    return this.isButtonDown(0, this.START);
  }
  static get isL3Down() {
    return this.isButtonDown(0, this.L3);
  }
  static get isR3Down() {
    return this.isButtonDown(0, this.R3);
  }
  static get isUpDown() {
    return this.isButtonDown(0, this.UP);
  }
  static get isDownDown() {
    return this.isButtonDown(0, this.DOWN);
  }
  static get isLeftDown() {
    return this.isButtonDown(0, this.LEFT);
  }
  static get isRightDown() {
    return this.isButtonDown(0, this.RIGHT);
  }
  static get isHomeDown() {
    return this.isButtonDown(0, this.HOME);
  }

  static get isAPressed() {
    return this.isButtonPressed(0, this.A);
  }
  static get isBPressed() {
    return this.isButtonPressed(0, this.B);
  }
  static get isXPressed() {
    return this.isButtonPressed(0, this.X);
  }
  static get isYPressed() {
    return this.isButtonPressed(0, this.Y);
  }
  static get isLBPressed() {
    return this.isButtonPressed(0, this.LB);
  }
  static get isRBPressed() {
    return this.isButtonPressed(0, this.RB);
  }
  static get isLTPressed() {
    return this.isButtonPressed(0, this.LT);
  }
  static get isRTPressed() {
    return this.isButtonPressed(0, this.RT);
  }
  static get isSelectPressed() {
    return this.isButtonPressed(0, this.SELECT);
  }
  static get isStartPressed() {
    return this.isButtonPressed(0, this.START);
  }
  static get isL3Pressed() {
    return this.isButtonPressed(0, this.L3);
  }
  static get isR3Pressed() {
    return this.isButtonPressed(0, this.R3);
  }
  static get isUpPressed() {
    return this.isButtonPressed(0, this.UP);
  }
  static get isDownPressed() {
    return this.isButtonPressed(0, this.DOWN);
  }
  static get isLeftPressed() {
    return this.isButtonPressed(0, this.LEFT);
  }
  static get isRightPressed() {
    return this.isButtonPressed(0, this.RIGHT);
  }
  static get isHomePressed() {
    return this.isButtonPressed(0, this.HOME);
  }
}
