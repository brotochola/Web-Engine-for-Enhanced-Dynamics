/**
 * Keeps a GPU-bound WebGL renderer from submitting frames faster than the GPU finishes them
 * (E-97 in docs/internal/EXECUTION_PLAN.md).
 *
 * A worker's rAF fires at the display rate whatever the GPU's backlog. When a frame takes the GPU
 * longer than a vsync, every tick still submitted one, and the browser dropped frames it never
 * showed: `bunnyMarkScene` (250 000 sprites, GPU at ~98 %) presented 44 frames a second with a 3 ms
 * Pixi step and 55 with a 14 ms one, the slower CPU being the only thing that paced it. Paced, 60.
 *
 * A fence goes in after each frame and is read two frames later; while it is unsignaled the tick
 * submits nothing. Two frames in flight keep the GPU fed (a sync's status changes only between
 * tasks, so waiting on the last frame would idle it every other tick).
 */

// gl.UNSIGNALED. A lost context answers null, which is not a reason to wait.
const UNSIGNALED = 0x9118;
// A fence that never signals (a driver bug) must not stop drawing for good: after this many
// skipped ticks in a row the frame is submitted anyway, as it was before pacing.
const MAX_SKIPS = 8;

export class GpuFramePacer {
  constructor() {
    this._fences = [null, null];
    this._slot = 0;
    this._skips = 0;
    /** Ticks skipped since construction. */
    this.skipped = 0;
  }

  /** True while the GPU still holds the frame submitted two frames ago: submit nothing now. */
  busy(gl) {
    const fence = this._fences[this._slot];
    if (fence === null) return false;
    if (this._skips < MAX_SKIPS && gl.getSyncParameter(fence, gl.SYNC_STATUS) === UNSIGNALED) {
      this._skips++;
      this.skipped++;
      return true;
    }
    gl.deleteSync(fence);
    this._fences[this._slot] = null;
    this._skips = 0;
    return false;
  }

  /** After the frame's last GL call. */
  submitted(gl) {
    this._fences[this._slot] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this._slot ^= 1;
  }

  /** The context was lost or restored: its syncs are gone. */
  reset() {
    this._fences[0] = null;
    this._fences[1] = null;
    this._slot = 0;
    this._skips = 0;
  }
}
