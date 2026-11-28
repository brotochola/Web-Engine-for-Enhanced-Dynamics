/**
 * DX-LAYERPASSES: the passes of a layer's look that run before its last one. The last pass is the look as it was with one
 * fragment (lookShaders.js: the custom layers draw it into rtOut or on the stage, the SCREEN layers into the next one's
 * input or onto the canvas). Each pass before it draws the full-screen mesh into a target of its own, at its resolution of
 * the layer's size, and the next one samples that target (uTexture). uSource is, in any of them, what the first one read:
 * the layer's own picture, or the frame under a SCREEN layer. Every target is laid out as that picture (no V flip).
 *
 * The owner of the passes is a custom layer's record (customLayers.js) or a SCREEN layer's (screenLayers.js): it carries
 * `earlierPasses` (null: a one-pass look, whose draw is untouched), `shader` (the last pass's), `scaleMode` and
 * `sharesTargets`.
 *
 * E-525: the targets look draws take turns on (takeTarget, giveTarget). A sprite or density look layer's picture
 * (customLayers.js, cl.rt) is cleared and read by its look in the pass that draws it, an earlier pass's target by the pass
 * after it, a SCREEN pass's output by the next SCREEN pass: layers of one size draw one after the other into one target
 * where each had its own (8.3 MB a target at 1920 x 1080). A slot says which of the targets of a size a draw takes, so
 * that a draw never reads what it draws into: 0 a layer's picture and the SCREEN chain's first output, 1 and 2 the
 * earlier passes in turn, 3 the SCREEN chain's second output. An owner whose passes' targets are read later in the frame
 * (a MESH layer's look on the stage) keeps targets of its own (`sharesTargets` false). A canvas resize gives the old
 * size's back and takes the new one's (customLayers.resizeRTs; the SCREEN chain at its next present). A lost WebGL context
 * or WebGPU device restarts the scene with new workers (N-301): the shared targets go with the old renderer.
 */
import { Layer } from '../../core/layer.js';
import { RenderTexture, Texture } from '../../vendor/pixi.min.js';
import { errorCompileFailed } from '../rendererBackend.js';
import { rtPixelSize } from '../gpuShadowCasters.js';
import { applyEngineLookUniforms, applyTexelSizeUniform, copyLookUniforms, setLookUniform2 } from './layerHelpers.js';

const READS_SCENE = /\buScene\b/;
const READS_SOURCE = /\buSource\b/;
const READS_GBUF = /\buGbuf(Face|Ids)\b/;

/**
 * What a look's source reads besides uTexture: uScene and the G-buffer (a SCREEN layer's), uSource (a look in several
 * passes).
 * @param {string} source
 * @param {boolean} screen a SCREEN layer's
 * @param {boolean} inPasses the look has more than one pass
 * @returns {{ scene: boolean, source: boolean, gbuf: boolean }}
 */
export function lookReads(source, screen, inPasses) {
  const text = typeof source === 'string' ? source : '';
  return {
    scene: screen && READS_SCENE.test(text),
    source: inPasses && READS_SOURCE.test(text),
    gbuf: screen && READS_GBUF.test(text),
  };
}

/** The textures a look is created with, besides uTexture: empty until a frame binds them. */
export function emptyLookTextures(reads) {
  const empty = Texture.EMPTY.source;
  return { scene: reads.scene ? empty : null, source: reads.source ? empty : null, gbuf: reads.gbuf };
}

/** The looks' earlier passes, for one renderer worker. */
export class PixiLookPasses {
  /** @param {object} worker the PixiRenderer that owns this (its renderer and look shaders) */
  constructor(worker) {
    this.worker = worker;
    // E-525: the shared targets, each { rt, width, height, slot, holders }: made on the first take, destroyed when the last
    // holder gives it back.
    this.shared = [];
  }

  /**
   * E-525: the shared target of width x height in `slot`, made if there is none; the caller holds it until giveTarget.
   * width and height are compared as given: a caller asks for the size it would have made.
   * @returns {RenderTexture}
   */
  takeTarget(width, height, slot) {
    const shared = this.shared;
    for (let i = 0; i < shared.length; i++) {
      const e = shared[i];
      if (e.slot === slot && e.width === width && e.height === height) {
        e.holders++;
        return e.rt;
      }
    }
    const rt = RenderTexture.create({ width, height });
    shared.push({ rt, width, height, slot, holders: 1 });
    return rt;
  }

  /**
   * E-525: a shared target given back by one holder; the last one's destroys it. Each holder takes its own draws off it
   * first (unbind); a SCREEN pass that read it without holding it is unbound by its chain (screenLayers.js).
   */
  giveTarget(rt) {
    const shared = this.shared;
    for (let i = 0; i < shared.length; i++) {
      const e = shared[i];
      if (e.rt !== rt) continue;
      if (--e.holders > 0) return;
      shared.splice(i, 1);
      this.worker._releaseTextureBindGroups(rt);
      rt.destroy(true);
      return;
    }
  }

