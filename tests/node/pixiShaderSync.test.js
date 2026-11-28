import test from 'node:test';
import assert from 'node:assert/strict';

import { generateShaderSyncPolyfill } from '../../node_modules/pixi.js/lib/unsafe-eval/shader/generateShaderSyncPolyfill.mjs';
import { BindGroup as UpstreamBindGroup } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/shader/BindGroup.mjs';
import { UniformGroup } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/shader/UniformGroup.mjs';
import { BufferResource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/buffer/BufferResource.mjs';
import { Buffer } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/buffer/Buffer.mjs';
import { TextureSource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/TextureSource.mjs';
import { TextureView } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/TextureView.mjs';
import { syncShader } from '../../scripts/pixi-stubs/shaderSyncPolyfill.mjs';
import { BindGroup as BundledBindGroup } from '../../src/vendor/pixi.min.js';

// The Pixi bundle's WebGL shader sync (scripts/pixi-stubs/shaderSyncPolyfill.mjs, swapped in by scripts/buildPixi.mjs)
// walks a per-shader plan instead of for…in over integer-keyed objects. It must make the calls Pixi's polyfill makes,
// in the same order, and follow a shader whose groups or bindings change. Pixi 8.23: a BindGroup is keyed by number
// or by name (its `layout`), and a uniform block is bound by name to the slot its program fixed at link.

const MAX_COMBINED = 0x8b4d;

/** A texture system that logs each bind and keeps what each unit holds, as Pixi's does (_boundTextures). */
function textureSystem(calls) {
  const bound = [];
  return {
    _boundTextures: bound,
    bind: (resource, unit) => {
      calls.push(['texture', resource.label, unit]);
      bound[unit] = resource.source;
    },
  };
}

/** A renderer and shader system that log what the sync does. */
function recorder() {
  const calls = [];
  const renderer = {
    gl: {
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: MAX_COMBINED,
      getParameter: (name) => (name === MAX_COMBINED ? 32 : null),
      uniform1i: (location, unit) => calls.push(['uniform1i', location, unit]),
    },
    texture: textureSystem(calls),
    shader: {
      _getProgramData: () => ({ uniformData: { uA: { location: 'locA', value: -1 }, uB: { location: 'locB', value: -1 } } }),
      bindUniformBlock: (resource, name) => calls.push(['block', name, resource.uid]),
      updateUniformGroup: (group) => calls.push(['uniforms', group.uniformStructures.uValue.value]),
    },
  };
  return { calls, renderer };
}

/** The uniform blocks the program linked (Pixi's getUboData): uTwo, uBuffer and uNamed; uThree is not in it. */
const BLOCKS = { uTwo: { index: 0, binding: 0 }, uBuffer: { index: 1, binding: 1 }, uNamed: { index: 2, binding: 2 } };

function shaderOf(groups, bindMap) {
  return { glProgram: { _uniformBlockData: BLOCKS }, groups, _uniformBindMap: bindMap };
}

/** The calls with their units left out (E-417 picks other units than upstream's count from 0; the tests below say which). */
function run(sync, shader) {
  const { calls, renderer } = recorder();
  sync(renderer, shader, { textureCount: 0 });
  return calls.map((c) => (c[0] === 'texture' || c[0] === 'uniform1i' ? c.slice(0, 2) : c));
}

const texture = (label) => {
  const source = new TextureSource({ width: 1, height: 1 });
  source.label = label;
  return source;
};
const uniforms = (value, ubo = false) => new UniformGroup({ uValue: { value, type: 'f32' } }, { ubo });

test('the plan makes the calls Pixi\'s polyfill makes, in its order', () => {
  const upstream = generateShaderSyncPolyfill();
  const groups = {
    0: new UpstreamBindGroup({ 0: uniforms(1), 1: uniforms(2, true), 2: uniforms(3, true) }),
    1: new UpstreamBindGroup({ 0: texture('A'), 1: texture('B') }),
    // Keyed by name: each resource binds under its layout name, whatever the shader's bind map says.
    2: new UpstreamBindGroup({ uB: texture('C'), uNamed: uniforms(4, true), uLater: null }),
    100: new UpstreamBindGroup({ 0: new BufferResource({ buffer: new Buffer({ data: new Float32Array(4) }) }) }),
  };
  const bindMap = {
    0: { 0: 'uOne', 1: 'uTwo', 2: 'uThree' },
    1: { 0: 'uA', 1: 'uB' },
    2: { 0: 'uOther', 1: 'uOther2' },
    100: { 0: 'uBuffer' },
  };
  const shader = shaderOf(groups, bindMap);
  const expected = run(upstream, shader);
  assert.ok(expected.length >= 8, JSON.stringify(expected));
  assert.ok(!expected.some((c) => c[1] === 'uThree'), 'a block the program does not have is not bound');
  assert.ok(expected.some((c) => c[0] === 'block' && c[1] === 'uNamed'), 'a named group binds by its names');
  assert.deepEqual(run(syncShader, shader), expected, 'first bind');
  assert.deepEqual(run(syncShader, shader), expected, 'from the plan');
});

test('a BindGroup swapped into a slot, or a binding added, rebuilds the plan', () => {
  const upstream = generateShaderSyncPolyfill();
  const groups = { 0: new UpstreamBindGroup({ 0: uniforms(1) }), 1: new UpstreamBindGroup({ 0: texture('A') }) };
  const bindMap = { 0: { 0: 'uOne', 1: 'uTwo' }, 1: { 0: 'uA', 1: 'uB' } };
  const shader = shaderOf(groups, bindMap);
  run(syncShader, shader);
  groups[1] = new UpstreamBindGroup({ 0: texture('C'), 1: texture('D') });
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'swapped group');
  groups[0].setResource(uniforms(7, true), 1);
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'new binding');
  groups[0].setResource(uniforms(9, true), 1);
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'a binding replaced');
});

