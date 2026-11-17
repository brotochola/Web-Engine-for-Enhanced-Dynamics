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
 * E-502 reads the class and the maker (gpuVendorOf) to keep E-448's opaque pass off where the hardware does not gain
 * from it (opaquePass.js opaquePassSuits). DX-IGPUWARN hands them to the game as scene.gpu, with one warning on an
 * integrated GPU.
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

/** The GPU makers gpuVendorOf tells apart, by the names WebGPU's adapter info gives them (GPUAdapterInfo.vendor). */
export const GPU_VENDOR_INTEL = 'intel';
export const GPU_VENDOR_AMD = 'amd';
export const GPU_VENDOR_NVIDIA = 'nvidia';

const VENDORS = [
  [INTEL, GPU_VENDOR_INTEL],
  [AMD, GPU_VENDOR_AMD],
  [NVIDIA, GPU_VENDOR_NVIDIA],
  [/\bapple\b/i, 'apple'],
  [/\bmali\b|immortalis|\barm\b/i, 'arm'],
  [/adreno|qualcomm/i, 'qualcomm'],
  [/powervr|\bimg\b|imagination/i, 'imagination'],
  [/videocore|\bv3d\b|broadcom/i, 'broadcom'],
];

/**
 * The maker of the GPU a renderer name names, in WebGPU's spelling ('intel', 'amd', 'nvidia', 'apple', 'arm',
 * 'qualcomm', 'imagination', 'broadcom'), or '' (software renderers, unknown names). Checked in that order, as
 * gpuClassOf: an Intel or AMD GPU in a Mac names Apple's Metal too.
 * @param {string|null|undefined} renderer
 * @returns {string}
 */
export function gpuVendorOf(renderer) {
  if (typeof renderer !== 'string' || renderer === '' || SOFTWARE.test(renderer)) return '';
  for (const [pattern, vendor] of VENDORS) if (pattern.test(renderer)) return vendor;
  return '';
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

/**
 * The name of a WebGPU adapter (GPUAdapterInfo): those of its vendor, architecture, device and description it gives,
 * e.g. "intel gen-9". Chrome leaves the description empty unless its developer features are on.
 * @param {{ vendor?: string, architecture?: string, device?: string, description?: string }|null|undefined} info
 * @returns {string}
 */
export function webgpuAdapterName(info) {
  if (!info) return '';
  const parts = [info.vendor, info.architecture, info.device, info.description];
  return parts.filter((part) => typeof part === 'string' && part !== '').join(' ');
}

// WebGPU adapters' vendors (GPUAdapterInfo.vendor, lower case) whose GPUs draw in tiles.
const ADAPTER_TILED = /^(?:apple|arm|qualcomm|imagination|img-tec|broadcom)$/;
// Intel's discrete architectures: Xe-HPG (Arc A), Xe2-HPG (Arc B), Xe-HP.
const ADAPTER_INTEL_CARD = /hpg|12hp/;

/**
 * The class of a WebGPU adapter's GPU (GPU_* above): from its description when that names one, else from its vendor
 * and architecture. AMD's APUs and cards share architectures (RDNA 2 is both a 680M and an RX 6600), so an AMD adapter
 * without a description is unknown.
 * @param {{ vendor?: string, architecture?: string, description?: string, isFallbackAdapter?: boolean }|null|undefined} info
 * @returns {'discrete'|'integrated'|'tiled'|'software'|'unknown'}
 */
export function gpuClassOfAdapter(info) {
  if (!info) return GPU_UNKNOWN;
  if (info.isFallbackAdapter === true) return GPU_SOFTWARE;
  const byDescription = gpuClassOf(info.description);
  if (byDescription !== GPU_UNKNOWN) return byDescription;
  const vendor = typeof info.vendor === 'string' ? info.vendor.toLowerCase() : '';
  const architecture = typeof info.architecture === 'string' ? info.architecture.toLowerCase() : '';
  if (architecture === 'swiftshader' || vendor === 'microsoft') return GPU_SOFTWARE;
  if (vendor === 'intel') return ADAPTER_INTEL_CARD.test(architecture) ? GPU_DISCRETE : GPU_INTEGRATED;
  if (vendor === 'nvidia') return GPU_DISCRETE;
  if (ADAPTER_TILED.test(vendor)) return GPU_TILED;
  return GPU_UNKNOWN;
}

/**
 * The name, maker and class of a WebGPU adapter's GPU. Where its info does not tell the class (an AMD adapter without a
 * description: GCN and RDNA are APUs and cards alike), the name a WebGL context gives is read instead (`readWebglName`,
 * called only then) and taken when it names the adapter's vendor.
 * @param {{ vendor?: string, architecture?: string, device?: string, description?: string }|null|undefined} info
 * @param {() => string} readWebglName
 * @returns {{ name: string, vendor: string, kind: string }}
 */
export function webgpuGpu(info, readWebglName) {
  const name = webgpuAdapterName(info);
  const kind = gpuClassOfAdapter(info);
  const vendor = typeof info?.vendor === 'string' ? info.vendor.toLowerCase() : '';
  if (kind !== GPU_UNKNOWN || vendor === '') return { name, vendor, kind };
  const webglName = readWebglName();
  if (typeof webglName !== 'string' || !webglName.toLowerCase().includes(vendor)) return { name, vendor, kind };
  return { name: webglName, vendor, kind: gpuClassOf(webglName) };
}

/**
 * The renderer name of a throwaway WebGL 2 context on an OffscreenCanvas, lost at once ('' without one).
 * @returns {string}
 */
export function offscreenWebglRendererName() {
  if (typeof OffscreenCanvas !== 'function') return '';
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
  if (!gl) return '';
  const name = webglRendererName(gl);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}
