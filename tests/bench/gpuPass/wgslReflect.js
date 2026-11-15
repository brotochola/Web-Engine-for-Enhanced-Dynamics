/**
 * What the GPU pass bench needs to know about the engine's WGSL to drive it without Pixi: its uniform structs laid out by
 * WGSL's alignment rules, its group and binding declarations, and an entry point's vertex inputs. Read from the source
 * text, so a shader that gains a uniform, a binding or an attribute is still driven (the bench fills what it does not
 * know with zeros).
 */

const SCALARS = { f32: 'f', i32: 'i', u32: 'u' };

/** WGSL's shorthand aliases (vec4f, mat3x3f) in their long form. */
function longType(type) {
  const t = type.replace(/\s+/g, '');
  const vec = /^vec([234])([fiu])$/.exec(t);
  if (vec) return `vec${vec[1]}<${vec[2] === 'f' ? 'f32' : vec[2] === 'i' ? 'i32' : 'u32'}>`;
  const mat = /^mat([234])x([234])f$/.exec(t);
  if (mat) return `mat${mat[1]}x${mat[2]}<f32>`;
  return t;
}

/**
 * Size, alignment and kind of a WGSL type in the uniform address space.
 * @returns {{ size: number, align: number, kind: string, n?: number, cols?: number, rows?: number, colStride?: number,
 *   scalar?: string, elem?: object, count?: number, stride?: number, struct?: string }}
 */
export function typeInfo(type, structs = {}) {
  const t = longType(type);
  if (SCALARS[t]) return { size: 4, align: 4, kind: 'scalar', n: 1, scalar: SCALARS[t] };
  const vec = /^vec([234])<(f32|i32|u32)>$/.exec(t);
  if (vec) {
    const n = Number(vec[1]);
    return { size: 4 * n, align: n === 2 ? 8 : 16, kind: 'vector', n, scalar: SCALARS[vec[2]] };
  }
  const mat = /^mat([234])x([234])<f32>$/.exec(t);
  if (mat) {
    const cols = Number(mat[1]);
    const rows = Number(mat[2]);
    const colStride = rows === 2 ? 8 : 16;
    return { size: cols * colStride, align: colStride, kind: 'matrix', cols, rows, colStride, scalar: 'f' };
  }
  const arr = /^array<(.+),(\d+)u?>$/.exec(t);
  if (arr) {
    const elem = typeInfo(arr[1], structs);
    const count = Number(arr[2]);
    // Uniform arrays round their element stride up to 16.
    const stride = Math.ceil(Math.max(elem.size, elem.align) / 16) * 16;
    return { size: stride * count, align: Math.max(16, elem.align), kind: 'array', elem, count, stride };
  }
  if (structs[t]) {
    const layout = layoutStruct(structs, t);
    return { size: layout.size, align: Math.ceil(layout.align / 16) * 16, kind: 'struct', struct: t };
  }
  throw new Error(`gpuPassBench: WGSL type ${type} is not one the bench can lay out`);
}

/** The source without comments: line comments, and block comments (which the engine's WGSL does not use, but may). */
export function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every `struct Name { field: type, ... }`, its fields in order (attributes dropped). */
export function parseStructs(code) {
  const text = stripComments(code);
  const structs = {};
  // Fields split on the commas outside angle brackets (array<vec4<f32>, 4> is one field).
  const split = (body) => {
    const parts = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '<') depth++;
      else if (body[i] === '>') depth--;
      else if (body[i] === ',' && depth === 0) {
        parts.push(body.slice(from, i));
        from = i + 1;
      }
    }
    parts.push(body.slice(from));
    return parts;
  };
  for (const m of text.matchAll(/struct\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
    const fields = [];
    for (const raw of split(m[2])) {
      const field = raw.replace(/@\w+(\([^)]*\))?/g, '').trim();
      if (!field) continue;
      const colon = field.indexOf(':');
      if (colon < 0) continue;
      fields.push({ name: field.slice(0, colon).trim(), type: field.slice(colon + 1).trim() });
    }
    structs[m[1]] = fields;
  }
  return structs;
}

/**
 * A struct's layout in the uniform address space.
 * @returns {{ size: number, align: number, fields: { name: string, type: string, offset: number, info: object }[] }}
 */
export function layoutStruct(structs, name) {
  const fields = structs[name];
  if (!fields) throw new Error(`gpuPassBench: no WGSL struct ${name}`);
  let offset = 0;
  let align = 4;
  const out = [];
  for (const f of fields) {
    const info = typeInfo(f.type, structs);
    offset = Math.ceil(offset / info.align) * info.align;
    out.push({ name: f.name, type: f.type, offset, info });
    offset += info.size;
    if (info.align > align) align = info.align;
  }
  return { size: Math.ceil(offset / align) * align, align, fields: out };
}

/**
 * Every `@group(g) @binding(b) var<space> name: type;`, sorted by group then binding.
 * @returns {{ group: number, binding: number, space: string, name: string, type: string, kind: string }[]}
 */
