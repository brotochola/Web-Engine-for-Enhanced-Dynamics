// Mouse.js - Static pointer input (mouse, pen, touch)
// Pure utility class like Camera and Keyboard - NOT a GameObject
// Zero allocations, direct SharedArrayBuffer access

/**
 * Static Mouse class for cross-worker pointer state.
 *
 * SharedArrayBuffer layout (36 Float32 values, 144 bytes):
 *   Header:
 *     [0] isPresent
 *     [1] wheel
 *     [2] btn1        [3] btn2
 *     [4] press1      [5] rel1
 *     [6] press2      [7] rel2
 *   Stride 7, MAX 4 contacts (slot i at 8 + i * 7):
 *     down, x, y, press, release, canvasX, canvasY
 *   x/y are world; canvasX/canvasY are canvas pixels (gestures such as pinch must be
 *   measured there, or a zoom driven by them feeds back through the camera).
 *
 * Slot 0 is the primary pointer: the cursor or pen, or the first finger
 * when no cursor owns the slot. Mouse.x and isButton0Down read that slot.
 * Middle and right buttons belong to the cursor, not to a finger.
 *
 * Edge detection uses SAB counters. Each realm keeps the last counter it
 * saw. updateEdgeFlags() latches stable booleans for the frame.
 * snapshotPreviousFrame() copies each slot's world position at frame end.
 *
 * NOT an entity. For a spatial query, use Grid.getEntitiesInRadius(Mouse.x, Mouse.y, radius).
 */
export class Mouse {
  static _data = null;

  /** Contacts in the table. Slot 0 is the primary pointer. */
  static MAX = 4;

  static HEADER = 8;
  static STRIDE = 7;

  // Header
  static _PRESENT = 0;
  static _WHEEL = 1;
  static _BTN1 = 2;
  static _BTN2 = 3;
  static _PRESS1 = 4;
  static _REL1 = 5;
  static _PRESS2 = 6;
  static _REL2 = 7;

  // Stride
  static _DOWN = 0;
  static _SX = 1;
  static _SY = 2;
  static _PRESS = 3;
  static _RELEASE = 4;
  static _CX = 5;
  static _CY = 6;

  /** SAB size in bytes: HEADER + MAX * STRIDE Float32 values. */
  static BUFFER_SIZE = (this.HEADER + this.MAX * this.STRIDE) * 4;

  // Debug tool mode flag - when true, primary-button down is consumed by DebugUI tools
  static isDebugToolActive = false;

  // Cursor owns slot 0 until it leaves with no button held (main thread)
  static _mouseOwnsSlot0 = false;

  // Main-thread pointerId → slot. -1 empty. Workers never read this.
  static _ids = new Int32Array(this.MAX).fill(-1);
  static _canvasX = new Float64Array(this.MAX);
  static _canvasY = new Float64Array(this.MAX);

  // Per-realm edge state
  static _lastDownPress = new Float32Array(this.MAX);
  static _lastDownRelease = new Float32Array(this.MAX);
  static _downPressed = new Uint8Array(this.MAX);
  static _downReleased = new Uint8Array(this.MAX);
  static _lastPress1 = 0;
  static _lastRelease1 = 0;
  static _lastPress2 = 0;
  static _lastRelease2 = 0;
  static _button1JustPressed = false;
  static _button1JustReleased = false;
  static _button2JustPressed = false;
  static _button2JustReleased = false;

  static _prevXs = new Float32Array(this.MAX);
  static _prevYs = new Float32Array(this.MAX);
  // Canvas positions and the pinch pair at the end of the previous frame (per realm).
  static _prevCXs = new Float32Array(this.MAX);
  static _prevCYs = new Float32Array(this.MAX);
  static _prevPinchA = -1;
  static _prevPinchB = -1;
  static _prevWheel = 0;
  static _pinchPair = new Int32Array(2);

  static _slot(i) {
    return this.HEADER + i * this.STRIDE;
  }

