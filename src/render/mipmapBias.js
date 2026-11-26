/**
 * E-204: the atlas's mip levels read sharper. With renderer.autoGenerateMipmaps a sprite zoomed out reads a small level
 * instead of level 0 scattered (Predator's people at crowd 2.5 on a Radeon iGPU: 3.73 ms of GPU a frame without them),
 * but the level the GPU picks blurs it (1.26 ms, the trees' leaves gone soft). A bias of -1 reads one level up: 1.94 ms,
 * the picture close to no mip levels at all. renderer.mipmapBias sets it (0: the GPU's own level).
 *
 * The engine's shaders that draw the atlas's colour (the sprites, their additive variant, the shadows' sprites, the
 * collider and mesh fills) get the bias in their texture reads, before any program is made from them.
 */

/** The GLSL read of the atlas's colour, as the engine's fragment shaders write it. */
const GLSL_READ = /texture\(uTexture, weedUv\(\)\)/g;
/** The WGSL one: textureSample over weedUv's or meshUv's arguments (no parentheses inside them). */
const WGSL_READ = /textureSample\(uTexture, uSampler, ((?:weedUv|meshUv)\([^()]*\))\)/g;

/**
 * The bias as a float literal both languages read.
 * @param {number} bias
 * @returns {string}
 */
function biasLiteral(bias) {
  return bias.toFixed(3);
}

/**
 * One shader source with its atlas reads biased.
 * @param {string} source
 * @param {number} bias
 * @returns {string}
 */
export function mipmapBiasSource(source, bias) {
  const b = biasLiteral(bias);
  return source
    .replace(GLSL_READ, () => `texture(uTexture, weedUv(), ${b})`)
    .replace(WGSL_READ, (_, uv) => `textureSampleBias(uTexture, uSampler, ${uv}, ${b})`);
}

/**
 * Every engine shader source (the worker's _engineShaders, by name) with its atlas reads biased; a bias of 0 leaves
 * them as they are.
 * @param {Record<string, unknown>} shaders
 * @param {number} bias
 */
export function applyMipmapBias(shaders, bias) {
  if (!(bias !== 0 && Number.isFinite(bias))) return;
  for (const key of Object.keys(shaders)) {
    const source = shaders[key];
    if (typeof source === 'string') shaders[key] = mipmapBiasSource(source, bias);
  }
}
