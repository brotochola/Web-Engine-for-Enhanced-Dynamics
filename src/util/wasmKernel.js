// Loads an engine WebAssembly kernel onto a shared memory (E-76 T5).
//
// A kernel module imports exactly one thing, the shared memory, and exports only its kernel
// functions (scripts/wasmKernelRules.mjs enforces it at build time). This loader holds the product
// to the same rule: it links `env.memory` and nothing else, so a module that needs another import
// fails here with its name instead of being answered by a stub that returns 0.
//
// Each module compiles once per worker, and is instantiated once per memory: the engine module (src/wasm/engine.js)
// holds every kernel, so the clients of one memory share its instance, each taking its own exports. A kernel has no
// globals and no data of its own, only the memory it imports, so sharing the instance shares nothing else.
// The callers pass the engine module's URL, the literal `new URL('./engine.wasm', import.meta.url)` in
// src/wasm/engine.js: webpack emits the asset only for that pattern, and the bundle rewrites it to a data URL
// (scripts/buildBundle.js), because a blob worker has no directory to fetch from; a gzipped one
// (data:application/gzip), which DecompressionStream inflates, as the bundle's Box2D loader does.

const compiled = new Map();
// The instances of each module (by URL), one per memory.
const instances = new Map();

function bytesFromDataUrl(href) {
  const binary = atob(href.slice(href.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function loadBytes(name, url) {
  const href = String(url);
  if (href.startsWith('data:application/gzip')) return gunzip(bytesFromDataUrl(href));
  if (href.startsWith('data:')) return bytesFromDataUrl(href);
  // Node (kernels and tests that run real workers) cannot fetch a file: URL.
  if (href.startsWith('file:') && globalThis.process?.getBuiltinModule) {
    const fs = globalThis.process.getBuiltinModule('fs');
    const { fileURLToPath } = globalThis.process.getBuiltinModule('url');
    return new Uint8Array(fs.readFileSync(fileURLToPath(href)));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name}.wasm: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The compiled module for `url`, compiled on first use in this worker. */
export function compileWasmKernel(name, url) {
  const href = String(url);
  let module = compiled.get(href);
  if (!module) {
    module = loadBytes(name, url).then((bytes) => WebAssembly.compile(bytes));
    // A failed load is not cached: the next caller tries again.
    module.catch(() => compiled.delete(href));
    compiled.set(href, module);
  }
  return module;
}

/**
 * Instantiate kernel `name` on `memory` and return the named exports.
 * @param {string} name the kernel's name, for errors (`spatialPublish`)
 * @param {URL | string} url the module's URL (src/wasm/engine.js' engineWasmUrl; a test may pass one kernel's own build)
 * @param {WebAssembly.Memory} memory the shared memory the kernel works in
 * @param {string[]} exportNames the functions the caller uses
 * @returns {Promise<Record<string, Function>>}
 */
export async function loadWasmKernel(name, url, memory, exportNames) {
  // The engine has no JavaScript path to fall back to, so a kernel that does not load stops the scene: its errors
  // name it (a CompileError or LinkError does not).
  const named = (err) => (String(err?.message).startsWith(`${name}.wasm`) ? err : new Error(`${name}.wasm: ${err?.message ?? err}`, { cause: err }));
  let module;
  try {
    module = await compileWasmKernel(name, url);
  } catch (err) {
    throw named(err);
  }
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'env' || imp.name !== 'memory' || imp.kind !== 'memory') {
      throw new Error(`${name}.wasm imports ${imp.module}.${imp.name} (${imp.kind}); a kernel may import only env.memory`);
    }
  }
  const href = String(url);
  let byMemory = instances.get(href);
  if (!byMemory) instances.set(href, (byMemory = new WeakMap()));
  let pending = byMemory.get(memory);
  if (!pending) {
    pending = WebAssembly.instantiate(module, { env: { memory } });
    // A failed instantiation is not cached either.
    pending.catch(() => byMemory.delete(memory));
    byMemory.set(memory, pending);
  }
  let instance;
  try {
    instance = await pending;
  } catch (err) {
    throw named(err);
  }
  const out = {};
  for (const exportName of exportNames) {
    const fn = instance.exports[exportName];
    if (typeof fn !== 'function') throw new Error(`${name}.wasm has no function export ${exportName}`);
    out[exportName] = fn;
  }
  return out;
}
