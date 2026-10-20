// Camera.js - Static camera interface for cross-worker access
// Provides consistent camera state via SharedArrayBuffer
// Pattern follows Mouse and Keyboard static classes

import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import Keyboard from './keyboard.js';
import { Mouse } from './mouse.js';
import { rotatedHalfExtents } from '../util/viewBounds.js';

/**
 * Camera center that keeps the entity inside a world-pixel box.
 * A non-positive half on an axis tracks the entity on that axis.
 * @param {number} entityX
 * @param {number} entityY
 * @param {number} centerX
 * @param {number} centerY
 * @param {number} halfW
 * @param {number} halfH
 * @param {{x: number, y: number}} [out]
 * @returns {{x: number, y: number}}
 */
export function deadzoneCenter(entityX, entityY, centerX, centerY, halfW, halfH, out) {
  const dest = out || { x: 0, y: 0 };
  dest.x = centerX;
  dest.y = centerY;
  if (halfW > 0) {
    const dx = entityX - centerX;
    if (dx > halfW) dest.x = entityX - halfW;
    else if (dx < -halfW) dest.x = entityX + halfW;
  } else {
    dest.x = entityX;
  }
  if (halfH > 0) {
    const dy = entityY - centerY;
    if (dy > halfH) dest.y = entityY - halfH;
    else if (dy < -halfH) dest.y = entityY + halfH;
  } else {
    dest.y = entityY;
  }
  return dest;
}

/**
 * Static Camera class for managing viewport state
 * Camera data is stored in a SharedArrayBuffer Float32Array[17]:
 * [zoom, x, y, followTargetX, followTargetY, targetZoom,
 *  followEntityIndex, followUsedX, followUsedY, rotation,
 *  deadzoneHalfW, deadzoneHalfH, shakeAmp, shakeDur, shakeElapsed, shakePhase,
 *  followSeq (Int32 seqlock, not a float)]
 *
 * followEntityIndex is 0 = none, else entityIndex+1 (0 is a valid entity).
 * followUsedX/Y are the entity pose xy followEntity read (not look-ahead).
 * followTarget is pose + look-ahead. Pre_render snaps the queue camera to
 * packed pose + (followTarget - followUsed) so MESH/tilemap do not get
 * ease-on-SAB plus a pose-delta slide (double Y hitch when falling).
 * followEntity holds SAB pan when the latched pose generation is unchanged
 * (physics skipped a publish). Otherwise the tilemap eases under a frozen car.
 *
 * Recommended threading model:
 * - Single writer for Camera.follow/centerOn/setPosition/setZoom
 * - Multiple readers in pre_render, pixi, main thread UI/debug
 */
export class Camera {
  // SharedArrayBuffer view: Float32Array[17]
  static _data = null;
  static FLOAT_COUNT = 17;
  static IDX_ZOOM = 0;
  static IDX_X = 1;
  static IDX_Y = 2;
  static IDX_FOLLOW_X = 3;
  static IDX_FOLLOW_Y = 4;
  static IDX_TARGET_ZOOM = 5;
  static IDX_FOLLOW_ENTITY = 6;
  static IDX_FOLLOW_USED_X = 7;
  static IDX_FOLLOW_USED_Y = 8;
  static IDX_ROTATION = 9;
  static IDX_DEADZONE_X = 10;
  static IDX_DEADZONE_Y = 11;
  static IDX_SHAKE_AMP = 12;
  static IDX_SHAKE_DUR = 13;
  static IDX_SHAKE_ELAPSED = 14;
  static IDX_SHAKE_PHASE = 15;
  /** Int32 seqlock guarding followEntity/followTarget/followUsed writes. */
  static IDX_FOLLOW_SEQ = 16;

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
  static _followTargetScratch = { x: 0, y: 0 };
  static _alignCamScratch = { x: 0, y: 0 };
  static _deadzoneScratch = { x: 0, y: 0 };
  static _shakeScratch = { x: 0, y: 0 };
  static _worldToScreenScratch = { x: 0, y: 0 };
  static _screenToWorldScratch = { x: 0, y: 0 };
  static _isOnScreenScratch = { x: 0, y: 0 };
  static _viewExtScratch = { halfW: 0, halfH: 0 };

  // Zoom limits
  static _maxZoom = 50;

  // Smoothing factor for camera follow (0-1, lower = smoother)
  static _smoothing = 0.1;

