#!/usr/bin/env node
/**
 * E-162: the indexed sprite vertex shader (spriteIndexed.js) and the shipped one, each compiled and linked with the
 * sprite fragment shader in the browser's WebGL2, with their active attributes. A check, not a timing.
 *
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/spriteIndexedCompileCheck.mjs
 */
export async function run({ root = '' } = {}) {
  const { spriteIndexedVertex } = await import(`${root}/src/render/spriteIndexed.js`);
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
  return results;
}