// E-236: Pixi's batcher, meshes and graphics put another BindGroup in a slot at each batch or draw, with the same keys
// (a batch's textures, a mesh's local uniforms). The plan holds for it (in Predator it was rebuilt at nearly every bind:
// 934 KB/s of Pixi's garbage); the calls stay Pixi's, in its order, whichever group the slot holds.
test('E-236: BindGroups with the same keys taking turns in a slot make Pixi\'s calls, each bind', () => {
  const upstream = generateShaderSyncPolyfill();
  const batch = (a, b) => new BundledBindGroup({ 0: texture(a), 1: texture(b) });
  const globals = new BundledBindGroup({ 0: uniforms(1) });
  const groups = { 0: globals, 1: batch('A', 'B') };
  const bindMap = { 0: { 0: 'uOne' }, 1: { 0: 'uA', 1: 'uB' } };
  const shader = shaderOf(groups, bindMap);
  const turns = [batch('C', 'D'), batch('E', 'F'), batch('C', 'D'), new BundledBindGroup({ 0: uniforms(5) })];
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'first bind');
  for (let k = 0; k < turns.length - 1; k++) {
    groups[1] = turns[k];
    assert.deepEqual(run(syncShader, shader), run(upstream, shader), `batch ${k}`);
  }
  // The globals slot swapped too (a new pass), with a group of the same keys.
  groups[0] = turns[3];
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'globals swapped');
});

test('E-236: a BindGroup with other keys, or the same keys in another order, rebuilds the plan', () => {
  const upstream = generateShaderSyncPolyfill();
  const groups = { 0: new BundledBindGroup({ 0: uniforms(1) }), 1: new BundledBindGroup({ 0: texture('A'), 1: texture('B') }) };
  const bindMap = { 0: { 0: 'uOne', 1: 'uTwo', 5: 'uFive' }, 1: { 0: 'uA', 1: 'uB', 2: 'uC' } };
  const shader = shaderOf(groups, bindMap);
  run(syncShader, shader);
  groups[1] = new BundledBindGroup({ 0: texture('C'), 1: texture('D'), 2: texture('E') });
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'a key more');
  const one = new BundledBindGroup();
  one.setResource(texture('F'), 1);
  groups[1] = one;
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'a key less');
  const reordered = new BundledBindGroup();
  reordered.setResource(uniforms(3), 5);
  reordered.setResource(uniforms(4), 0);
  groups[0] = reordered;
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'other keys in the globals slot');
});

test('groups keyed by name: the same layout takes turns on the plan, another layout or a group by number rebuilds it', () => {
  const upstream = generateShaderSyncPolyfill();
  const named = (a, b) => new BundledBindGroup({ uA: texture(a), uB: texture(b) });
  const groups = { 0: new BundledBindGroup({ 0: uniforms(1) }), 1: named('A', 'B') };
  const bindMap = { 0: { 0: 'uOne' }, 1: { 0: 'uB', 1: 'uA' } };
  const shader = shaderOf(groups, bindMap);
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'first bind');
  groups[1] = named('C', 'D');
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'the same layout');
  groups[1] = new BundledBindGroup({ uB: texture('E'), uA: texture('F') });
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'the names in another order');
  groups[1] = new BundledBindGroup({ 0: texture('G'), 1: texture('H') });
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'keyed by number: the bind map names them');
  groups[1] = named('I', 'J');
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'by name again');
});

