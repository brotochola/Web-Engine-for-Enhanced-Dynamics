import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PIXEL_DEPTH_FLOOR_STEPS, gbufDepthFragment, gbufDepthVertex, gbufDepthWgsl, pixelDepthVertex } from '../../src/render/pixelDepth.js';
import { pixelDepthValue } from '../reference/renderMathJs.mjs';
import { faceGbufFragment, faceMapVertex, faceMapWgsl, faceUnshadedFragment, gbufAttributeWgsl } from '../../src/render/faceMap.js';
import { spriteIndexedVertex, spriteIndexedWgsl } from '../../src/render/spriteIndexed.js';
import { readEngineShader } from './engineShaderSources.mjs';

const shader = readEngineShader;
const count = (s, part) => s.split(part).length - 1;

// N-274: the G-buffer's one pass (the face map and the ids map) takes the colour pass's depth, so the light reads the
// surface the canvas shows at each texel: before, a wall the painter drew after a house in front of it gave the house its
// shading and its shadows.

test('N-274: the G-buffer\'s vertex passes on the floor place and painter step the colour pass\'s depth works out', () => {
  for (const name of ['instancedSprite.vert.glsl']) {
    const v = gbufDepthVertex(faceMapVertex(shader(name), { gbuf: true }));
    assert.equal(count(v, 'out float vGbufFloor;'), 1, name);
    // N-262: the painter step, the foot and its feet's half depth in one flat vec3.
    assert.equal(count(v, 'flat out vec3 vGbufPainter;'), 1, name);
    assert.match(v, /vec4 uDepth = vec4\(1\.0 \/ uFaceSpace\.y, uFaceSpace\.x, uFaceSpace\.z, uFaceSpace\.w\);/, name);
    assert.match(v, /depthFloor = \(world\.y \+ uDepth\.y \* dfZ\) \* uDepth\.x \+ dfInner \* 0\.2500;/, `${name}: a face's plane and its innerZ tie`);
    assert.match(v, /gbufFootRy = footBase\.x > 0\.0 && footBase\.y > 0\.0 \? 0\.6 \* footBase\.y \* abs\(aInstScale\.x\) : 0\.0;/, name);
    assert.match(v, /vGbufFloor = depthFloor;/, name);
    // N-450: the foot the painter sorts it at (a decoration's depth foot code), as the colour pass's.
    assert.match(v, /vGbufPainter = vec3\(depthPainter, depthFootY \* uDepth\.x, gbufFootRy\);/, name);
    assert.match(v, /float depthFloor = depthFootY \* uDepth\.x;/, name);
  }
  // The indexed form keeps it (its pose comes from the statics; the depth reads the same names).
  const indexed = spriteIndexedVertex(gbufDepthVertex(faceMapVertex(shader('instancedSprite.vert.glsl'), { gbuf: true })));
  assert.match(indexed, /vGbufFloor = depthFloor;/);
  assert.throws(() => gbufDepthVertex('void main() {\n}\n'), /G-buffer's depth/);
});

test('N-189: the painter step counts from the first instance in the colour pass and the G-buffer pass (WebGL)', () => {
  const painter = '(gl_InstanceID + uWeedFirstInstance) & 127';
  for (const name of ['instancedSprite.vert.glsl']) {
    const g = gbufDepthVertex(faceMapVertex(shader(name), { gbuf: true }));
    assert.equal(count(g, 'uniform int uWeedFirstInstance;'), 1, `${name}: the G-buffer pass declares it once`);
    assert.ok(g.includes(`float depthPainter = float(${painter});`), name);
    for (const faces of [false, true]) {
      const v = pixelDepthVertex(shader(name), { gbuf: true, faces, cull: faces ? 'heights' : 'none' });
      assert.equal(count(v, 'uniform int uWeedFirstInstance;'), 1, `${name} faces ${faces}: the colour pass declares it once`);
      assert.ok(v.includes(`vPainter = vec2(float(${painter}), abs(aInstScale.y));`), `${name} faces ${faces}`);
      assert.doesNotMatch(v, /float\(gl_InstanceID &/, `${name} faces ${faces}: no step from the draw's own index`);
      if (faces) assert.ok(v.includes(`float depthPainter = float(${painter});`), name);
    }
  }
});

test('N-274: the G-buffer\'s fragment writes that depth for every texel past its alpha cut', () => {
  for (const unshaded of [false, true]) {
    const f = gbufDepthFragment(faceGbufFragment(shader('faceMap.frag.glsl'), { unshaded }));
    const cut = f.indexOf('  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;\n');
    const write = f.indexOf('  gl_FragDepth = weedGbufDepth(uv);\n');
    assert.ok(cut > 0 && write > cut, 'right after the cut');
    // Before any other way out of main (the unshaded texel's early return, the discards past the cut).
    const main = f.indexOf('void main() {');
    assert.ok(f.indexOf('return;', main) < 0 || f.indexOf('return;', main) > write, 'before any return');
    assert.match(f, /if \(twinPresent\(md\) && twinHeights\(vMapsWin\) && !glow\) \{\n {4}floorY = \(vWorld\.y \+ uDepth\.y \* twinZ\(md\) \* vMapScale\) \* uDepth\.x;/);
    // N-262: within the feet's footprint, as the colour pass's (the foot and its half depth in vGbufPainter's y, z).
    assert.match(f, /if \(vGbufPainter\.z > 0\.0\) floorY = clamp\(floorY, vGbufPainter\.y - vGbufPainter\.z, vGbufPainter\.y \+ vGbufPainter\.z\);/);
    assert.equal(count(f, 'gl_FragDepth'), 1);
  }
});

test('N-274: the G-buffer\'s WGSL writes frag_depth from the one pass\'s entry, its vertex outputs at free locations', () => {
  const words = (name) => gbufAttributeWgsl(shader(name));
  for (const source of [
    faceMapWgsl(words('instancedSprite.wgsl'), { gbuf: true, unshaded: true }),
    spriteIndexedWgsl(faceMapWgsl(words('instancedSprite.wgsl'), { gbuf: true })),
  ]) {
    const w = gbufDepthWgsl(source);
    assert.match(w, /@builtin\(frag_depth\) depth: f32,/);
    assert.match(w, /fn mainFragGbuf\(in: VertexOut\) -> WeedGbufOut \{\n {2}var o: WeedGbufOut;\n {2}o\.depth = weedGbufDepth\(in\);/);
    assert.equal(count(w, '@builtin(instance_index) weedInstance: u32'), 1);
    // N-262: the foot clamp, its terms in vGbufPainter's y, z (no new output: the 16 are taken).
    assert.ok(w.includes('out.vGbufPainter = vec3<f32>(depthPainter, depthFootY * weedDepth.x, footRy);'));
    assert.ok(w.includes('var depthFloor = depthFootY * weedDepth.x;'), 'N-450: the foot the painter sorts it at');
    assert.ok(w.includes('if (gp.z > 0.0) { floorY = clamp(floorY, gp.y - gp.z, gp.y + gp.z); }'));
    const out = w.slice(w.indexOf('struct VertexOut {'), w.indexOf('}', w.indexOf('struct VertexOut {')));
    const locations = [...out.matchAll(/@location\((\d+)\)/g)].map((m) => +m[1]);
    assert.ok(Math.max(...locations) <= 15 && new Set(locations).size === locations.length, `within 16 outputs, each its own: ${locations}`);
  }
});

test('N-274: in that depth a texel nearer the camera on the floor, or on a higher band, wins (less)', () => {
  // pixelDepthValue's continuous form is the G-buffer's (DEPTH_FORMULA_FACES): the house in front of a wall the painter
  // drew later is the smaller depth, so the depth test keeps it whatever the draw order.
  const wallBehind = pixelDepthValue(0, 0.40, 0, true);
  const houseInFront = pixelDepthValue(0, 0.42, 0, true);
  assert.ok(houseInFront < wallBehind);
  assert.ok(pixelDepthValue(1, 0.1, 0, true) < pixelDepthValue(0, 0.9, 0, true), 'a higher zIndex band first');
});

test('N-266: the G-buffer\'s and the unshaded passes take the colour pass\'s formula: stepped without faces, continuous with them', () => {
  const frag = faceGbufFragment(shader('faceMap.frag.glsl'), { unshaded: true });
  assert.match(gbufDepthFragment(frag, { faces: false }), /floor\(u \* \d+\.0\)/, 'without faces, the floor place in steps');
  assert.doesNotMatch(gbufDepthFragment(frag, { faces: true }), /floor\(u \* /, 'with faces, continuous');
  const wgsl = faceMapWgsl(gbufAttributeWgsl(shader('instancedSprite.wgsl')), { gbuf: true, unshaded: true });
  assert.match(gbufDepthWgsl(wgsl, { faces: false }), /floor\(u \* \d+\.0\)/);
  assert.doesNotMatch(gbufDepthWgsl(wgsl, { faces: true }), /floor\(u \* /);
  // In the stepped form two places within one step tie and the painter's order decides, as on the canvas: the later
  // instance in front. The continuous form let the place decide, so a lamp post 3 px before a person lost rows to them.
  const step = 1 / (PIXEL_DEPTH_FLOOR_STEPS - 1);
  const u = 3000 * step;
  assert.ok(pixelDepthValue(0, u + step * 0.2, 2, false) > pixelDepthValue(0, u + step * 0.1, 9, false), 'stepped: the painter');
  assert.ok(pixelDepthValue(0, u + step * 0.2, 2, true) < pixelDepthValue(0, u + step * 0.1, 9, true), 'continuous: the place');
});

test('N-266: with pixel depth the unshaded pass is the colour pass\'s two passes, opaque writing and edges testing', () => {
  // Without depth, as before: every texel, its colour if unshaded, black with its alpha if not.
  assert.doesNotMatch(faceUnshadedFragment(), /discard/);
  // The opaque one: the solid texels that are not unshaded, black, writing the depth after the cut.
  const opaque = gbufDepthFragment(faceUnshadedFragment({ depth: true }));
  const cut = opaque.indexOf('  if (texture(uTexture, uv).a * vColor.a < 0.5) discard;\n');
  const write = opaque.indexOf('  gl_FragDepth = weedGbufDepth(uv);\n');
  const notUnshaded = opaque.indexOf('  if (unshadedOf(vGbuf) > 0.0) discard;\n');
  assert.ok(cut > 0 && write > cut && notUnshaded > write);
  assert.match(opaque, /flat in float vMapScale;\nuniform vec4 uFaceSpace;/);
  // The edge one: the soft texels and the unshaded ones, the depth written for its test (the state writes none).
  const edge = gbufDepthFragment(faceUnshadedFragment({ depth: true, edge: true }));
  const edgeCut = edge.indexOf('  if (ad <= 0.0 || (ad >= 0.5 && unshadedOf(vGbuf) <= 0.0)) discard;\n');
  assert.ok(edgeCut > 0 && edge.indexOf('  gl_FragDepth = weedGbufDepth(uv);\n') > edgeCut);
  // WGSL: the one pass and both unshaded entries write frag_depth.
  const words = gbufAttributeWgsl(shader('instancedSprite.wgsl'));
  const w = gbufDepthWgsl(faceMapWgsl(words, { gbuf: true, unshaded: true }));
  assert.match(w, /fn mainFragUnshaded\(in: VertexOut\) -> WeedUnshadedOut \{/);
  assert.match(w, /@fragment\nfn mainFragUnshadedEdge\(in: VertexOut\) -> WeedUnshadedOut \{/);
  assert.equal(count(w, 'o.depth = weedGbufDepth(in);'), 3, 'the one pass and the two unshaded entries');
});