  /**
   * @param {SharedArrayBuffer|Float32Array} buffer
   */
  static initialize(buffer) {
    if (buffer instanceof SharedArrayBuffer) {
      this._data = new Float32Array(buffer);
    } else {
      this._data = buffer;
    }
    const d = this._data;
    for (let i = 0; i < this.MAX; i++) {
      const base = this._slot(i);
      this._lastDownPress[i] = d[base + this._PRESS] || 0;
      this._lastDownRelease[i] = d[base + this._RELEASE] || 0;
      this._downPressed[i] = 0;
      this._downReleased[i] = 0;
    }
    this._lastPress1 = d[this._PRESS1] || 0;
    this._lastRelease1 = d[this._REL1] || 0;
    this._lastPress2 = d[this._PRESS2] || 0;
    this._lastRelease2 = d[this._REL2] || 0;
    this._button1JustPressed = false;
    this._button1JustReleased = false;
    this._button2JustPressed = false;
    this._button2JustReleased = false;
  }

  /** @returns {boolean} */
  static get isInitialized() {
    return this._data !== null;
  }

  /**
   * Clear contact state and the pointer-id table.
   * Press counters stay so a realm does not see a false edge.
   */
  static reset() {
    const d = this._data;
    if (d) {
      d[this._PRESENT] = 0;
      d[this._WHEEL] = 0;
      d[this._BTN1] = 0;
      d[this._BTN2] = 0;
      for (let i = 0; i < this.MAX; i++) d[this._slot(i) + this._DOWN] = 0;
    }
    this._ids.fill(-1);
    this._mouseOwnsSlot0 = false;
  }

  // ============================================
  // POSITION
  // ============================================

  static get x() {
    return this.xAt(0);
  }
  static set x(value) {
    if (this._data) this._data[this._slot(0) + this._SX] = value;
  }

  static get y() {
    return this.yAt(0);
  }
  static set y(value) {
    if (this._data) this._data[this._slot(0) + this._SY] = value;
  }

  static get prevX() { return this._prevXs[0]; }
  static get prevY() { return this._prevYs[0]; }

  static xAt(i) {
    i = i | 0;
    if (!this._data || i < 0 || i >= this.MAX) return 0;
    return this._data[this._slot(i) + this._SX];
  }

  static yAt(i) {
    i = i | 0;
    if (!this._data || i < 0 || i >= this.MAX) return 0;
    return this._data[this._slot(i) + this._SY];
  }

  /** Canvas x in pixels of contact slot i (any realm). */
  static canvasXAt(i) {
    i = i | 0;
    if (!this._data || i < 0 || i >= this.MAX) return 0;
    return this._data[this._slot(i) + this._CX];
  }

  /** Canvas y in pixels of contact slot i (any realm). */
  static canvasYAt(i) {
    i = i | 0;
    if (!this._data || i < 0 || i >= this.MAX) return 0;
    return this._data[this._slot(i) + this._CY];
  }

  static prevXAt(i) {
    i = i | 0;
    if (i < 0 || i >= this.MAX) return 0;
    return this._prevXs[i];
  }

  static prevYAt(i) {
    i = i | 0;
    if (i < 0 || i >= this.MAX) return 0;
    return this._prevYs[i];
  }

  // ============================================
  // BUTTON HELD STATE
  // ============================================

  static get isButton0Down() {
    return this.isDownAt(0);
  }
  static set isButton0Down(value) {
    if (this._data) this._data[this._slot(0) + this._DOWN] = value ? 1 : 0;
  }

  static get isButton1Down() {
    return this._data ? this._data[this._BTN1] === 1 : false;
  }
  static set isButton1Down(value) {
    if (this._data) this._data[this._BTN1] = value ? 1 : 0;
  }

  static get isButton2Down() {
    return this._data ? this._data[this._BTN2] === 1 : false;
  }
  static set isButton2Down(value) {
    if (this._data) this._data[this._BTN2] = value ? 1 : 0;
  }

  static isDownAt(i) {
    i = i | 0;
    if (!this._data || i < 0 || i >= this.MAX) return false;
    return this._data[this._slot(i) + this._DOWN] === 1;
  }

