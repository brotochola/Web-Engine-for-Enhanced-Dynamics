// Camera.js - Static camera interface for cross-worker access
// Provides consistent camera state via SharedArrayBuffer
// Pattern follows Mouse and Keyboard static classes

/**
 * Static Camera class for managing viewport state
 * Camera data is stored in a SharedArrayBuffer: [zoom, x, y]
 * - zoom: Camera zoom level (1 = 100%)
 * - x, y: Top-left corner of viewport in world coordinates
 */
export class Camera {
  // SharedArrayBuffer view: Float32Array [zoom, x, y]
  static _data = null;

  // Canvas dimensions (needed for centering calculations)
  static _canvasWidth = 0;
  static _canvasHeight = 0;

  // World bounds (for clamping camera to world edges)
  static _worldWidth = Infinity;
  static _worldHeight = Infinity;

  // Smoothing factor for camera follow (0-1, lower = smoother)
  static _smoothing = 0.1;

  // ============================================
  // INITIALIZATION
  // ============================================

  /**
   * Initialize camera with shared data buffer
   * @param {Float32Array} data - Float32Array view of SharedArrayBuffer [zoom, x, y]
   * @param {number} canvasWidth - Canvas width in pixels
   * @param {number} canvasHeight - Canvas height in pixels
   */
  static initialize(data, canvasWidth = 0, canvasHeight = 0) {
    this._data = data;
    this._canvasWidth = canvasWidth;
    this._canvasHeight = canvasHeight;
  }

  /**
   * Check if camera is initialized
   * @returns {boolean}
   */
  static get isInitialized() {
    return this._data !== null;
  }

  // ============================================
  // POSITION & ZOOM - getters and setters
  // ============================================

  static get zoom() {
    return this._data ? this._data[0] : 1;
  }

  static set zoom(value) {
    if (this._data) this._data[0] = value;
  }

  static get x() {
    return this._data ? this._data[1] : 0;
  }

  static set x(value) {
    if (this._data) this._data[1] = value;
  }

  static get y() {
    return this._data ? this._data[2] : 0;
  }

  static set y(value) {
    if (this._data) this._data[2] = value;
  }

  // ============================================
  // CANVAS DIMENSIONS
  // ============================================

  static get canvasWidth() {
    return this._canvasWidth;
  }

  static set canvasWidth(value) {
    this._canvasWidth = value;
  }

  static get canvasHeight() {
    return this._canvasHeight;
  }

  static set canvasHeight(value) {
    this._canvasHeight = value;
  }

  // ============================================
  // WORLD BOUNDS
  // ============================================

  static get worldWidth() {
    return this._worldWidth;
  }

  static set worldWidth(value) {
    this._worldWidth = value;
  }

  static get worldHeight() {
    return this._worldHeight;
  }

  static set worldHeight(value) {
    this._worldHeight = value;
  }

  /**
   * Set world bounds for camera clamping
   * @param {number} width - World width in pixels
   * @param {number} height - World height in pixels
   */
  static setWorldBounds(width, height) {
    this._worldWidth = width;
    this._worldHeight = height;
  }

  // ============================================
  // SMOOTHING
  // ============================================

  static get smoothing() {
    return this._smoothing;
  }

  static set smoothing(value) {
    this._smoothing = Math.max(0, Math.min(1, value));
  }

  // ============================================
  // CAMERA METHODS
  // ============================================

  /**
   * Clamp camera position to world bounds
   * Ensures camera never shows beyond world edges
   */
  static _clampToWorldBounds() {
    if (!this._data) return;

    const zoom = this._data[0];
    const viewportWidth = this._canvasWidth / zoom;
    const viewportHeight = this._canvasHeight / zoom;

    // Calculate max camera position (so viewport doesn't exceed world bounds)
    const maxX = Math.max(0, this._worldWidth - viewportWidth);
    const maxY = Math.max(0, this._worldHeight - viewportHeight);

    // Clamp camera position
    this._data[1] = Math.max(0, Math.min(this._data[1], maxX));
    this._data[2] = Math.max(0, Math.min(this._data[2], maxY));
  }