test('a destroyed BindGroup in a slot binds nothing, as Pixi\'s polyfill; a live one put back is bound again', () => {
  const upstream = generateShaderSyncPolyfill();
  const live = new BundledBindGroup({ 0: texture('A'), 1: texture('B') });
  const groups = { 0: new BundledBindGroup({ 0: uniforms(1) }), 1: live };
  const shader = shaderOf(groups, { 0: { 0: 'uOne' }, 1: { 0: 'uA', 1: 'uB' } });
  run(syncShader, shader);
  const dead = new BundledBindGroup({ 0: texture('C'), 1: texture('D') });
  dead.destroy();
  groups[1] = dead;
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'destroyed');
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'still destroyed, from the plan');
  groups[1] = live;
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'a live group back');
});

// N-109: Pixi's batcher declares sixteen float samplers and binds only the units its batch uses; WebGL2 drops a draw
// whose sampler finds an integer texture in its unit. Integer textures take the top units, counting down, and leave the
// others to float textures (E-417: from the first unit past the batcher's sixteen).
test('integer textures take the top texture units, float ones the units past the batcher\'s in order', () => {
  const calls = [];
  const renderer = {
    gl: {
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: MAX_COMBINED,
      getParameter: (name) => (name === MAX_COMBINED ? 32 : null),
      uniform1i: (location, unit) => calls.push(['uniform1i', location, unit]),
    },
    texture: textureSystem(calls),
    shader: {
      _getProgramData: () => ({
        uniformData: Object.fromEntries(['uA', 'uB', 'uC', 'uD'].map((n) => [n, { location: 'loc' + n.slice(1), value: -1 }])),
      }),
    },
  };
  const integerView = new TextureView(new TextureSource({ width: 1, height: 1, format: 'r8uint' }), {});
  integerView.label = 'C';
  const groups = {
    1: new UpstreamBindGroup({
      0: texture('A'),
      1: Object.assign(new TextureSource({ width: 1, height: 1, format: 'rgba32uint' }), { label: 'B' }),
      2: integerView,
      3: texture('D'),
    }),
  };
  const shader = shaderOf(groups, { 1: { 0: 'uA', 1: 'uB', 2: 'uC', 3: 'uD' } });
  const expected = [
    ['texture', 'A', 16], ['uniform1i', 'locA', 16],
    ['texture', 'B', 31], ['uniform1i', 'locB', 31],
    ['texture', 'C', 30], ['uniform1i', 'locC', 30],
    ['texture', 'D', 17], ['uniform1i', 'locD', 17],
  ];
  for (const bind of ['first bind', 'from the plan']) {
    calls.length = 0;
    const syncData = { textureCount: 0 };
    syncShader(renderer, shader, syncData);
    assert.deepEqual(calls, expected, bind);
    assert.equal(syncData.textureCount, 2, 'the float textures counted');
  }
});

test('the bundled BindGroup lists a new _resourceKeys when it gains a binding, the same one when one is replaced', () => {
  const group = new BundledBindGroup();
  const resource = () => ({ _resourceId: 1, on() {}, off() {} });
  group.setResource(resource(), 0);
  group.setResource(resource(), 2);
  const keys = group._resourceKeys;
  assert.deepEqual(keys, [0, 2]);
  group.setResource(resource(), 0);
  assert.equal(group._resourceKeys, keys, 'replacing binding 0 keeps the list');
  group.setResource(resource(), 1);
  assert.notEqual(group._resourceKeys, keys, 'a binding more, a new list');
  assert.deepEqual(group._resourceKeys, [0, 1, 2]);
});

// E-417: a float texture keeps the unit it sits on across programs, a new one takes the unit past the batcher's sixteen
// used longest ago that the program has not taken; the top four units stay the integer textures'. E-389: a sampler's
// uniform1i is written when its unit changes, and remembered.
function program(names) {
  return { uniformData: Object.fromEntries(names.map((n) => [n, { location: 'loc' + n.slice(1), value: 0 }])) };
}

function sharedRenderer(calls, programs) {
  return {
    gl: {
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: MAX_COMBINED,
      getParameter: (name) => (name === MAX_COMBINED ? 32 : null),
      uniform1i: (location, unit) => calls.push(['uniform1i', location, unit]),
    },
    texture: textureSystem(calls),
    shader: { _getProgramData: (glProgram) => programs.get(glProgram) },
  };
}

