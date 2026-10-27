// The renderer's side of a GPU particle layer (LAYER_KIND.GPU_PARTICLES): one instanced mesh per writer ring over
// the ring's records, which are uploaded once, when published. The vertex shader evaluates every particle from its
// record and age (src/shaders/gpuParticle.*), so a frame costs the CPU a few uniforms and a range per ring.
//
// Each frame, per ring: copy what was published since the last frame out of the shared memory into the ring's own
// array and upload that range (uploading from the shared memory itself slows the other workers: E-123); a range
// that wraps the ring end uploads the whole array, since Pixi keeps one pending range per buffer. Then draw only
// the live window: from the first record of the oldest group that may still be alive to the last published one.
// A window that wraps the ring is two draws. Unborn and dead records inside it cost four vertex invocations each.

import {
  Buffer,
  BufferUsage,
  Container,
  Geometry,
  GlProgram,
  GpuProgram,
  Mesh,
  Shader,
  State,
} from '../vendor/pixi.min.js';

import { gpuStageF, gpuStageVF } from './webgpu/pixiMeshWgsl.js';
import {
  GPU_GROUP,
  GPU_GROUP_WORDS,
  GPU_RECORD_BYTES,
  GPU_RECORD_FLOATS,
  GPU_RING,
} from '../util/gpuParticleLayout.js';

/** Instance attributes, one vec4 each, in record order (gpuParticleLayout GPU_REC). */
export const GPU_PARTICLE_ATTRIBUTES = Object.freeze(['aMove', 'aHeight', 'aTime', 'aScale', 'aColor', 'aSpin', 'aFrames']);

/** Animation indices per row of the anim-start lookup (uAnimStart). */
export const GPU_ANIM_LUT_WIDTH = 64;

/** Records per pre-made copy view (RingDraw._copy); a power of two. */
const COPY_BLOCK = 256;
const COPY_BLOCK_SHIFT = 8;

const QUAD = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QUAD_INDEX = new Uint32Array([0, 1, 2, 0, 2, 3]);

/**
 * WebGPU program: the sprite batch's bind groups plus the anim-start lookup at group 2, binding 4.
 * @param {typeof GpuProgram} GpuProgramClass
 * @param {string} source gpuParticle.wgsl
 * @param {'mainFrag'|'mainFragAdd'} fragEntry
 * @param {string} name
 */
export function gpuParticleGpuProgram(GpuProgramClass, source, fragEntry, name) {
  if (!source) throw new Error('WeedJS: GPU particle WGSL was not loaded before GpuProgram creation.');
  const vf = gpuStageVF();
  const f = gpuStageF();
  const lookup = { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false };
  return GpuProgramClass.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: fragEntry },
    layout: {
      0: { globalUniforms: 0 },
      1: { localUniforms: 0 },
      2: { uTexture: 0, uSampler: 1, uTexLut: 2, uniforms: 3, uAnimStart: 4 },
    },
    gpuLayout: [
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [
        { binding: 0, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } },
        { binding: 1, visibility: f, sampler: { type: 'filtering' } },
        { binding: 2, visibility: vf, texture: lookup },
        { binding: 3, visibility: vf, buffer: { type: 'uniform' } },
        { binding: 4, visibility: vf, texture: lookup },
      ],
    ],
  });
}

/**
 * Animation index -> the atlas lookup's texture id, as the emit kernel maps CPU particles (0 = `whiteTexture`).
 * Packed RGBA32F, the id in red, GPU_ANIM_LUT_WIDTH per row.
 * @param {number[]} animationFrameStart
 * @param {number} whiteTexture
 * @returns {{ data: Float32Array, width: number, height: number }}
 */
export function packAnimStartLookup(animationFrameStart, whiteTexture) {
  const n = Math.max(1, animationFrameStart?.length | 0);
  const height = Math.max(1, Math.ceil(n / GPU_ANIM_LUT_WIDTH));
  const data = new Float32Array(GPU_ANIM_LUT_WIDTH * height * 4).fill(-1);
  for (let a = 0; a < n; a++) {
    const id = a === 0 ? whiteTexture : animationFrameStart[a];
    data[a * 4] = Number.isFinite(id) ? id : -1;
  }
  return { data, width: GPU_ANIM_LUT_WIDTH, height };
}

