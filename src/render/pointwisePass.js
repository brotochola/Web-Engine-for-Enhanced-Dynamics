/**
 * DX-POSTFUSE: SCREEN passes that only map their pixel's colour (shader.pointwise), generated into one fragment shader. A
 * game writes the map and nothing else: `vec4 weedPass(vec4 color, vec2 uv)` in GLSL, `fn weedPass(color: vec4f, uv: vec2f)
 * -> vec4f` in WGSL. Consecutive ones become one full-screen draw that reads the frame once, so a chain of n costs one
 * full-screen read and write instead of n.
 *
 * Each source's own names (functions, constants, its uniforms) get a suffix, so two layers may use the same ones; the
 * engine's look uniforms (uTime, uCanvasSize, …) are the same for every pass and keep theirs. The result is a look as any
 * other (lookShaders.js): GLSL ES 1.00, or WGSL without the prelude. No Pixi and no GPU here: tests/node/pointwisePass.test.js.
 */

/** What a pointwise source may not read: it maps a colour it is given. */
const READS_ELSEWHERE = /\b(uTexture|uScene|uSource|uGbufFace|uGbufIds|texture2D|textureSample\w*|textureLoad|gl_FragColor|gl_FragCoord)\b/;
const GLSL_HAS_MAIN = /\bvoid\s+main\s*\(/;
const WGSL_HAS_ENTRY = /@(fragment|vertex|compute)\b/;
const GLSL_PASS = /\bvec4\s+weedPass\s*\(\s*(?:in\s+)?vec4\s+\w+\s*,\s*(?:in\s+)?vec2\s+\w+\s*\)/;
const WGSL_PASS = /\bfn\s+weedPass\s*\(\s*\w+\s*:\s*vec4(?:f|<\s*f32\s*>)\s*,\s*\w+\s*:\s*vec2(?:f|<\s*f32\s*>)\s*\)\s*->\s*vec4(?:f|<\s*f32\s*>)/;

/** The source with its comments blanked out (same length, its line breaks kept), for reading its declarations. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** The source with everything inside braces blanked out: what is declared at its top level. */
function topLevel(source) {
  let depth = 0;
  let out = '';
  for (const ch of withoutComments(source)) {
    if (ch === '}') depth--;
    out += depth > 0 && ch !== '\n' ? ' ' : ch;
    if (ch === '{') depth++;
  }
  return out;
}

/**
 * Why a source cannot be a pointwise pass, or null.
 * @param {string} source
 * @param {boolean} wgsl
 * @returns {string|null}
 */
export function pointwiseProblem(source, wgsl) {
  const code = withoutComments(source);
  const found = (wgsl ? WGSL_PASS : GLSL_PASS).test(code);
  if (!found) {
    return wgsl ? 'it has no fn weedPass(color: vec4f, uv: vec2f) -> vec4f' : 'it has no vec4 weedPass(vec4 color, vec2 uv)';
  }
  if (wgsl ? WGSL_HAS_ENTRY.test(code) : GLSL_HAS_MAIN.test(code)) return 'it has an entry point of its own: weedPass is the pass, the engine writes the rest';
  const m = READS_ELSEWHERE.exec(code);
  if (m) return `it names ${m[1]}: a pointwise pass maps the colour it is given and samples nothing`;
  return null;
}

/** Names declared at the top level of a GLSL source that the engine does not declare itself. */
function glslNames(source) {
  const top = topLevel(source);
  const names = new Set();
  for (const m of top.matchAll(/\buniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)/g)) names.add(m[1]);
  // A global without const: `vec3 acc;` or `float k = 1.0;`.
  for (const m of top.matchAll(/(?:^|[;}\n])\s*\w+\s+(\w+)\s*[=;]/g)) names.add(m[1]);
  for (const m of top.matchAll(/\bconst\s+(?:\w+\s+)?\w+\s+(\w+)\s*=/g)) names.add(m[1]);
  for (const m of top.matchAll(/(?:^|[;}\n])\s*(?:(?:lowp|mediump|highp)\s+)?\w+\s+(\w+)\s*\(/g)) names.add(m[1]);
  for (const m of top.matchAll(/\bstruct\s+(\w+)/g)) names.add(m[1]);
  for (const m of top.matchAll(/#define\s+(\w+)/g)) names.add(m[1]);
  return names;
}

function wgslNames(source) {
  const top = topLevel(source);
  const names = new Set();
  for (const m of top.matchAll(/\b(?:fn|struct|alias)\s+(\w+)/g)) names.add(m[1]);
  for (const m of top.matchAll(/\b(?:const|override)\s+(\w+)/g)) names.add(m[1]);
  for (const m of top.matchAll(/\bvar\s*(?:<[^>]*>)?\s+(\w+)/g)) names.add(m[1]);
  return names;
}

/** Replaces whole identifiers outside comments (a map name -> new name). */
function renameIdentifiers(source, names) {
  if (names.size === 0) return source;
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|[A-Za-z_]\w*/g, (m) => names.get(m) ?? m);
}

