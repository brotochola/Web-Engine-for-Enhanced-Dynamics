// Loads an engine WebAssembly kernel onto a shared memory (E-76 T5).
//
// A kernel module imports exactly one thing, the shared memory, and exports only its kernel
// functions (scripts/wasmKernelRules.mjs enforces it at build time). This loader holds the product
// to the same rule: it links `env.memory` and nothing else, so a module that needs another import
// fails here with its name instead of being answered by a stub that returns 0.
//
// Each module compiles once per worker; every instance after the first reuses the compiled module.
// Callers keep the literal `new URL('./<name>.wasm', import.meta.url)` in their own module and pass
// the URL: webpack emits the asset only for that pattern, and the bundle rewrites it to a data URL
// (scripts/buildBundle.js), because a blob worker has no directory to fetch from.

const compiled = new Map();

function bytesFromDataUrl(href) {
  const binary = atob(href.slice(href.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function loadBytes(name, url) {
  const href = String(url);
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
 * @param {string} name module name, for errors (`spatialPublish`)
 * @param {URL | string} url the module's URL, from `new URL('./<name>.wasm', import.meta.url)`
 * @param {WebAssembly.Memory} memory the shared memory the kernel works in
 * @param {string[]} exportNames the functions the caller uses
 * @returns {Promise<Record<string, Function>>}
 */
export async function loadWasmKernel(name, url, memory, exportNames) {
  const module = await compileWasmKernel(name, url);
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'env' || imp.name !== 'memory' || imp.kind !== 'memory') {
      throw new Error(`${name}.wasm imports ${imp.module}.${imp.name} (${imp.kind}); a kernel may import only env.memory`);
    }
  }
  const instance = await WebAssembly.instantiate(module, { env: { memory } });
  const out = {};
  for (const exportName of exportNames) {
    const fn = instance.exports[exportName];
    if (typeof fn !== 'function') throw new Error(`${name}.wasm has no function export ${exportName}`);
    out[exportName] = fn;
  }
  return out;
}
