#!/usr/bin/env node
/**
 * E-162: the indexed sprite vertex shader (spriteIndexed.js) and the shipped one, each compiled and linked with the
 * sprite fragment shader in the browser's WebGL2, with their active attributes; and on WebGPU the indexed WGSL and the
 * shipped one, each a shader module and a render pipeline with its program's bind group layouts and vertex inputs.
 * A check, not a timing.
 *
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/spriteIndexedCompileCheck.mjs
 */
export async function run({ root = '' } = {}) {
  const { spriteIndexedVertex, spriteIndexedWgsl } = await import(`${root}/src/render/spriteIndexed.js`);
  const text = async (p) => (await fetch(`${root}${p}`)).text();
  const vert = await text('/src/shaders/instancedSprite.vert.glsl');
  const frag = await text('/src/shaders/instancedSprite.frag.glsl');
  const gl = new OffscreenCanvas(4, 4).getContext('webgl2');
  if (!gl) return { ok: false, why: 'no webgl2' };
  const prefixV = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
  const prefixF = ''; // the fragment file has its own #version
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return { ok: gl.getShaderParameter(s, gl.COMPILE_STATUS), log: gl.getShaderInfoLog(s), s };
  };
  const results = {};
  for (const [name, vsrc] of [['shipped', vert], ['indexed', spriteIndexedVertex(vert)]]) {
    const v = compile(gl.VERTEX_SHADER, prefixV + vsrc);
    const f = compile(gl.FRAGMENT_SHADER, prefixF + frag);
    let linked = false;
    let linkLog = '';
    const attribs = [];
    if (v.ok && f.ok) {
      const p = gl.createProgram();
      gl.attachShader(p, v.s);
      gl.attachShader(p, f.s);
      gl.linkProgram(p);
      linked = gl.getProgramParameter(p, gl.LINK_STATUS);
      linkLog = gl.getProgramInfoLog(p);
      const n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
      for (let i = 0; i < n; i++) attribs.push(gl.getActiveAttrib(p, i).name);
    }
    results[name] = { vertexOk: v.ok, vertexLog: v.log, fragmentOk: f.ok, fragmentLog: f.log, linked, linkLog, attribs: attribs.sort() };
  }
  const adapter = globalThis.navigator?.gpu ? await navigator.gpu.requestAdapter() : null;
  if (!adapter) {
    results.webgpu = 'no adapter';
    return results;
  }
  const device = await adapter.requestDevice();
  const wgsl = await text('/src/shaders/instancedSprite.wgsl');
  const V = GPUShaderStage.VERTEX;
  const F = GPUShaderStage.FRAGMENT;
  const uniform = (binding) => ({ binding, visibility: V | F, buffer: { type: 'uniform' } });
  for (const [name, code, storage] of [['shippedWgsl', wgsl, false], ['indexedWgsl', spriteIndexedWgsl(wgsl), true]]) {
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    const group2 = [
      { binding: 0, visibility: F, texture: { sampleType: 'float' } },
      { binding: 1, visibility: F, sampler: { type: 'filtering' } },
      { binding: 2, visibility: V | F, texture: { sampleType: 'unfilterable-float' } },
      uniform(3),
    ];
    if (storage) group2.push({ binding: 4, visibility: V | F, buffer: { type: 'read-only-storage' } });
    const layout = device.createPipelineLayout({
      bindGroupLayouts: [[uniform(0)], [uniform(0)], group2].map((entries) => device.createBindGroupLayout({ entries })),
    });
    // The quad's buffer, and one instance buffer with every other input, at the locations the entry point names.
    const from = code.indexOf('fn mainVert(');
    const head = code.slice(from, code.indexOf(') -> VertexOut {', from));
    const inputs = [...head.matchAll(/@location\((\d+)\) (\w+): (vec2<f32>|f32)/g)].map((m) => ({
      location: +m[1],
      name: m[2],
      two: m[3] !== 'f32',
    }));
    const attribute = (a, offset) => ({ shaderLocation: a.location, offset, format: a.two ? 'float32x2' : 'float32' });
    const perInstance = [];
    let stride = 0;
    for (const a of inputs) {
      if (a.name === 'aQuad') continue;
      perInstance.push(attribute(a, stride));
      stride += a.two ? 8 : 4;
    }
    const quad = inputs.find((a) => a.name === 'aQuad');
    const buffers = [
      { arrayStride: 8, stepMode: 'vertex', attributes: [attribute(quad, 0)] },
      { arrayStride: stride, stepMode: 'instance', attributes: perInstance },
    ];
    device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'mainVert', buffers },
      fragment: { module, entryPoint: 'mainFrag', targets: [{ format: 'bgra8unorm' }] },
    });
    const error = await device.popErrorScope();
    results[name] = {
      messages: info.messages.map((m) => `${m.type} ${m.lineNum}:${m.linePos} ${m.message}`),
      pipeline: error ? error.message : 'ok',
      inputs: inputs.map((a) => `${a.location}:${a.name}`).sort(),
    };
  }
  device.destroy();
  return results;
}