  /** Contacts with the primary button down. Hover and right-click do not count. */
  static get count() {
    let n = 0;
    for (let i = 0; i < this.MAX; i++) if (this.isDownAt(i)) n++;
    return n;
  }

  // ============================================
  // EDGE DETECTION
  // ============================================

  static get isButton0Pressed() { return this.isPressedAt(0); }
  static get isButton0Released() { return this.isReleasedAt(0); }
  static get isButton1Pressed() { return this._button1JustPressed; }
  static get isButton1Released() { return this._button1JustReleased; }
  static get isButton2Pressed() { return this._button2JustPressed; }
  static get isButton2Released() { return this._button2JustReleased; }

  static isPressedAt(i) {
    i = i | 0;
    if (i < 0 || i >= this.MAX) return false;
    return this._downPressed[i] === 1;
  }

  static isReleasedAt(i) {
    i = i | 0;
    if (i < 0 || i >= this.MAX) return false;
    return this._downReleased[i] === 1;
  }

  // ============================================
  // PRESENCE & WHEEL
  // ============================================

  static get isPresent() {
    return this._data ? this._data[this._PRESENT] === 1 : false;
  }
  static set isPresent(value) {
    if (this._data) this._data[this._PRESENT] = value ? 1 : 0;
  }

  static get wheel() {
    return this._data ? this._data[this._WHEEL] : 0;
  }
  static set wheel(value) {
    if (this._data) this._data[this._WHEEL] = value;
  }

  static get prevWheel() { return this._prevWheel; }

  /** @param {number} deltaY */
  static addWheel(deltaY) {
    if (this._data) this._data[this._WHEEL] += deltaY;
  }

  // ============================================
  // ALIASES
  // ============================================

  static get isDown() { return this.isButton0Down; }
  static get isInWorld() { return this.isPresent; }
  static get isLeftButtonDown() { return this.isButton0Down; }
  static get isMiddleButtonDown() { return this.isButton1Down; }
  static get isRightButtonDown() { return this.isButton2Down; }

  /** Alias for isButton0Pressed — true on the primary press frame. */
  static get clicked() { return this.isPressedAt(0); }
  static get isLeftButtonPressed() { return this.isPressedAt(0); }
  static get isLeftButtonReleased() { return this.isReleasedAt(0); }
  static get isMiddleButtonPressed() { return this._button1JustPressed; }
  static get isMiddleButtonReleased() { return this._button1JustReleased; }
  static get isRightButtonPressed() { return this._button2JustPressed; }
  static get isRightButtonReleased() { return this._button2JustReleased; }

  // ============================================
  // PINCH (first two contacts that are down)
  // ============================================

  static _twoDown() {
    const pair = this._pinchPair;
    let n = 0;
    for (let i = 0; i < this.MAX && n < 2; i++) {
      if (this.isDownAt(i)) pair[n++] = i;
    }
    return n;
  }

  /**
   * Screen distance now / screen distance last frame between the first two contacts
   * that are down. 1 when fewer than two are down, when either one landed or lifted
   * this frame, or when the pair changed (no previous distance to compare).
   * Measured in canvas pixels, so `targetZoom *= Mouse.pinchRatio()` does not feed back.
   */
  static pinchRatio() {
    if (this._twoDown() < 2) return 1;
    const a = this._pinchPair[0];
    const b = this._pinchPair[1];
    if (a !== this._prevPinchA || b !== this._prevPinchB) return 1;
    if (this.isPressedAt(a) || this.isPressedAt(b) || this.isReleasedAt(a) || this.isReleasedAt(b)) {
      return 1;
    }
    const pdx = this._prevCXs[a] - this._prevCXs[b];
    const pdy = this._prevCYs[a] - this._prevCYs[b];
    const prev = Math.sqrt(pdx * pdx + pdy * pdy);
    if (!(prev > 0)) return 1;
    const dx = this.canvasXAt(a) - this.canvasXAt(b);
    const dy = this.canvasYAt(a) - this.canvasYAt(b);
    return Math.sqrt(dx * dx + dy * dy) / prev;
  }

