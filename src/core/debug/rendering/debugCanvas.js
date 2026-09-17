// DebugCanvas.js — Manages the full-screen canvas overlay for all debug rendering

import { DEBUG_FLAGS } from '../debugFlags.js';
import { NavDebugRenderer } from './navDebugRenderer.js';
import { PhysicsDebugRenderer } from './physicsDebugRenderer.js';
import { bindBox2dHotFields, isBox2dHotFieldsBound } from '../../../box2d/box2dHotFields.js';
import { createRenderQueueCameraViews } from '../../../render/renderQueueLayout.js';
import { Mouse } from '../../mouse.js';

/**
 * Owns the <canvas> overlay that sits above the game viewport.
 * Delegates to sub-renderers for navigation and physics debug drawing.
 */
export class DebugCanvas {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this._canvas = null;
    this._ctx = null;
    this._rafId = null;
    this._resizeHandler = null;
    this._hotRebindLogged = false;

    // Scratch camera — mutated each frame; matches pixi renderQueueCamera when ready
    this._cam = { x: 0, y: 0, zoom: 1 };
    this._rqSync = null;
    this._rqCamA = null;
    this._rqCamB = null;
    this._rqPoseReadyA = null;
    this._rqPoseReadyB = null;
    this._queuePoseReady = 0;
    this._poseBuffers = [null, null];
    this._poseX = null;
    this._poseY = null;
    this._poseRotC = null;
    this._poseRotS = null;
    this._colliderPose = { x: null, y: null, rotC: null, rotS: null };

    this.nav = new NavDebugRenderer();
    this.physics = new PhysicsDebugRenderer();

    this._vpBuf = [null, null];
    this._vpMaxVerts = 0;
    this._vpSlotBytes = 0;
    this._visPolyScratch = { buf: null, lightCount: 0, maxVerts: 0, slotBytes: 0 };

