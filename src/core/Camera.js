// Camera.js - Static camera interface for cross-worker access
// Provides consistent camera state via SharedArrayBuffer
// Pattern follows Mouse and Keyboard static classes

/**
 * Static Camera class for managing viewport state
 * Camera data is stored in a SharedArrayBuffer Float32Array[6]:
 * [zoom, x, y, followTargetX, followTargetY, targetZoom]
 *
 * Recommended threading model:
 * - Single writer for Camera.follow/centerOn/setPosition/setZoom
 * - Multiple readers in pre_render, pixi, main thread UI/debug
 */
export class Camera {
  // SharedArrayBuffer view: Float32Array [zoom, x, y, followTargetX, followTargetY, targetZoom]
  static _data = null;
  static IDX_ZOOM = 0;
  static IDX_X = 1;
  static IDX_Y = 2;
  static IDX_FOLLOW_X = 3;
  static IDX_FOLLOW_Y = 4;
  static IDX_TARGET_ZOOM = 5;

  // Canvas dimensions (needed for centering calculations)
  static _canvasWidth = 0;
  static _canvasHeight = 0;

  // World bounds (for clamping camera to world edges)
  static _worldWidth = Infinity;
  static _worldHeight = Infinity;

  // Zoom limits
  static _maxZoom = 50;

  // Smoothing factor for camera follow (0-1, lower = smoother)
  static _smoothing = 0.1;

  // ============================================
  // INITIALIZATION
  // ============================================

  /**
   * Initialize camera with shared data buffer
   * @param {Float32Array} data - Float32Array view [zoom, x, y, followTargetX, followTargetY, targetZoom]
   * @param {number} canvasWidth - Canvas width in pixels
   * @param {number} canvasHeight - Canvas height in pixels
   */
  static initialize(data, canvasWidth = 0, canvasHeight = 0) {
    this._data = data;
    this._canvasWidth = canvasWidth;
    this._canvasHeight = canvasHeight;
    if (this._data && this._data.length > this.IDX_TARGET_ZOOM) {
      // Keep buffer fields in a valid state for readers across workers.
      this._data[this.IDX_TARGET_ZOOM] = this._data[this.IDX_TARGET_ZOOM] > 0
        ? this._data[this.IDX_TARGET_ZOOM]
        : (this._data[this.IDX_ZOOM] || 1);
      if (Number.isNaN(this._data[this.IDX_FOLLOW_X])) this._data[this.IDX_FOLLOW_X] = this._data[this.IDX_X] || 0;
      if (Number.isNaN(this._data[this.IDX_FOLLOW_Y])) this._data[this.IDX_FOLLOW_Y] = this._data[this.IDX_Y] || 0;
    }
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
    if (this._data) {
      this._data[0] = Math.max(this.minZoom, Math.min(this._maxZoom, value));
      this._clampToWorldBounds();
    }
  }

  static get targetZoom() {
    return this._data ? this._data[5] : 1;
  }

  static set targetZoom(value) {
    if (this._data) {
      this._data[5] = Math.max(this.minZoom, Math.min(this._maxZoom, value));
    }
  }

  static get x() {
    return this._data ? this._data[1] : 0;
  }

  static set x(value) {
    if (this._data) {
      this._data[1] = value;
      this._clampToWorldBounds();
    }
  }

  static get y() {
    return this._data ? this._data[2] : 0;
  }

  static set y(value) {
    if (this._data) {
      this._data[2] = value;
      this._clampToWorldBounds();
    }
  }

  // ============================================
  // VIEWPORT BOUNDS (read-only getters)
  // ============================================

  /** Left edge of viewport in world coordinates */
  static get minX() {
    return this._data ? this._data[1] : 0;
  }

  /** Right edge of viewport in world coordinates */
  static get maxX() {
    const zoom = this._data ? this._data[0] : 1;
    const cameraX = this._data ? this._data[1] : 0;
    return cameraX + this._canvasWidth / zoom;
  }

  /** Top edge of viewport in world coordinates */
  static get minY() {
    return this._data ? this._data[2] : 0;
  }

  /** Bottom edge of viewport in world coordinates */
  static get maxY() {
    const zoom = this._data ? this._data[0] : 1;
    const cameraY = this._data ? this._data[2] : 0;
    return cameraY + this._canvasHeight / zoom;
  }

  /** Center X of viewport in world coordinates */
  static get centerX() {
    const zoom = this._data ? this._data[0] : 1;
    const cameraX = this._data ? this._data[1] : 0;
    return cameraX + this._canvasWidth / (2 * zoom);
  }

  /** Center Y of viewport in world coordinates */
  static get centerY() {
    const zoom = this._data ? this._data[0] : 1;
    const cameraY = this._data ? this._data[2] : 0;
    return cameraY + this._canvasHeight / (2 * zoom);
  }

  // ============================================
  // CANVAS DIMENSIONS
  // ============================================

  static get canvasWidth() {
    return this._canvasWidth;
  }