  static get pinchX() {
    if (this._twoDown() < 2) return this.x;
    return (this.xAt(this._pinchPair[0]) + this.xAt(this._pinchPair[1])) * 0.5;
  }

  static get pinchY() {
    if (this._twoDown() < 2) return this.y;
    return (this.yAt(this._pinchPair[0]) + this.yAt(this._pinchPair[1])) * 0.5;
  }

  // ============================================
  // FRAME UPDATE
  // ============================================

  static updateEdgeFlags() {
    const d = this._data;
    if (!d) return;

    const lastP = this._lastDownPress;
    const lastR = this._lastDownRelease;
    const pressed = this._downPressed;
    const released = this._downReleased;
    for (let i = 0; i < this.MAX; i++) {
      const base = this._slot(i);
      const p = d[base + this._PRESS] || 0;
      const r = d[base + this._RELEASE] || 0;
      pressed[i] = p !== lastP[i] ? 1 : 0;
      released[i] = r !== lastR[i] ? 1 : 0;
      lastP[i] = p;
      lastR[i] = r;
    }

    this._button1JustPressed = d[this._PRESS1] !== this._lastPress1;
    this._button1JustReleased = d[this._REL1] !== this._lastRelease1;
    this._button2JustPressed = d[this._PRESS2] !== this._lastPress2;
    this._button2JustReleased = d[this._REL2] !== this._lastRelease2;
    this._lastPress1 = d[this._PRESS1] || 0;
    this._lastRelease1 = d[this._REL1] || 0;
    this._lastPress2 = d[this._PRESS2] || 0;
    this._lastRelease2 = d[this._REL2] || 0;
  }

  static snapshotPreviousFrame() {
    const d = this._data;
    if (!d) return;
    for (let i = 0; i < this.MAX; i++) {
      const base = this._slot(i);
      this._prevXs[i] = d[base + this._SX] || 0;
      this._prevYs[i] = d[base + this._SY] || 0;
      this._prevCXs[i] = d[base + this._CX] || 0;
      this._prevCYs[i] = d[base + this._CY] || 0;
    }
    if (this._twoDown() === 2) {
      this._prevPinchA = this._pinchPair[0];
      this._prevPinchB = this._pinchPair[1];
    } else {
      this._prevPinchA = -1;
      this._prevPinchB = -1;
    }
    this._prevWheel = d[this._WHEEL] || 0;
  }

  // ============================================
  // WORLD POSITION (main thread)
  // ============================================

  /**
   * Refresh world positions from the last canvas coordinates.
   * Slot 0 tracks the camera every frame. Other slots refresh only while down.
   * @param {Object} camera
   */
  static updateWorldPosition(camera) {
    if (!this._data || !camera) return;
    this._writeWorld(0, camera);
    for (let i = 1; i < this.MAX; i++) {
      if (this.isDownAt(i)) this._writeWorld(i, camera);
    }
  }

  /**
   * Put slot 0 at a canvas point and refresh its world position.
   * @param {number} canvasX
   * @param {number} canvasY
   * @param {Object} camera
   */
  static setCanvasPosition(canvasX, canvasY, camera) {
    this._writeCanvas(0, canvasX, canvasY);
    this._writeWorld(0, camera);
  }

  static _writeCanvas(slot, canvasX, canvasY) {
    this._canvasX[slot] = canvasX;
    this._canvasY[slot] = canvasY;
    const d = this._data;
    if (!d) return;
    const base = this._slot(slot);
    d[base + this._CX] = canvasX;
    d[base + this._CY] = canvasY;
  }

