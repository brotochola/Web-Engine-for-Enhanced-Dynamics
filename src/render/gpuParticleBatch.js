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
  GPU_RING,
} from '../util/gpuParticleLayout.js';

/** Instance attributes, one vec4 each, in record order (gpuParticleLayout GPU_REC). */
export const GPU_PARTICLE_ATTRIBUTES = Object.freeze(['aMove', 'aHeight', 'aTime', 'aScale', 'aColor', 'aSpin', 'aFrames']);

/** Animation indices per row of the anim-start lookup (uAnimStart). */
export const GPU_ANIM_LUT_WIDTH = 64;

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
  constructor(ring, shader, state, label) {
    this.ring = ring;
    this.shader = shader;
    this.mirror = new Float32Array(ring.records.length);
    this.buffer = new Buffer({
      data: this.mirror,
      label: `${label}-records`,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    this.quad = new Buffer({ data: QUAD, usage: BufferUsage.VERTEX });
    this.index = new Buffer({ data: QUAD_INDEX, usage: BufferUsage.INDEX });
    // Two meshes: a live window that wraps the ring end is drawn as two ranges.
    this.meshes = [this._mesh(state), this._mesh(state)];
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

  /** Copy and upload the records published since the last call. */
  upload(published) {
    const cap = this.ring.capacity;
    let fresh = (published - this.uploaded) >>> 0;
    if (fresh === 0) return;
    if (fresh > cap) fresh = cap; // lapped: only the newest ring's worth is still there
    const start = (published - fresh) >>> 0;
    const from = start & (cap - 1);
    const src = this.ring.records;
    const floats = GPU_RECORD_BYTES / 4;
    const head = Math.min(fresh, cap - from);
    this.mirror.set(src.subarray(from * floats, (from + head) * floats), from * floats);
    if (fresh > head) {
      this.mirror.set(src.subarray(0, (fresh - head) * floats), 0);
      this.buffer.update(cap * GPU_RECORD_BYTES, 0); // across the ring end: the whole array
    } else {
      this.buffer.update(head * GPU_RECORD_BYTES, from * GPU_RECORD_BYTES);
    }
    this.uploaded = published >>> 0;
  }

  /**
   * The live window: [first record of the oldest live group, published). Groups the writer wrote before its last
   * epoch move (it moves it only once everything has ended), groups whose first record was written over and groups
   * that ended are skipped.
   * @returns {number} live records (0 = nothing to draw)
   */
  window(published, groups, nowRel, epochGen) {
    const ring = this.ring;
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

  /** Point the meshes at [first, first + count) of the ring (two ranges across the ring end). */
  setRange(first, count) {
    const cap = this.ring.capacity;
    const [a, b] = this.meshes;
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
    for (const m of this.meshes) {
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
   * @param {string} [opts.label]
   */
  constructor(opts) {
    this.info = opts.info;
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
    const shaders = opts.shaders || {};
    for (let r = 0; r < this.info.rings.length; r++) {
      const shader = this._makeShader(shaders, opts, `${this.label}-ring${r}`);
      const draw = new RingDraw(this.info.rings[r], shader, this.state, `${this.label}-ring${r}`);
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
   * @param {number} nowMs Time.simNowMs
   * @returns {number} live records drawn
   */
  update(nowMs) {
    let live = 0;
    for (let r = 0; r < this.rings.length; r++) {
      const draw = this.rings[r];
      const ring = draw.ring;
      const groups = Atomics.load(ring.header, GPU_RING.GROUPS) >>> 0;
      const published = Atomics.load(ring.header, GPU_RING.PUBLISHED) >>> 0;
      const epochGen = Atomics.load(ring.header, GPU_RING.EPOCH_GEN) >>> 0;
      draw.upload(published);
      const nowRel = nowMs - ring.epoch[0];
      const count = draw.window(published, groups, nowRel, epochGen);
      draw.setRange(draw.liveFirst, count);
      const group = draw.shader.resources.uniforms;
      const u = group.uniforms.uGpuParticles;
      u[0] = nowRel;
      u[1] = this.pixelSnap ? 1 : 0;
      if (typeof group.update === 'function') group.update();
      live += count;
    }
    this.liveRecords = live;
    return live;
  }

  destroy() {
    for (const r of this.rings) r.destroy();
    this.rings.length = 0;
    this.container.destroy({ children: false });
  }
}
