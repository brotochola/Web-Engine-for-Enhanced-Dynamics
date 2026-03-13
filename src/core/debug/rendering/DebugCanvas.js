// DebugCanvas.js — Manages the full-screen canvas overlay for all debug rendering

import { DEBUG_FLAGS } from '../../DebugFlags.js';
import { NavDebugRenderer } from './NavDebugRenderer.js';
import { PhysicsDebugRenderer } from './PhysicsDebugRenderer.js';

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

    this.nav = new NavDebugRenderer();
    this.physics = new PhysicsDebugRenderer();
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
  }

  detach() {
    this.stopLoop();
    this.clear();
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
      flags.isEnabled(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_SPATIAL_GRID) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_DEBUG_DRAWS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_CELLS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_SELECTED_ENTITY) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_CONSTRAINTS) ||
      flags.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS)
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
    const camera = scene?.camera || { x: 0, y: 0 };
    const zoom = scene?.camera?.zoom || 1;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Spatial grid
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SPATIAL_GRID))
      this.physics.drawSpatialGrid(ctx, canvas, camera, zoom);

    // 1.5. Sleeping cells
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_CELLS))
      this.physics.drawSleepingCells(ctx, canvas, camera, zoom);

    // 2. Nav walkability
    if (this.nav.showWalkabilityGrid)
      this.nav.drawWalkabilityGrid(ctx, canvas, camera, zoom);

    // 3. Dynamic flowfield
    if (this.nav.selectedFlowfieldSlot >= 0)
      this.nav.drawFlowfield(ctx, canvas, camera, zoom, this.nav.selectedFlowfieldSlot);

    // 3.5 Static flowfield
    if (this.nav.selectedStaticFlowfield !== null)
      this.nav.drawStaticFlowfield(ctx, canvas, camera, zoom, this.nav.selectedStaticFlowfield);

    // 4. Path
    if (this.nav.selectedPathSlot >= 0)
      this.nav.drawPath(ctx, canvas, camera, zoom, this.nav.selectedPathSlot);

    // 5. Colliders
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_COLLIDERS))
      this.physics.drawColliders(ctx, canvas, camera, zoom);

    // 5.5 Entity origins
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_ORIGINS))
      this.physics.drawEntityOrigins(ctx, canvas, camera, zoom, flags);

    // 6. Velocity
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_VELOCITY))
      this.physics.drawVelocityVectors(ctx, canvas, camera, zoom);

    // 7. Acceleration
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ACCELERATION))
      this.physics.drawAccelerationVectors(ctx, canvas, camera, zoom);

    // 8. Neighbors
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_NEIGHBORS))
      this.physics.drawNeighborConnections(ctx, canvas, camera, zoom);

    // 8.5 Collision candidates
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_COLLISION_CANDIDATES))
      this.physics.drawCollisionCandidateConnections(ctx, canvas, camera, zoom);

    // 9. Debug draw primitives (lines, circles, text, etc. via DebugDraw API)
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_DEBUG_DRAWS))
      this.physics.drawDebugPrimitives(ctx, canvas, camera, zoom);

    // 10. Entity indices
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_ENTITY_INDICES))
      this.physics.drawEntityIndices(ctx, canvas, camera, zoom);

    // 11. Sleeping entities
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SLEEPING_ENTITIES))
      this.physics.drawSleepingEntities(ctx, canvas, camera, zoom);

    // 12. Constraints
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_CONSTRAINTS))
      this.physics.drawConstraints(ctx, canvas, camera, zoom);

    // 13. Selected entity (always on top)
    if (flags?.isEnabled(DEBUG_FLAGS.SHOW_SELECTED_ENTITY))
      this.physics.drawSelectedEntity(ctx, canvas, camera, zoom, flags);
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
  }
}