  static _writeWorld(slot, camera) {
    const d = this._data;
    if (!d || !camera) return;
    const canvasX = this._canvasX[slot];
    const canvasY = this._canvasY[slot];
    const base = this._slot(slot);
    const zoom = camera.zoom || 1;
    const rot = camera.rotation || 0;
    const cw = camera.canvasWidth || 0;
    const ch = camera.canvasHeight || 0;
    if (!rot || !(cw > 0 && ch > 0 && zoom > 0)) {
      d[base + this._SX] = canvasX / zoom + camera.x;
      d[base + this._SY] = canvasY / zoom + camera.y;
      return;
    }
    const focusX = camera.x + cw / (2 * zoom);
    const focusY = camera.y + ch / (2 * zoom);
    const sx = canvasX - cw * 0.5;
    const sy = canvasY - ch * 0.5;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const inv = 1 / zoom;
    d[base + this._SX] = focusX + (c * sx + s * sy) * inv;
    d[base + this._SY] = focusY + (-s * sx + c * sy) * inv;
  }

  // ============================================
  // POINTER EVENTS (main thread)
  // ============================================

  static _pid(e) {
    return e.pointerId | 0;
  }

  static _isTouch(e) {
    return e.pointerType === 'touch';
  }

  static _findId(id) {
    const ids = this._ids;
    for (let i = 0; i < this.MAX; i++) if (ids[i] === id) return i;
    return -1;
  }

  static _allocTouch() {
    const start = this._mouseOwnsSlot0 ? 1 : 0;
    const ids = this._ids;
    for (let i = start; i < this.MAX; i++) {
      if (ids[i] < 0) return i;
    }
    return -1;
  }

  static _setHeld(index, held, pressIndex, releaseIndex) {
    const d = this._data;
    if (!d) return;
    const next = held ? 1 : 0;
    if (d[index] === next) return;
    d[index] = next;
    d[held ? pressIndex : releaseIndex]++;
  }

  static _setDown(slot, held) {
    const base = this._slot(slot);
    this._setHeld(base + this._DOWN, held, base + this._PRESS, base + this._RELEASE);
  }

  static _cursorHeld() {
    return this.isButton0Down || this.isButton1Down || this.isButton2Down;
  }

  /**
   * Pointer Events fire pointerdown for the first button and pointerup for the last;
   * every press or release in between is a pointermove with a new `buttons` mask
   * (1 primary, 2 secondary, 4 auxiliary). Releases always apply. A press applies only
   * when `allowPress`: a move that did not start on this canvas (a drag in from a DOM
   * panel) must not start one.
   * @param {number} buttons
   * @param {boolean} allowPress
   */
  static _syncCursorButtons(buttons, allowPress) {
    if ((buttons & 1) === 0) this._setDown(0, false);
    else if (allowPress && !this.isDebugToolActive) this._setDown(0, true);
    if ((buttons & 4) === 0) this._setHeld(this._BTN1, false, this._PRESS1, this._REL1);
    else if (allowPress) this._setHeld(this._BTN1, true, this._PRESS1, this._REL1);
    if ((buttons & 2) === 0) this._setHeld(this._BTN2, false, this._PRESS2, this._REL2);
    else if (allowPress) this._setHeld(this._BTN2, true, this._PRESS2, this._REL2);
  }

  static _claimCursor(pointerId) {
    this._mouseOwnsSlot0 = true;
    if (this._ids[0] !== pointerId && this._ids[0] >= 0) this._setDown(0, false);
    this._ids[0] = pointerId;
  }

  static _place(slot, e, camera) {
    const el = e.currentTarget;
    let x = e.clientX;
    let y = e.clientY;
    if (el && el.getBoundingClientRect) {
      const rect = el.getBoundingClientRect();
      x -= rect.left;
      y -= rect.top;
    }
    this._writeCanvas(slot, x, y);
    if (camera) this._writeWorld(slot, camera);
  }

  static _inside(e) {
    const el = e.currentTarget;
    if (!el || !el.getBoundingClientRect) return true;
    const rect = el.getBoundingClientRect();
    return e.clientX >= rect.left && e.clientX < rect.right
      && e.clientY >= rect.top && e.clientY < rect.bottom;
  }

