// The engine's WebAssembly kernels in one module (E-76 close-out step 4): every wasm/*.c that ships, linked by
// scripts/buildWasm.mjs into engine.wasm (wasm/modules.json's "engine"). A worker compiles it once and instantiates
// it once per memory its kernels run on (util/wasmKernel.js); each kernel's client takes its own exports from that
// instance. A kernel keeps its name in errors and comments ("preRenderEmit.wasm" is that kernel in this module).
//
// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it. This module is the only
// one that names it, so the worker bundles carry one copy (in their common chunk).
export const engineWasmUrl = new URL('./engine.wasm', import.meta.url);
