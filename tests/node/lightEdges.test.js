/**
 * DX-LIGHTEDGES (src/render/lightEdges.js): the light shown without crossing the floor's edges. The selection rule on
 * its JS twin, the programs' text in both languages, and the light pass's EDGES flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  LIGHT_EDGES_ENTITY, LIGHT_EDGES_FLOOR, LIGHT_EDGES_KINDS, LIGHT_EDGES_MARK_DEPTH, lightEdgesGlsl, lightEdgesWgsl, rgbOnlyHost,
  wallEdgesWanted,
} from '../../src/render/lightEdges.js';
import { edgeLightAt } from '../reference/renderMathJs.mjs';
import { lightingSource } from '../../src/render/faceMap.js';
import { Container } from '../../src/vendor/pixi.min.js';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');

/** RGBA floats of a row of texels: [light, alpha] each (grey light). */
function row(...texels) {
  const out = new Float32Array(texels.length * 4);
  texels.forEach(([light, alpha], i) => out.set([light, light, light, alpha], i * 4));
  return out;
}

test('a pixel takes only the light texels of its own kind; none of its kind round it, all four as before', () => {
  // A dark floor texel (0.1) beside a lit head's (0.9), half way between them.
  const texels = row([0.1, LIGHT_EDGES_FLOOR], [0.9, LIGHT_EDGES_ENTITY]);
  const between = 0.5;
  assert.deepEqual(edgeLightAt(texels, 2, 1, between, 0.5, LIGHT_EDGES_FLOOR).map((v) => +v.toFixed(5)), [0.1, 0.1, 0.1], 'the floor keeps its own light');
  assert.deepEqual(edgeLightAt(texels, 2, 1, between, 0.5, LIGHT_EDGES_ENTITY).map((v) => +v.toFixed(5)), [0.9, 0.9, 0.9], 'the head its own');
  // All floor: the plain bilinear mix.
  const floor = row([0.2, LIGHT_EDGES_FLOOR], [0.6, LIGHT_EDGES_FLOOR]);
  assert.equal(+edgeLightAt(floor, 2, 1, between, 0.5, LIGHT_EDGES_FLOOR)[0].toFixed(5), 0.4);
  // An entity pixel with no entity texel round it (a thing thinner than a texel): the four as a stretch gives them.
  assert.equal(+edgeLightAt(floor, 2, 1, between, 0.5, LIGHT_EDGES_ENTITY)[0].toFixed(5), 0.4);
});

test('each variant bakes its kind and the mark its depth, in both languages, with balanced text', () => {
  const balanced = (s, label) => {
    for (const [o, c] of [['(', ')'], ['{', '}'], ['[', ']']]) {
      let d = 0;
      for (const ch of s.replace(/\/\/[^\n]*/g, '')) { if (ch === o) d++; else if (ch === c) d--; }
      assert.equal(d, 0, `${label}: ${o}${c}`);
    }
  };
  for (const kind of LIGHT_EDGES_KINDS) {
    const { vertex, fragment } = lightEdgesGlsl(kind);
    balanced(vertex, `${kind} vertex`);
    balanced(fragment, `${kind} fragment`);
    balanced(lightEdgesWgsl(kind), `${kind} wgsl`);
  }
  // WebGL's clip z for the mark's depth, WebGPU's the depth itself.
  assert.match(lightEdgesGlsl('mark').vertex, new RegExp(`, ${String(LIGHT_EDGES_MARK_DEPTH * 2 - 1).replace('.', '\\.')}, 1\\.0\\)`));
  assert.match(lightEdgesWgsl('mark'), new RegExp(`, ${String(LIGHT_EDGES_MARK_DEPTH).replace('.', '\\.')}, 1\\.0\\)`));
  assert.match(lightEdgesGlsl('lightFloor').fragment, /- 0\.0\), vec4\(0\.5\)\)/);
  assert.match(lightEdgesGlsl('lightEntity').fragment, /- 1\.0\), vec4\(0\.5\)\)/);
  assert.match(lightEdgesWgsl('unshadedEntity'), /- 1\.0\), vec4<f32>\(0\.5\)\)/);
  assert.match(lightEdgesGlsl('unshadedFloor').fragment, /uniform sampler2D uUnshaded;/);
  assert.doesNotMatch(lightEdgesGlsl('lightFloor').fragment, /uUnshaded/);
  assert.throws(() => lightEdgesGlsl('nope'), /no kind/);
});