  /**
   * A layer's earlier passes made from its metadata, or null when its look has one.
   * @param {object} config the layer's worker metadata
   * @param {boolean} screen a SCREEN layer's
   */
  make(config, screen) {
    const list = config.shaderEarlier;
    if (!list || list.length === 0) return null;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const name = list[i].name || config.name;
      const reads = lookReads(list[i].fragment, screen, true);
      const defs = this.worker.lookShaders.buildUniformDefs(config.id, config.uniformMap, config.uniformTypes);
      let shader;
      try {
        shader = this.worker.lookShaders.create(list[i].fragment, Texture.EMPTY.source, defs, name, config.name,
          emptyLookTextures(reads));
      } catch (err) {
        if (err && typeof err.message === 'string' && err.message.startsWith('WeedJS:')) throw err;
        throw errorCompileFailed('look', name, config.name, this.worker._useWebGpu ? 'WebGPU' : 'WebGL', err);
      }
      out.push({
        layerId: config.id,
        shader,
        uniformStore: shader.resources?.customUniforms?.uniforms || null,
        mesh: this.worker.lookShaders.makeMesh(shader, false),
        resolution: list[i].resolution,
        reads,
        target: null,
      });
    }
    return out;
  }

  /** The layer's uniforms, changed from any thread, in every earlier pass (the last one's are the owner's). */
  syncUniforms(owner, entries, floats) {
    const passes = owner.earlierPasses;
    if (passes === null) return;
    for (let i = 0; i < passes.length; i++) copyLookUniforms(entries, floats, passes[i].uniformStore);
  }

  /**
   * Draws the owner's earlier passes, each into its target, and binds the last pass's inputs (uTexture: what the last of
   * them drew; uSource). Without them, nothing: the owner's look keeps the input it has.
   * @param {object} owner the layer's record: earlierPasses, shader, scaleMode
   * @param {object} source the TextureSource the first pass reads
   * @param {number} width the layer's size in pixels, which the passes' resolutions are shares of
   * @param {number} height
   */
  draw(owner, source, width, height) {
    const passes = owner.earlierPasses;
    if (passes === null) return;
    const worker = this.worker;
    const opts = worker._rtRenderOpts;
    const mode = Layer.scaleModeString(Layer._normalizeScaleMode(owner.scaleMode));
    let input = source;
    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i];
      pass.target = this._target(owner, pass, i, rtPixelSize(width, pass.resolution), rtPixelSize(height, pass.resolution));
      const out = pass.target.source;
      if (out.scaleMode !== mode) out.scaleMode = mode;
      this.bind(pass.shader, input, pass.reads.source ? source : null);
      applyEngineLookUniforms(pass, worker._computeFrame);
      applyTexelSizeUniform(pass, input);
      if (owner.compute) {
        setLookUniform2(Layer._uniformMaps[pass.layerId] || {}, null, pass.uniformStore, 'uTexSize', owner.compute.numX,
          owner.compute.numY);
      }
      opts.transform = null;
      opts.container = pass.mesh;
      opts.target = pass.target;
      opts.clear = true;
      opts.clearColor = worker._clearTransparent;
      worker._submitRender(opts);
      input = out;
    }
    this.bind(owner.shader, input, owner.reads.source ? source : null);
  }

  /** A look's uTexture (with its sampler on WebGPU) and, when it reads it, uSource. */
  bind(shader, input, source) {
    const res = shader.resources;
    if (res.uTexture !== input) res.uTexture = input;
    if (res.uSampler !== undefined && res.uSampler !== input.style) res.uSampler = input.style;
    if (source !== null && res.uSource !== source) res.uSource = source;
  }

  /** The picture the owner's first pass read is about to go (a resize): the passes let go of it and of their targets. */
  unbind(owner) {
    const passes = owner.earlierPasses;
    if (passes === null) return;
    const empty = Texture.EMPTY.source;
    for (let i = 0; i < passes.length; i++) {
      this.worker.lookShaders.unbindTexture(passes[i].shader);
      if (passes[i].reads.source) passes[i].shader.resources.uSource = empty;
    }
    if (owner.shader) {
      this.worker.lookShaders.unbindTexture(owner.shader);
      if (owner.reads.source) owner.shader.resources.uSource = empty;
    }
  }

  /** The owner's earlier passes destroyed (a scene's end, or a look swapped for one fragment). */
  destroy(owner) {
    const passes = owner.earlierPasses;
    if (passes === null) return;
    this.unbind(owner);
    for (let i = 0; i < passes.length; i++) {
      if (passes[i].target) this._letGo(owner, passes[i].target);
      passes[i].mesh.destroy(true);
    }
    owner.earlierPasses = null;
  }

  /**
   * The `index`th pass's target of width x height: the one it has when it is that size, else another (the old one unbound
   * first). E-525: one of the shared ones, slots 1 and 2 in turn (each pass reads the one before it and the owner's
   * picture, slot 0), when the owner's look reads them in the pass that draws them.
   */
  _target(owner, pass, index, width, height) {
    const rt = pass.target;
    if (rt && rt.width === width && rt.height === height) return rt;
    if (rt) {
      this.unbind(owner);
      this._letGo(owner, rt);
    }
    return owner.sharesTargets ? this.takeTarget(width, height, 1 + (index & 1)) : RenderTexture.create({ width, height });
  }

  /** A pass's target let go of: a shared one given back, one of the owner's own destroyed. */
  _letGo(owner, rt) {
    if (owner.sharesTargets) {
      this.giveTarget(rt);
      return;
    }
    this.worker._releaseTextureBindGroups(rt);
    rt.destroy(true);
  }
}
