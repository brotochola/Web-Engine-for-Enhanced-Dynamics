// DX-POSTFUSE: pointwise SCREEN passes generated into one fragment (src/render/pointwisePass.js). The generator is pure text
// here, checked by its identifiers and by evaluating the GLSL's maths in JS where it is simple enough; the picture on a GPU is
// tests/bench/screenIdentityCheck.mjs's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/layer.js';
import { fusePointwise, pointwiseProblem } from '../../src/render/pointwisePass.js';
import { assertLoadedShadersCompatible } from '../../src/render/rendererBackend.js';
import { LAYER_KIND } from '../../src/util/configDefaults.js';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { readEngineShader } from './engineShaderSources.mjs';

const ENGINE = [{ name: 'uTime', type: 'f32' }, { name: 'uCanvasSize', type: 'vec2<f32>' }];
const GLSL_A = `precision mediump float;
varying vec2 vTextureCoord;
uniform float uAmount;
uniform float uTime;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA); }
vec4 weedPass(vec4 color, vec2 uv) {
  float l = luma(color.rgb) * uTime; // LUMA and luma in a comment stay as they are read
  return vec4(mix(vec3(l), color.rgb, uAmount), color.a);
}
`;
const GLSL_B = `precision mediump float;
uniform float uAmount;
uniform vec2 uCanvasSize;
const vec3 LUMA = vec3(1.0, 0.0, 0.0);
vec4 weedPass(vec4 color, vec2 uv) { return vec4(color.rgb * (1.0 - uAmount) * LUMA, color.a + uCanvasSize.x * 0.0); }
`;
const WGSL_A = `const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);
fn luma(c: vec3<f32>) -> f32 { return dot(c, LUMA); }
fn weedPass(color: vec4<f32>, uv: vec2<f32>) -> vec4<f32> {
  let u = customUniforms;
  return vec4<f32>(mix(vec3<f32>(luma(color.rgb)), color.rgb, u.uAmount + customUniforms.uAmountExtra), color.a);
}
`;
const WGSL_B = `fn weedPass(color: vec4f, uv: vec2f) -> vec4f { return vec4f(color.rgb * (1.0 - customUniforms.uAmount), color.a); }
`;

const member = (source, uniforms, layerName = 'grade') => ({ source, layerName, uniforms, uniformTypes: Object.fromEntries(uniforms.map((u) => [u, 'f32'])) });

test('what a source must have, and what it may not name', () => {
  assert.equal(pointwiseProblem(GLSL_A, false), null);
  assert.equal(pointwiseProblem(WGSL_A, true), null);
  assert.equal(pointwiseProblem(WGSL_B, true), null);
  assert.match(pointwiseProblem('void main() {}', false), /no vec4 weedPass\(vec4 color, vec2 uv\)/);
  assert.match(pointwiseProblem('fn other() {}', true), /no fn weedPass/);
  assert.match(pointwiseProblem(GLSL_A + 'void main() { gl_FragColor = vec4(1.0); }', false), /entry point of its own/);
  assert.match(pointwiseProblem(WGSL_A + '@fragment fn mainFrag() {}', true), /entry point of its own/);
  for (const name of ['uTexture', 'uScene', 'uSource', 'uGbufIds', 'gl_FragCoord']) {
    assert.match(pointwiseProblem(GLSL_A.replace('return vec4(mix', `float q = ${name}.x; return vec4(mix`), false), new RegExp(`names ${name}`));
  }
  assert.equal(pointwiseProblem('// weedPass reads uTexture here\n' + GLSL_A, false), null, 'a comment reads nothing');
});

test('two layers that use the same names are told apart; the engine\'s uniforms are declared once', () => {
  const f = fusePointwise([member(GLSL_A, ['uAmount']), member(GLSL_B, ['uAmount'], 'vignette')], false, ENGINE);
  assert.match(f.source, /uniform float uAmount_0;/);
  assert.match(f.source, /uniform float uAmount_1;/);
  assert.doesNotMatch(f.source, /uniform float uAmount;/);
  assert.equal(f.source.match(/uniform float uTime;/g).length, 1, 'shared and once');
  assert.equal(f.source.match(/uniform vec2 uCanvasSize;/g).length, 1);
  assert.match(f.source, /const vec3 LUMA_0 =/);
  assert.match(f.source, /const vec3 LUMA_1 =/);
  assert.match(f.source, /float luma_0\(vec3 c\)/);
  assert.match(f.source, /vec4 weedPass_0\(vec4 color, vec2 uv\)/);
  assert.match(f.source, /vec4 weedPass_1\(vec4 color, vec2 uv\)/);
  assert.equal(f.source.match(/varying vec2 vTextureCoord;/g).length, 1);
  assert.equal(f.source.match(/precision highp float;/g).length, 1);
  assert.doesNotMatch(f.source, /precision mediump/);
  assert.deepEqual(f.on, ['uWeedOn_0', 'uWeedOn_1']);
  assert.deepEqual(f.uniforms, [{ name: 'uAmount_0', member: 0, uniform: 'uAmount' }, { name: 'uAmount_1', member: 1, uniform: 'uAmount' }]);
});