test("the light pass's EDGES: the floor's texels leave alpha 0 with it, 1 without, in both languages", () => {
  const flags = { faces: true, sunMap: true, ids: true, tiles: true };
  const glsl = shader('lightingBasic.frag.glsl');
  const wgsl = shader('lightingBasic.wgsl');
  assert.match(lightingSource(glsl, { ...flags, edges: true }), /finalColor = vec4\(totalLight, 0\.0\);/);
  assert.doesNotMatch(lightingSource(glsl, { ...flags, edges: true }), /finalColor = vec4\(totalLight, 1\.0\);/);
  // DBG-3: without EDGES the pass may be drawn on the canvas, so it mixes its light toward white by the layer's alpha.
  assert.match(lightingSource(glsl, flags), /finalColor = vec4\(mix\(vec3\(1\.0\), totalLight, uColor\.a\), 1\.0\);/);
  assert.doesNotMatch(lightingSource(glsl, flags), /finalColor = vec4\(totalLight, 0\.0\);/);
  assert.match(lightingSource(wgsl, { ...flags, edges: true }), /return vec4<f32>\(totalLight, 0\.0\);/);
  assert.match(lightingSource(wgsl, flags), /return vec4<f32>\(mix\(vec3<f32>\(1\.0\), totalLight, localUniforms\.uColor\.a\), 1\.0\);/);
  // A face's texel keeps alpha 1 either way (its light dithered, N-277).
  assert.match(lightingSource(glsl, { ...flags, edges: true }), /finalColor = vec4\(weedDither\(min\(faceLight\(fragWorld, face, selfId, selfOn\), vec3\(1\.0\)\), ditherAt\), 1\.0\);/);
});

test("OL-14: walls ask for the entities' depth where the light is under the canvas's size and its edges are on", () => {
  const walls = { enabled: true, walls: true, resolution: 0.25 };
  assert.equal(wallEdgesWanted(walls), true, 'walls, the default resolution');
  assert.equal(wallEdgesWanted({ ...walls, resolution: 0.5 }), true);
  assert.equal(wallEdgesWanted({ ...walls, resolution: 1 }), false, "at the canvas's size nothing is stretched");
  assert.equal(wallEdgesWanted({ ...walls, resolution: undefined }), false, "no resolution is the canvas's size");
  assert.equal(wallEdgesWanted({ ...walls, lightEdges: false }), false, 'the scene turned the edges off');
  assert.equal(wallEdgesWanted({ ...walls, walls: false }), false, 'no walls');
  assert.equal(wallEdgesWanted({ ...walls, enabled: false }), false, 'no lighting');
  assert.equal(wallEdgesWanted(undefined), false);
});

test("a light splat's host draws it in RGB alone: Pixi's colour mask is 14 on WebGL (red 8 ... alpha 1), 7 on WebGPU's writeMask", () => {
  for (const [useWebGpu, rgb] of [[false, 14], [true, 7]]) {
    const calls = [];
    const renderer = { colorMask: { setMask: (m) => calls.push(m) } };
    const host = rgbOnlyHost(new Container(), useWebGpu);
    const steps = host.children.filter((c) => typeof c.render === 'function');
    steps.forEach((s) => s.render(renderer));
    assert.deepEqual(calls, [rgb, 15], useWebGpu ? 'WebGPU' : 'WebGL');
  }
});
