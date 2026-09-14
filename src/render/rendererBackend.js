/**
 * Renderer backend ('webgl' | 'webgpu') and shader-dialect checks.
 * Error messages are full sentences for scene authors.
 */

export const RENDERER_BACKEND_WEBGL = 'webgl';
export const RENDERER_BACKEND_WEBGPU = 'webgpu';

const WGSL_RE = /@(?:vertex|fragment|compute)\b/;
const GLSL_RE = /(?:#version\s+\d+|gl_FragColor|gl_FragCoord|gl_Position|precision\s+(?:highp|mediump|lowp)\s+float|void\s+main\s*\()/;

export function dialectLabel(dialect) {
  if (dialect === 'wgsl') return 'WGSL';
  if (dialect === 'glsl') return 'GLSL';
  return 'unknown';
}

export function detectShaderDialectFromPath(path) {
  if (typeof path !== 'string' || !path) return null;
  const clean = path.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.wgsl')) return 'wgsl';
  if (clean.endsWith('.frag') || clean.endsWith('.vert') || clean.endsWith('.glsl')) return 'glsl';
  return null;
}

export function detectShaderDialectFromSource(source) {
  if (typeof source !== 'string' || !source.trim()) return null;
  const wgsl = WGSL_RE.test(source);
  const glsl = GLSL_RE.test(source);
  if (wgsl && !glsl) return 'wgsl';
  if (glsl && !wgsl) return 'glsl';
  if (wgsl && glsl) return 'wgsl';
  return null;
}

/**
 * @param {unknown} value
 * @returns {'webgl'|'webgpu'}
 */
export function normalizeRendererBackend(value) {
  if (value === undefined || value === null || value === '') {
    return RENDERER_BACKEND_WEBGPU;
  }
  if (value === RENDERER_BACKEND_WEBGL || value === RENDERER_BACKEND_WEBGPU) {
    return value;
  }
  throw new Error(
    `WeedJS: config.renderer.backend must be "webgl" or "webgpu". Got "${value}". Set renderer.backend on the scene.`
  );
}

export function pixiRendererTypeName(type, RendererType) {
  if (RendererType) {
    if (type === RendererType.WEBGPU) return 'WEBGPU';
    if (type === RendererType.WEBGL) return 'WEBGL';
  }
  if (type === 2) return 'WEBGPU';
  if (type === 1) return 'WEBGL';
  return String(type);
}

export function errorPixiTypeMismatch(backend, actualName) {
  return new Error(
    `WeedJS: This scene requested renderer.backend "${backend}", but Pixi initialized as ${actualName}.`
  );
}

export function errorMissingGpuDevice() {
  return new Error(
    'WeedJS: This scene requested renderer.backend "webgpu", but a GPUDevice is missing. Set renderer.backend to "webgl" if this machine has no WebGPU, or check GPU support.'
  );
}

export function errorShaderFetchFailed(name, path, status) {
  return new Error(
    `WeedJS: Failed to load shader asset "${name}" from ${path} (HTTP ${status}). Check static.assets.shaders.`
  );
}

export function errorLookMissing(layerName, asset) {
  return new Error(
    `WeedJS: Layer "${layerName}" look shader "${asset}" was not loaded. Add it to static.assets.shaders.`
  );
}

export function errorComputeMissing(layerName, asset) {
  return new Error(
    `WeedJS: Layer "${layerName}" compute shader "${asset}" was not loaded. Add it to static.assets.shaders.`
  );
}

export function errorWebglCompute(layerName) {
  return new Error(
    `WeedJS: Layer "${layerName}" uses a compute shader, which requires WebGPU. This scene has renderer.backend "webgl". Set renderer.backend to "webgpu", or remove shader.compute from that layer.`
  );
}

export function errorPathBodyMismatch(asset, path, extDialect, bodyDialect) {
  return new Error(
    `WeedJS: Shader asset "${asset}" at ${path} does not match its contents (file looks like ${dialectLabel(extDialect)}, source looks like ${dialectLabel(bodyDialect)}). Fix the file or the path.`
  );
}

export function errorLookWrongBackend(layerName, asset, path, dialect, backend) {
  if (dialect === 'wgsl' && backend === RENDERER_BACKEND_WEBGL) {
    return new Error(
      `WeedJS: Layer "${layerName}" look shader "${asset}" is WGSL (${path}), but renderer.backend is "webgl". Point that asset at a .frag GLSL file, or set renderer.backend to "webgpu".`
    );
  }
  if (dialect === 'glsl' && backend === RENDERER_BACKEND_WEBGPU) {
    return new Error(
      `WeedJS: Layer "${layerName}" look shader "${asset}" is GLSL (${path}), but renderer.backend is "webgpu". Point that asset at a .wgsl file, or set renderer.backend to "webgl".`
    );
  }
  return new Error(
    `WeedJS: Layer "${layerName}" look shader "${asset}" (${path}) is not compatible with renderer.backend "${backend}".`
  );
}

export function errorComputeNotWgsl(layerName, asset, path) {
  return new Error(
    `WeedJS: Layer "${layerName}" compute shader "${asset}" must be WGSL. Got GLSL (${path}). Compute shaders only run on WebGPU.`
  );
}

export function errorCompileFailed(kind, asset, layerName, backendLabel, original) {
  const orig = original && original.message ? original.message : String(original || 'unknown error');
  return new Error(
    `WeedJS: Failed to compile ${kind} shader "${asset}" for layer "${layerName}" on ${backendLabel}: ${orig}`
  );
}

export function resolveShaderPath(asset, shaderAssets) {
  if (shaderAssets && typeof shaderAssets[asset] === 'string') return shaderAssets[asset];
  if (typeof asset === 'string' && (asset.includes('/') || asset.includes('.'))) return asset;
  return asset;
}

/**
 * Resolve dialect from path then body. Throws on path/body mismatch.
 * @returns {'wgsl'|'glsl'|null}
 */
export function resolveShaderDialect(asset, path, source) {
  const extDialect = detectShaderDialectFromPath(path);
  const bodyDialect = detectShaderDialectFromSource(source);
  if (extDialect && bodyDialect && extDialect !== bodyDialect) {
    throw errorPathBodyMismatch(asset, path, extDialect, bodyDialect);
  }
  return extDialect || bodyDialect;
}

export function collectComputeAssetNames(shader) {
  const names = [];
  const raw = shader?.compute;
  if (!raw) return names;
  if (typeof raw === 'string') {
    names.push(raw);
    return names;
  }
  if (typeof raw.source === 'string') names.push(raw.source);
  const passes = Array.isArray(raw.passes) ? raw.passes : [];
  for (let i = 0; i < passes.length; i++) {
    const src = passes[i]?.source;
    if (typeof src === 'string') names.push(src);
  }
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < names.length; i++) {
    if (seen[names[i]]) continue;
    seen[names[i]] = 1;
    out.push(names[i]);
  }
  return out;
}