test('the fused GLSL reads the frame once and runs the passes in order, each behind its own switch, in [0, 1] between them', () => {
  const f = fusePointwise([member(GLSL_A, ['uAmount']), member(GLSL_B, ['uAmount'], 'vignette')], false, ENGINE);
  assert.equal(f.source.match(/texture2D\(/g).length, 1);
  const at = (s) => f.source.indexOf(s);
  assert.ok(at('if (uWeedOn_0 > 0.5) color = ') < at('if (uWeedOn_1 > 0.5) color = '));
  assert.match(f.source, /if \(uWeedOn_0 > 0\.5\) color = clamp\(weedPass_0\(color, vTextureCoord\), 0\.0, 1\.0\);/);
  assert.match(f.source, /gl_FragColor = color;\n}/);
});

test('the fused WGSL: suffixed names and uniforms, an alias of customUniforms, no prefix confusion, entry point added', () => {
  const f = fusePointwise([member(WGSL_A, ['uAmount', 'uAmountExtra']), member(WGSL_B, ['uAmount'], 'vignette')], true, ENGINE);
  assert.match(f.source, /const LUMA_0 = /);
  assert.match(f.source, /fn luma_0\(c: vec3<f32>\)/);
  assert.match(f.source, /u\.uAmount_0 \+ customUniforms\.uAmountExtra_0/);
  assert.match(f.source, /customUniforms\.uAmount_1\)/);
  assert.doesNotMatch(f.source, /uAmount_0Extra/);
  assert.match(f.source, /fn weedPass_0\(color: vec4<f32>, uv: vec2<f32>\)/);
  assert.equal(f.source.match(/textureSample\(/g).length, 1);
  assert.match(f.source, /@fragment\nfn mainFrag\(in: VertexOut\)/);
  assert.match(f.source, /if \(customUniforms\.uWeedOn_0 > 0\.5\) \{ color = clamp\(weedPass_0\(color, in\.vTextureCoord\), vec4<f32>\(0\.0\), vec4<f32>\(1\.0\)\); \}/);
});

test('a bad source is refused by name', () => {
  assert.throws(() => fusePointwise([member('void main() {}', [])], false, ENGINE), {
    message: 'WeedJS: layer "grade" is pointwise and it has no vec4 weedPass(vec4 color, vec2 uv).',
  });
});

test('one pass alone is generated the same way', () => {
  const f = fusePointwise([member(GLSL_B, ['uAmount'])], false, ENGINE);
  assert.equal(f.on.length, 1);
  assert.match(f.source, /void main\(\)/);
});

// --- In the renderer ---

const BUILT_IN = { decals: { zIndex: 1 }, castedShadows: { zIndex: 2 }, entities: { zIndex: 3 }, lighting: { zIndex: 4 } };
const pointwise = (zIndex, extra = {}, shader = {}) => ({
  kind: LAYER_KIND.SCREEN,
  zIndex,
  shader: { fragment: 'grade', pointwise: true, uniforms: { uAmount: { value: 0.5, type: 'f32' } }, ...shader },
  ...extra,
});
const copyLook = (zIndex) => ({ kind: LAYER_KIND.SCREEN, zIndex, shader: { fragment: 'copy' } });
const COPY = 'precision mediump float;\nvarying vec2 vTextureCoord;\nuniform sampler2D uTexture;\nvoid main() { gl_FragColor = texture2D(uTexture, vTextureCoord); }\n';

const load = (layers) => {
  Layer.reset();
  Layer.initializeFromConfig(layers, BUILT_IN);
};

/** A Pixi worker with a stand-in renderer: the shaders it made, what each submit drew. */
async function pixiWith(layers, sources = {}) {
  load(layers);
  for (const name of Object.keys(layers)) Layer._metadata.layers[Layer.get(name).id].shaderFragment = sources[name] ?? GLSL_B;
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.config = { physics: {}, renderer: {}, particle: {} };
  px._useWebGpu = false;
  px._engineShaders = { lookVert: readEngineShader('fullscreenLook.vert.glsl') };
  px.canvasWidth = 800;
  px.canvasHeight = 600;
  const made = [];
  px.lookShaders.create = (source, texture, uniformDefs, name, layerName) => {
    const shader = { name, source, resources: { customUniforms: { uniforms: Object.fromEntries(Object.entries(uniformDefs).map(([k, d]) => [k, d.value])) }, uTexture: texture } };
    made.push(shader);
    return shader;
  };
  px.customLayers.list = [];
  px.screenLayers.passes = [];
  px.globalEntityCount = 0;
  px.pixiApp = { stage: { addChild() {}, sortChildren() {} }, renderer: { background: { colorRgba: [0, 0, 0, 1] } } };
  px._releaseTextureBindGroups = () => {};
  px._gpuLive = () => true;
  await quietly(() => px.customLayers.initialize({ config: px.config, layerData: Layer.getSerializableData(), customLayerRenderQueues: {} }));
  const draws = [];
  px._submitRender = (what) => {
    const shader = (what.container ?? what)?.shader ?? null;
    draws.push({ name: shader?.name ?? 'stage', reads: shader?.resources?.uTexture ?? null, into: what.target?.source ?? null });
  };
  return { px, draws, made };
}

