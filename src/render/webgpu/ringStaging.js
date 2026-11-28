// E-488: WebGPU uploads of GPU particle records through staging buffers mapped ahead.
//
// A ring's fresh records are in the shared memory its writer fills (gpuParticleLayout.js). queue.writeBuffer from that
// memory costs Chrome's calling thread about 2.5 GB/s (the data goes through the GPU process's command stream); a buffer
// mapped for writing is memory the GPU process reads itself, so a copy into its mapped range is the only CPU copy. Each
// frame a layer copies its large ranges into one staging buffer (MAP_WRITE | COPY_SRC) that has finished mapping,
// unmaps it and copies them into the rings' buffers on the GPU (copyBufferToBuffer), submitted before the frame draws,
// then maps it again for a later frame. Chrome 158, GTX 1650, GPU Galaxy's 1.5 MB a frame over four rings
// (tests/bench/chrome/gpuRingUploadKernel.mjs): 0.27 ms a frame, against 0.61 for writeBuffer from the shared memory
// and 0.81 for the route before E-488 (a copy into the ring's own array, then writeBuffer from it).
//
// The copy into the mapped range takes whole COPY_BLOCK-record blocks through views of the ring made once (no view a
// frame); the GPU copies only the range's own bytes, so the block's other records, which a writer may be writing, never
// reach the ring. A range that does not fit, or a frame with no buffer mapped, is the caller's to write (writeBuffer).
// The pool holds up to POOL buffers, each made for the most the last frames asked for (MIN_BYTES to MAX_BYTES).

import { GPU_RECORD_BYTES, GPU_RECORD_FLOATS } from '../../util/gpuParticleLayout.js';

/** Records per block of a ring's pre-made views (gpuParticleBatch.js's RingDraw.blocks); a power of two. */
export const STAGE_BLOCK = 256;
export const STAGE_BLOCK_SHIFT = 8;
const BLOCK_BYTES = STAGE_BLOCK * GPU_RECORD_BYTES;
const BLOCK_WORDS = STAGE_BLOCK * GPU_RECORD_FLOATS;

const POOL = 3;
const MIN_BYTES = 1 << 18;
const MAX_BYTES = 1 << 24;
// The WebGPU constants (GPUBufferUsage, GPUMapMode), which Node has no globals for.
const USAGE_MAP_WRITE = 0x0002;
const USAGE_COPY_SRC = 0x0004;
const MAP_WRITE = 0x0002;
const NO_WORDS = new Uint32Array(0);

/** One staging buffer and its mapping state. */
class StagingBuffer {
  constructor(device, bytes, label) {
    this.buffer = device.createBuffer({ size: bytes, usage: USAGE_MAP_WRITE | USAGE_COPY_SRC, mappedAtCreation: true, label });
    this.bytes = bytes;
    this.mapped = true;
    // A mapping failed (the device was lost or the buffer destroyed): left out of the pool.
    this.dead = false;
    // The mapped range while the buffer is mapped and a frame has taken it; NO_WORDS otherwise.
    this.words = NO_WORDS;
    this.onMapped = () => {
      this.mapped = true;
    };
    this.onFailed = () => {
      this.dead = true;
    };
  }
}

/** The bytes a buffer is made at for a frame that asks for `bytes`: a power of two from MIN_BYTES to MAX_BYTES. */
function bufferBytesFor(bytes) {
  let size = MIN_BYTES;
  while (size < bytes && size < MAX_BYTES) size *= 2;
  return size;
}

export class RingStaging {
  /**
   * @param {GPUDevice} device
   * @param {(buffer: object) => GPUBuffer} gpuBufferOf a Pixi Buffer's GPU buffer, made (with all its data) if it has
   *   none yet: Pixi's renderer.buffer.getGPUBuffer
   * @param {string} [label]
   */
  constructor(device, gpuBufferOf, label = 'gpu-particles') {
    this.device = device;
    this.gpuBufferOf = gpuBufferOf;
    this.label = `${label}-staging`;
    /** @type {StagingBuffer[]} */
    this.pool = [];
    /** The frame's staging buffer once a range took one, else null. */
    this.current = null;
    /** The frame's copies, from its first staged range. */
    this.encoder = null;
    this.submits = [null];
    /** Bytes of `current` the frame has taken. */
    this.cursor = 0;
    /** Bytes the frame's ranges asked for, staged or not; `want`: the most of the last frames (it decays). */
    this.requested = 0;
    this.want = 0;
    /** Ranges staged and ranges left to the caller, since the start (for probes and tests). */
    this.stagedRanges = 0;
    this.declinedRanges = 0;
  }

