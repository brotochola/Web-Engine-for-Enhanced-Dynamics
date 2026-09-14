// Shared WASM instantiate for LiquidFun L1 micros (Node).
// LTO glue: import a.b is _emscripten_get_now — stub 0 makes get_liquidfun_step_ms always 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BOX2D_DIR = path.resolve(__dirname, '../../src/box2d');
export const WASM_PATH = path.join(BOX2D_DIR, 'box2dWasm.wasm');
export const JS_PATH = path.join(BOX2D_DIR, 'box2dWasm.js');

export function parseWasmExportMap(jsSource) {
  const map = Object.create(null);
  const re = /Module\["_(\w+)"\]\s*=\s*wasmExports\["([^"]+)"\]/g;
  let m;
  while ((m = re.exec(jsSource))) {
    map[m[1]] = m[2];
  }
  return map;
}

export function instantiateBox2dWasm() {
  const wasmBuffer = fs.readFileSync(WASM_PATH);
  const jsSource = fs.readFileSync(JS_PATH, 'utf8');
  const names = parseWasmExportMap(jsSource);
  const wasmModule = new WebAssembly.Module(wasmBuffer);
  let memory = null;
  const imports = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'memory') {
      memory = new WebAssembly.Memory({ initial: 4096, maximum: 4096, shared: true });
      imports[imp.module][imp.name] = memory;
    } else if (imp.kind === 'table') {
      imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 1024, element: 'anyfunc' });
    } else if (imp.kind === 'function') {
      if (imp.module === 'a' && imp.name === 'b') {
        imports[imp.module][imp.name] = () => performance.now();
      } else {
        imports[imp.module][imp.name] = () => 0;
      }
    } else if (imp.kind === 'global') {
      imports[imp.module][imp.name] = 0;
    }
  }
  if (!memory) throw new Error('wasm memory import missing');
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const fn = (name) => {
    const exp = names[name];
    if (!exp || typeof instance.exports[exp] !== 'function') {
      throw new Error(`missing wasm export ${name} (${exp}) - rebuild box2dWasm.js`);
    }
    return instance.exports[exp];
  };
  return { fn, memory, instance };
}

export function median(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  return s[(s.length / 2) | 0];
}
