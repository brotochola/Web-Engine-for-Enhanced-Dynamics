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
  /** E-248: 1 while a pad's rows hold zeros (absent and cleared). */
  static _padCleared = new Uint8Array(4).fill(1);

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
    // E-248: each pad's rows are all zero (a new buffer); poll writes an absent pad's zeros once, not every frame.
    this._padCleared = new Uint8Array(this.MAX_PADS).fill(1);

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
        if (this._padCleared[pad] === 1) continue;
        this._padCleared[pad] = 1;
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
      this._padCleared[pad] = 0;

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

  // Pad 0's getters (Mouse-style: Gamepad.leftX, Gamepad.isADown, Gamepad.isAPressed, …) are made below the class
  // from PAD0_AXES and PAD0_BUTTONS.
}

// ============================================
// PAD-0 ERGONOMICS (Mouse-style)
// ============================================

/** Pad 0's sticks, getAxis(0, n): Gamepad.leftX, leftY, rightX, rightY. */
const PAD0_AXES = ['leftX', 'leftY', 'rightX', 'rightY'];

/**
 * Pad 0's buttons: Gamepad.is<Name>Down (isButtonDown) and Gamepad.is<Name>Pressed (isButtonPressed), for the W3C
 * index in Gamepad[<constant>]: isADown, isLBPressed, isSelectDown, isUpPressed, …
 */
const PAD0_BUTTONS = [
  ['A', 'A'], ['B', 'B'], ['X', 'X'], ['Y', 'Y'], ['LB', 'LB'], ['RB', 'RB'], ['LT', 'LT'], ['RT', 'RT'],
  ['Select', 'SELECT'], ['Start', 'START'], ['L3', 'L3'], ['R3', 'R3'],
  ['Up', 'UP'], ['Down', 'DOWN'], ['Left', 'LEFT'], ['Right', 'RIGHT'], ['Home', 'HOME'],
];

/**
 * N-303 CR-29: one pad-0 getter, `this.<method>(0, arg)` (arg an axis index, or the name of Gamepad's button constant),
 * compiled on its own as component.js compiles its field accessors (CODE_REDUCTION_PLAN rule 7: closures of one function
 * share their feedback); a closure where new Function is refused (a page's CSP).
 */
function pad0Getter(method, arg) {
  const argCode = typeof arg === 'number' ? String(arg) : `this.${arg}`;
  try {
    return new Function(`return function () { return this.${method}(0, ${argCode}); };`)();
  } catch {
    return typeof arg === 'number'
      ? function () { return this[method](0, arg); }
      : function () { return this[method](0, this[arg]); };
  }
}

for (let a = 0; a < PAD0_AXES.length; a++) {
  Object.defineProperty(Gamepad, PAD0_AXES[a], { get: pad0Getter('getAxis', a), configurable: true });
}
for (let i = 0; i < PAD0_BUTTONS.length; i++) {
  const [name, constant] = PAD0_BUTTONS[i];
  Object.defineProperty(Gamepad, `is${name}Down`, { get: pad0Getter('isButtonDown', constant), configurable: true });
  Object.defineProperty(Gamepad, `is${name}Pressed`, { get: pad0Getter('isButtonPressed', constant), configurable: true });
}
