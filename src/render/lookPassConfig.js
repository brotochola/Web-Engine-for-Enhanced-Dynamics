/**
 * DX-LAYERPASSES: a layer's look as its config writes it, for the loader, the layer's metadata and the checks at load:
 * shader.passes (several fragments, each drawn into a target the next one samples) or shader.fragment (one). The renderer's
 * side is src/render/pixi/lookPasses.js.
 */
import { LAYER_KIND, isSceneryKind } from '../util/configDefaults.js';

const NO_PASSES = Object.freeze([]);

/**
 * @param {object|null|undefined} shader the layer's shader block
 * @returns {ReadonlyArray<{ fragment: string|object, resolution?: number }>} the look's passes in order; empty: no look
 */
export function lookPassesOf(shader) {
  if (!shader) return NO_PASSES;
  if (Array.isArray(shader.passes)) return shader.passes;
  return shader.fragment ? [{ fragment: shader.fragment }] : NO_PASSES;
}

/**
 * The passes that run before the last one, as the layer's metadata carries them (the last one is the metadata's
 * shaderFragment): null where the look has one pass or none. The loader puts each one's source and name in.
 * @param {object|null|undefined} shader
 * @returns {Array<{ fragment: string|object, name: string|null, resolution: number }>|null}
 */
export function earlierPassesOf(shader) {
  const passes = lookPassesOf(shader);
  if (passes.length < 2) return null;
  return passes.slice(0, -1).map((p) => ({ fragment: p.fragment, name: null, resolution: p.resolution ?? 1 }));
}

/**
 * Thrown at load, both builds: a list of passes the layer cannot draw.
 * @param {string} layerName
 * @param {boolean} builtIn
 * @param {string} kind LAYER_KIND
 * @param {object|null|undefined} shader
 */
export function assertLookPasses(layerName, builtIn, kind, shader) {
  if (!shader || shader.passes === undefined) return;
  const bad = (why) => new Error(`WeedJS: layer "${layerName}": ${why}`);
  const passes = shader.passes;
  if (!Array.isArray(passes) || passes.length === 0) {
    throw bad('shader.passes is a list of at least one pass: passes: [{ fragment }, …].');
  }
  if (shader.fragment) throw bad('shader.passes and shader.fragment are both set: the look is one or the other.');
  if (builtIn || isSceneryKind(kind) || kind === LAYER_KIND.DECALS || kind === LAYER_KIND.SHADOWS || kind === LAYER_KIND.LIGHTING
    || shader.worldRect) {
    throw bad('shader.passes needs a look over the layer\'s own picture: a SPRITES, MESH, DENSITY, COMPUTE, GPU_PARTICLES or ' +
      'SCREEN layer, without worldRect.');
  }
  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    if (!p || !p.fragment) throw bad(`shader.passes[${i}] has no fragment.`);
    if (p.resolution === undefined) continue;
    if (i === passes.length - 1) {
      throw bad(`shader.passes[${i}].resolution: the last pass draws the layer, at the layer's resolution. Set it there.`);
    }
    if (!(p.resolution > 0 && p.resolution <= 1)) {
      throw bad(`shader.passes[${i}].resolution is ${p.resolution}: a share of the layer's size, over 0 and up to 1.`);
    }
  }
}