  /** Published physics pose (logic worker latch). Null until a pose frame exists. */
  static _poseX = null;
  static _poseY = null;
  static _poseRotC = null;
  static _poseRotS = null;
  /** poseSync readyFrame from the last bindDisplayPose (0 = unknown). */
  static _poseReadyFrame = 0;
  /** readyFrame followEntity last eased against. */
  static _followPoseReady = 0;
  /** Int32 seqlock view of IDX_FOLLOW_SEQ, or null for non-shared test buffers. */
  static _followSeq = null;
  /** Nesting depth of camera writes in this realm; only the outermost moves the seqlock. */
  static _writeDepth = 0;
  /**
   * Last coherent snapshot: follow stamp and lead, plus the zoom and x/y of the
   * same write. Lead is pose-relative, so it stays valid for a newer pose.
   */
  static _followSnap = { slot: 0, usedX: 0, usedY: 0, leadX: 0, leadY: 0, zoom: 1, camX: 0, camY: 0 };
  /** Drawn camera for the screen helpers, and what it was resolved from (see _drawnView). */
  static _view = { zoom: 1, x: 0, y: 0, rotation: 0 };
  static _viewSeq = -1;

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
  /** World point under the pointer at the last free-cam wheel. Null = zoom around center. */
  static _freeZoomAnchorX = null;
  static _freeZoomAnchorY = null;

  // ============================================
  // INITIALIZATION
  // ============================================

  /**
   * Initialize camera with shared data buffer
   * @param {Float32Array} data - Float32Array view (see FLOAT_COUNT)
   * @param {number} canvasWidth - Canvas width in pixels
   * @param {number} canvasHeight - Canvas height in pixels
   */
  static initialize(data, canvasWidth = 0, canvasHeight = 0) {
    this._data = data;
    this._canvasWidth = canvasWidth;
    this._canvasHeight = canvasHeight;
    this._poseReadyFrame = 0;
    this._followPoseReady = 0;
    this._followSeq = this._bindFollowSeq(data);
    this._writeDepth = 0;
    this._viewSeq = -1;
    this._followSnap.slot = 0;
    this._followSnap.usedX = 0;
    this._followSnap.usedY = 0;
    this._followSnap.leadX = 0;
    this._followSnap.leadY = 0;
    this._followSnap.zoom = (data && data[this.IDX_ZOOM]) || 1;
    this._followSnap.camX = data ? data[this.IDX_X] || 0 : 0;
    this._followSnap.camY = data ? data[this.IDX_Y] || 0 : 0;
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
   * Bind the Int32 seqlock at the tail of the camera SAB.
   * Plain ArrayBuffers (Node tests) run single-threaded and need no lock.
   * @param {Float32Array|null} data
   * @returns {Int32Array|null}
   */
  static _bindFollowSeq(data) {
    if (!data || !data.buffer) return null;
    if (typeof SharedArrayBuffer === 'undefined') return null;
    if (!(data.buffer instanceof SharedArrayBuffer)) return null;
    const byteOffset = data.byteOffset + this.IDX_FOLLOW_SEQ * 4;
    if (byteOffset + 4 > data.buffer.byteLength) return null;
    return new Int32Array(data.buffer, byteOffset, 1);
  }

  /**
   * Mark the start of a camera write (seqlock becomes odd). Every write of
   * zoom, x/y or the follow fields goes inside one, so the drawn camera reads
   * them as a set. Nested calls only count depth.
   */
  static _followWriteBegin() {
    if (this._writeDepth++ === 0 && this._followSeq) Atomics.add(this._followSeq, 0, 1);
  }

  /** Mark the end of a camera write (seqlock becomes even at the outermost end). */
  static _followWriteEnd() {
    if (--this._writeDepth === 0 && this._followSeq) Atomics.add(this._followSeq, 0, 1);
  }

  /**
   * Read the follow slot and lead (followTarget - followUsed), with the zoom
   * and x/y of the same write, coherently. A torn set shifts the queue camera
   * (a zoom from one write centered with another moves the view by
   * cw/2·(1/z1 − 1/z2)), so retry on the seqlock and otherwise reuse the last
   * coherent snapshot. The lead is relative to the followed pose, so an older
   * lead still applies to a newer latched pose.
   * @returns {{slot: number, usedX: number, usedY: number, leadX: number, leadY: number, zoom: number, camX: number, camY: number}}
   */
  static _readFollowSnapshot() {
    const data = this._data;
    const snap = this._followSnap;
    if (!data) {
      snap.slot = 0;
      return snap;
    }
    const seq = this._followSeq;
    if (!seq) {
      const slot = data[this.IDX_FOLLOW_ENTITY] | 0;
      const usedX = data[this.IDX_FOLLOW_USED_X];
      const usedY = data[this.IDX_FOLLOW_USED_Y];
      snap.slot = slot;
      snap.usedX = usedX;
      snap.usedY = usedY;
      snap.leadX = data[this.IDX_FOLLOW_X] - usedX;
      snap.leadY = data[this.IDX_FOLLOW_Y] - usedY;
      snap.zoom = data[this.IDX_ZOOM];
      snap.camX = data[this.IDX_X];
      snap.camY = data[this.IDX_Y];
      return snap;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const s0 = Atomics.load(seq, 0);
      if (s0 & 1) continue;
      const slot = data[this.IDX_FOLLOW_ENTITY] | 0;
      const usedX = data[this.IDX_FOLLOW_USED_X];
      const usedY = data[this.IDX_FOLLOW_USED_Y];
      const leadX = data[this.IDX_FOLLOW_X] - usedX;
      const leadY = data[this.IDX_FOLLOW_Y] - usedY;
      const zoom = data[this.IDX_ZOOM];
      const camX = data[this.IDX_X];
      const camY = data[this.IDX_Y];
      if (Atomics.load(seq, 0) !== s0) continue;
      snap.slot = slot;
      snap.usedX = usedX;
      snap.usedY = usedY;
      snap.leadX = leadX;
      snap.leadY = leadY;
      snap.zoom = zoom;
      snap.camX = camX;
      snap.camY = camY;
      return snap;
    }
    // Writer busy/torn. Only reuse the cached lead for the same follow entity.
    const slotNow = data[this.IDX_FOLLOW_ENTITY] | 0;
    if (snap.slot <= 0 || snap.slot !== slotNow) snap.slot = 0;
    return snap;
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
      this._followWriteBegin();
      try {
        this._data[0] = Math.max(this.minZoom, Math.min(this._maxZoom, value));
        this._clampToWorldBounds();
      } finally {
        this._followWriteEnd();
      }
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
      this._followWriteBegin();
      try {
        this._data[1] = value;
        this._clampToWorldBounds();
      } finally {
        this._followWriteEnd();
      }
    }
  }