  static _capture(e) {
    const el = e.currentTarget;
    if (!el || typeof el.setPointerCapture !== 'function') return;
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* pointer already gone */ }
  }

  static _releaseCapture(e) {
    const el = e.currentTarget;
    if (!el || typeof el.releasePointerCapture !== 'function') return;
    try { el.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
  }

  static _releaseCursor(e) {
    if (this._cursorHeld()) return;
    this.isPresent = false;
    this._mouseOwnsSlot0 = false;
    if (this._ids[0] === this._pid(e)) this._ids[0] = -1;
  }

  static _endTouch(e, camera) {
    const slot = this._findId(this._pid(e));
    if (slot < 0) return;
    this._place(slot, e, camera);
    this._setDown(slot, false);
    this._ids[slot] = -1;
    if (slot === 0) this.isPresent = false;
    this._releaseCapture(e);
  }

  /**
   * @param {PointerEvent} e
   * @param {Object} [camera]
   */
  static pointerDown(e, camera) {
    if (!e || !this._data) return;
    const id = this._pid(e);
    const button = e.button | 0;
    if (this._isTouch(e)) {
      const slot = this._allocTouch();
      if (slot < 0) return;
      this._ids[slot] = id;
      this._place(slot, e, camera);
      if (slot === 0) this.isPresent = true;
      if (!(this.isDebugToolActive && button === 0)) this._setDown(slot, true);
    } else {
      this._claimCursor(id);
      this._place(0, e, camera);
      this.isPresent = true;
      if (typeof e.buttons === 'number') {
        this._syncCursorButtons(e.buttons, true);
      } else if (button === 0) {
        if (!this.isDebugToolActive) this._setDown(0, true);
      } else if (button === 1) {
        this._setHeld(this._BTN1, true, this._PRESS1, this._REL1);
      } else if (button === 2) {
        this._setHeld(this._BTN2, true, this._PRESS2, this._REL2);
      }
    }
    this._capture(e);
  }

  /**
   * @param {PointerEvent} e
   * @param {Object} [camera]
   */
  static pointerMove(e, camera) {
    if (!e || !this._data) return;
    if (this._isTouch(e)) {
      const slot = this._findId(this._pid(e));
      if (slot < 0) return;
      this._place(slot, e, camera);
      return;
    }
    this._claimCursor(this._pid(e));
    this._place(0, e, camera);
    this.isPresent = true;
    // A chord's middle presses and releases only arrive here. A new press counts only
    // while a button pressed on this canvas is still held.
    if (typeof e.buttons === 'number') this._syncCursorButtons(e.buttons, this._cursorHeld());
  }

  /**
   * @param {PointerEvent} e
   * @param {Object} [camera]
   */
  static pointerUp(e, camera) {
    if (!e || !this._data) return;
    if (this._isTouch(e)) {
      this._endTouch(e, camera);
      return;
    }
    this._claimCursor(this._pid(e));
    this._place(0, e, camera);
    if (typeof e.buttons === 'number') {
      this._syncCursorButtons(e.buttons, false);
    } else {
      const button = e.button | 0;
      if (button === 0) this._setDown(0, false);
      else if (button === 1) this._setHeld(this._BTN1, false, this._PRESS1, this._REL1);
      else if (button === 2) this._setHeld(this._BTN2, false, this._PRESS2, this._REL2);
    }
    this._releaseCapture(e);
    if (!this._inside(e)) this._releaseCursor(e);
  }

  /**
   * @param {PointerEvent} e
   * @param {Object} [camera]
   */
  static pointerCancel(e, camera) {
    if (!e || !this._data) return;
    if (this._isTouch(e)) {
      this._endTouch(e, camera);
      return;
    }
    this._setDown(0, false);
    this._setHeld(this._BTN1, false, this._PRESS1, this._REL1);
    this._setHeld(this._BTN2, false, this._PRESS2, this._REL2);
    this._releaseCapture(e);
    this._releaseCursor(e);
  }

  /**
   * @param {PointerEvent} e
   */
  static pointerLeave(e) {
    if (!e || !this._data || this._isTouch(e)) return;
    this._releaseCursor(e);
  }
}