export function parseBindings(code) {
  const text = stripComments(code);
  const out = [];
  for (const m of text.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<([^>]+)>)?\s+(\w+)\s*:\s*([^;]+);/g)) {
    const space = (m[3] || '').replace(/\s+/g, '');
    const type = m[5].trim();
    let kind = 'unknown';
    if (space === 'uniform') kind = 'uniform';
    else if (space.startsWith('storage')) kind = space.includes('read_write') ? 'storage' : 'read-only-storage';
    else if (/^texture_depth/.test(type)) kind = 'depthTexture';
    else if (/^texture_2d/.test(type)) kind = 'texture';
    else if (type === 'sampler_comparison') kind = 'comparisonSampler';
    else if (type === 'sampler') kind = 'sampler';
    out.push({ group: Number(m[1]), binding: Number(m[2]), space, name: m[4], type, kind });
  }
  out.sort((a, b) => (a.group - b.group) || (a.binding - b.binding));
  return out;
}

/** The parameter list of `fn entry(...)`, up to its closing parenthesis. */
function entryParams(text, entry) {
  const head = new RegExp(`fn\\s+${entry}\\s*\\(`).exec(text);
  if (!head) throw new Error(`gpuPassBench: no WGSL entry point ${entry}`);
  let depth = 1;
  let i = head.index + head[0].length;
  const from = i;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
  }
  return text.slice(from, i - 1);
}

/**
 * An entry point's `@location(n) name: type` inputs (builtins left out).
 * @returns {{ location: number, name: string, type: string, format: string, floats: number }[]}
 */
export function parseVertexInputs(code, entry) {
  const params = entryParams(stripComments(code), entry);
  const out = [];
  for (const m of params.matchAll(/@location\((\d+)\)\s*(?:@interpolate\([^)]*\)\s*)?(\w+)\s*:\s*([\w<>]+)/g)) {
    const type = longType(m[3]);
    const info = typeInfo(type);
    const base = info.scalar === 'f' ? 'float32' : info.scalar === 'i' ? 'sint32' : 'uint32';
    const n = info.n || 1;
    out.push({ location: Number(m[1]), name: m[2], type, format: n === 1 ? base : `${base}x${n}`, floats: n });
  }
  return out.sort((a, b) => a.location - b.location);
}

/** Whether the source samples texture `name` with a sampler (textureSample*): its binding must be filterable. */
export function isSampled(code, name) {
  return new RegExp(`textureSample\\w*\\s*\\(\\s*${name}\\b`).test(stripComments(code));
}

/** The fragment entry's colour outputs: 1, or the locations of the struct it returns. */
export function fragmentTargets(code, entry) {
  const text = stripComments(code);
  const m = new RegExp(`fn\\s+${entry}\\s*\\([^)]*\\)\\s*->\\s*([^{]+)\\{`).exec(text);
  if (!m) throw new Error(`gpuPassBench: no WGSL fragment entry ${entry}`);
  const ret = m[1].trim();
  if (/^@location/.test(ret)) return 1;
  const structs = parseStructs(code);
  const name = ret.replace(/@\w+(\([^)]*\))?/g, '').trim();
  const fields = structs[name];
  if (!fields) return 1;
  // Locations are the struct's; parseStructs drops attributes, so count them from the source.
  const body = new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\}`).exec(text);
  return body ? (body[1].match(/@location\(/g) || []).length : 1;
}

/**
 * Writes `values` (by field name) into a uniform buffer laid out as `layout`. Missing fields stay 0. A mat3x3 value is
 * Pixi's 9 floats, column by column. `intBits`: 'exact' writes an i32 field as the integer (the vendored Pixi's uniform
 * sync: dataInt32[offset] = v), 'float' as a float's bits (what pixiWorker's uConeCount note says Pixi once did).
 * @returns {ArrayBuffer}
 */
export function packUniforms(layout, values, intBits = 'exact') {
  const size = Math.max(16, Math.ceil(layout.size / 16) * 16);
  const buffer = new ArrayBuffer(size);
  const f32 = new Float32Array(buffer);
  const i32 = new Int32Array(buffer);
  const u32 = new Uint32Array(buffer);
  for (const field of layout.fields) {
    const v = values[field.name];
    if (v === undefined || v === null) continue;
    const at = field.offset / 4;
    const info = field.info;
    const put = (k, x) => {
      if (info.scalar === 'i' && intBits === 'exact') i32[at + k] = x | 0;
      else if (info.scalar === 'u' && intBits === 'exact') u32[at + k] = x >>> 0;
      else f32[at + k] = x;
    };
    if (info.kind === 'scalar') put(0, typeof v === 'number' ? v : v[0]);
    else if (info.kind === 'vector') for (let k = 0; k < info.n; k++) put(k, v[k] ?? 0);
    else if (info.kind === 'matrix') {
      for (let c = 0; c < info.cols; c++) {
        for (let r = 0; r < info.rows; r++) f32[at + (c * info.colStride) / 4 + r] = v[c * info.rows + r] ?? 0;
      }
    }
  }
  return buffer;
}