  /**
   * Stage records [from, from + n) of a ring for its Pixi buffer `pixiBuffer`: the blocks of `blocks` (the ring's
   * views of STAGE_BLOCK records) that hold them into the frame's staging buffer, and the range's own bytes from there
   * into the ring's GPU buffer at flush. false: not staged (no buffer mapped, or no room left); the caller writes it.
   * @param {Uint32Array[]} blocks
   * @param {number} from
   * @param {number} n
   * @param {object} pixiBuffer
   * @returns {boolean}
   */
  stage(blocks, from, n, pixiBuffer) {
    const b0 = from >> STAGE_BLOCK_SHIFT;
    const b1 = (from + n + STAGE_BLOCK - 1) >> STAGE_BLOCK_SHIFT;
    const bytes = (b1 - b0) * BLOCK_BYTES;
    this.requested += bytes;
    let s = this.current;
    if (s === null) s = this._take();
    if (s === null || this.cursor + bytes > s.bytes) {
      this.declinedRanges++;
      return false;
    }
    const words = s.words;
    let w = this.cursor >> 2;
    for (let b = b0; b < b1; b++) {
      words.set(blocks[b], w);
      w += BLOCK_WORDS;
    }
    if (this.encoder === null) this.encoder = this.device.createCommandEncoder({ label: this.label });
    const skip = (from - (b0 << STAGE_BLOCK_SHIFT)) * GPU_RECORD_BYTES;
    this.encoder.copyBufferToBuffer(s.buffer, this.cursor + skip, this.gpuBufferOf(pixiBuffer), from * GPU_RECORD_BYTES, n * GPU_RECORD_BYTES);
    this.cursor += bytes;
    this.stagedRanges++;
    return true;
  }

  /** A mapped buffer of the pool for this frame, made or remade at the size the last frames asked for; or null. */
  _take() {
    const pool = this.pool;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].dead) {
        pool[i].buffer.destroy();
        pool.splice(i, 1);
      }
    }
    const size = bufferBytesFor(this.want > this.requested ? this.want : this.requested);
    let s = null;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].mapped) {
        s = pool[i];
        break;
      }
    }
    // Too small for the frames now, or four times too large: made again (a mapped buffer is made mapped).
    if (s !== null && (s.bytes < size || s.bytes > size * 4)) {
      s.buffer.destroy();
      pool.splice(pool.indexOf(s), 1);
      s = null;
    }
    if (s === null) {
      if (pool.length >= POOL) return null;
      s = new StagingBuffer(this.device, size, this.label);
      pool.push(s);
    }
    if (s.words.length === 0) s.words = new Uint32Array(s.buffer.getMappedRange());
    this.current = s;
    this.cursor = 0;
    return s;
  }

  /** End of the frame's ranges: the staged ones go to the GPU, before the frame draws, and their buffer maps again. */
  flush() {
    const s = this.current;
    if (s !== null && this.cursor > 0) {
      s.buffer.unmap();
      s.words = NO_WORDS;
      s.mapped = false;
      this.submits[0] = this.encoder.finish();
      this.device.queue.submit(this.submits);
      this.submits[0] = null;
      s.buffer.mapAsync(MAP_WRITE).then(s.onMapped, s.onFailed);
    }
    // A buffer that took no range stays mapped for the next frame.
    this.current = null;
    this.encoder = null;
    this.cursor = 0;
    const decayed = this.want - (this.want >> 4);
    this.want = this.requested > decayed ? this.requested : decayed;
    this.requested = 0;
  }

  destroy() {
    for (let i = 0; i < this.pool.length; i++) this.pool[i].buffer.destroy();
    this.pool.length = 0;
    this.current = null;
    this.encoder = null;
  }
}