test('E-417: a texture already on a unit stays there for the next program, which binds only what is new', () => {
  const calls = [];
  const atlas = texture('atlas');
  const lut = texture('lut');
  const maps = texture('maps');
  const p1 = {};
  const p2 = {};
  const renderer = sharedRenderer(calls, new Map([[p1, program(['uA', 'uB'])], [p2, program(['uC', 'uD'])]]));
  const first = { glProgram: p1, groups: { 1: new UpstreamBindGroup({ 0: atlas, 1: lut }) }, _uniformBindMap: { 1: { 0: 'uA', 1: 'uB' } } };
  const second = { glProgram: p2, groups: { 1: new UpstreamBindGroup({ 0: maps, 1: atlas }) }, _uniformBindMap: { 1: { 0: 'uC', 1: 'uD' } } };
  syncShader(renderer, first, { textureCount: 0 });
  assert.deepEqual(calls, [['texture', 'atlas', 16], ['uniform1i', 'locA', 16], ['texture', 'lut', 17], ['uniform1i', 'locB', 17]]);
  calls.length = 0;
  syncShader(renderer, second, { textureCount: 0 });
  assert.deepEqual(calls, [['texture', 'maps', 18], ['uniform1i', 'locC', 18], ['texture', 'atlas', 16], ['uniform1i', 'locD', 16]],
    'the atlas stays on 16');
  calls.length = 0;
  syncShader(renderer, first, { textureCount: 0 });
  assert.deepEqual(calls, [['texture', 'atlas', 16], ['texture', 'lut', 17]], 'nothing moves, no uniform1i (E-389)');
});

test('E-417: with every float unit held, a new texture takes the one used longest ago, never one the program holds', () => {
  const calls = [];
  const programs = new Map();
  const renderer = sharedRenderer(calls, programs);
  const syncOne = (label) => {
    const glProgram = {};
    programs.set(glProgram, program(['uA']));
    const shader = { glProgram, groups: { 0: new UpstreamBindGroup({ 0: texture(label) }) }, _uniformBindMap: { 0: { 0: 'uA' } } };
    calls.length = 0;
    syncShader(renderer, shader, { textureCount: 0 });
    return calls.find((c) => c[0] === 'texture')[2];
  };
  // 32 units: the batcher's 0 to 15, the top 4 the integer textures': 16 to 27 filled in order.
  const firsts = Array.from({ length: 12 }, (_, k) => syncOne('t' + k));
  assert.deepEqual(firsts, Array.from({ length: 12 }, (_, k) => 16 + k));
  assert.equal(syncOne('t12'), 16, 'the oldest, unit 16');
  assert.equal(syncOne('t13'), 17);
  // A program of two new textures while unit 18 is the oldest: they take 18 and 19, not the same one twice.
  const glProgram = {};
  programs.set(glProgram, program(['uA', 'uB']));
  calls.length = 0;
  syncShader(renderer, { glProgram, groups: { 0: new UpstreamBindGroup({ 0: texture('x'), 1: texture('y') }) }, _uniformBindMap: { 0: { 0: 'uA', 1: 'uB' } } },
    { textureCount: 0 });
  assert.deepEqual(calls.filter((c) => c[0] === 'texture').map((c) => c[2]), [18, 19]);
  assert.ok(renderer.texture._boundTextures.slice(28).every((t) => t === undefined), 'the integer units untouched');
  // A program of thirteen new textures: twelve past the batcher's units, the thirteenth on the batcher's oldest.
  const many = {};
  programs.set(many, program(Array.from({ length: 13 }, (_, k) => 'u' + k)));
  calls.length = 0;
  const resources = Object.fromEntries(Array.from({ length: 13 }, (_, k) => [k, texture('m' + k)]));
  syncShader(renderer, { glProgram: many, groups: { 0: new UpstreamBindGroup(resources) }, _uniformBindMap: { 0: Object.fromEntries(Array.from({ length: 13 }, (_, k) => [k, 'u' + k])) } },
    { textureCount: 0 });
  const units = calls.filter((c) => c[0] === 'texture').map((c) => c[2]);
  assert.deepEqual(units.slice(0, 12).sort((a, b) => a - b), Array.from({ length: 12 }, (_, k) => 16 + k));
  assert.equal(units[12], 0);
});

test('E-417: integer textures of two programs keep their own top units instead of taking turns on the last one', () => {
  const calls = [];
  const programs = new Map();
  const renderer = sharedRenderer(calls, programs);
  const integer = (label) => Object.assign(new TextureSource({ width: 1, height: 1, format: 'r32uint' }), { label });
  const statics = integer('statics');
  const tiles = integer('tiles');
  const sync = (source) => {
    const glProgram = {};
    programs.set(glProgram, program(['uA']));
    calls.length = 0;
    syncShader(renderer, { glProgram, groups: { 0: new UpstreamBindGroup({ 0: source }) }, _uniformBindMap: { 0: { 0: 'uA' } } },
      { textureCount: 0 });
    return calls.find((c) => c[0] === 'texture')[2];
  };
  assert.equal(sync(statics), 31, 'the last unit first');
  assert.equal(sync(tiles), 30, 'the next one down, not 31 again');
  assert.equal(sync(statics), 31, 'still where it was');
  assert.equal(renderer.texture._boundTextures[30], tiles);
});