  /**
   * Smoothly follow a target position (centers target on screen)
   * @param {number} targetX - Target X position in world coordinates
   * @param {number} targetY - Target Y position in world coordinates
   * @param {number} [smoothing] - Optional smoothing override (0-1)
   */
  static follow(targetX, targetY, smoothing) {
    if (!this._data) return;

    const s = smoothing ?? this._smoothing;
    const zoom = this._data[0];

    // Calculate camera position to center target on screen (accounting for zoom)
    // Formula derived from: screenCenter = (targetX - cameraX) * zoom
    // Solving for cameraX: cameraX = targetX - screenCenter / zoom
    const targetCameraX = targetX - this._canvasWidth / (2 * zoom);
    const targetCameraY = targetY - this._canvasHeight / (2 * zoom);

    // Lerp to target
    this._data[1] += (targetCameraX - this._data[1]) * s;
    this._data[2] += (targetCameraY - this._data[2]) * s;

    // Clamp to world bounds
    this._clampToWorldBounds();
  }

  /**
   * Immediately set camera to center on a target (no smoothing)
   * @param {number} targetX - Target X position in world coordinates
   * @param {number} targetY - Target Y position in world coordinates
   */
  static centerOn(targetX, targetY) {
    if (!this._data) return;

    const zoom = this._data[0];

    // Account for zoom when centering
    this._data[1] = targetX - this._canvasWidth / (2 * zoom);
    this._data[2] = targetY - this._canvasHeight / (2 * zoom);

    // Clamp to world bounds
    this._clampToWorldBounds();
  }

  /**
   * Set camera position directly (top-left corner)
   * @param {number} x - X position
   * @param {number} y - Y position
   */
  static setPosition(x, y) {
    if (!this._data) return;
    this._data[1] = x;
    this._data[2] = y;

    // Clamp to world bounds
    this._clampToWorldBounds();
  }

  /**
   * Check if a world position is visible on screen
   * @param {number} worldX - X position in world coordinates
   * @param {number} worldY - Y position in world coordinates
   * @param {number} [margin=0] - Extra margin around screen edges
   * @returns {boolean} True if position is on screen
   */
  static isOnScreen(worldX, worldY, margin = 0) {
    if (!this._data) return true;

    const zoom = this._data[0];
    const cameraX = this._data[1];
    const cameraY = this._data[2];

    // Convert world position to screen position
    const screenX = (worldX - cameraX) * zoom;
    const screenY = (worldY - cameraY) * zoom;

    return (
      screenX >= -margin &&
      screenX <= this._canvasWidth + margin &&
      screenY >= -margin &&
      screenY <= this._canvasHeight + margin
    );
  }

  /**
   * Convert world coordinates to screen coordinates
   * @param {number} worldX - X in world space
   * @param {number} worldY - Y in world space
   * @returns {{x: number, y: number}} Screen coordinates
   */
  static worldToScreen(worldX, worldY) {
    const zoom = this._data ? this._data[0] : 1;
    const cameraX = this._data ? this._data[1] : 0;
    const cameraY = this._data ? this._data[2] : 0;

    return {
      x: (worldX - cameraX) * zoom,
      y: (worldY - cameraY) * zoom,
    };
  }

  /**
   * Convert screen coordinates to world coordinates
   * @param {number} screenX - X in screen space
   * @param {number} screenY - Y in screen space
   * @returns {{x: number, y: number}} World coordinates
   */
  static screenToWorld(screenX, screenY) {
    const zoom = this._data ? this._data[0] : 1;
    const cameraX = this._data ? this._data[1] : 0;
    const cameraY = this._data ? this._data[2] : 0;

    return {
      x: screenX / zoom + cameraX,
      y: screenY / zoom + cameraY,
    };
  }

  /**
   * Get viewport bounds in world coordinates
   * @returns {{left: number, top: number, right: number, bottom: number, width: number, height: number}}
   */
  static getViewportBounds() {
    const zoom = this._data ? this._data[0] : 1;
    const cameraX = this._data ? this._data[1] : 0;
    const cameraY = this._data ? this._data[2] : 0;

    const width = this._canvasWidth / zoom;
    const height = this._canvasHeight / zoom;

    return {
      left: cameraX,
      top: cameraY,
      right: cameraX + width,
      bottom: cameraY + height,
      width,
      height,
    };
  }
}