  static get y() {
    return this._data ? this._data[2] : 0;
  }

  static set y(value) {
    if (this._data) {
      this._followWriteBegin();
      try {
        this._data[2] = value;
        this._clampToWorldBounds();
      } finally {
        this._followWriteEnd();
      }
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
    this._reclamp();
  }

  static get canvasHeight() {
    return this._canvasHeight;
  }

  static set canvasHeight(value) {
    this._canvasHeight = value;
    this._reclamp();
  }

  // ============================================
  // WORLD BOUNDS
  // ============================================

  static get worldWidth() {
    return this._worldWidth;
  }

  static set worldWidth(value) {
    this._worldWidth = value;
    this._reclamp();
  }

  static get worldHeight() {
    return this._worldHeight;
  }

  static set worldHeight(value) {
    this._worldHeight = value;
    this._reclamp();
  }

  /**
   * Set world bounds for camera clamping
   * @param {number} width - World width in pixels
   * @param {number} height - World height in pixels
   */
  static setWorldBounds(width, height) {
    this._worldWidth = width;
    this._worldHeight = height;
    this._reclamp();
  }

  /** Re-clamp zoom, targetZoom and position after a canvas or world size change (minZoom may move). */
  static _reclamp() {
    if (!this._data) return;
    this._followWriteBegin();
    try {
      this._data[0] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[0]));
      if (this._data[5] > 0) {
        this._data[5] = Math.max(this.minZoom, Math.min(this._maxZoom, this._data[5]));
      }
      this._clampToWorldBounds();
    } finally {
      this._followWriteEnd();
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

  static _hasFollowEntityStamp() {
    return !!(this._data && this._data.length > this.IDX_FOLLOW_USED_Y);
  }

  static _clearFollowEntityStamp() {
    if (!this._hasFollowEntityStamp()) return;
    this._data[this.IDX_FOLLOW_ENTITY] = 0;
  }

  static _stampFollowEntity(index, x, y) {
    if (!this._hasFollowEntityStamp()) return;
    this._data[this.IDX_FOLLOW_ENTITY] = (index | 0) + 1;
    this._data[this.IDX_FOLLOW_USED_X] = x;
    this._data[this.IDX_FOLLOW_USED_Y] = y;
  }

  /**
   * Queue camera top-left for the packed followEntity pose.
   * Snaps to packed + look-ahead lead. Ignores eased SAB cam so a newer
   * pack does not add a pose-delta on top of an in-flight ease.
   * No-op if follow() wrote last (slot 0) or pose missing.
   * @param {number} camX
   * @param {number} camY
   * @param {Float32Array|null} poseX
   * @param {Float32Array|null} poseY
   * @param {{x?: number, y?: number}|null} [out]
   * @returns {{x: number, y: number}}
   */
  static alignFollowCameraToLatchedPose(camX, camY, poseX, poseY, out) {
    const dest = out || this._alignCamScratch;
    dest.x = camX;
    dest.y = camY;
    if (!this._hasFollowEntityStamp() || !poseX || !poseY) return dest;
    return this._alignToSnapshot(this._readFollowSnapshot(), poseX, poseY, dest);
  }

  /**
   * Snap `dest` (a camera top-left) to a follow snapshot. Centers with the
   * snapshot's zoom, the one packed next to it. No-op without a stamp.
   */
  static _alignToSnapshot(snap, poseX, poseY, dest) {
    if (snap.slot <= 0) return dest;
    const i = snap.slot - 1;
    if (i < 0 || i >= poseX.length) return dest;
    const zoom = snap.zoom || 1;
    const cw = this._canvasWidth;
    const ch = this._canvasHeight;
    if (!(cw > 0 && ch > 0 && zoom > 0)) {
      dest.x += poseX[i] - snap.usedX;
      dest.y += poseY[i] - snap.usedY;
      return dest;
    }
    dest.x = poseX[i] + snap.leadX - cw / (2 * zoom);
    dest.y = poseY[i] + snap.leadY - ch / (2 * zoom);
    return dest;
  }

  /**
   * The camera pre-render packs into the render queue, before shake: the SAB
   * camera with followEntity snapped to the latched pose, then an unrotated
   * view clamped to the world. Cull with this, not the SAB x/y, which can
   * trail it by the follow ease.
   * @param {Float32Array|null} poseX latched pose; null before the first publish
   * @param {Float32Array|null} poseY
   * @param {{zoom: number, x: number, y: number, rotation: number}} out
   * @returns {{zoom: number, x: number, y: number, rotation: number}} out
   */
  static resolveDrawnCamera(poseX, poseY, out) {
    const data = this._data;
    if (!data) {
      out.zoom = 1;
      out.x = 0;
      out.y = 0;
      out.rotation = 0;
      return out;
    }
    // One snapshot for everything: x/y, zoom and the follow lead of one write.
    const snap = this._readFollowSnapshot();
    const zoom = snap.zoom;
    const rot = data.length > this.IDX_ROTATION ? (data[this.IDX_ROTATION] || 0) : 0;
    const aligned = this._alignCamScratch;
    aligned.x = snap.camX;
    aligned.y = snap.camY;
    if (poseX && poseY && this._hasFollowEntityStamp()) this._alignToSnapshot(snap, poseX, poseY, aligned);
    let x = aligned.x;
    let y = aligned.y;
    const worldWidth = this._worldWidth;
    const worldHeight = this._worldHeight;
    if (!rot && worldWidth !== Infinity && worldHeight !== Infinity && zoom > 0) {
      const maxX = Math.max(0, worldWidth - this._canvasWidth / zoom);
      const maxY = Math.max(0, worldHeight - this._canvasHeight / zoom);
      x = Math.max(0, Math.min(x, maxX));
      y = Math.max(0, Math.min(y, maxY));
    }
    out.zoom = zoom;
    out.x = x;
    out.y = y;
    out.rotation = rot;
    return out;
  }

  /**
   * The drawn camera for the screen helpers (isOnScreen, worldToScreen,
   * screenToWorld, getViewportBounds), cached per realm. Every write of zoom,
   * x/y, angle or the follow fields moves the lock counter, and
   * bindDisplayPose drops the cache, so it is never stale. One compare on the
   * hot path: isOnScreen runs per listener entity per frame. A plain test
   * buffer has no lock and recomputes every call.
   * @returns {{zoom: number, x: number, y: number, rotation: number}}
   */
  static _drawnView() {
    const v = this._view;
    const seq = this._followSeq;
    if (seq) {
      // A plain read is enough for a staleness key; the recompute reads under the lock.
      const key = seq[0];
      if (key === this._viewSeq) return v;
      this._viewSeq = key;
    }
    return this.resolveDrawnCamera(this._poseX, this._poseY, v);
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
    this._followWriteBegin();
    try {
      this._clearFollowEntityStamp();
      this._applyFollow(targetX, targetY, smoothing, dtRatio);
    } finally {
      this._followWriteEnd();
    }
  }

  static _applyFollow(targetX, targetY, smoothing, dtRatio) {
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
    const rot = this._data.length > this.IDX_ROTATION ? this._data[this.IDX_ROTATION] : 0;
    if (rot) {
      this._data[1] = newX;
      this._data[2] = newY;
    } else {
      this._data[1] = Math.max(0, Math.min(newX, maxX));
      this._data[2] = Math.max(0, Math.min(newY, maxY));
    }
    this._data[0] = newZoom;
  }

  /**
   * Bind latched pose SoA from logic_worker (read-only). Pass nulls to clear.
   * @param {Float32Array|null} x
   * @param {Float32Array|null} y
   * @param {Float32Array|null} rotC
   * @param {Float32Array|null} rotS
   * @param {number} [readyFrame=0] - poseSync readyFrame for this latch
   */
  static bindDisplayPose(x, y, rotC, rotS, readyFrame) {
    this._poseX = x || null;
    this._poseY = y || null;
    this._poseRotC = rotC || null;
    this._poseRotS = rotS || null;
    this._poseReadyFrame = this._poseX ? (readyFrame | 0) : 0;
    // A new pose moves a followed view; the screen helpers resolve it again.
    this._viewSeq = -1;
    if (!this._poseX) {
      this._clearLookHold();
      this._followPoseReady = 0;
    }
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
    const ready = this._poseReadyFrame | 0;
    const publishFrozen = ready > 0 && ready === this._followPoseReady;
    this._followPoseReady = ready;
    // Same pose snapshot as last follow: sprite is frozen. Do not ease the
    // camera or the tilemap slides under the car (high-speed rAF lap hitch).
    if (publishFrozen) {
      this._followWriteBegin();
      try {
        this._stampFollowEntity(i, x, y);
      } finally {
        this._followWriteEnd();
      }
      return;
    }
    const aim = this._deadzoneAim(x, y);
    this._followWriteBegin();
    try {
      this._stampFollowEntity(i, x, y);
      this._applyFollow(aim.x + vx * look, aim.y + vy * look, smoothing, dtRatio);
    } finally {
      this._followWriteEnd();
    }
  }

  /**
   * World-pixel box around the view center. The camera holds while the
   * follow point stays inside. Zero on an axis tracks that axis.
   * @param {number} halfWidth
   * @param {number} halfHeight
   */
  static setDeadzone(halfWidth, halfHeight) {
    if (!this._data || this._data.length <= this.IDX_DEADZONE_Y) return;
    this._data[this.IDX_DEADZONE_X] = halfWidth > 0 ? halfWidth : 0;
    this._data[this.IDX_DEADZONE_Y] = halfHeight > 0 ? halfHeight : 0;
  }

  /** @returns {{x: number, y: number}} */
  static _deadzoneAim(entityX, entityY) {
    const dest = this._deadzoneScratch;
    const data = this._data;
    const halfW = data && data.length > this.IDX_DEADZONE_X ? data[this.IDX_DEADZONE_X] : 0;
    const halfH = data && data.length > this.IDX_DEADZONE_Y ? data[this.IDX_DEADZONE_Y] : 0;
    if (!(halfW > 0) && !(halfH > 0) || !data) {
      dest.x = entityX;
      dest.y = entityY;
      return dest;
    }
    const zoom = data[this.IDX_ZOOM] || 1;
    const cx = data[this.IDX_X] + this._canvasWidth / (2 * zoom);
    const cy = data[this.IDX_Y] + this._canvasHeight / (2 * zoom);
    const rot = this.rotation;
    if (!rot) {
      return deadzoneCenter(entityX, entityY, cx, cy, halfW, halfH, dest);
    }

    // Rotate world delta into camera view/screen space
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const dx = entityX - cx;
    const dy = entityY - cy;
    const viewDx = c * dx - s * dy;
    const viewDy = s * dx + c * dy;

    let targetViewDx = 0;
    let targetViewDy = 0;
    if (halfW > 0) {
      if (viewDx > halfW) targetViewDx = viewDx - halfW;
      else if (viewDx < -halfW) targetViewDx = viewDx + halfW;
      else targetViewDx = 0;
    } else {
      targetViewDx = viewDx;
    }
    if (halfH > 0) {
      if (viewDy > halfH) targetViewDy = viewDy - halfH;
      else if (viewDy < -halfH) targetViewDy = viewDy + halfH;
      else targetViewDy = 0;
    } else {
      targetViewDy = viewDy;
    }

    // Rotate camera shift back into world space
    dest.x = cx + (c * targetViewDx + s * targetViewDy);
    dest.y = cy + (-s * targetViewDx + c * targetViewDy);
    return dest;
  }

  /**
   * Start a view punch. The offset is added when the camera is packed,
   * not written into the follow target, so follow does not ease it away.
   * @param {number} amplitude - World pixels at the start of the punch
   * @param {number} durationMs - Sim milliseconds
   */
  static shake(amplitude, durationMs) {
    const data = this._data;
    if (!data || data.length <= this.IDX_SHAKE_PHASE) return;
    data[this.IDX_SHAKE_AMP] = amplitude > 0 ? amplitude : 0;
    data[this.IDX_SHAKE_DUR] = durationMs > 0 ? durationMs : 0;
    data[this.IDX_SHAKE_ELAPSED] = 0;
    data[this.IDX_SHAKE_PHASE] = 1;
  }

  /**
   * Decay the punch by sim milliseconds and return this frame's offset.
   * Zero sim time holds the offset (hitstop).
   * @param {number} simMs
   * @param {{x: number, y: number}} [out]
   * @returns {{x: number, y: number}}
   */
  static advanceShake(simMs, out) {
    const dest = out || this._shakeScratch;
    dest.x = 0;
    dest.y = 0;
    const data = this._data;
    if (!data || data.length <= this.IDX_SHAKE_PHASE) return dest;
    const amp = data[this.IDX_SHAKE_AMP];
    const dur = data[this.IDX_SHAKE_DUR];
    if (!(amp > 0) || !(dur > 0)) return dest;
    const step = simMs > 0 ? simMs : 0;
    const elapsed = data[this.IDX_SHAKE_ELAPSED] + step;
    if (elapsed >= dur) {
      data[this.IDX_SHAKE_ELAPSED] = dur;
      data[this.IDX_SHAKE_AMP] = 0;
      return dest;
    }
    data[this.IDX_SHAKE_ELAPSED] = elapsed;
    if (step > 0) data[this.IDX_SHAKE_PHASE] = data[this.IDX_SHAKE_PHASE] > 0 ? -1 : 1;
    const mag = amp * (1 - elapsed / dur);
    const phase = data[this.IDX_SHAKE_PHASE] || 1;
    dest.x = phase * mag;
    dest.y = phase * mag * -0.5;
    return dest;
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

  /** Pose generation followEntity last read. 0 until a pose is bound. */
  static get poseReadyFrame() {
    return this._poseReadyFrame | 0;
  }

  /** Pose xy the last followEntity accepted. Not the look-ahead point. */
  static get followUsedX() {
    if (!this._data || this._data.length <= this.IDX_FOLLOW_USED_X) return 0;
    return this._data[this.IDX_FOLLOW_USED_X];
  }

  static get followUsedY() {
    if (!this._data || this._data.length <= this.IDX_FOLLOW_USED_Y) return 0;
    return this._data[this.IDX_FOLLOW_USED_Y];
  }

  /** World rotation that keeps radial up at the top of the screen. Radians. */
  static get rotation() {
    if (!this._data || this._data.length <= this.IDX_ROTATION) return 0;
    return this._data[this.IDX_ROTATION] || 0;
  }

  static set rotation(radians) {
    if (!this._data || this._data.length <= this.IDX_ROTATION) return;
    // Inside the lock so the screen helpers' cached view sees the new angle.
    this._followWriteBegin();
    this._data[this.IDX_ROTATION] = radians || 0;
    this._followWriteEnd();
  }

  static setRotation(radians) {
    this.rotation = radians;
  }

  static setAngle(radians) {
    this.rotation = radians;
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
      this._freeZoomAnchorX = null;
      this._freeZoomAnchorY = null;
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
      this._freeZoomAnchorX = null;
      this._freeZoomAnchorY = null;
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

    // Wheel updates targetZoom only; display zoom lerps (no setZoom snap).
    // exp: log-symmetric in/out for raw deltaY (~±100/notch); linear 1-w*s is not invertible.
    // Pointer over the canvas: latch the world point under it and zoom around that,
    // not the screen center. Follow cameras still use follow()'s center anchor.
    if (!this._freeZoomPaused && Mouse.wheel) {
      let z = this.targetZoom * Math.exp(-Mouse.wheel * this._freeZoomSensitivity);
      const maxZ = this._freeMaxZoom != null ? this._freeMaxZoom : this._maxZoom;
      z = Math.max(this.minZoom, Math.min(maxZ, z));
      this._data[this.IDX_TARGET_ZOOM] = z;
      if (Mouse.isPresent) {
        this._freeZoomAnchorX = Mouse.x;
        this._freeZoomAnchorY = Mouse.y;
      }
    }
    this._freeZoomPaused = false;

    const z0 = this._data[this.IDX_ZOOM];
    const zT = this._data[this.IDX_TARGET_ZOOM];
    const zooming = zT > 0 && z0 > 0 && Math.abs(zT - z0) > 0.0001;
    if (!zooming) {
      this._freeZoomAnchorX = null;
      this._freeZoomAnchorY = null;
    }
    if (!zooming || this._freeZoomAnchorX == null || !(this._canvasWidth > 0)) {
      this.follow(this._freeFollowX, this._freeFollowY, this._freeSmoothing, dtRatio);
      return;
    }

    this._zoomFreeTowardPointer(dtRatio, z0);
  }

  /**
   * Ease free-cam zoom while keeping _freeZoomAnchor under the same screen pixel.
   * Shifts _freeFollow so WASD pan still eases in the zoomed frame.
   * Zoom ease matches _applyFollow (smoothstep of the follow ease).
   * @param {number} dtRatio
   * @param {number} z0
   */
  static _zoomFreeTowardPointer(dtRatio, z0) {
    const s = this._freeSmoothing;
    const es = (dtRatio != null && dtRatio > 0) ? Math.min(s * dtRatio, 1.0) : s;
    const esZoom = es * es * (3 - 2 * es);
    let z1 = z0 + (this._data[this.IDX_TARGET_ZOOM] - z0) * esZoom;
    z1 = Math.max(this.minZoom, Math.min(this._maxZoom, z1));
    if (!(z1 > 0) || z1 === z0) {
      this.follow(this._freeFollowX, this._freeFollowY, this._freeSmoothing, dtRatio);
      return;
    }

    const camX = this._data[1];
    const camY = this._data[2];
    const cw = this._canvasWidth;
    const ch = this._canvasHeight;
    const sx = (this._freeZoomAnchorX - camX) * z0;
    const sy = (this._freeZoomAnchorY - camY) * z0;

    this._freeFollowX += (sx - cw * 0.5) * (1 / z0 - 1 / z1);
    this._freeFollowY += (sy - ch * 0.5) * (1 / z0 - 1 / z1);
    if (this._worldWidth !== Infinity) {
      this._freeFollowX = Math.max(0, Math.min(this._freeFollowX, this._worldWidth));
    }
    if (this._worldHeight !== Infinity) {
      this._freeFollowY = Math.max(0, Math.min(this._freeFollowY, this._worldHeight));
    }

    const keepX = this._freeZoomAnchorX - sx / z1;
    const keepY = this._freeZoomAnchorY - sy / z1;
    const halfW1 = cw / (2 * z1);
    const halfH1 = ch / (2 * z1);
    const newX = keepX + (this._freeFollowX - halfW1 - keepX) * es;
    const newY = keepY + (this._freeFollowY - halfH1 - keepY) * es;

    const clampZoom = Math.min(z0, z1);
    const maxX = Math.max(0, this._worldWidth - cw / clampZoom);
    const maxY = Math.max(0, this._worldHeight - ch / clampZoom);

    this._followWriteBegin();
    try {
      this._clearFollowEntityStamp();
      this._data[3] = this._freeFollowX;
      this._data[4] = this._freeFollowY;
      this._data[1] = Math.max(0, Math.min(newX, maxX));
      this._data[2] = Math.max(0, Math.min(newY, maxY));
      this._data[0] = z1;
    } finally {
      this._followWriteEnd();
    }
  }

  /**
   * Get the current follow target position (if any)
   * Reads from SharedArrayBuffer for cross-thread access
   * @param {{x?: number, y?: number}|null} [out]
   * @returns {{x: number, y: number} | null} Follow target or null if not following
   */
  static getFollowTarget(out = null) {
    if (!this._data) return null;

    // Buffer layout: [zoom, x, y, followTargetX, followTargetY, targetZoom]
    const targetX = this._data[3];
    const targetY = this._data[4];

    // NaN indicates no target set
    if (!Number.isNaN(targetX) && !Number.isNaN(targetY)) {
      const dest = out || Camera._followTargetScratch;
      dest.x = targetX;
      dest.y = targetY;
      return dest;
    }
    return null;
  }

  /**
   * Clear the follow target (stops following)
   */
  static clearFollowTarget() {
    if (!this._data) return;
    this._followWriteBegin();
    try {
      // Stamp first: a reader that still sees the slot must not see a NaN target.
      this._clearFollowEntityStamp();
      // NaN indicates no target
      this._data[3] = Number.NaN;
      this._data[4] = Number.NaN;
    } finally {
      this._followWriteEnd();
    }
  }

  /**
   * Immediately set camera to center on a target (no smoothing)
   * @param {number} targetX - Target X position in world coordinates
   * @param {number} targetY - Target Y position in world coordinates
   */
  static centerOn(targetX, targetY) {
    if (!this._data) return;
    this._followWriteBegin();
    try {
      this._clearFollowEntityStamp();

      const zoom = this._data[0];

      // Account for zoom when centering
      this._data[1] = targetX - this._canvasWidth / (2 * zoom);
      this._data[2] = targetY - this._canvasHeight / (2 * zoom);

      // Clamp to world bounds
      this._clampToWorldBounds();
    } finally {
      this._followWriteEnd();
    }
  }

  /**
   * Set camera position directly (top-left corner)
   * @param {number} x - X position
   * @param {number} y - Y position
   */
  static setPosition(x, y) {
    if (!this._data) return;
    this._followWriteBegin();
    try {
      this._clearFollowEntityStamp();
      this._data[1] = x;
      this._data[2] = y;

      // Clamp to world bounds
      this._clampToWorldBounds();
    } finally {
      this._followWriteEnd();
    }
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
    // The drawn camera (followEntity snapped to the pose), cached per realm.
    const v = this._drawnView();
    if (v.rotation) return this._isOnScreenTurned(worldX, worldY, margin);

    const zoom = v.zoom;
    const screenX = (worldX - v.x) * zoom;
    const screenY = (worldY - v.y) * zoom;

    return (
      screenX >= -margin &&
      screenX <= this._canvasWidth + margin &&
      screenY >= -margin &&
      screenY <= this._canvasHeight + margin
    );
  }

  /** isOnScreen for a turned camera: the view turns about the canvas center. */
  static _isOnScreenTurned(worldX, worldY, margin) {
    const s = this.worldToScreen(worldX, worldY, this._isOnScreenScratch);
    return (
      s.x >= -margin &&
      s.x <= this._canvasWidth + margin &&
      s.y >= -margin &&
      s.y <= this._canvasHeight + margin
    );
  }

  /**
   * Convert world coordinates to screen coordinates
   * @param {number} worldX - X in world space
   * @param {number} worldY - Y in world space
   * @param {{x?: number, y?: number}|null} [out]
   * @returns {{x: number, y: number}} Screen coordinates
   */
  static worldToScreen(worldX, worldY, out = null) {
    const v = this._drawnView();
    const zoom = v.zoom;
    const cameraX = v.x;
    const cameraY = v.y;
    const dest = out || Camera._worldToScreenScratch;
    const rot = v.rotation;
    const cw = this._canvasWidth;
    const ch = this._canvasHeight;
    if (!rot || !(cw > 0 && ch > 0 && zoom > 0)) {
      dest.x = (worldX - cameraX) * zoom;
      dest.y = (worldY - cameraY) * zoom;
      return dest;
    }
    const focusX = cameraX + cw / (2 * zoom);
    const focusY = cameraY + ch / (2 * zoom);
    const dx = worldX - focusX;
    const dy = worldY - focusY;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    dest.x = (c * dx - s * dy) * zoom + cw * 0.5;
    dest.y = (s * dx + c * dy) * zoom + ch * 0.5;
    return dest;
  }

  /**
   * Convert screen coordinates to world coordinates
   * @param {number} screenX - X in screen space
   * @param {number} screenY - Y in screen space
   * @param {{x?: number, y?: number}|null} [out]
   * @returns {{x: number, y: number}} World coordinates
   */
  static screenToWorld(screenX, screenY, out = null) {
    const v = this._drawnView();
    const zoom = v.zoom;
    const cameraX = v.x;
    const cameraY = v.y;
    const dest = out || Camera._screenToWorldScratch;
    const rot = v.rotation;
    const cw = this._canvasWidth;
    const ch = this._canvasHeight;
    if (!rot || !(cw > 0 && ch > 0 && zoom > 0)) {
      dest.x = screenX / zoom + cameraX;
      dest.y = screenY / zoom + cameraY;
      return dest;
    }
    const focusX = cameraX + cw / (2 * zoom);
    const focusY = cameraY + ch / (2 * zoom);
    const sx = screenX - cw * 0.5;
    const sy = screenY - ch * 0.5;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const inv = 1 / zoom;
    dest.x = focusX + (c * sx + s * sy) * inv;
    dest.y = focusY + (-s * sx + c * sy) * inv;
    return dest;
  }

  /**
   * Get viewport bounds in world coordinates.
   * Writes into `out` when provided; otherwise reuses a static scratch object
   * (zero allocation on the hot path used by SoundManager spatial culling).
   * With a rotated camera this is the world box around the turned view.
   * @param {{left?: number, top?: number, right?: number, bottom?: number, width?: number, height?: number}|null} [out]
   * @returns {{left: number, top: number, right: number, bottom: number, width: number, height: number}}
   */
  static getViewportBounds(out = null) {
    const result = out || Camera._viewportBoundsScratch;
    const v = this._drawnView();
    const zoom = v.zoom;
    const cameraX = v.x;
    const cameraY = v.y;

    const width = this._canvasWidth / zoom;
    const height = this._canvasHeight / zoom;
    const rot = v.rotation;
    if (rot) {
      const e = rotatedHalfExtents(width, height, rot, this._viewExtScratch);
      const cx = cameraX + width * 0.5;
      const cy = cameraY + height * 0.5;
      result.left = cx - e.halfW;
      result.top = cy - e.halfH;
      result.right = cx + e.halfW;
      result.bottom = cy + e.halfH;
      result.width = e.halfW * 2;
      result.height = e.halfH * 2;
      return result;
    }

    result.left = cameraX;
    result.top = cameraY;
    result.right = cameraX + width;
    result.bottom = cameraY + height;
    result.width = width;
    result.height = height;
    return result;
  }
}
