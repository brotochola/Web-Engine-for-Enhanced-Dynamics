/**
 * SpriteUpdateOptimizer - Performance utilities for sprite rendering
 *
 * Provides:
 * - Transform calculation pooling
 * - Batch property assignment helpers
 * - Performance profiling tools
 */

export class SpriteUpdateOptimizer {
  constructor() {
    // Object pools to avoid allocations
    this.vec2Pool = [];
    this.vec2PoolIndex = 0;

    // Performance tracking
    this.frameTimings = {
      visibilityPass: 0,
      transformPass: 0,
      visualPass: 0,
      total: 0,
      frameCount: 0,
    };

    // Preallocate pool
    for (let i = 0; i < 1000; i++) {
      this.vec2Pool.push({ x: 0, y: 0 });
    }
  }

  /**
   * Get a pooled vector object (avoids allocation)
   */
  getVec2(x, y) {
    const vec = this.vec2Pool[this.vec2PoolIndex++ % this.vec2Pool.length];
    vec.x = x;
    vec.y = y;
    return vec;
  }

  /**
   * Reset pool for next frame
   */
  resetPool() {
    this.vec2PoolIndex = 0;
  }

  /**
   * Start timing a pass
   */
  startTiming() {
    return performance.now();
  }

  /**
   * End timing and record
   */
  endTiming(passName, startTime) {
    this.frameTimings[passName] = performance.now() - startTime;
  }

  /**
   * Get performance report (call every N frames)
   */
  getPerformanceReport() {
    this.frameTimings.frameCount++;

    if (this.frameTimings.frameCount % 60 === 0) {
      const report = {
        visibilityPass: this.frameTimings.visibilityPass.toFixed(2) + "ms",
        transformPass: this.frameTimings.transformPass.toFixed(2) + "ms",
        visualPass: this.frameTimings.visualPass.toFixed(2) + "ms",
        total: this.frameTimings.total.toFixed(2) + "ms",
        fps: (1000 / this.frameTimings.total).toFixed(1),
      };
      return report;
    }

    return null;
  }

  /**
   * SIMD-style batch operations for transform updates
   * Process 4 entities at once (simulates SIMD without actual SIMD API)
   */
  batchTransformUpdate4(
    containers,
    x,
    y,
    rotation,
    scaleX,
    scaleY,
    zOffset,
    startIndex
  ) {
    // Unroll loop for 4 entities (better CPU pipelining)
    const i0 = startIndex;
    const i1 = startIndex + 1;
    const i2 = startIndex + 2;
    const i3 = startIndex + 3;

    // Entity 0
    const c0 = containers[i0];
    if (c0 && c0.visible) {
      c0.x = x[i0];
      c0.y = y[i0];
      c0.rotation = rotation[i0];
      c0.scale.x = scaleX[i0];
      c0.scale.y = scaleY[i0];
      c0.zIndex = y[i0] + zOffset[i0];
    }

    // Entity 1
    const c1 = containers[i1];
    if (c1 && c1.visible) {
      c1.x = x[i1];
      c1.y = y[i1];
      c1.rotation = rotation[i1];
      c1.scale.x = scaleX[i1];
      c1.scale.y = scaleY[i1];
      c1.zIndex = y[i1] + zOffset[i1];
    }

    // Entity 2
    const c2 = containers[i2];
    if (c2 && c2.visible) {
      c2.x = x[i2];
      c2.y = y[i2];
      c2.rotation = rotation[i2];
      c2.scale.x = scaleX[i2];
      c2.scale.y = scaleY[i2];
      c2.zIndex = y[i2] + zOffset[i2];
    }

    // Entity 3
    const c3 = containers[i3];
    if (c3 && c3.visible) {
      c3.x = x[i3];
      c3.y = y[i3];
      c3.rotation = rotation[i3];
      c3.scale.x = scaleX[i3];
      c3.scale.y = scaleY[i3];
      c3.zIndex = y[i3] + zOffset[i3];
    }
  }

  /**
   * Fast visibility batch check (4 at a time)
   */
  batchVisibilityCheck4(
    containers,
    active,
    renderVisible,
    isItOnScreen,
    startIndex
  ) {
    const i0 = startIndex;
    const i1 = startIndex + 1;
    const i2 = startIndex + 2;
    const i3 = startIndex + 3;

    const c0 = containers[i0];
    const c1 = containers[i1];
    const c2 = containers[i2];
    const c3 = containers[i3];

    if (c0) c0.visible = active[i0] && renderVisible[i0] && isItOnScreen[i0];
    if (c1) c1.visible = active[i1] && renderVisible[i1] && isItOnScreen[i1];
    if (c2) c2.visible = active[i2] && renderVisible[i2] && isItOnScreen[i2];
    if (c3) c3.visible = active[i3] && renderVisible[i3] && isItOnScreen[i3];
  }

  /**
   * Compute visible entity indices (returns array of visible entity IDs)
   * This allows processing only visible entities in subsequent passes
   */
  computeVisibleIndices(containers, entityCount) {
    const visible = [];

    for (let i = 0; i < entityCount; i++) {
      const container = containers[i];
      if (container && container.visible) {
        visible.push(i);
      }
    }

    return visible;
  }

  /**
   * Batch property assignment helper
   * Assigns multiple properties at once, checking if update is needed
   */
  batchAssignIfChanged(target, props) {
    let changed = false;

    for (const key in props) {
      if (target[key] !== props[key]) {
        target[key] = props[key];
        changed = true;
      }
    }

    return changed;
  }
}

/**
 * Performance monitoring mixin
 * Add to worker to track sprite update performance
 */
export class PerformanceMonitor {
  constructor() {
    this.metrics = {
      updateSpritesTime: 0,
      visibleCount: 0,
      dirtyCount: 0,
      frameCount: 0,
      lastReportTime: Date.now(),
    };
  }

  startFrame() {
    this.frameStartTime = performance.now();
  }

  endFrame(visibleCount, dirtyCount) {
    this.metrics.updateSpritesTime = performance.now() - this.frameStartTime;
    this.metrics.visibleCount = visibleCount;
    this.metrics.dirtyCount = dirtyCount;
    this.metrics.frameCount++;

    // Report every 2 seconds
    const now = Date.now();
    if (now - this.metrics.lastReportTime > 2000) {
      this.reportMetrics();
      this.metrics.lastReportTime = now;
    }
  }

  reportMetrics() {
    const avgTime = this.metrics.updateSpritesTime;
    const visible = this.metrics.visibleCount;
    const dirty = this.metrics.dirtyCount;

    console.log(
      `🎨 Render Stats: ${avgTime.toFixed(2)}ms | ` +
        `Visible: ${visible} | Dirty: ${dirty} | ` +
        `FPS: ${(1000 / avgTime).toFixed(1)}`
    );
  }
}
