/**
 * The shipped Box2D WASM for node tests, one instance alive at a time.
 *
 * The module imports a shared memory of 256 to 32768 pages (16 MB to 2 GB);
 * the engine picks the size per scene (physics.wasmMemoryMB). Tests get 8192
 * pages (512 MB, the engine's default) unless they pass `pages`. The memory is
 * committed up front. Test files made a new instance per test and left the old
 * ones to GC (liquidFun.wasm.test.js made 47). With four test processes in
 * parallel that took this machine's free commit from ~6 GB to 0.2 GB; then any
 * process's allocation could fail and V8 aborted it (exit 0xC0000409). Those
 * were the file-level crashes of review item N-7, in whichever test file
 * happened to allocate at that moment.
 *
 * Each call collects garbage first (an earlier test's instance is unreachable
 * once that test ended). The module is compiled once per process, and the
 * export and import maps are parsed once from the glue.
 */
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const BOX2D_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/box2d');

let wasmModule = null;
let exportNames = null;
let importNames = null;
let gc = null;

function collectGarbage() {
  if (!gc) {
    v8.setFlagsFromString('--expose-gc');
    gc = vm.runInNewContext('gc');
  }
  gc();
}

function load() {
  if (wasmModule) return;
  wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.wasm')));
  const jsSource = fs.readFileSync(path.join(BOX2D_DIR, 'box2dWasm.js'), 'utf8');
  exportNames = Object.create(null);
  for (const m of jsSource.matchAll(/Module\["_(\w+)"\]\s*=\s*wasmExports\["([^"]+)"\]/g)) {
    exportNames[m[1]] = m[2];
  }
  // The imports are minified to letters (assignWasmImports: `b: _emscripten_get_now`).
  importNames = Object.create(null);
  for (const m of jsSource.matchAll(/\/\*\* @export \*\/ (\w+): (\w+)/g)) {
    importNames[m[1]] = m[2];
  }
}

/**
 * @param {string[]} [requiredExports] fail fast when the build lacks these
 * @param {{ pages?: number }} [options] memory size in 64 KB pages (default 8192, 512 MB)
 * @returns {{ instance: WebAssembly.Instance, memory: WebAssembly.Memory,
 *   fn: (name: string) => Function, names: Record<string, string> }}
 */
export function instantiateBox2dWasm(requiredExports = [], { pages = 8192 } = {}) {
  load();
  for (const name of requiredExports) {
    if (!exportNames[name]) throw new Error(`${name} export missing - rebuild box2dWasm.js`);
  }
  collectGarbage();
  let memory = null;
  const imports = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!imports[imp.module]) imports[imp.module] = {};
    if (imp.kind === 'memory') {
      // initial === maximum, as in the engine: the memory never grows.
      memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
      imports[imp.module][imp.name] = memory;
    } else if (imp.kind === 'table') {
      imports[imp.module][imp.name] = new WebAssembly.Table({ initial: 1024, element: 'anyfunc' });
    } else if (imp.kind === 'function') {
      // The clock is real; running out of memory throws (the engine aborts with "OOM"), so a
      // test never hands Box2D a NULL; everything else is a stub returning 0.
      const glueName = importNames[imp.name];
      if (glueName === '_emscripten_get_now') {
        imports[imp.module][imp.name] = () => performance.now();
      } else if (glueName === '_emscripten_resize_heap') {
        imports[imp.module][imp.name] = (requested) => {
          throw new Error(
            `Box2D test instance ran out of memory: asked for ${requested >>> 0} bytes, has ${pages} pages`
          );
        };
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
    const exp = exportNames[name];
    const f = exp && instance.exports[exp];
    if (typeof f !== 'function') throw new Error(`missing wasm export ${name} (${exp})`);
    return f;
  };
  return { instance, memory, fn, names: exportNames };
}