export function assertSceneRendererConfig(config) {
  const backend = normalizeRendererBackend(config?.renderer?.backend);
  const layers = config?.layers;
  if (backend === RENDERER_BACKEND_WEBGL && layers) {
    for (const name of Object.keys(layers)) {
      if (layers[name]?.shader?.compute) {
        throw errorWebglCompute(name);
      }
    }
  }
  return backend;
}

export function assertLookShaderCompatible({ backend, layerName, asset, path, source }) {
  const dialect = resolveShaderDialect(asset, path, source);
  if (!dialect) {
    throw new Error(
      `WeedJS: Layer "${layerName}" look shader "${asset}" (${path}) could not be identified as GLSL or WGSL. Use a .frag file on WebGL or a .wgsl file on WebGPU.`
    );
  }
  if (backend === RENDERER_BACKEND_WEBGL && dialect !== 'glsl') {
    throw errorLookWrongBackend(layerName, asset, path, dialect, backend);
  }
  if (backend === RENDERER_BACKEND_WEBGPU && dialect !== 'wgsl') {
    throw errorLookWrongBackend(layerName, asset, path, dialect, backend);
  }
  return dialect;
}

export function assertComputeShaderCompatible({ layerName, asset, path, source }) {
  const dialect = resolveShaderDialect(asset, path, source);
  if (dialect !== 'wgsl') {
    throw errorComputeNotWgsl(layerName, asset, path || asset);
  }
  return dialect;
}

/**
 * After shader assets are fetched: look dialect vs backend, compute must be WGSL.
 */
export function assertLoadedShadersCompatible({ backend, layers, shaderAssets, loadedSources }) {
  if (!layers) return;
  const assets = shaderAssets || {};
  const loaded = loadedSources || {};
  for (const layerName of Object.keys(layers)) {
    const shader = layers[layerName]?.shader;
    if (!shader) continue;
    const look = shader.fragment;
    if (look) {
      const path = resolveShaderPath(look, assets);
      const source = loaded[look];
      if (!source) throw errorLookMissing(layerName, look);
      assertLookShaderCompatible({ backend, layerName, asset: look, path, source });
    }
    if (shader.compute) {
      const names = collectComputeAssetNames(shader);
      for (let i = 0; i < names.length; i++) {
        const asset = names[i];
        const path = resolveShaderPath(asset, assets);
        const source = loaded[asset];
        if (!source) throw errorComputeMissing(layerName, asset);
        assertComputeShaderCompatible({ layerName, asset, path, source });
      }
    }
  }
}
