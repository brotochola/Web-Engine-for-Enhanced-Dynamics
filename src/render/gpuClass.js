/**
 * What kind of GPU a renderer name says the page got. The name comes from WEBGL_debug_renderer_info
 * (UNMASKED_RENDERER_WEBGL, or the plain RENDERER when the browser hides it) or, on WebGPU, from the adapter's info.
 * Chrome wraps it in ANGLE's form:
 *
 *   ANGLE (Intel, Intel(R) HD Graphics 620 (0x00005916) Direct3D11 vs_5_0 ps_5_0, D3D11)
 *   ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F91) Direct3D11 vs_5_0 ps_5_0, D3D11)
 *   ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)
 *
 * The class is read from the name alone, with no benchmark at run time:
 * - 'integrated': the GPU shares the CPU's memory and power budget. That covers Intel's HD, UHD, Iris and the Arc
 *   graphics built into Core Ultra parts; AMD's APUs (Radeon Graphics, Vega, the R-series, the M parts such as 780M,
 *   Custom GPU); and NVIDIA Tegra.
 * - 'tiled': the GPU draws in tiles on chip and removes hidden surfaces itself: Apple, Mali, Immortalis, Adreno,
 *   PowerVR, VideoCore.
 * - 'software': the CPU draws (SwiftShader, llvmpipe, softpipe, Microsoft Basic Render Driver).
 * - 'discrete': a card with its own memory: NVIDIA GeForce, Quadro and RTX, AMD Radeon RX, Pro and HD, Intel Arc A or B.
 * - 'unknown': an empty or masked name, or one the rules do not know.
 *
 * E-502 reads it to keep E-448's opaque pass off where the hardware does not gain from it (opaquePass.js
 * opaquePassSuits).
 */

export const GPU_DISCRETE = 'discrete';
export const GPU_INTEGRATED = 'integrated';
export const GPU_TILED = 'tiled';
export const GPU_SOFTWARE = 'software';
export const GPU_UNKNOWN = 'unknown';

const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|basic render|software rasterizer|mesa offscreen/i;
const TILED = /\bapple\b|\bmali\b|immortalis|adreno|powervr|\bimg\b|videocore|\bv3d\b/i;
// Intel's discrete Arc cards carry a letter and three digits (A770, Pro A60, B580); the Arc graphics built into Core
// Ultra parts are "Arc(TM) Graphics" or "Arc(TM) 140V GPU".
const INTEL = /\bintel\b/i;
const INTEL_ARC_CARD = /\barc(?:\(tm\))?\s+(?:pro\s+)?[ab]\d{2,3}\b/i;
const AMD = /\bamd\b|\bati\b|radeon|xclipse/i;
// AMD's APUs: "Radeon(TM) Graphics", "Radeon Vega 8 Graphics", "Radeon R7 Graphics", "Radeon 780M Graphics",
// "Radeon 610M", the Steam Deck's "Custom GPU 0405", Samsung's Xclipse.
const AMD_APU = /radeon(?:\(tm\))?\s+(?:graphics|vega\b|r[2-7]\s+graphics|\d{3}m\b)|custom gpu|xclipse/i;
const NVIDIA = /nvidia|geforce|quadro|\brtx\b|\bgtx\b/i;
const NVIDIA_TEGRA = /tegra/i;

/**
 * The class of the GPU a renderer name names (GPU_* above).
 * @param {string|null|undefined} renderer
 * @returns {'discrete'|'integrated'|'tiled'|'software'|'unknown'}
 */
export function gpuClassOf(renderer) {
  if (typeof renderer !== 'string' || renderer === '') return GPU_UNKNOWN;
  if (SOFTWARE.test(renderer)) return GPU_SOFTWARE;
  // The desktop vendors before the tile-based names: an Intel or AMD GPU in a Mac reads "ANGLE Metal Renderer: …".
  if (INTEL.test(renderer)) return INTEL_ARC_CARD.test(renderer) ? GPU_DISCRETE : GPU_INTEGRATED;
  if (AMD.test(renderer)) return AMD_APU.test(renderer) ? GPU_INTEGRATED : GPU_DISCRETE;
  if (NVIDIA.test(renderer)) return NVIDIA_TEGRA.test(renderer) ? GPU_INTEGRATED : GPU_DISCRETE;
  if (TILED.test(renderer)) return GPU_TILED;
  return GPU_UNKNOWN;
}

/**
 * The renderer name of a WebGL context: the unmasked one where the browser gives it, else the plain RENDERER
 * (Firefox and Safari give a generalised name there), else ''.
 * @param {WebGLRenderingContext|WebGL2RenderingContext|null|undefined} gl
 * @returns {string}
 */
export function webglRendererName(gl) {
  if (!gl) return '';
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const unmasked = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
  if (typeof unmasked === 'string' && unmasked !== '') return unmasked;
  const plain = gl.getParameter(gl.RENDERER);
  return typeof plain === 'string' ? plain : '';
}