test('consecutive pointwise layers are one draw; a look between them, or another resolution, starts another', async () => {
  const a = await pixiWith({ grade: pointwise(90), vignette: pointwise(100) });
  assert.equal(a.px.screenLayers.passes.length, 2, 'two layers');
  assert.deepEqual(a.px.screenLayers.steps.map((s) => s.layerName), ['grade+vignette'], 'one draw');
  assert.equal(a.made.length, 1, 'one shader');
  const b = await pixiWith({ grade: pointwise(80), blur: copyLook(90), vignette: pointwise(100) }, { blur: COPY });
  assert.deepEqual(b.px.screenLayers.steps.map((s) => s.layerName), ['grade', 'blur', 'vignette']);
  const c = await pixiWith({ grade: pointwise(80), vignette: pointwise(90, { resolution: 0.5 }) });
  assert.deepEqual(c.px.screenLayers.steps.map((s) => s.layerName), ['grade', 'vignette']);
});

test('the fused draw: one full-screen draw onto the canvas, reading the frame; hiding a member switches it off', async () => {
  const { px, draws } = await pixiWith({ grade: pointwise(90), vignette: pointwise(100) });
  px.screenLayers.present();
  assert.equal(draws.length, 2, 'the stage, then one draw');
  assert.equal(draws[1].into, null, 'the canvas');
  assert.equal(draws[1].reads, draws[0].into);
  const store = px.screenLayers.steps[0].uniformStore;
  assert.deepEqual([store.uWeedOn_0, store.uWeedOn_1], [1, 1]);
  Layer.get('grade').visible = false;
  px.screenLayers.present();
  assert.deepEqual([store.uWeedOn_0, store.uWeedOn_1], [0, 1]);
  assert.equal(px.screenLayers.shown(), true);
  Layer.get('vignette').visible = false;
  assert.equal(px.screenLayers.present(), false, 'none shown: the present is the stage\'s');
});

test('each member\'s uniforms land in the fused shader under its own name, and one layer\'s does not move the other\'s', async () => {
  const { px } = await pixiWith({ grade: pointwise(90), vignette: pointwise(100) });
  const store = px.screenLayers.steps[0].uniformStore;
  assert.equal(store.uAmount_0, 0.5);
  Layer.get('vignette').setUniform('uAmount', 0.125);
  px.screenLayers.present();
  assert.deepEqual([store.uAmount_0, store.uAmount_1], [0.5, 0.125]);
  Layer.get('grade').setUniform('uAmount', 0.75);
  px.screenLayers.present();
  assert.deepEqual([store.uAmount_0, store.uAmount_1], [0.75, 0.125]);
});

test('the engine\'s uniforms are the fused draw\'s: the canvas size, the texel size of the frame it reads', async () => {
  const { px } = await pixiWith({ grade: pointwise(90), vignette: pointwise(100) });
  px.screenLayers.present();
  const store = px.screenLayers.steps[0].uniformStore;
  assert.deepEqual(Array.from(store.uCanvasSize), [800, 600]);
  assert.deepEqual(Array.from(store.uTexelSize), [1 / 800, 1 / 600].map(Math.fround));
});

test('the config: pointwise is for a SCREEN layer of one fragment, and the loader names what is wrong with a source', () => {
  const refused = (layers, message) => assert.throws(() => load(layers), { message });
  refused({ grade: pointwise(90, { kind: LAYER_KIND.SPRITES }) }, /shader\.pointwise is for a LAYER_KIND\.SCREEN layer of one fragment/);
  refused({ grade: pointwise(90, {}, { passes: [{ fragment: 'a' }], fragment: undefined }) }, /shader\.pointwise is for/);
  refused({ grade: pointwise(90, {}, { pointwise: 'yes' }) }, /shader\.pointwise is "yes": true or false/);
  load({ grade: pointwise(90) });
  assert.equal(Layer._metadata.layers[Layer.get('grade').id].shaderPointwise, true);
  const check = (source) => assertLoadedShadersCompatible({
    backend: 'webgl', layers: { grade: pointwise(90) }, shaderAssets: { grade: '/grade.frag' }, loadedSources: { grade: source },
  });
  assert.doesNotThrow(() => check(GLSL_B));
  assert.throws(() => check(COPY), { message: /layer "grade" is pointwise and it has no vec4 weedPass\(vec4 color, vec2 uv\) \(shader "grade"\)/ });
});