    this._fpsHist = new Float32Array(120);
    this._fpsHistI = 0;
    this._fpsHistN = 0;
    this._hudMx = 0x7fffffff;
    this._hudMy = 0x7fffffff;
    this._hudCx = 0;
    this._hudCy = 0;
    this._hudCz = 0;
    this._hudLine1 = '';
    this._hudLine2 = '';
  }

  // ------- canvas management -------

  _ensure() {
    if (this._canvas) return;

    const canvas = document.createElement('canvas');
    canvas.id = 'debug-visualization-canvas';
    canvas.style.cssText = `
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 9998;
    `;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);

    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');

    this._resizeHandler = () => {
      if (this._canvas) {
        this._canvas.width = window.innerWidth;
        this._canvas.height = window.innerHeight;
      }
    };
    window.addEventListener('resize', this._resizeHandler);
  }

  // ------- lifecycle -------

  attach(scene) {
    this.nav.attach(scene);
    this.physics.attach(scene);
    this._bindRenderQueueCamera(scene);
    this._bindDisplayPose(scene);
    this._bindVisPoly(scene);
  }

  detach() {
    this.stopLoop();
    this.clear();
    this._rqSync = null;
    this._rqCamA = null;
    this._rqCamB = null;
    this._rqPoseReadyA = null;
    this._rqPoseReadyB = null;
    this._queuePoseReady = 0;
    this._poseBuffers[0] = null;
    this._poseBuffers[1] = null;
    this._poseX = null;
    this._poseY = null;
    this._poseRotC = null;
    this._poseRotS = null;
    this._colliderPose.x = null;
    this._colliderPose.y = null;
    this._colliderPose.rotC = null;
    this._colliderPose.rotS = null;
    this._vpBuf[0] = null;
    this._vpBuf[1] = null;
  }

  /** Cache SAB views once (no per-frame alloc). */
  _bindRenderQueueCamera(scene) {
    const buffers = scene?.buffers;
    if (!buffers?.renderQueueSync || !buffers.renderQueueCameraA || !buffers.renderQueueCameraB) {
      this._rqSync = null;
      this._rqCamA = null;
      this._rqCamB = null;
      this._rqPoseReadyA = null;
      this._rqPoseReadyB = null;
      return;
    }
    this._rqSync = new Int32Array(buffers.renderQueueSync);
    const a = createRenderQueueCameraViews(buffers.renderQueueCameraA);
    const b = createRenderQueueCameraViews(buffers.renderQueueCameraB);
    this._rqCamA = a ? a.camera : null;
    this._rqCamB = b ? b.camera : null;
    this._rqPoseReadyA = a ? a.poseReady : null;
    this._rqPoseReadyB = b ? b.poseReady : null;
  }

  /** Same 4-channel pose SAB as AbstractWorker._bindPosePublish. */
  _bindDisplayPose(scene) {
    const buffers = scene?.buffers;
    const n = scene?.poseCapacity | 0;
    if (!buffers?.poseSync || !buffers.poseDataA || !buffers.poseDataB || !(n > 0)) {
      this._poseBuffers[0] = null;
      this._poseBuffers[1] = null;
      return;
    }
    const sabs = [buffers.poseDataA, buffers.poseDataB];
    for (let i = 0; i < 2; i++) {
      const sab = sabs[i];
      this._poseBuffers[i] = {
        x: new Float32Array(sab, 0, n),
        y: new Float32Array(sab, n * 4, n),
        rotC: new Float32Array(sab, n * 8, n),
        rotS: new Float32Array(sab, n * 12, n),
      };
    }
  }

  /**
   * Pin pose views to the generation stamped on the render-queue camera.
   * Read-only: do not consume poseSync (pre_render owns that).
   */
  _pinDisplayPose(poseReady) {
    this._poseX = null;
    this._poseY = null;
    this._poseRotC = null;
    this._poseRotS = null;
    const pose = this._colliderPose;
    pose.x = null;
    pose.y = null;
    pose.rotC = null;
    pose.rotS = null;
    if (!this._poseBuffers[0] || !(poseReady > 0)) return;
    const curIdx = (poseReady - 1) & 1;
    const buf = this._poseBuffers[curIdx];
    this._poseX = buf.x;
    this._poseY = buf.y;
    this._poseRotC = buf.rotC;
    this._poseRotS = buf.rotS;
    pose.x = buf.x;
    pose.y = buf.y;
    pose.rotC = buf.rotC;
    pose.rotS = buf.rotS;
  }

  _bindVisPoly(scene) {
    const buffers = scene?.buffers;
    const a = buffers?.visibilityPolygonDataA;
    const b = buffers?.visibilityPolygonDataB;
    if (!a || !b) {
      this._vpBuf[0] = null;
      this._vpBuf[1] = null;
      return;
    }
    const maxVerts = scene.maxPolygonVertices || scene.config?.lighting?.maxPolygonVertices || 128;
    this._vpMaxVerts = maxVerts;
    this._vpSlotBytes = 16 + maxVerts * 8;
    this._vpBuf[0] = { header: new Int32Array(a, 0, 1), i32: new Int32Array(a), f32: new Float32Array(a) };
    this._vpBuf[1] = { header: new Int32Array(b, 0, 1), i32: new Int32Array(b), f32: new Float32Array(b) };
  }

  /**
   * Latch camera to the same render-queue snapshot pixi uses.
   * Read-only: do not store consumedFrame (pixi owns that).
   */
  _latchRenderCamera(scene) {
    const cam = this._cam;
    this._queuePoseReady = 0;
    if (this._rqSync && this._rqCamA && this._rqCamB) {
      const ready = Atomics.load(this._rqSync, 0);
      if (ready > 0) {
        const slotA = ((ready - 1) % 2) === 0;
        const view = slotA ? this._rqCamA : this._rqCamB;
        const poseReady = slotA ? this._rqPoseReadyA : this._rqPoseReadyB;
        cam.zoom = view[0];
        cam.x = view[1];
        cam.y = view[2];
        this._queuePoseReady = poseReady ? poseReady[0] : 0;
        return cam;
      }
    }
    const sc = scene?.camera;
    cam.zoom = sc?.zoom || 1;
    cam.x = sc?.x || 0;
    cam.y = sc?.y || 0;
    return cam;
  }

  // ------- RAF loop -------

  startLoop() {
    if (this._rafId) return;
    const loop = () => {
      if (this.hasActiveVisualization()) {
        this.render();
        this._rafId = requestAnimationFrame(loop);
      } else {
        this._rafId = null;
      }
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stopLoop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Restart loop if needed after a flag toggle */
  syncLoop() {
    if (this.hasActiveVisualization()) {
      this.startLoop();
    } else {
      this.stopLoop();
      this.clear();
    }
  }

  // ------- queries -------

  hasActiveNavVisualization() {
    return this.nav.hasActiveVisualization();
  }

  hasActiveVisualization() {
    if (this.nav.hasActiveVisualization()) return true;

    const flags = this.debugUI.debugFlags;
    if (!flags) return false;

    return (
      flags.isEnabled(DEBUG_FLAGS.SHOW_COLLIDERS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_VELOCITY) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_ACCELERATION) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INDICES) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_NEIGHBORS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_SPATIAL_GRID) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_DEBUG_DRAWS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_CELLS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_SELECTED_ENTITY) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_JOINTS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INFO) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_LIGHTS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_FPS_GRAPH) ||
      !!this.debugUI.tools?.selectedPoolKind
    );
  }

  // ------- rendering -------

  clear() {
    if (this._ctx && this._canvas) {
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  }

  render() {
    if (!this.hasActiveVisualization()) {
      this.clear();
      return;
    }
    this._ensure();

    const ctx = this._ctx;
    const canvas = this._canvas;
    const scene = this.debugUI.scene;
    const flags = this.debugUI.debugFlags;
    this._ensureBox2dHotFields(scene);
    if (!this._rqSync && scene) this._bindRenderQueueCamera(scene);
    if (!this._poseBuffers[0] && scene) this._bindDisplayPose(scene);
    const camera = this._latchRenderCamera(scene);
    const zoom = camera.zoom;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this._pinDisplayPose(this._queuePoseReady);
    const pose = this._colliderPose;

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SPATIAL_GRID))
      this.physics.drawSpatialGrid(ctx, canvas, camera, zoom);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_CELLS))
      this.physics.drawSleepingCells(ctx, canvas, camera, zoom);

    if (this.nav.showWalkabilityGrid)
      this.nav.drawWalkabilityGrid(ctx, canvas, camera, zoom);

    if (this.nav.selectedFlowfieldSlot >= 0)
      this.nav.drawFlowfield(ctx, canvas, camera, zoom, this.nav.selectedFlowfieldSlot);

    if (this.nav.selectedStaticFlowfield !== null)
      this.nav.drawStaticFlowfield(ctx, canvas, camera, zoom, this.nav.selectedStaticFlowfield);

    if (this.nav.selectedPathSlot >= 0)
      this.nav.drawPath(ctx, canvas, camera, zoom, this.nav.selectedPathSlot);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_COLLIDERS))
      this.physics.drawColliders(ctx, canvas, camera, zoom, pose, flags);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS))
      this.physics.drawEntityOrigins(ctx, canvas, camera, zoom, flags, pose);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_VELOCITY))
      this.physics.drawVelocityVectors(ctx, canvas, camera, zoom, flags, pose);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ACCELERATION))
      this.physics.drawAccelerationVectors(ctx, canvas, camera, zoom, flags, pose);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_NEIGHBORS))
      this.physics.drawNeighborConnections(ctx, canvas, camera, zoom);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_DEBUG_DRAWS))
      this.physics.drawDebugPrimitives(ctx, canvas, camera, zoom);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INDICES))
      this.physics.drawEntityIndices(ctx, canvas, camera, zoom, flags, pose);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES))
      this.physics.drawSleepingEntities(ctx, canvas, camera, zoom, pose);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_JOINTS))
      this.physics.drawJoints(ctx, canvas, camera, zoom, flags);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_LIGHTS))
      this.physics.drawLights(ctx, canvas, camera, zoom, flags, pose, this._visPolyFrame());

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INFO))
      this.physics.drawEntityInfo(ctx, canvas, camera, zoom, pose);

    const tools = this.debugUI.tools;
    if (tools?.selectedPoolKind)
      this.physics.drawPoolSelection(ctx, canvas, camera, zoom, tools.selectedPoolKind, tools.selectedPoolIndex);

    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SELECTED_ENTITY))
      this.physics.drawSelectedEntity(ctx, canvas, camera, zoom, flags, pose);

    this._drawHud(ctx, canvas, camera, zoom);
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_FPS_GRAPH))
      this._drawFpsGraph(ctx, canvas, scene);
  }

  _visPolyFrame() {
    const scratch = this._visPolyScratch;
    scratch.buf = null;
    scratch.lightCount = 0;
    scratch.maxVerts = this._vpMaxVerts;
    scratch.slotBytes = this._vpSlotBytes;
    if (!this._vpBuf[0] || !this._rqSync) return scratch;
    const ready = Atomics.load(this._rqSync, 0);
    if (!(ready > 0)) return scratch;
    const slot = (ready - 1) & 1;
    const buf = this._vpBuf[slot];
    if (!buf) return scratch;
    scratch.buf = buf;
    scratch.lightCount = buf.header[0] | 0;
    return scratch;
  }

  _drawHud(ctx, canvas, camera, zoom) {
    const mx = Mouse.isPresent ? (Mouse.x * 10) | 0 : 0x7fffffff;
    const my = Mouse.isPresent ? (Mouse.y * 10) | 0 : 0x7fffffff;
    const cx = (camera.x * 10) | 0;
    const cy = (camera.y * 10) | 0;
    const cz = (zoom * 100) | 0;
    if (mx !== this._hudMx || my !== this._hudMy || cx !== this._hudCx || cy !== this._hudCy || cz !== this._hudCz) {
      this._hudMx = mx;
      this._hudMy = my;
      this._hudCx = cx;
      this._hudCy = cy;
      this._hudCz = cz;
      if (Mouse.isPresent) {
        this._hudLine1 = 'mouse ' + (mx / 10).toFixed(1) + ', ' + (my / 10).toFixed(1);
      } else {
        this._hudLine1 = 'mouse --';
      }
      this._hudLine2 = 'cam ' + (cx / 10).toFixed(1) + ', ' + (cy / 10).toFixed(1) + '  z' + (cz / 100).toFixed(2);
    }
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(8, canvas.height - 36, 220, 28);
    ctx.fillStyle = 'rgba(220, 220, 220, 0.9)';
    ctx.fillText(this._hudLine1, 12, canvas.height - 32);
    ctx.fillText(this._hudLine2, 12, canvas.height - 18);
  }

  _drawFpsGraph(ctx, canvas, scene) {
    const fps = scene?.mainFPS || 0;
    const hist = this._fpsHist;
    hist[this._fpsHistI] = fps;
    this._fpsHistI = (this._fpsHistI + 1) % hist.length;
    if (this._fpsHistN < hist.length) this._fpsHistN++;

    const w = 120;
    const h = 36;
    const x0 = canvas.width - w - 12;
    const y0 = 40;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = this._fpsHistN;
    const start = (this._fpsHistI - n + hist.length) % hist.length;
    for (let i = 0; i < n; i++) {
      const v = hist[(start + i) % hist.length];
      const x = x0 + (i / (hist.length - 1)) * w;
      const y = y0 + h - Math.max(0, Math.min(1, v / 60)) * (h - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** Re-bind HEAP views if WASM memory growth detached TypedArrays. */
  _ensureBox2dHotFields(scene) {
    const hot = scene?.box2dHotFields;
    if (!hot?.sab || !hot.channelOffsets) return;
    if (isBox2dHotFieldsBound(hot)) return;
    bindBox2dHotFields(hot);
  }

  // ------- cleanup -------

  destroy() {
    this.stopLoop();
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
    }
    if (this._canvas?.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._canvas = null;
    this._ctx = null;
    this._rqSync = null;
    this._rqCamA = null;
    this._rqCamB = null;
    this._rqPoseReadyA = null;
    this._rqPoseReadyB = null;
    this._poseBuffers[0] = null;
    this._poseBuffers[1] = null;
  }
}
