// Camera.js - Static camera interface for cross-worker access
// Provides consistent camera state via SharedArrayBuffer
// Pattern follows Mouse and Keyboard static classes

import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import Keyboard from './Keyboard.js';
import { Mouse } from './Mouse.js';

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

  /** Reused by getViewportBounds() when no out-param is passed. */
  static _viewportBoundsScratch = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  };

  // Zoom limits
  static _maxZoom = 50;

  // Smoothing factor for camera follow (0-1, lower = smoother)
  static _smoothing = 0.1;

  /** Published physics pose (logic worker latch). Null until a pose frame exists. */
  static _poseX = null;
  static _poseY = null;
  static _poseRotC = null;
  static _poseRotS = null;

  // Look-ahead vel frozen to pose-xy publishes (live HEAP vx wanders between publishes).
  static _lookHoldIdx = -1;
  static _lookHoldX = 0;
  static _lookHoldY = 0;
  static _lookHoldVx = 0;
  static _lookHoldVy = 0;
  static _lookHoldHasVel = false;
  static _LOOK_HOLD_EMA = 0.5;

  // Free-cam (WASD/arrows pan + wheel zoom). Ticked by Scene via updateFree().
  static _free = false;
  static _freePanSpeed = 10;
  static _freeZoomSensitivity = 0.001;
  static _freeSmoothing = 0.15;
  static _freeArrows = true;
  static _freeMaxZoom = null;
  static _freeFollowX = 0;
  static _freeFollowY = 0;
  static _freeZoomPaused = false;

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
      // smoothstep(es): softer zoom approach than linear blend
      const esZoom = es * es * (3 - 2 * es);
      newZoom = currentZoom + (tgtZoom - currentZoom) * esZoom;
      newZoom = Math.max(this.minZoom, Math.min(this._maxZoom, newZoom));
    }

    // Keep world point under screen center fixed across the zoom change, then
    // lerp only the remaining pan error toward the follow target.
    const halfW0 = this._canvasWidth / (2 * currentZoom);
    const halfH0 = this._canvasHeight / (2 * currentZoom);
    const halfW1 = this._canvasWidth / (2 * newZoom);
    const halfH1 = this._canvasHeight / (2 * newZoom);
    const cx = this._data[1] + halfW0;
    const cy = this._data[2] + halfH0;
    const keepCenterX = cx - halfW1;
    const keepCenterY = cy - halfH1;
    const followX = targetX - halfW1;
    const followY = targetY - halfH1;

    const newX = keepCenterX + (followX - keepCenterX) * es;
    const newY = keepCenterY + (followY - keepCenterY) * es;

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
   * Bind latched pose SoA from logic_worker (read-only). Pass nulls to clear.
   * @param {Float32Array|null} x
   * @param {Float32Array|null} y
   * @param {Float32Array|null} rotC
   * @param {Float32Array|null} rotS
   */
  static bindDisplayPose(x, y, rotC, rotS) {
    this._poseX = x || null;
    this._poseY = y || null;
    this._poseRotC = rotC || null;
    this._poseRotS = rotS || null;
    if (!this._poseX) this._clearLookHold();
  }

  static _clearLookHold() {
    this._lookHoldIdx = -1;
    this._lookHoldX = 0;
    this._lookHoldY = 0;
    this._lookHoldVx = 0;
    this._lookHoldVy = 0;
    this._lookHoldHasVel = false;
  }

  /**
   * Resample HEAP vx/vy only when this entity's published pose xy changes.
   * First sample copies; later publishes EMA so one noisy step does not spike look-ahead.
   * Writes Camera._lookHoldVx/Vy.
   */
  static _poseLookVelocity(i, x, y) {
    const poseChanged =
      i !== this._lookHoldIdx || x !== this._lookHoldX || y !== this._lookHoldY;
    if (poseChanged) {
      const liveVx = RigidBody.vx ? RigidBody.vx[i] : 0;
      const liveVy = RigidBody.vy ? RigidBody.vy[i] : 0;
      if (!this._lookHoldHasVel || this._lookHoldIdx !== i) {
        this._lookHoldVx = liveVx;
        this._lookHoldVy = liveVy;
        this._lookHoldHasVel = true;
      } else {
        const a = this._LOOK_HOLD_EMA;
        this._lookHoldVx += (liveVx - this._lookHoldVx) * a;
        this._lookHoldVy += (liveVy - this._lookHoldVy) * a;
      }
      this._lookHoldIdx = i;
      this._lookHoldX = x;
      this._lookHoldY = y;
    }
  }

  /**
   * Follow an entity using published pose xy when available, plus velocity look-ahead.
   * Look-ahead vel is frozen to pose-xy publishes so it shares the sprite clock.
   * @param {number} index - Entity index
   * @param {number} [lookAheadSec=0]
   * @param {number} [smoothing]
   * @param {number} [dtRatio]
   */
  static followEntity(index, lookAheadSec, smoothing, dtRatio) {
    if (index == null) return;
    const i = index | 0;
    const poseX = this._poseX;
    const look = lookAheadSec || 0;
    let x;
    let y;
    let vx;
    let vy;
    if (poseX && RigidBody.active && RigidBody.active[i]) {
      x = poseX[i];
      y = this._poseY[i];
      if (look !== 0) {
        this._poseLookVelocity(i, x, y);
        vx = this._lookHoldVx;
        vy = this._lookHoldVy;
      } else {
        vx = 0;
        vy = 0;
      }
    } else {
      x = Transform.x[i];
      y = Transform.y[i];
      vx = RigidBody.vx ? RigidBody.vx[i] : 0;
      vy = RigidBody.vy ? RigidBody.vy[i] : 0;
    }
    this.follow(x + vx * look, y + vy * look, smoothing, dtRatio);
  }

  /**
   * Set zoom immediately and sync targetZoom so follow() does not lerp back.
   * @param {number} targetZoom - Zoom level
   */
  static setZoom(targetZoom) {
    if (!this._data) return;
    this.zoom = targetZoom;
    this._data[this.IDX_TARGET_ZOOM] = this._data[this.IDX_ZOOM];
  }

  /**
   * Enable/disable free-cam (WASD/arrows pan + wheel zoom).
   * Scene calls updateFree() each frame while enabled.
   * @param {boolean} enabled
   * @param {{panSpeed?: number, zoomSensitivity?: number, smoothing?: number, arrows?: boolean, maxZoom?: number}} [options]
   */
  static setFree(enabled, options = {}) {
    const wasFree = this._free;
    this._free = !!enabled;

    if (options.panSpeed != null) this._freePanSpeed = options.panSpeed;
    if (options.zoomSensitivity != null) this._freeZoomSensitivity = options.zoomSensitivity;
    if (options.smoothing != null) this._freeSmoothing = options.smoothing;
    if (options.arrows != null) this._freeArrows = !!options.arrows;
    if (options.maxZoom != null) this._freeMaxZoom = options.maxZoom;

    if (enabled && !wasFree) {
      const existing = this.getFollowTarget();
      if (existing) {
        this._freeFollowX = existing.x;
        this._freeFollowY = existing.y;
      } else {
        this._freeFollowX = this.centerX;
        this._freeFollowY = this.centerY;
      }
    }

    if (!enabled) {
      this._freeZoomPaused = false;
      this._freeMaxZoom = null;
    }
  }

  /** Override free-cam follow target (e.g. machine follow, create() seed). */
  static setFreeTarget(x, y) {
    this._freeFollowX = x;
    this._freeFollowY = y;
  }

  /** Skip wheel zoom for one frame (e.g. consume wheel for another action). */
  static pauseFreeZoom() {
    this._freeZoomPaused = true;
  }

  /** True if WASD (/arrows when enabled) currently held. Safe to read during scene.update. */
  static get isFreePanning() {
    if (Keyboard.w || Keyboard.s || Keyboard.a || Keyboard.d) return true;
    if (this._freeArrows && (Keyboard.arrowup || Keyboard.arrowdown || Keyboard.arrowleft || Keyboard.arrowright)) {
      return true;
    }
    return false;
  }

  static get freeArrows() {
    return this._freeArrows;
  }

  static set freeArrows(value) {
    this._freeArrows = !!value;
  }

  /**
   * Tick free-cam. Called by Scene after scene.update(), before Mouse.wheel reset.
   * @param {number} [dtRatio]
   */
  static updateFree(dtRatio) {
    if (!this._free || !this._data) {
      this._freeZoomPaused = false;
      return;
    }

    const panSpeed = this._freePanSpeed / this.zoom;
    const arrows = this._freeArrows;

    if (Keyboard.w || (arrows && Keyboard.arrowup)) {
      this._freeFollowY -= panSpeed;
    }
    if (Keyboard.s || (arrows && Keyboard.arrowdown)) {
      this._freeFollowY += panSpeed;
    }
    if (Keyboard.a || (arrows && Keyboard.arrowleft)) {
      this._freeFollowX -= panSpeed;
    }
    if (Keyboard.d || (arrows && Keyboard.arrowright)) {
      this._freeFollowX += panSpeed;
    }

    if (this._worldWidth !== Infinity) {
      this._freeFollowX = Math.max(0, Math.min(this._freeFollowX, this._worldWidth));
    }
    if (this._worldHeight !== Infinity) {
      this._freeFollowY = Math.max(0, Math.min(this._freeFollowY, this._worldHeight));
    }

    // Wheel updates targetZoom only; follow() lerps display zoom (no setZoom snap).
    // exp: log-symmetric in/out for raw deltaY (~±100/notch); linear 1-w*s is not invertible.
    if (!this._freeZoomPaused && Mouse.wheel) {
      let z = this.targetZoom * Math.exp(-Mouse.wheel * this._freeZoomSensitivity);
      const maxZ = this._freeMaxZoom != null ? this._freeMaxZoom : this._maxZoom;
      z = Math.max(this.minZoom, Math.min(maxZ, z));
      this._data[this.IDX_TARGET_ZOOM] = z;
    }
    this._freeZoomPaused = false;

    this.follow(this._freeFollowX, this._freeFollowY, this._freeSmoothing, dtRatio);
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
   * Get viewport bounds in world coordinates.
   * Writes into `out` when provided; otherwise reuses a static scratch object
   * (zero allocation on the hot path used by SoundManager spatial culling).
   * @param {{left?: number, top?: number, right?: number, bottom?: number, width?: number, height?: number}|null} [out]
   * @returns {{left: number, top: number, right: number, bottom: number, width: number, height: number}}
   */
  static getViewportBounds(out = null) {
    const result = out || Camera._viewportBoundsScratch;
    const zoom = this._data ? this._data[0] : 1;
    const cameraX = this._data ? this._data[1] : 0;
    const cameraY = this._data ? this._data[2] : 0;

    const width = this._canvasWidth / zoom;
    const height = this._canvasHeight / zoom;

    result.left = cameraX;
    result.top = cameraY;
    result.right = cameraX + width;
    result.bottom = cameraY + height;
    result.width = width;
    result.height = height;
    return result;
  }
}