/** One ring's draw state on the renderer. */
class RingDraw {
  constructor(ring, shader, state, label, flush) {
    this.ring = ring;
    this.shader = shader;
    this.mirror = new Float32Array(ring.records.length);
    this.mirrorBits = new Uint32Array(this.mirror.buffer);
    // Whole blocks of COPY_BLOCK records copy through views made once (TypedArray.set); a view per upload was
    // garbage. A range's ends copy word by word (_copyWords).
    const blockCount = (ring.capacity / COPY_BLOCK) | 0;
    const blockWords = COPY_BLOCK * GPU_RECORD_FLOATS;
    this.srcBlocks = new Array(blockCount);
    this.dstBlocks = new Array(blockCount);
    for (let k = 0; k < blockCount; k++) {
      this.srcBlocks[k] = ring.records.subarray(k * blockWords, (k + 1) * blockWords);
      this.dstBlocks[k] = this.mirror.subarray(k * blockWords, (k + 1) * blockWords);
    }
    this.buffer = new Buffer({
      data: this.mirror,
      label: `${label}-records`,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    // Sends the buffer's pending range to the GPU now (GpuParticleLayerBatch's `flush`), or null.
    this.flush = flush || null;
    this.quad = new Buffer({ data: QUAD, usage: BufferUsage.VERTEX });
    this.index = new Buffer({ data: QUAD_INDEX, usage: BufferUsage.INDEX });
    // Two meshes: a live window that wraps the ring end is drawn as two ranges.
    this.meshes = [this._mesh(state), this._mesh(state)];
    this.state = state;
    // Groups drawn one by one among the entities (gpuParticleChunks.js): meshes reused frame to frame.
    this.pool = [];
    this.poolUsed = 0;
    this.uploaded = 0; // records uploaded (absolute count)
    this.oldestLive = 0; // reader-side: the oldest group that may still be alive (absolute)
    this.liveFirst = 0;
    this.liveCount = 0;
  }

  _mesh(state) {
    const stride = GPU_RECORD_BYTES;
    const attributes = { aQuad: { buffer: this.quad, format: 'float32x2', stride: 8, offset: 0 } };
    GPU_PARTICLE_ATTRIBUTES.forEach((name, k) => {
      attributes[name] = { buffer: this.buffer, format: 'float32x4', stride, offset: k * 16, instance: true };
    });
    const geometry = new Geometry({ attributes, indexBuffer: this.index });
    geometry.instanceCount = 0;
    geometry.weedFirstInstance = 0;
    const mesh = new Mesh({ geometry, shader: this.shader, state });
    mesh.cullable = false;
    mesh.visible = false;
    return mesh;
  }

  /** Records [from, from + n) of the ring into the mirror (a range that does not wrap the ring end). */
  _copy(from, n) {
    const end = from + n;
    let r = from;
    let blocks = (r + COPY_BLOCK - 1) & ~(COPY_BLOCK - 1);
    if (blocks > end) blocks = end;
    this._copyWords(r * GPU_RECORD_FLOATS, blocks * GPU_RECORD_FLOATS);
    r = blocks;
    while (r + COPY_BLOCK <= end) {
      this.dstBlocks[r >> COPY_BLOCK_SHIFT].set(this.srcBlocks[r >> COPY_BLOCK_SHIFT]);
      r += COPY_BLOCK;
    }
    this._copyWords(r * GPU_RECORD_FLOATS, end * GPU_RECORD_FLOATS);
  }

  /** Words [from, to) as Uint32: bit for bit, the bit-packed fields included. */
  _copyWords(from, to) {
    const src = this.ring.recordBits;
    const dst = this.mirrorBits;
    for (let w = from; w < to; w++) dst[w] = src[w];
  }

  /** Copy and upload the records published since the last call. */
  upload(published) {
    const cap = this.ring.capacity;
    let fresh = (published - this.uploaded) >>> 0;
    if (fresh === 0) return;
    if (fresh > cap) fresh = cap; // lapped: only the newest ring's worth is still there
    const start = (published - fresh) >>> 0;
    const from = start & (cap - 1);
    const head = fresh < cap - from ? fresh : cap - from;
    this._copy(from, head);
    if (fresh > head) {
      this._copy(0, fresh - head);
      this.buffer.update(cap * GPU_RECORD_BYTES, 0); // across the ring end: the whole array
    } else {
      this.buffer.update(head * GPU_RECORD_BYTES, from * GPU_RECORD_BYTES);
    }
    // A buffer keeps one pending range; the next update replaces it. Sent now, a frame that draws nothing of this
    // ring cannot lose what it published.
    if (this.flush !== null) this.flush(this.buffer);
    this.uploaded = published >>> 0;
  }

  /**
   * The live window: [first record of the oldest live group, published). Groups the writer wrote before its last
   * epoch move (it moves it only once everything has ended), groups whose first record was written over and groups
   * that ended are skipped.
   * @returns {number} live records (0 = nothing to draw)
   */
  window(published, groups, epochGen, clock) {
    const ring = this.ring;
    const nowRel = clock[0] - ring.epoch[0];
    const gcap = ring.groupCapacity;
    if (((groups - this.oldestLive) >>> 0) > gcap) this.oldestLive = (groups - gcap) >>> 0;
    while (this.oldestLive !== groups) {
      const b = (this.oldestLive & (gcap - 1)) * GPU_GROUP_WORDS;
      const first = ring.groupBits[b + GPU_GROUP.FIRST] >>> 0;
      const stale = (ring.groupBits[b + GPU_GROUP.EPOCH_GEN] >>> 0) !== epochGen;
      const overwritten = ((published - first) >>> 0) > ring.capacity;
      const ended = ring.groups[b + GPU_GROUP.END_F] <= nowRel;
      if (!stale && !overwritten && !ended) break;
      this.oldestLive = (this.oldestLive + 1) >>> 0;
    }
    if (this.oldestLive === groups) {
      this.liveFirst = published;
      this.liveCount = 0;
      return 0;
    }
    const b = (this.oldestLive & (gcap - 1)) * GPU_GROUP_WORDS;
    this.liveFirst = ring.groupBits[b + GPU_GROUP.FIRST] >>> 0;
    this.liveCount = (published - this.liveFirst) >>> 0;
    return this.liveCount;
  }

  /** A mesh of the group pool, pointed at slots [slot, slot + count). */
  groupMesh(slot, count) {
    let mesh = this.pool[this.poolUsed];
    if (!mesh) {
      mesh = this._mesh(this.state);
      mesh.visible = true;
      this.pool.push(mesh);
    }
    this.poolUsed++;
    mesh.geometry.weedFirstInstance = slot;
    mesh.geometry.instanceCount = count;
    return mesh;
  }

  /** Point the meshes at [first, first + count) of the ring (two ranges across the ring end). */
  setRange(first, count) {
    const cap = this.ring.capacity;
    const a = this.meshes[0];
    const b = this.meshes[1];
    if (count <= 0) {
      a.visible = false;
      b.visible = false;
      return;
    }
    const slot = first & (cap - 1);
    const headCount = Math.min(count, cap - slot);
    a.geometry.weedFirstInstance = slot;
    a.geometry.instanceCount = headCount;
    a.visible = true;
    const tail = count - headCount;
    if (tail > 0) {
      b.geometry.weedFirstInstance = 0;
      b.geometry.instanceCount = tail;
      b.visible = true;
    } else {
      b.visible = false;
    }
  }

  destroy() {
    for (const m of this.meshes.concat(this.pool)) {
      m.geometry.destroy();
      m.destroy();
    }
    this.buffer.destroy();
    this.quad.destroy();
    this.index.destroy();
  }
}

export class GpuParticleLayerBatch {
  /**
   * @param {object} opts
   * @param {object} opts.info GpuParticles.layerOf(...) of this layer
   * @param {boolean} opts.useWebGpu
   * @param {object} opts.shaders the Pixi worker's engine shaders
   * @param {object} opts.atlasSource
   * @param {object} opts.lutSource
   * @param {object} opts.animStartSource
   * @param {string} opts.blendMode Pixi blend mode name ('normal', 'add', ...)
   * @param {boolean} [opts.additive] color-only output (an additive layer drawn on the stage)
   * @param {boolean} [opts.pixelSnap]
   * @param {boolean} [opts.sorted] drawn among the entities, a group at a time (gpuParticleChunks.js), not at the
   *   layer's zIndex; a look layer still draws its rings into its density target
   * @param {boolean} [opts.look] the layer has a look shader
   * @param {string} [opts.label]
   * @param {(buffer: Buffer) => void} [opts.flush] uploads a ring's newly published range at once (the Pixi
   *   worker passes its renderer's `buffer.updateBuffer`). Pixi's WebGL buffers upload their last range only when
   *   next drawn, so without it a ring that draws nothing in a frame (a hidden layer; with `sorted`, groups that
   *   are all off-screen) loses that frame's records.
   */
  constructor(opts) {
    this.info = opts.info;
    this.sorted = !!opts.sorted;
    this.look = !!opts.look;
    this.label = opts.label || `gpu-particles-${opts.info.name}`;
    this.useWebGpu = !!opts.useWebGpu;
    this.pixelSnap = !!opts.pixelSnap;
    this.container = new Container();
    this.container.label = this.label;
    this.state = new State();
    this.state.blend = true;
    this.state.blendMode = opts.blendMode || 'normal';
    this.state.depthTest = false;
    this.state.depthMask = false;
    this.state.culling = false;
    this.rings = [];
    this.liveRecords = 0;
    /** The layer's alpha for this frame's group meshes (groupMeshes); the Pixi worker sets it each frame. */
    this.alpha = NaN;
    const shaders = opts.shaders || {};
    for (let r = 0; r < this.info.rings.length; r++) {
      const shader = this._makeShader(shaders, opts, `${this.label}-ring${r}`);
      const draw = new RingDraw(this.info.rings[r], shader, this.state, `${this.label}-ring${r}`, opts.flush);
      for (const m of draw.meshes) {
        m.blendMode = this.state.blendMode;
        this.container.addChild(m);
      }
      this.rings.push(draw);
    }
  }

  _makeShader(shaders, opts, name) {
    const resources = {
      uTexture: opts.atlasSource,
      uSampler: opts.atlasSource?.style,
      uTexLut: opts.lutSource,
      uAnimStart: opts.animStartSource,
      uniforms: { uGpuParticles: { value: new Float32Array(4), type: 'vec4<f32>' } },
    };
    if (this.useWebGpu) {
      const gpuProgram = gpuParticleGpuProgram(GpuProgram, shaders.gpuParticle, opts.additive ? 'mainFragAdd' : 'mainFrag', name);
      return new Shader({ gpuProgram, resources });
    }
    const fragment = opts.additive ? shaders.gpuParticleFragAdd : shaders.gpuParticleFrag;
    if (!shaders.gpuParticleVert || !fragment) throw new Error('WeedJS: GPU particle GLSL was not loaded before GlProgram creation.');
    const glProgram = GlProgram.from({ vertex: shaders.gpuParticleVert, fragment, name });
    return new Shader({ glProgram, resources });
  }

  /** Rebind the atlas, its lookup and the anim-start lookup (they are rebuilt when spritesheets load). */
  setTextures(atlasSource, lutSource, animStartSource) {
    for (const r of this.rings) {
      const res = r.shader.resources;
      if (atlasSource) {
        res.uTexture = atlasSource;
        res.uSampler = atlasSource.style;
      }
      if (lutSource) res.uTexLut = lutSource;
      if (animStartSource) res.uAnimStart = animStartSource;
    }
  }

  /**
   * Upload new records and set every ring's live window and clock for this frame.
   * @param {Float64Array} clock clock[0] is Time.simNowMs (Time.readSimNowInto): a typed array, since a double
   *   passed to a call TurboFan does not inline is boxed
   * @returns {number} live records drawn
   */
  update(clock) {
    let live = 0;
    for (let r = 0; r < this.rings.length; r++) {
      const draw = this.rings[r];
      const ring = draw.ring;
      const groups = Atomics.load(ring.header, GPU_RING.GROUPS) >>> 0;
      const published = Atomics.load(ring.header, GPU_RING.PUBLISHED) >>> 0;
      const epochGen = Atomics.load(ring.header, GPU_RING.EPOCH_GEN) >>> 0;
      draw.upload(published);
      const count = draw.window(published, groups, epochGen, clock);
      // Sorted among the entities, a plain layer's groups are drawn one by one (groupMeshes); its rings are not.
      draw.setRange(draw.liveFirst, this.sorted && !this.look ? 0 : count);
      const group = draw.shader.resources.uniforms;
      const u = group.uniforms.uGpuParticles;
      u[0] = clock[0] - ring.epoch[0];
      u[1] = this.pixelSnap ? 1 : 0;
      if (typeof group.update === 'function') group.update();
      live += count;
    }
    this.liveRecords = live;
    return live;
  }

  /** Start a frame of group draws (the pools are reused). */
  beginGroups() {
    for (let r = 0; r < this.rings.length; r++) this.rings[r].poolUsed = 0;
  }

  /**
   * Write the meshes that draw group `group` (absolute) of writer ring `r` at out[n…]: one, or two when its slots
   * wrap the ring end. Records the writer has written over are left out. The meshes take `alpha`, the layer's for
   * this frame. Returns the next free index.
   * @param {number} r
   * @param {number} group
   * @param {object[]} out
   * @param {number} n
   * @returns {number}
   */
  groupMeshes(r, group, out, n) {
    const draw = this.rings[r];
    if (draw === undefined) return n;
    const ring = draw.ring;
    const b = (group & (ring.groupCapacity - 1)) * GPU_GROUP_WORDS;
    let first = ring.groupBits[b + GPU_GROUP.FIRST] >>> 0;
    let count = ring.groupBits[b + GPU_GROUP.COUNT] >>> 0;
    const published = draw.uploaded;
    const floor = (published - ring.capacity) >>> 0;
    if (((published - first) >>> 0) > ring.capacity) {
      const lost = (floor - first) >>> 0;
      if (lost >= count) return n;
      first = floor;
      count -= lost;
    }
    const cap = ring.capacity;
    const slot = first & (cap - 1);
    const head = count < cap - slot ? count : cap - slot;
    const blend = this.state.blendMode;
    const a = draw.groupMesh(slot, head);
    a.alpha = this.alpha;
    a.blendMode = blend;
    out[n++] = a;
    if (count > head) {
      const m = draw.groupMesh(0, count - head);
      m.alpha = this.alpha;
      m.blendMode = blend;
      out[n++] = m;
    }
    return n;
  }

  destroy() {
    for (const r of this.rings) r.destroy();
    this.rings.length = 0;
    this.container.destroy({ children: false });
  }
}
