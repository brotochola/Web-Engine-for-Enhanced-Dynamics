// Drawing the y-sort painter's proxies (gpuParticleProxies.js): the entities batch in chunks, with GPU particle
// groups and look-layer regions in the gaps, as children of the entities root (so the camera, the entities layer's
// alpha and the lighting above it apply to them as they do to sprites).
//
// A chunk is the entities batch's own buffers drawn from an instance (instanceRangeDraw.js): nothing is copied or
// uploaded again. Proxies with no sprite between them share one gap; past `maxSplits` gaps, the closest gaps merge
// (a group then draws a few sprites early or late). Without proxies the root holds the batch's mesh, as before.

import { Buffer, BufferUsage, Geometry, GlProgram, GpuProgram, Mesh, Shader, State } from '../vendor/pixi.min.js';
import { gpuStageF, gpuStageVF } from './webgpu/pixiMeshWgsl.js';
import { RENDERER_DEFAULTS } from '../util/configDefaults.js';
import { PROXY, PROXY_ENTRY_WORDS } from './gpuParticleProxies.js';

/** Default most gaps per frame in the entities batch (renderer.maxPainterSplits). */
export const DEFAULT_MAX_PAINTER_SPLITS = RENDERER_DEFAULTS.maxPainterSplits;

/**
 * A geometry over `base`'s buffers (same attributes, same index buffer), for drawing a range of its instances.
 * @param {Geometry} base
 */
export function rangeGeometryOf(base) {
  const attributes = {};
  for (const name in base.attributes) {
    const a = base.attributes[name];
    attributes[name] = { buffer: a.buffer, format: a.format, stride: a.stride, offset: a.offset, instance: a.instance };
  }
  const geometry = new Geometry({ attributes, indexBuffer: base.indexBuffer, topology: base.topology });
  geometry.instanceCount = 0;
  geometry.weedFirstInstance = 0;
  return geometry;
}

/**
 * Gap of each entry: entries come in key order, so their instance indices do not decrease. Equal indices share a
 * gap; past `maxSplits` distinct gaps, the two closest neighbours merge (the later one takes the earlier's index)
 * until they fit. Writes the gap index each entry draws at into `at`, returns the gap count.
 * @param {Int32Array} ints the entries
 * @param {number} count entries
 * @param {number} maxSplits
 * @param {Int32Array} at out: per entry, its instance index after merging
 * @param {number} instanceCount clamp
 */
export function assignGaps(ints, count, maxSplits, at, instanceCount) {
  let gaps = 0;
  let last = -1;
  for (let e = 0; e < count; e++) {
    let k = ints[e * PROXY_ENTRY_WORDS + PROXY.INDEX];
    if (k > instanceCount) k = instanceCount;
    if (k < 0) k = 0;
    if (k < last) k = last; // never draw before an earlier entry
    at[e] = k;
    if (k !== last) gaps++;
    last = k;
  }
  const max = Math.max(1, maxSplits | 0);
  while (gaps > max) {
    // the closest pair of neighbouring gaps
    let best = -1;
    let bestDiff = Infinity;
    let prev = -1;
    for (let e = 0; e < count; e++) {
      if (e > 0 && at[e] !== at[e - 1]) {
        const diff = at[e] - prev;
        if (diff < bestDiff) {
          bestDiff = diff;
          best = e;
        }
      }
      prev = at[e];
    }
    if (best < 0) break;
    const from = at[best];
    const to = at[best - 1];
    for (let e = best; e < count && at[e] === from; e++) at[e] = to;
    gaps--;
  }
  return gaps;
}

/** WebGPU program of a region quad. */
function regionGpuProgram(source, name) {
  const vf = gpuStageVF();
  const f = gpuStageF();
  return GpuProgram.from({
    name,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: 'mainFrag' },
    layout: { 0: { globalUniforms: 0 }, 1: { localUniforms: 0 }, 2: { uTexture: 0, uSampler: 1 } },
    gpuLayout: [
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
      [
        { binding: 0, visibility: f, texture: { sampleType: 'float', viewDimension: '2d', multisampled: false } },
        { binding: 1, visibility: f, sampler: { type: 'filtering' } },
      ],
    ],
  });
}