/**
 * One fused pass's text in GLSL: its top-level declarations suffixed, without the `precision` statement or the uniform
 * declarations of the engine's names (the fused shader declares them once).
 */
function glslMember(source, suffix, engineNames, uniformNames) {
  const rename = new Map();
  for (const name of glslNames(source)) if (!engineNames.has(name)) rename.set(name, `${name}_${suffix}`);
  for (const name of uniformNames) rename.set(name, `${name}_${suffix}`);
  let text = renameIdentifiers(source, rename);
  text = text.replace(/^\s*#version[^\n]*\n/, '').replace(/\bprecision\s+\w+\s+\w+\s*;/g, '');
  for (const name of engineNames) {
    text = text.replace(new RegExp(`\\buniform\\s+(?:(?:lowp|mediump|highp)\\s+)?\\w+\\s+${name}\\s*;[^\\n]*\\n?`, 'g'), '');
  }
  // The varying, which the fused shader declares.
  return text.replace(/\bvarying\s+\w+\s+vTextureCoord\s*;[^\n]*\n?/g, '');
}

/**
 * Consecutive pointwise passes fused into one fragment.
 * @param {Array<{ source: string, layerName: string, uniforms: string[], uniformTypes: Record<string, string> }>} members the
 *   passes in order; uniforms: the layer's own uniform names (without the engine's)
 * @param {boolean} wgsl
 * @param {Array<{ name: string, type: string }>} engineUniforms the engine's look uniforms ("f32", "vec2<f32>", …)
 * @returns {{ source: string, on: string[], uniforms: Array<{ name: string, member: number, uniform: string }> }} the fragment,
 *   the name of each member's on/off uniform, and where each suffixed uniform came from
 */
export function fusePointwise(members, wgsl, engineUniforms) {
  const engineNames = new Set(engineUniforms.map((u) => u.name));
  const uniforms = [];
  const on = [];
  let body = '';
  let calls = '';
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const problem = pointwiseProblem(m.source, wgsl);
    if (problem !== null) throw new Error(`WeedJS: layer "${m.layerName}" is pointwise and ${problem}.`);
    on.push(`uWeedOn_${i}`);
    for (const name of m.uniforms) uniforms.push({ name: `${name}_${i}`, member: i, uniform: name });
    if (wgsl) {
      const rename = new Map();
      for (const name of wgslNames(m.source)) rename.set(name, `${name}_${i}`);
      let text = renameIdentifiers(m.source, rename);
      // As a field: customUniforms.uAmount, or u.uAmount where the pass took `let u = customUniforms`.
      for (const name of m.uniforms) text = text.replace(new RegExp(`\\.\\s*${name}\\b`, 'g'), `.${name}_${i}`);
      body += `// layer ${m.layerName}\n${text}\n`;
      calls += `  if (customUniforms.${on[i]} > 0.5) { color = clamp(weedPass_${i}(color, in.vTextureCoord), vec4<f32>(0.0), vec4<f32>(1.0)); }\n`;
    } else {
      body += `// layer ${m.layerName}\n${glslMember(m.source, i, engineNames, m.uniforms)}\n`;
      // Between passes the colour is what an 8-bit target would hold: in [0, 1].
      calls += `  if (${on[i]} > 0.5) color = clamp(weedPass_${i}(color, vTextureCoord), 0.0, 1.0);\n`;
    }
  }
  if (wgsl) {
    return {
      source: `${body}\n@fragment\nfn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {\n` +
        '  var color = textureSample(uTexture, uSampler, in.vTextureCoord);\n' + calls + '  return color;\n}\n',
      on,
      uniforms,
    };
  }
  let head = 'precision highp float;\nvarying vec2 vTextureCoord;\nuniform sampler2D uTexture;\n';
  for (const name of on) head += `uniform float ${name};\n`;
  for (const u of engineUniforms) if (new RegExp(`\\b${u.name}\\b`).test(body)) head += `uniform ${glslType(u.type)} ${u.name};\n`;
  return {
    source: `${head}${body}\nvoid main() {\n  vec4 color = texture2D(uTexture, vTextureCoord);\n${calls}  gl_FragColor = color;\n}\n`,
    on,
    uniforms,
  };
}

/** A uniform's type in GLSL ("f32", "vec2<f32>", …). */
function glslType(type) {
  switch (type) {
    case 'f32': return 'float';
    case 'i32': return 'int';
    case 'vec2<f32>': return 'vec2';
    case 'vec3<f32>': return 'vec3';
    case 'vec4<f32>': return 'vec4';
    default: throw new Error(`WeedJS: no GLSL type for the uniform type "${type}".`);
  }
}
