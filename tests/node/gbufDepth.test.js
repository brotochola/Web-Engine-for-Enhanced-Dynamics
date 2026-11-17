import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { gbufDepthFragment, gbufDepthVertex, gbufDepthWgsl, pixelDepthValue } from '../../src/render/pixelDepth.js';
import { faceGbufFragment, faceMapVertex, faceMapWgsl, gbufAttributeWgsl } from '../../src/render/faceMap.js';
import { spriteIndexedVertex, spriteIndexedWgsl } from '../../src/render/spriteIndexed.js';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');
const count = (s, part) => s.split(part).length - 1;

// N-274: the G-buffer's one pass (the face map and the ids map) takes the colour pass's depth, so the light reads the
// surface the canvas shows at each texel: before, a wall the painter drew after a house in front of it gave the house its
// shading and its shadows.

test('N-274: the G-buffer\'s vertex passes on the floor place and painter step the colour pass\'s depth works out', () => {
  for (const name of ['instancedSprite.vert.glsl', 'instancedSpritePose.vert.glsl']) {
    const v = gbufDepthVertex(faceMapVertex(shader(name), { gbuf: true }));
    assert.equal(count(v, 'out float vGbufFloor;'), 1, name);
    assert.equal(count(v, 'flat out float vGbufPainter;'), 1, name);
    assert.match(v, /vec4 uDepth = vec4\(1\.0 \/ uFaceSpace\.y, uFaceSpace\.x, uFaceSpace\.z, uFaceSpace\.w\);/, name);
    assert.match(v, /depthFloor = \(world\.y \+ uDepth\.y \* dfZ\) \* uDepth\.x \+ dfInner \* 0\.2500;/, `${name}: a face's plane and its innerZ tie`);
    assert.match(v, /vGbufFloor = depthFloor;\n\s*vGbufPainter = depthPainter;/, name);
  }
  // The indexed form keeps it (its pose comes from the statics; the depth reads the same names).
  const indexed = spriteIndexedVertex(gbufDepthVertex(faceMapVertex(shader('instancedSprite.vert.glsl'), { gbuf: true })));
  assert.match(indexed, /vGbufFloor = depthFloor;/);
  assert.throws(() => gbufDepthVertex('void main() {\n}\n'), /G-buffer's depth/);
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
    assert.match(f, /if \(twinPresent\(md\) && twinHeights\(vMapsWin\) && !glow\) floorY = \(vWorld\.y \+ uDepth\.y \* twinZ\(md\) \* vMapScale\) \* uDepth\.x;/);
    assert.equal(count(f, 'gl_FragDepth'), 1);
  }
});

test('N-274: the G-buffer\'s WGSL writes frag_depth from the one pass\'s entry, its vertex outputs at free locations', () => {
  const words = (name) => gbufAttributeWgsl(shader(name));
  for (const source of [
    faceMapWgsl(words('instancedSprite.wgsl'), { gbuf: true, unshaded: true }),
    faceMapWgsl(words('instancedSpritePose.wgsl'), { gbuf: true }),
    spriteIndexedWgsl(faceMapWgsl(words('instancedSprite.wgsl'), { gbuf: true })),
  ]) {
    const w = gbufDepthWgsl(source);
    assert.match(w, /@builtin\(frag_depth\) depth: f32,/);
    assert.match(w, /fn mainFragGbuf\(in: VertexOut\) -> WeedGbufOut \{\n {2}var o: WeedGbufOut;\n {2}o\.depth = weedGbufDepth\(in\);/);
    assert.equal(count(w, '@builtin(instance_index) weedInstance: u32'), 1);
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