/**
 * Quads for one look layer's regions: world-space rectangles sampling the layer's finished look target at the
 * UVs where the camera puts them on screen.
 */
export class RegionQuads {
  /**
   * @param {object} opts
   * @param {boolean} opts.useWebGpu
   * @param {object} opts.shaders the Pixi worker's engine shaders (gpuRegion / gpuRegionVert, gpuRegionFrag)
   * @param {object} opts.texture the layer's look output (RenderTexture)
   * @param {string} opts.blendMode the layer's blendMode, as its full-screen composite draws
   * @param {string} [opts.label]
   */
  constructor(opts) {
    this.label = opts.label || 'gpu-regions';
    const source = opts.texture.source;
    /** The texture source the quads sample (the layer's look output). */
    this.source = source;
    const resources = { uTexture: source, uSampler: source.style };
    if (opts.useWebGpu) {
      this.shader = new Shader({ gpuProgram: regionGpuProgram(opts.shaders.gpuRegion, this.label), resources });
    } else {
      const glProgram = GlProgram.from({ vertex: opts.shaders.gpuRegionVert, fragment: opts.shaders.gpuRegionFrag, name: this.label });
      this.shader = new Shader({ glProgram, resources });
    }
    this.state = new State();
    this.state.blend = true;
    this.state.blendMode = opts.blendMode || 'normal';
    this.state.depthTest = false;
    this.state.culling = false;
    this.blendMode = this.state.blendMode;
    this.index = new Buffer({ data: new Uint32Array([0, 1, 2, 0, 2, 3]), usage: BufferUsage.INDEX });
    this.pool = [];
    this.used = 0;
  }

  /** The blend the quads draw with: the one the layer's full-screen composite uses. */
  setBlendMode(blendMode) {
    this.blendMode = blendMode || 'normal';
    this.state.blendMode = this.blendMode;
    for (let i = 0; i < this.pool.length; i++) this.pool[i].mesh.blendMode = this.blendMode;
  }

  /** The layer's look target was recreated (a resize). */
  setTexture(texture) {
    const source = texture.source;
    this.source = source;
    this.shader.resources.uTexture = source;
    this.shader.resources.uSampler = source.style;
  }

  beginFrame() {
    this.used = 0;
  }

