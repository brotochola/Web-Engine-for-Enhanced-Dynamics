// Structure of a WebAssembly binary, and the rules every engine kernel module obeys (E-76 T6).
//
// Kernels own no memory. Several kernel modules, in several workers, run on the same shared
// WebAssembly.Memory. A module that brought its own statics, data segments, start function or
// shadow stack would place them at the same addresses as every other module built the same way
// (REVIEW_PLAN N-62: the emcc-built spatial module kept an init flag at 1028 and its stack inside
// the shared header). So a kernel module may import exactly one thing, the shared memory, and may
// export only its kernel functions. All scratch comes in by pointer from the JS layout.
//
// Used by scripts/buildWasm.mjs (after every build and in --check) and by
// tests/node/wasmKernelRules.test.js (on the committed binaries, no toolchain needed).

const SECTION = {
  custom: 0,
  type: 1,
  import: 2,
  function: 3,
  table: 4,
  memory: 5,
  global: 6,
  export: 7,
  start: 8,
  element: 9,
  code: 10,
  data: 11,
  dataCount: 12,
  tag: 13,
};

const KIND_NAMES = ['function', 'table', 'memory', 'global', 'tag'];

function reader(bytes, start, end) {
  let pos = start;
  const u8 = () => {
    if (pos >= end) throw new Error('wasm: read past the end of a section');
    return bytes[pos++];
  };
  const uleb = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = u8();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) throw new Error('wasm: LEB128 too long');
    }
  };
  const name = () => {
    const len = uleb();
    if (pos + len > end) throw new Error('wasm: name past the end of a section');
    const s = new TextDecoder().decode(bytes.subarray(pos, pos + len));
    pos += len;
    return s;
  };
  const limits = () => {
    const flags = u8();
    const min = uleb();
    const max = flags & 0x01 ? uleb() : null;
    return { min, max, shared: (flags & 0x02) !== 0, memory64: (flags & 0x04) !== 0 };
  };
  const seek = (p) => {
    if (p > end) throw new Error('wasm: section past the end of the module');
    pos = p;
  };
  return { u8, uleb, name, limits, seek, get pos() { return pos; } };
}

/**
 * Read the parts of a module the kernel rules look at.
 * @param {Uint8Array} bytes
 */
export function readWasmStructure(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || u8[0] !== 0 || u8[1] !== 0x61 || u8[2] !== 0x73 || u8[3] !== 0x6d) {
    throw new Error('wasm: not a WebAssembly binary');
  }
  const out = {
    imports: [],
    exports: [],
    counts: {},
    hasStart: false,
    customSections: [],
    size: u8.length,
  };
  const top = reader(u8, 8, u8.length);
  while (top.pos < u8.length) {
    const id = top.u8();
    const size = top.uleb();
    const start = top.pos;
    const end = start + size;
    const r = reader(u8, start, end);
    if (id === SECTION.custom) {
      out.customSections.push(r.name());
    } else if (id === SECTION.import) {
      const n = r.uleb();
      for (let i = 0; i < n; i++) {
        const module = r.name();
        const field = r.name();
        const kind = r.u8();
        const entry = { module, field, kind: KIND_NAMES[kind] ?? `kind ${kind}` };
        if (kind === 0) entry.typeIndex = r.uleb();
        else if (kind === 1) {
          entry.refType = r.u8();
          entry.limits = r.limits();
        } else if (kind === 2) entry.limits = r.limits();
        else if (kind === 3) {
          entry.valType = r.u8();
          entry.mutable = r.u8() === 1;
        } else if (kind === 4) {
          r.u8();
          entry.typeIndex = r.uleb();
        }
        out.imports.push(entry);
      }
    } else if (id === SECTION.export) {
      const n = r.uleb();
      for (let i = 0; i < n; i++) {
        const name = r.name();
        const kind = r.u8();
        out.exports.push({ name, kind: KIND_NAMES[kind] ?? `kind ${kind}`, index: r.uleb() });
      }
    } else if (id === SECTION.start) {
      out.hasStart = true;
    } else if (id === SECTION.dataCount) {
      out.counts.dataCount = r.uleb();
    } else {
      const key = Object.keys(SECTION).find((k) => SECTION[k] === id) ?? `section ${id}`;
      out.counts[key] = size > 0 ? r.uleb() : 0;
    }
    top.seek(end);
  }
  return out;
}

/**
 * The kernel rules. Returns a list of problems; an empty list passes.
 * @param {Uint8Array} bytes
 * @param {{ exports: string[], maxMemoryPages: number, names?: boolean }} spec
 */
export function kernelRuleProblems(bytes, spec) {
  const problems = [];
  let s;
  try {
    s = readWasmStructure(bytes);
  } catch (err) {
    return [String(err.message || err)];
  }
  try {
    new WebAssembly.Module(bytes);
  } catch (err) {
    problems.push(`does not compile: ${err.message}`);
  }

  const memoryImports = s.imports.filter((i) => i.kind === 'memory');
  const others = s.imports.filter((i) => !(i.kind === 'memory' && i.module === 'env' && i.field === 'memory'));
  if (others.length) {
    problems.push(`imports other than env.memory: ${others.map((i) => `${i.module}.${i.field} (${i.kind})`).join(', ')}`);
  }
  if (memoryImports.length !== 1 || memoryImports[0].module !== 'env' || memoryImports[0].field !== 'memory') {
    problems.push('does not import exactly one memory, env.memory');
  } else {
    const lim = memoryImports[0].limits;
    if (!lim.shared) problems.push('the imported memory is not shared');
    if (lim.memory64) problems.push('the imported memory is 64-bit');
    if (lim.max !== spec.maxMemoryPages) {
      problems.push(`the imported memory's maximum is ${lim.max} pages, the manifest says ${spec.maxMemoryPages}`);
    }
  }

  const want = new Set(spec.exports);
  for (const e of s.exports) {
    if (e.kind !== 'function') problems.push(`exports a ${e.kind}: ${e.name}`);
    else if (!want.has(e.name)) problems.push(`exports a function the manifest does not list: ${e.name}`);
  }
  for (const name of want) {
    if (!s.exports.some((e) => e.kind === 'function' && e.name === name)) problems.push(`does not export ${name}`);
  }

  if (s.hasStart) problems.push('has a start function (runs on every instantiate)');
  if (s.counts.global) problems.push(`defines ${s.counts.global} global(s) (a shadow stack or statics)`);
  if (s.counts.data || s.counts.dataCount) problems.push(`has ${s.counts.data || s.counts.dataCount} data segment(s)`);
  if (s.counts.memory) problems.push('defines its own memory');
  if (s.counts.table) problems.push('defines a table');
  if (s.counts.element) problems.push('has element segments');
  if (s.counts.tag) problems.push('defines exception tags');
  if (spec.names && !s.customSections.includes('name')) problems.push('has no name section (profiles would show wasm-function[N])');
  return problems;
}
