/**
 * Keeps a GPU-bound renderer from submitting frames faster than the GPU finishes them
 * (E-97 in docs/internal/EXECUTION_PLAN.md; WebGPU: E-97b).
 *
 * A worker's rAF fires at the display rate whatever the GPU's backlog. When a frame takes the GPU
 * longer than a vsync, every tick still submitted one, and the browser dropped frames it never
 * showed: `bunnyMarkScene` (250 000 sprites, GPU at ~98 %) presented 44 frames a second with a 3 ms
 * Pixi step and 55 with a 14 ms one, the slower CPU being the only thing that paced it. Paced, 60.
 * WebGPU did the same (43 presented with a 2.5 ms Pixi step).
 *
 * The frame before last must be finished before a tick submits another. Two frames in flight keep
 * the GPU fed (a WebGL sync's status changes only between tasks, so waiting on the last frame would
 * idle the GPU every other tick).
 * - WebGL2: a fence after each frame, read two frames later.
 * - WebGPU: `queue.onSubmittedWorkDone()` after each frame. Its promises resolve in submission
 *   order, so frames finished is the count of resolutions, and one bound callback serves them all.
 */

// gl.UNSIGNALED. A lost context answers null, which is not a reason to wait.
const UNSIGNALED = 0x9118;
// A frame that never reports done (a driver bug, a lost device) must not stop drawing for good:
// after this many skipped ticks in a row the frame is submitted anyway, as it was before pacing.
const MAX_SKIPS = 8;

export class GpuFramePacer {
  constructor() {
    /** True once bound to a context or device that can be paced. */
    this.enabled = false;
    this._gl = null;
    this._fences = [null, null];
    this._slot = 0;
    this._queue = null;
    this._submitted = 0;
    this._completed = 0;
    this._onDone = () => {
      if (this._completed < this._submitted) this._completed++;
    };
    this._skips = 0;
    /** Ticks skipped since construction. */
    this.skipped = 0;
  }

  /** Pace a WebGL2 context (one without fenceSync is not paced). */
  bindGl(gl) {
    this.reset();
    this._queue = null;
    this._gl = gl && typeof gl.fenceSync === 'function' ? gl : null;
    this.enabled = this._gl !== null;
  }

  /** Pace a WebGPU device's queue. */
  bindDevice(device) {
    this.reset();
    this._gl = null;
    const queue = device && device.queue;
    this._queue = queue && typeof queue.onSubmittedWorkDone === 'function' ? queue : null;
    this.enabled = this._queue !== null;
  }

  /** True while the GPU still holds the frame submitted two frames ago: submit nothing now. */
  busy() {
    if (this._gl !== null) return this._glBusy(this._gl);
    if (this._queue === null || this._submitted - this._completed < 2) return false;
    if (this._skips < MAX_SKIPS) {
      this._skips++;
      this.skipped++;
      return true;
    }
    this._completed = this._submitted - 1;
    this._skips = 0;
    return false;
  }

  _glBusy(gl) {
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

  /** After the frame's last GPU call. */
  submitted() {
    const gl = this._gl;
    if (gl !== null) {
      this._fences[this._slot] = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      this._slot ^= 1;
      return;
    }
    if (this._queue === null) return;
    this._submitted++;
    this._skips = 0;
    this._queue.onSubmittedWorkDone().then(this._onDone);
  }

  /** The context or device was lost or restored: what it had in flight is gone. */
  reset() {
    this._fences[0] = null;
    this._fences[1] = null;
    this._slot = 0;
    this._completed = this._submitted;
    this._skips = 0;
  }
}
