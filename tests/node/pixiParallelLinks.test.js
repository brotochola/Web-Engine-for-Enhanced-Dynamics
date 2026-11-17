import test from 'node:test';
import assert from 'node:assert/strict';

import { GlProgram, GlShaderSystem } from '../../src/vendor/pixi.min.js';

// The Pixi bundle's links ahead (scripts/buildPixi.mjs, patchPixiParallelLinks; E-475): a program's link can start
// before its first bind, without reading anything back; the shader system tells how many such links still run (never
// waiting) and the first bind reads the link started instead of making another.

// GlProgram probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };

const COMPLETION_STATUS_KHR = 0x91b1;

/** A WebGL2 context that logs its calls; `complete` says whether a program's link is done (COMPLETION_STATUS_KHR). */
function fakeGl({ parallel = true } = {}) {
  const calls = [];
  let ids = 0;
  const gl = {
    calls,
    complete: new Set(),
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    COMPILE_STATUS: 0x8b81,
    ACTIVE_ATTRIBUTES: 0x8b89,
    ACTIVE_UNIFORMS: 0x8b86,
    ACTIVE_UNIFORM_BLOCKS: 0x8a36,
    getExtension: (name) => (name === 'KHR_parallel_shader_compile' && parallel ? { COMPLETION_STATUS_KHR } : null),
    createShader: (type) => ({ shader: ++ids, type }),
    shaderSource: (s, src) => calls.push(['shaderSource', s.shader, src.length]),
    compileShader: (s) => calls.push(['compileShader', s.shader]),
    createProgram: () => {
      const p = { program: ++ids };
      calls.push(['createProgram', p.program]);
      return p;
    },
    attachShader: (p, s) => calls.push(['attachShader', p.program, s.shader]),
    linkProgram: (p) => calls.push(['linkProgram', p.program]),
    getProgramParameter: (p, pname) => {
      calls.push(['getProgramParameter', p.program, pname]);
      if (pname === COMPLETION_STATUS_KHR) return gl.complete.has(p.program);
      if (pname === gl.LINK_STATUS) return true;
      return 0; // no attributes, uniforms or blocks
    },
    deleteShader: (s) => calls.push(['deleteShader', s.shader]),
    getUniformLocation: () => null,
  };
  return gl;
}

/** GLSL ES 3.00, as the engine's programs: Pixi links a GLSL 1 program a second time, its attributes bound in order. */
function program(n) {
  return new GlProgram({
    vertex: `#version 300 es\nvoid main() { gl_Position = vec4(${n}.0); }`,
    fragment: '#version 300 es\nvoid main() {}',
    name: `p${n}`,
  });
}

function system(gl) {
  const shaders = new GlShaderSystem({});
  shaders.contextChange(gl);
  return shaders;
}

const named = (gl, name) => gl.calls.filter((c) => c[0] === name);

test('a link started ahead compiles, attaches and links without reading anything back', () => {
  const gl = fakeGl();
  const shaders = system(gl);
  const p = program(1);
  assert.equal(shaders.weedLinkAhead(p), true);
  assert.deepEqual(gl.calls.map((c) => c[0]), ['shaderSource', 'compileShader', 'shaderSource', 'compileShader',
    'createProgram', 'attachShader', 'attachShader', 'linkProgram']);
  assert.equal(shaders.weedLinkAhead(p), false, 'a second call starts nothing');
  assert.equal(named(gl, 'linkProgram').length, 1);
});

test('weedLinksRunning counts the links not yet complete, and asks a complete one no more', () => {
  const gl = fakeGl();
  const shaders = system(gl);
  const a = program(2);
  const b = program(3);
  shaders.weedLinkAhead(a);
  shaders.weedLinkAhead(b);
  const [pa, pb] = named(gl, 'createProgram').map((c) => c[1]);
  assert.equal(shaders.weedLinksRunning(), 2);
  gl.complete.add(pa);
  assert.equal(shaders.weedLinksRunning(), 1);
  gl.complete.add(pb);
  assert.equal(shaders.weedLinksRunning(), 0);
  const polls = named(gl, 'getProgramParameter').length;
  assert.equal(shaders.weedLinksRunning(), 0);
  assert.equal(named(gl, 'getProgramParameter').length, polls, 'complete links are not asked again');
  assert.equal(gl.calls.some((c) => c[2] === gl.LINK_STATUS), false, 'polling never reads LINK_STATUS');
});

test('the first bind of a program linked ahead reads that link, and makes no other', () => {
  const gl = fakeGl();
  const shaders = system(gl);
  const p = program(4);
  shaders.weedLinkAhead(p);
  const [webGl] = named(gl, 'createProgram').map((c) => c[1]);
  const data = shaders._getProgramData(p);
  assert.equal(data.program.program, webGl);
  assert.equal(named(gl, 'createProgram').length, 1);
  assert.equal(named(gl, 'linkProgram').length, 1);
  assert.deepEqual(named(gl, 'getProgramParameter')[0], ['getProgramParameter', webGl, gl.LINK_STATUS]);
  assert.equal(named(gl, 'deleteShader').length, 2, 'the shaders go once linked, as Pixi does');
  assert.equal(shaders._getProgramData(p), data, 'cached');
  assert.equal(shaders.weedLinksRunning(), 0, 'a bound link is no longer counted');
  assert.equal(shaders.weedLinkAhead(p), false, 'nor started again');
});

test('a program not linked ahead links on its first bind, as Pixi does', () => {
  const gl = fakeGl();
  const shaders = system(gl);
  shaders._getProgramData(program(5));
  const order = gl.calls.map((c) => c[0]);
  const link = order.indexOf('linkProgram');
  assert.equal(order[link + 1], 'getProgramParameter');
  assert.equal(gl.calls[link + 1][2], gl.LINK_STATUS, 'LINK_STATUS read right after the link');
});

test('without KHR_parallel_shader_compile nothing reads as running', () => {
  const gl = fakeGl({ parallel: false });
  const shaders = system(gl);
  shaders.weedLinkAhead(program(6));
  assert.equal(shaders.weedLinksRunning(), 0);
  assert.equal(named(gl, 'getProgramParameter').length, 0);
});

test('a lost context answers null: that link is not waited for', () => {
  const gl = fakeGl();
  const shaders = system(gl);
  gl.getProgramParameter = () => null;
  shaders.weedLinkAhead(program(7));
  assert.equal(shaders.weedLinksRunning(), 0);
});

test('a new context drops the links started on the old one', () => {
  const gl = fakeGl();
  const shaders = system(gl);
  const p = program(8);
  shaders.weedLinkAhead(p);
  const gl2 = fakeGl();
  shaders.contextChange(gl2);
  assert.equal(shaders.weedLinksRunning(), 0);
  assert.equal(shaders.weedLinkAhead(p), true, 'started again on the new context');
});

test('GlProgram.weedMade collects the programs made while it is set, each once', () => {
  assert.equal(GlProgram.weedMade, null, 'off by default');
  const made = [];
  GlProgram.weedMade = made;
  try {
    const a = program(9);
    const b = GlProgram.from({ vertex: 'void main() { gl_Position = vec4(10.0); }', fragment: 'void main() {}', name: 'p10' });
    GlProgram.from({ vertex: 'void main() { gl_Position = vec4(10.0); }', fragment: 'void main() {}', name: 'p10' });
    assert.deepEqual(made, [a, b]);
  } finally {
    GlProgram.weedMade = null;
  }
  program(11);
  assert.equal(made.length, 2);
});