  static set canvasWidth(value) {
    this._canvasWidth = value;
    // Re-clamp zoom and position since minZoom may have changed
    if (this._data) {
      this._data[0] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[0]));
      if (this._data[5] > 0) {
        this._data[5] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[5]));
      }
      this._clampToWorldBounds();
    }
  }

  static get canvasHeight() {
    return this._canvasHeight;
  }

  static set canvasHeight(value) {
    this._canvasHeight = value;
    // Re-clamp zoom and position since minZoom may have changed
    if (this._data) {
      this._data[0] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[0]));
      if (this._data[5] > 0) {
        this._data[5] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[5]));
      }
      this._clampToWorldBounds();
    }
  }

  // ============================================
  // WORLD BOUNDS
  // ============================================

  static get worldWidth() {
    return this._worldWidth;
  }

  static set worldWidth(value) {
    this._worldWidth = value;
    // Re-clamp zoom and position since minZoom may have changed
    if (this._data) {
      this._data[0] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[0]));
      if (this._data[5] > 0) {
        this._data[5] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[5]));
      }
      this._clampToWorldBounds();
    }
  }

  static get worldHeight() {
    return this._worldHeight;
  }

  static set worldHeight(value) {
    this._worldHeight = value;
    // Re-clamp zoom and position since minZoom may have changed
    if (this._data) {
      this._data[0] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[0]));
      if (this._data[5] > 0) {
        this._data[5] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[5]));
      }
      this._clampToWorldBounds();
    }
  }

  /**
   * Set world bounds for camera clamping
   * @param {number} width - World width in pixels
   * @param {number} height - World height in pixels
   */
  static setWorldBounds(width, height) {
    this._worldWidth = width;
    this._worldHeight = height;

    // Re-clamp zoom and position with new bounds
    if (this._data) {
      this._data[0] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[0]));
      if (this._data[5] > 0) {
        this._data[5] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[5]));
      }
      this._clampToWorldBounds();
    }
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
  // ZOOM LIMITS
  // ============================================

  /**
   * Get minimum zoom to prevent showing void areas beyond world bounds
   * Ensures viewport never exceeds world dimensions
   * @returns {number} Minimum allowed zoom level
   */
  static get minZoom() {
    // If world bounds aren't set, allow any zoom
    if (this._worldWidth === Infinity || this._worldHeight === Infinity) {
      return 0.01;
    }

    // minZoom = max(canvasWidth / worldWidth, canvasHeight / worldHeight)
    const minZoomForWidth = this._canvasWidth / this._worldWidth;
    const minZoomForHeight = this._canvasHeight / this._worldHeight;

    return Math.max(minZoomForWidth, minZoomForHeight, 0.01);
  }

  static get maxZoom() {
    return this._maxZoom;
  }

  static set maxZoom(value) {
    this._maxZoom = value;
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
   * Also lerps zoom toward targetZoom if set
   * @param {number} targetX - Target X position in world coordinates
   * @param {number} targetY - Target Y position in world coordinates
   * @param {number} [smoothing] - Optional smoothing override (0-1)
   * @param {number} [dtRatio] - Delta time ratio for frame-rate-independent smoothing
   */
  static follow(targetX, targetY, smoothing, dtRatio) {
    if (!this._data) return;

    this._data[3] = targetX;
    this._data[4] = targetY;

    const s = smoothing ?? this._smoothing;
    const es = (dtRatio != null && dtRatio > 0) ? Math.min(s * dtRatio, 1.0) : s;

    // Compute new zoom without writing to the shared buffer yet
    const currentZoom = this._data[0];
    let newZoom = currentZoom;
    const tgtZoom = this._data[5];
    if (tgtZoom > 0 && Math.abs(tgtZoom - currentZoom) > 0.0001) {
      newZoom = currentZoom + (tgtZoom - currentZoom) * es;
      newZoom = Math.max(this.minZoom, Math.min(this._maxZoom, newZoom));
    }

    const targetCameraX = targetX - this._canvasWidth / (2 * newZoom);
    const targetCameraY = targetY - this._canvasHeight / (2 * newZoom);

    const newX = this._data[1] + (targetCameraX - this._data[1]) * es;
    const newY = this._data[2] + (targetCameraY - this._data[2]) * es;

    // Clamp using the LOWER of old/new zoom so the position is valid for
    // whichever zoom a cross-thread reader might observe (SAB race window).
    const clampZoom = Math.min(currentZoom, newZoom);
    const vpW = this._canvasWidth / clampZoom;
    const vpH = this._canvasHeight / clampZoom;
    const maxX = Math.max(0, this._worldWidth - vpW);
    const maxY = Math.max(0, this._worldHeight - vpH);

    // Write position BEFORE zoom so a reader that still sees the old zoom
    // will never pair it with a position that exceeds its viewport bounds.
    this._data[1] = Math.max(0, Math.min(newX, maxX));
    this._data[2] = Math.max(0, Math.min(newY, maxY));
    this._data[0] = newZoom;
  }

  /**
   * Set target zoom level (will be lerped in follow())
   * @param {number} targetZoom - Target zoom level
   */
  static setZoom(targetZoom) {
    if (!this._data) return;
    this._data[5] = Math.max(this.minZoom, Math.min(this._maxZoom, targetZoom));
  }

  /**
   * Get the current follow target position (if any)
   * Reads from SharedArrayBuffer for cross-thread access
   * @returns {{x: number, y: number} | null} Follow target or null if not following
   */
  static getFollowTarget() {
    if (!this._data) return null;

    // Buffer layout: [zoom, x, y, followTargetX, followTargetY, targetZoom]
    const targetX = this._data[3];
    const targetY = this._data[4];

    // NaN indicates no target set
    if (!Number.isNaN(targetX) && !Number.isNaN(targetY)) {
      return { x: targetX, y: targetY };
    }
    return null;
  }

  /**
   * Clear the follow target (stops following)
   */
  static clearFollowTarget() {
    if (!this._data) return;
    // Set to NaN to indicate no target
    this._data[3] = Number.NaN;
    this._data[4] = Number.NaN;
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