  /**
   * A quad over world rect [minX, maxX] x [minY, maxY]. `m` maps world to screen px (a, b, c, d, tx, ty);
   * the UVs are screen / canvas.
   */
  quad(minX, minY, maxX, maxY, m, canvasW, canvasH) {
    let q = this.pool[this.used];
    if (!q) {
      const positions = new Buffer({ data: new Float32Array(8), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
      const uvs = new Buffer({ data: new Float32Array(8), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
      const geometry = new Geometry({
        attributes: {
          aPosition: { buffer: positions, format: 'float32x2', stride: 8, offset: 0 },
          aUV: { buffer: uvs, format: 'float32x2', stride: 8, offset: 0 },
        },
        indexBuffer: this.index,
      });
      const mesh = new Mesh({ geometry, shader: this.shader, state: this.state });
      mesh.cullable = false;
      mesh.blendMode = this.blendMode;
      q = { mesh, positions, uvs };
      this.pool.push(q);
    }
    this.used++;
    const p = q.positions.data;
    p[0] = minX; p[1] = minY; p[2] = maxX; p[3] = minY; p[4] = maxX; p[5] = maxY; p[6] = minX; p[7] = maxY;
    const u = q.uvs.data;
    for (let v = 0; v < 4; v++) {
      const x = p[v * 2];
      const y = p[v * 2 + 1];
      u[v * 2] = (m.a * x + m.c * y + m.tx) / canvasW;
      u[v * 2 + 1] = (m.b * x + m.d * y + m.ty) / canvasH;
    }
    q.positions.update();
    q.uvs.update();
    return q.mesh;
  }

  destroy() {
    for (const q of this.pool) {
      q.mesh.geometry.destroy();
      q.mesh.destroy();
      q.positions.destroy();
      q.uvs.destroy();
    }
    this.pool.length = 0;
    this.index.destroy();
  }
}

/** The entities batch in chunks with proxies between them, under the entities root. */
export class EntityChunks {
  /**
   * @param {object} opts
   * @param {object} opts.batch the entities InstancedSpriteBatch
   * @param {object} opts.root its container (the entities root)
   * @param {number} [opts.maxSplits]
   */
  constructor(opts) {
    this.batch = opts.batch;
    this.root = opts.root;
    this.maxSplits = opts.maxSplits | 0 || DEFAULT_MAX_PAINTER_SPLITS;
    // Per base geometry of the batch (it flips between two each frame): its chunk meshes.
    this.chunks = new Map();
    this.children = [];
    this.previous = [];
    this.at = new Int32Array(64);
    this.gaps = 0;
    this.active = false;
  }

  _chunk(base, j) {
    let list = this.chunks.get(base);
    if (!list) {
      list = [];
      this.chunks.set(base, list);
    }
    let mesh = list[j];
    if (!mesh) {
      mesh = new Mesh({ geometry: rangeGeometryOf(base), shader: this.batch.mesh.shader, state: this.batch.mesh.state });
      mesh.cullable = false;
      mesh.label = `entities-chunk-${j}`;
      list[j] = mesh;
    }
    return mesh;
  }

  /**
   * Arrange the entities root for this frame.
   * @param {{ ints: Int32Array }} half the frame's entries
   * @param {number} count entries
   * @param {number} instanceCount instances the batch committed
   * @param {(entryWord: number, out: object[]) => void} drawEntry pushes the meshes of one entry
   */
  apply(half, count, instanceCount, drawEntry) {
    if (count <= 0) {
      this.clear();
      return;
    }
    if (this.at.length < count) this.at = new Int32Array(count * 2);
    const at = this.at;
    this.gaps = assignGaps(half.ints, count, this.maxSplits, at, instanceCount);
    const children = this.children;
    children.length = 0;
    const base = this.batch.mesh.geometry;
    let from = 0;
    let chunk = 0;
    const visible = this.batch.mesh.visible && instanceCount > 0;
    for (let e = 0; e < count; e++) {
      const k = at[e];
      if (k > from && visible) {
        const m = this._chunk(base, chunk++);
        m.geometry.weedFirstInstance = from;
        m.geometry.instanceCount = k - from;
        children.push(m);
      }
      if (k > from) from = k;
      drawEntry(e * PROXY_ENTRY_WORDS, children);
    }
    if (from < instanceCount && visible) {
      const m = this._chunk(base, chunk++);
      m.geometry.weedFirstInstance = from;
      m.geometry.instanceCount = instanceCount - from;
      children.push(m);
    }
    this._setChildren(children);
    this.active = true;
  }

  /** Back to the batch's own mesh. */
  clear() {
    if (!this.active) return;
    this.children.length = 0;
    this.children.push(this.batch.mesh);
    this._setChildren(this.children);
    this.active = false;
  }

  _setChildren(list) {
    const prev = this.previous;
    let same = prev.length === list.length;
    for (let i = 0; same && i < list.length; i++) same = prev[i] === list[i];
    if (same) return;
    this.root.removeChildren();
    for (let i = 0; i < list.length; i++) this.root.addChild(list[i]);
    prev.length = 0;
    for (let i = 0; i < list.length; i++) prev.push(list[i]);
  }

  destroy() {
    for (const list of this.chunks.values()) {
      for (const m of list) {
        if (!m) continue;
        m.geometry.destroy();
        m.destroy();
      }
    }
    this.chunks.clear();
  }
}
