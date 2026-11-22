/** DX-FACES: what a decoration says about its face, what the shaders are made of, on the real sources. */
import { HEIGHT_UNITS } from '../../src/render/spriteMaps.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  FACE_DEFAULTS,
  lightingSource,
  decodeFaceNormal,
  encodeFaceHeight,
  encodeFaceNormal,
  faceFragmentGlsl,
  faceMapVertex,
  faceMapWgsl,
  resolveFaces,
  shaderWithFlag,
} from '../../src/render/faceMap.js';
import { spriteIndexedVertex, spriteIndexedWgsl } from '../../src/render/spriteIndexed.js';
import { twinGlsl, twinPresent, twinWgsl, twinZ } from '../../src/render/twinTexel.js';
import { turnFrameNormal } from '../reference/renderMathJs.mjs';

const TWIN_GLSL = twinGlsl('A');
const TWIN_WGSL = twinWgsl('A');
import { encodeOctahedral, twinTexels } from '../../src/render/spriteMaps.js';
import { pixelDepthFragment, pixelDepthWgsl } from '../../src/render/pixelDepth.js';
import { sunMapColumnsVertex, sunMapColumnsWgsl } from '../../src/render/sunShadowMap.js';
import { lampMapColumnsVertex, lampMapColumnsWgsl } from '../../src/render/lampShadowMap.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { buildPoolScene } from '../helpers/poolScene.mjs';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');

const angleDeg = (a, b) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

// N-271: 12 bits a component, so that pieces anchored apart on one wall keep one plane in the depth.
test('a normal comes back within a tenth of a degree, whichever way it looks, and no code has a zero half', () => {
  const out = [0, 0, 0];
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < 20000; i++) {
    const v = [r(), r(), r()];
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    const n = v.map((c) => c / len);
    const code = encodeFaceNormal(n[0], n[1], n[2]);
    assert.ok(code >>> 12 > 0 && (code & 4095) > 0 && code < 1 << 24, `code ${code} would read as no face`);
    assert.ok(angleDeg(n, decodeFaceNormal(code, out)) < 0.1, `${n} came back as ${out}`);
  }
});

test('walls on the axes and at 45 degrees come back exact', () => {
  const s = Math.SQRT1_2;
  const out = [0, 0, 0];
  for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [s, s, 0], [-s, s, 0], [s, -s, 0], [-s, -s, 0]]) {
    decodeFaceNormal(encodeFaceNormal(n[0], n[1], n[2]), out);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(out[i] - n[i]) < 1e-12, `${n}: ${out}`);
  }
});

test('a normal need not be unit length, and a zero one is no face', () => {
  assert.equal(encodeFaceNormal(0, 0, 0), 0);
  assert.equal(encodeFaceNormal(3, 4, 0), encodeFaceNormal(0.6, 0.8, 0));
});

// DX-FACEDEPTH, N-271: 21 bits of height in 1/64 px (32 767 px) and innerZ in the top 3, clamped to 0..7.
test('a height is kept in 64ths of a px in 21 bits, the face\'s innerZ in the top 3', async () => {
  const { decodeFaceHeight, FACE_INNER_Z_SHIFT, FACE_Z_HEIGHT_MAX_CODE } = await import('../../src/render/faceMap.js');
  assert.equal(encodeFaceHeight(0), 0);
  assert.equal(encodeFaceHeight(1.25), 80);
  assert.equal(encodeFaceHeight(-3), 0);
  assert.equal(encodeFaceHeight(1e6), FACE_Z_HEIGHT_MAX_CODE);
  assert.equal(encodeFaceHeight(1.25, 3), (3 << FACE_INNER_Z_SHIFT) | 80);
  assert.equal(encodeFaceHeight(1.25, 9) >>> FACE_INNER_Z_SHIFT, 7, 'innerZ past 7 is 7');
  assert.equal(encodeFaceHeight(1.25, -4), 80, 'a negative innerZ (an attached piece\'s) is 0 on a face');
  assert.deepEqual(decodeFaceHeight(encodeFaceHeight(109.8, 2)), { height: 109.796875, innerZ: 2 });
  assert.ok(encodeFaceHeight(1e6, 7) < 1 << 24, 'a code is exact in a float32');
});

// DX-BARRIOS: no lighting.faces: a scene's light can take faces where it is lit (whether any decoration carries a
// normal is DecorationPool.facesInUse); no wrap, gain or sunDirect (Sun.skyLight).
test('resolveFaces: a lit scene\'s light takes faces, walls or not; an unlit one does not; no wrap, gain or sunDirect', () => {
  assert.deepEqual(resolveFaces(null), { ...FACE_DEFAULTS });
  assert.equal(resolveFaces({ enabled: false }).enabled, false);
  assert.equal(resolveFaces({ enabled: true }).enabled, true);
  assert.equal(resolveFaces({ enabled: true, walls: true }).enabled, true, 'a scene with walls keeps them');
  // A scene may still carry the retired key (it is told so, and it stays in its config): nothing reads it.
  assert.equal(resolveFaces({ enabled: true, raycasted: true }).enabled, true, 'lighting.raycasted is not read');
  const on = resolveFaces({ enabled: true, faces: { enabled: false, wrap: 0.5 } });
  assert.equal(on.enabled, true, 'the old switch is not read');
  assert.deepEqual(Object.keys(on).sort(), ['enabled', 'heightScaleY']);
});

// DX-BARRIOS: a decoration with a normal turns the faces-in-use word on, for good; one without leaves it.
test('the first decoration with a face normal turns faces on, and nothing turns them off', async () => {
  buildPoolScene({ decorations: 8 });
  assert.equal(DecorationPool.facesInUse(), false);
  const plain = DecorationPool.spawn({ x: 1, y: 1 });
  assert.equal(DecorationPool.facesInUse(), false, 'no normal, no faces');
  DecorationPool.spawn({ x: 2, y: 2, faceNormalX: 0, faceNormalY: 0, faceNormalZ: 0 });
  assert.equal(DecorationPool.facesInUse(), false, 'a zero normal is no face');
  const face = DecorationPool.spawn({ x: 3, y: 3, faceNormalX: 0, faceNormalY: 1, faceNormalZ: 0, faceHeight: 10 });
  assert.equal(DecorationPool.facesInUse(), true);
  DecorationPool.despawn(face);
  DecorationPool.despawn(plain);
  assert.equal(DecorationPool.facesInUse(), true, 'for good');
});

test('without faces the light pass is the old one: no face code left in either shader', () => {
  for (const name of ['lightingBasic.frag.glsl', 'lightingBasic.wgsl']) {
    const source = shader(name);
    const off = lightingSource(source, { faces: false, sunMap: false });
    assert.doesNotMatch(off, /uFace|faceLight|uSunMap|#if|#endif/, name);
    const on = lightingSource(source, { faces: true, sunMap: false });
    assert.match(on, /uFaceMap/, name);
    assert.doesNotMatch(on, /#if|#endif/, name);
  }
});

test('the face map is made from every sprite vertex shader the batch uses', () => {
  for (const name of ['instancedSprite.vert.glsl', 'instancedSpritePose.vert.glsl']) {
    const v = faceMapVertex(shader(name));
    assert.match(v, /flat out vec2 vFaceOct;/, name);
    assert.match(v, /vFaceZ = float\(faceHeight & \d+u\) \/ [\d.]+ \+ faceDz;/, name);
  }
  const indexed = spriteIndexedVertex(faceMapVertex(shader('instancedSprite.vert.glsl')));
  assert.match(indexed, /vFaceZ = float\(faceHeight & \d+u\) \/ [\d.]+ \+ faceDz;/);
  assert.throws(() => faceMapVertex('void main() {\n}\n'), /vTileOff/);
  for (const name of ['instancedSprite.wgsl', 'instancedSpritePose.wgsl']) {
    const w = faceMapWgsl(shader(name));
    assert.match(w, /fn mainFragFace/, name);
    assert.match(w, /@interpolate\(flat\) vFaceOct/, name);
  }
  assert.match(spriteIndexedWgsl(faceMapWgsl(shader('instancedSprite.wgsl'))), /fn mainFragFace/);
  assert.throws(() => faceMapWgsl('struct S {}\n'), /uTileWorld/);
});

test('the height scale of the shaders is the encoder\'s', () => {
  // N-271: a face's code reaches the vertex as code / 65536 in a float32 (gpuPack.c TILE_OFF_SCALE), which it reads back
  // whole; its height is the low 21 bits in 1/64 px, innerZ above them.
  const v = faceMapVertex(shader('instancedSprite.vert.glsl'));
  const [, scale, mask, units] = v.match(/uint faceHeight = uint\(aInstTileOff\.y \* ([\d.]+) \+ 0\.5\);\n\s*vFaceZ = float\(faceHeight & (\d+)u\) \/ ([\d.]+) \+ faceDz;/).map(Number);
  for (const [z, k] of [[100, 0], [100, 5], [0.015625, 7], [32767.984375, 7], [3.2, 1]]) {
    const code = encodeFaceHeight(z, k);
    const read = Math.floor(Math.fround(code / 65536) * scale + 0.5);
    assert.equal(read, code, `${z}, ${k}: the code comes back whole`);
    assert.ok(Math.abs((read & mask) / units - z) <= 1 / 128, `${z}, ${k}`);
  }
  assert.match(shader('faceMap.frag.glsl'), /clamp\(z \* 8\.0/);
  // DX-MAPS: a twin texel's height is in spriteMaps.js's units (twinTexel.js twinZ; N-194: times the sprite's scale where
  // it is written).
  for (const twin of [TWIN_GLSL, TWIN_WGSL]) assert.match(twin, new RegExp(`\\) / ${HEIGHT_UNITS}\\.0;`));
  // N-257: a frame's own heights where it has them (twinHeights), its surface's or the floor's where it does not.
  assert.match(faceFragmentGlsl(shader('faceMap.frag.glsl')), /z = twinHeights\(vMapsWin\) \? twinZ\(m\) \* vMapScale : 0\.0;/);
  assert.match(faceMapWgsl(shader('instancedSprite.wgsl')), /z = select\(0\.0, twinZ\(m\) \* in\.vMapScale, twinHeights\(in\.vMapsWin\)\);/);
  assert.match(faceFragmentGlsl(shader('faceMap.frag.glsl'), { gbuf: true }), /float zw = twinHeights\(vMapsWin\) \? zm \* vMapScale/);
  assert.match(shader('lightingBasic.frag.glsl'), /\/ 8\.0;/);
});

test('a decoration spawned with a face holds it, and its slot does not hand it to the next one', () => {
  buildPoolScene({ decorations: 8 });
  const D = DecorationComponent;
  const wall = DecorationPool.spawn({ x: 10, y: 20, faceNormalX: 0, faceNormalY: 1, faceNormalZ: 0, faceHeight: 40 });
  assert.equal(D.faceOct[wall], encodeFaceNormal(0, 1, 0));
  assert.equal(D.faceZ[wall], encodeFaceHeight(40));
  const plain = DecorationPool.spawn({ x: 10, y: 20 });
  assert.equal(D.faceOct[plain], 0, 'no normal, no face');
  assert.ok(DecorationPool.despawn(wall));
  const next = DecorationPool.spawn({ x: 1, y: 1 });
  assert.equal(next, wall, 'the test needs the slot back');
  assert.equal(D.faceOct[next], 0);
});

test('spawnMany takes a face per decoration', () => {
  buildPoolScene({ decorations: 8 });
  const D = DecorationComponent;
  const out = new Int32Array(3);
  const made = DecorationPool.spawnMany({
    x: [1, 2, 3],
    y: 5,
    faceNormalX: [1, 0, 0],
    faceNormalY: [0, 1, 0],
    faceNormalZ: [0, 0, 1],
    faceHeight: [10, 20, 30],
    out,
  });
  assert.equal(made, 3);
  assert.deepEqual([...out].map((i) => D.faceOct[i]), [encodeFaceNormal(1, 0, 0), encodeFaceNormal(0, 1, 0), encodeFaceNormal(0, 0, 1)]);
  assert.deepEqual([...out].map((i) => D.faceZ[i]), [640, 1280, 1920]);
});

// DX-MAPS on WebGPU: the face pass's WGSL reads the atlas's twin page at group 2's binding 5, and its programs' explicit
// layouts must name it, or the pipeline fails its validation ("Binding doesn't exist", seen on a real GPU).
test('the face programs name the twin page in their WebGPU layout', async () => {
  const { instancedSpriteGpuProgram, instancedSpriteIndexedGpuProgram } = await import('../../src/render/webgpu/instancedSpriteWgsl.js');
  const GpuProgram = { from: (o) => o };
  const wgsl = faceMapWgsl(fs.readFileSync(new URL('../../src/shaders/instancedSprite.wgsl', import.meta.url), 'utf8'));
  assert.match(wgsl, /@group\(2\) @binding\(5\) var uMaps: texture_2d<f32>;/);
  for (const make of [instancedSpriteGpuProgram, instancedSpriteIndexedGpuProgram]) {
    const plain = make(GpuProgram, wgsl, 'mainFragFace', 'p');
    assert.equal(plain.layout[2].uMaps, undefined, `${make.name}: the sprite pass has no maps`);
    assert.ok(!plain.gpuLayout[2].some((e) => e.binding === 5));
    const face = make(GpuProgram, wgsl, 'mainFragFace', 'p', { maps: true });
    assert.equal(face.layout[2].uMaps, 5, `${make.name}: the face pass's maps`);
    const entry = face.gpuLayout[2].find((e) => e.binding === 5);
    assert.equal(entry.texture.sampleType, 'unfilterable-float', 'read with textureLoad');
  }
});

// DX-GBUF (plan §5.4): with words, the face programs read each instance's (aInstGbuf) and its foot, and their GBUF block
// writes an entity's sprite as its normals and surface say; without, they are the face map's programs as they were.
test('the face programs take the G-buffer words only when the batch carries them', async () => {
  const { FACE_FLAT_CODE, FACE_K_BIT, faceFragmentGlsl, gbufAttributeWgsl } = await import('../../src/render/faceMap.js');
  const vert = shader('instancedSprite.vert.glsl');
  assert.doesNotMatch(faceMapVertex(vert), /aInstGbuf|vFootY/);
  const on = faceMapVertex(vert, { gbuf: true });
  assert.match(on, /in vec3 aInstGbuf;/);
  assert.match(on, /flat out vec2 vGbuf;/);
  // N-275: an owned decoration stands on its owner's foot (the words' z), any other row on its own.
  assert.match(on, /vFootY = aInstGbuf\.z > -1\.0e29 \? aInstGbuf\.z\s*: world\.y - /);
  assert.match(spriteIndexedVertex(faceMapVertex(vert, { gbuf: true })), /vFootY = /, 'the indexed form keeps them');
  const frag = shader('faceMap.frag.glsl');
  assert.doesNotMatch(faceFragmentGlsl(frag), /vGbuf|#if|discard;\n\s*\/\/ #endif/);
  assert.match(faceFragmentGlsl(frag, { gbuf: true }), /flat in vec2 vGbuf;/);
  // DX-UNSHADED: without the unshaded pass an unshaded pixel writes the face map's code; with it, nothing. The sheet's mark
  // (the maps table's) comes before the face branch: an unshaded face is unshaded; the entity's word (its bit 21) too.
  assert.match(faceFragmentGlsl(frag), /finalColor = vec4\(1\.0 \/ 255\.0, 0\.0, 0\.0, 0\.0\);/);
  assert.doesNotMatch(faceFragmentGlsl(frag, { unshaded: true }), /finalColor = vec4\(1\.0 \/ 255\.0, 0\.0, 0\.0, 0\.0\);/);
  const withPass = faceFragmentGlsl(frag, { gbuf: true, unshaded: true });
  assert.match(withPass, /\(\(word >> 21u\) & 1u\) != 0u\) discard;/);
  assert.ok(withPass.indexOf('if (twinUnshaded(vMapsWin))') < withPass.indexOf('vec2 oct = vFaceOct;'), 'before the face branch');
  assert.doesNotMatch(withPass, /254\.5 \/ 255\.0/, 'no code in the twin page any more');
  assert.ok(frag.includes(`vec2(${FACE_FLAT_CODE}.0 / 255.0)`), 'the FLAT code');
  assert.ok(frag.includes(`${FACE_K_BIT - 1}.0)) + (k ? ${FACE_K_BIT}.0`), 'heights of 15 bits and the k bit');
  for (const name of ['instancedSprite.wgsl', 'instancedSpritePose.wgsl']) {
    const off = faceMapWgsl(shader(name));
    assert.doesNotMatch(off, /aInstGbuf|vGbuf/, name);
    const w = faceMapWgsl(shader(name), { gbuf: true });
    assert.match(w, /@location\(12\) aInstGbuf: vec3<f32>,/, name);
    assert.match(w, /@location\(9\) @interpolate\(flat\) vGbuf: vec2<f32>,/, name);
    assert.match(w, /fn faceHeightNormal/, name);
    assert.equal(gbufAttributeWgsl(w), w, 'declared once');
  }
  assert.match(spriteIndexedWgsl(faceMapWgsl(shader('instancedSprite.wgsl'), { gbuf: true })), /aInstGbuf: vec3<f32>/);
  assert.match(gbufAttributeWgsl(shader('instancedSprite.wgsl')), /@location\(12\) aInstGbuf/);
});

// A colour program without pixel depth reads no words, yet the batch's geometry carries them: WebGL dropped the unread
// input and Pixi warned of aInstGbuf ("not present in the shader") in every map-mode scene without maps.
test('a GLSL colour program takes the G-buffer words, read or not, once, in every sprite form', async () => {
  const { gbufAttributeGlsl } = await import('../../src/render/faceMap.js');
  for (const name of ['instancedSprite.vert.glsl', 'instancedSpritePose.vert.glsl']) {
    for (const [form, src] of [['plain', shader(name)], ['indexed', spriteIndexedVertex(shader(name))]]) {
      const out = gbufAttributeGlsl(src);
      assert.equal(out.split('in vec3 aInstGbuf;').length, 2, `${name} ${form}: declared once`);
      assert.ok(out.includes('  if (aInstGbuf.x < -1.0) gl_Position.x += aInstGbuf.y;\n'), `${name} ${form}: kept alive`);
      assert.ok(out.indexOf('in vec3 aInstGbuf;') < out.indexOf('void main() {'), `${name} ${form}: at global scope`);
      assert.equal(gbufAttributeGlsl(out), out, `${name} ${form}: twice is once`);
    }
  }
  const face = faceMapVertex(shader('instancedSprite.vert.glsl'), { gbuf: true });
  assert.equal(gbufAttributeGlsl(face), face, 'a program that reads the words is left as it is');
  assert.throws(() => gbufAttributeGlsl('void main() {\n}\n'), /gl_Position/);
});

test('the light pass reads a FLAT pixel and the k bit in both languages, and masks the bit from a height', () => {
  for (const name of ['lightingBasic.frag.glsl', 'lightingBasic.wgsl']) {
    const on = lightingSource(shader(name), { faces: true, sunMap: true, selfShadow: true, lampMap: true });
    assert.match(on, /253\.5 \/ 255\.0/, `${name}: the FLAT code`);
    assert.match(on, /32768\.0/, `${name}: the k bit`);
    assert.match(on, /lampDrawn/, `${name}: the lamps lit as drawn`);
  }
});

test('the G-buffer in one pass (MRT) writes the face texel at location 0 and the ids texel at 1, in both languages', async () => {
  const { faceGbufFragment } = await import('../../src/render/faceMap.js');
  const frag = faceGbufFragment(shader('faceMap.frag.glsl'));
  assert.match(frag, /layout\(location = 0\) out vec4 finalColor;/);
  assert.match(frag, /layout\(location = 1\) out vec4 finalIds;/);
  assert.match(frag, /finalIds = idsTexel\(vGbuf, vRender > 0\.5\);/);
  assert.doesNotMatch(frag, /#if/);
  const wgsl = faceMapWgsl(shader('instancedSprite.wgsl'), { gbuf: true });
  assert.match(wgsl, /fn mainFragGbuf\(in: VertexOut\) -> WeedGbufOut/);
  assert.match(wgsl, /@location\(1\) ids: vec4<f32>,/);
});

// E-457: the unshaded mask draws only the instances that can be unshaded (their word's unshaded bit, or their frame's sheet's
// mark in the maps table) and marks only the pixels where they add colour; every other pass keeps its vertices.
test('the unshaded mask leaves out the instances that cannot be unshaded, in every sprite form and both languages', async () => {
  const { faceUnshadedMaskFragment, unshadedMaskVertex } = await import('../../src/render/faceMap.js');
  const cut = /& 1u\) == 0u && !twinUnshaded\(twinWindow\(int\(aInstTexId \+ 0\.5\)\)\)\) gl_Position = vec4\(2\.0, 2\.0, 2\.0, 1\.0\);/;
  for (const name of ['instancedSprite.vert.glsl', 'instancedSpritePose.vert.glsl']) {
    const plain = faceMapVertex(shader(name), { gbuf: true });
    assert.doesNotMatch(plain, /2\.0, 2\.0, 2\.0, 1\.0/, name);
    const mask = unshadedMaskVertex(plain);
    assert.match(mask, cut, name);
    assert.ok(mask.indexOf('bool twinUnshaded(vec4 win)') < mask.indexOf('void main()'), 'the marks before main');
    // The cut comes after the place is computed, so the mask covers what the unshaded pass draws.
    assert.ok(mask.indexOf('gl_Position = vec4(2.0') > mask.indexOf('gl_Position = vec4(clip.xy'), name);
  }
  const vert = faceMapVertex(shader('instancedSprite.vert.glsl'), { gbuf: true });
  assert.match(spriteIndexedVertex(unshadedMaskVertex(vert)), cut, 'indexed');
  assert.match(spriteIndexedVertex(unshadedMaskVertex(vert), { poseBlock: 1024 }), cut, 'by row');
  assert.throws(() => unshadedMaskVertex('void main() {\n}\n'), /vTileOff/);
  // A whole quad, no work a pixel: no discard and no texture read.
  const frag = faceUnshadedMaskFragment();
  assert.doesNotMatch(frag, /discard|texture\(/);
  for (const name of ['instancedSprite.wgsl', 'instancedSpritePose.wgsl']) {
    assert.doesNotMatch(faceMapWgsl(shader(name), { gbuf: true, unshaded: true }), /vec4<f32>\(2\.0, 2\.0, 2\.0, 1\.0\)/, name);
    const w = faceMapWgsl(shader(name), { gbuf: true, unshaded: true, unshadedMask: true });
    assert.match(w, /& 1u\) == 0u && !twinUnshaded\(twinWindow\(tid\)\)\) \{ out\.position = vec4<f32>\(2\.0, 2\.0, 2\.0, 1\.0\); \}/, name);
    assert.match(w, /fn mainFragUnshadedMask\(in: VertexOut\)/, name);
    assert.ok(w.indexOf('out.position = vec4<f32>(2.0') > w.indexOf('out.position = vec4<f32>(clip.xy'), name);
  }
  const wcut = /out\.position = vec4<f32>\(2\.0, 2\.0, 2\.0, 1\.0\)/;
  assert.match(spriteIndexedWgsl(faceMapWgsl(shader('instancedSprite.wgsl'), { gbuf: true, unshadedMask: true })), wcut);
  assert.doesNotMatch(faceMapWgsl(shader('instancedSprite.wgsl'), { unshadedMask: true }), wcut, 'no words, no mask');
});

// DX-MAPS: one twinPresent (twinTexel.js) says "this twin texel holds a map" for every reader, in both languages, and it
// agrees with the texels spriteMaps.js writes: a mapped texel's normal bytes are 1..253, an unmapped texel is all zeros.
test('every reader of the twin page asks twinTexel.js whether a texel holds a map, and the texels agree', () => {
  const height = new Float32Array([0, 12.5, 40]);
  const normals = new Float32Array([0, 0, 1, 0.3, 0.2, 0.9, -1, 0, 0]);
  const texels = twinTexels(height, normals, new Uint8Array([1, 1, 0]), 3, 1);
  assert.equal(twinPresent(texels, 0), true, 'a height-0 opaque texel still holds a map (its normal)');
  assert.equal(twinPresent(texels, 4), true);
  assert.equal(twinPresent(texels, 8), false, 'a transparent pixel holds none');
  assert.equal(twinZ(texels, 4), 12.5);
  const oct = [0, 0];
  encodeOctahedral(0, 0, -1, oct, 0);
  assert.ok(oct[0] > 0 || oct[1] > 0, 'no normal encodes to two zero bytes');
  const sh = (n) => shader(n);
  const readers = {
    face: faceFragmentGlsl(sh('faceMap.frag.glsl'), { gbuf: true }),
    faceWgsl: faceMapWgsl(sh('instancedSprite.wgsl'), { gbuf: true }),
    depth: pixelDepthFragment(sh('instancedSprite.frag.glsl'), { gbuf: true }),
    depthWgsl: pixelDepthWgsl(sh('instancedSprite.wgsl'), { gbuf: true }),
    sun: sunMapColumnsVertex(sh('instancedSpriteShadow.vert.glsl')),
    sunWgsl: sunMapColumnsWgsl(sh('instancedSpriteShadow.wgsl')),
    lamp: lampMapColumnsVertex(sh('instancedSpriteShadow.vert.glsl')),
    lampWgsl: lampMapColumnsWgsl(sh('instancedSpriteShadow.wgsl')),
  };
  for (const [name, src] of Object.entries(readers)) {
    const defs = src.split(name.endsWith('Wgsl') ? 'fn twinPresent(' : 'bool twinPresent(').length - 1;
    assert.equal(defs, 1, `${name}: one twinPresent`);
    assert.ok(src.split('twinPresent(').length - 1 >= 2, `${name}: reads it`);
    const own = src.split(TWIN_GLSL).join('').split(TWIN_WGSL).join('');
    assert.doesNotMatch(own, /\.b \+ m?d?\.a [<>]/, `${name}: no presence test of its own`);
  }
});

// N-258: a mirrored or rotated sprite's normals turn with it in the G-buffer pass. A mirrored car (flipX, a negative scale
// x) lit by a lamp on its left: its frame's normal that faces right must face left on the screen, as its pixels do.
test('a sprite\'s normals mirror with a negative scale and turn with its rotation, in both languages', async () => {
  const out = [0, 0, 0];
  assert.deepEqual(turnFrameNormal([0.6, 0.3, 0.74], 1, 0, 1, 1, out), [0.6, 0.3, 0.74], 'unturned: the same bits');
  assert.deepEqual(turnFrameNormal([0.6, 0.3, 0.74], 1, 0, -1, 1, out), [-0.6, 0.3, 0.74], 'flipX mirrors x');
  assert.deepEqual(turnFrameNormal([0.6, 0.3, 0.74], 1, 0, 1, -1, out), [0.6, -0.3, 0.74], 'flipY mirrors y');
  // A quarter turn on the screen (y down: x goes to screen down) takes a right-facing normal to camera-space down (y up).
  turnFrameNormal([1, 0, 0], 0, 1, 1, 1, out);
  assert.ok(Math.abs(out[0]) < 1e-12 && Math.abs(out[1] + 1) < 1e-12, `a quarter turn: ${out}`);
  // The vertex stage's local x axis under that turn, as instancedSprite.vert.glsl spins it, lands where the normal points.
  const c = 0;
  const s = 1;
  const spun = [1 * c - 0 * s, 1 * s + 0 * c];
  assert.deepEqual([spun[0], -spun[1]], [0, -1], 'screen down is camera-space down');
  const vert = faceMapVertex(shader('instancedSprite.vert.glsl'), { gbuf: true });
  assert.match(vert, /vNormalTurn = vec4\(isShear \? 1\.0 : c, isShear \? 0\.0 : s, aInstScale\.x < 0\.0 \? -1\.0 : 1\.0, aInstScale\.y < 0\.0 \? -1\.0 : 1\.0\);/);
  const frag = faceFragmentGlsl(shader('faceMap.frag.glsl'), { gbuf: true });
  assert.match(frag, /vec3 n = turnNormal\(sobel \? heightNormal\(tc, zm\) : twinStoredNormal\(m, tc\)\);/, 'the map\'s normal and the Sobel\'s alike');
  assert.match(frag, /vec3 n = turnNormal\(TWIN_NORMALS \? twinStoredNormal\(m, tc\) : heightNormal\(tc, twinZ\(m\)\)\);/, 'without words too');
  for (const name of ['instancedSprite.wgsl', 'instancedSpritePose.wgsl']) {
    const w = faceMapWgsl(shader(name), { gbuf: true });
    assert.match(w, /@location\(13\) @interpolate\(flat\) vNormalTurn: vec4<f32>,/, name);
    assert.match(w, /n = turnNormal\(n, in\.vNormalTurn\);/, name);
    assert.match(w, /let n = turnNormal\(stored, in\.vNormalTurn\);/, name);
    // Within WebGPU's 16 vertex outputs (locations 0..15), none used twice.
    const out = w.slice(w.indexOf('struct VertexOut {'), w.indexOf('}', w.indexOf('struct VertexOut {')));
    const locs = [...out.matchAll(/@location\((\d+)\)/g)].map((m) => +m[1]);
    assert.ok(Math.max(...locs) <= 15, name);
    assert.equal(new Set(locs).size, locs.length, `${name}: each output its own location`);
  }
});

// N-257: a sprite with a normal map and no height map (or a relief map) stands as its surface says in the G-buffer, pixel
// depth and the shadow maps: its frame's heights are read only where the maps table marks heights. OL-4: a sprite without
// heights stands as a card only where the camera shows height (uFaceSpace.x, heightScaleY, above 0); straight down or
// from the side it lies on the floor (and nothing divides by that 0).
test('a frame without heights takes its surface\'s height in the G-buffer, depth and the columns; with no height shown it lies on the floor', async () => {
  const frag = faceFragmentGlsl(shader('faceMap.frag.glsl'), { gbuf: true });
  assert.match(frag, /float zw = twinHeights\(vMapsWin\) \? zm \* vMapScale\s*: \(\(flags & 4u\) == 0u && uFaceSpace\.x > 0\.0 \? max\(vFootY - vWorld\.y, 0\.0\) \/ uFaceSpace\.x : 0\.0\);/);
  assert.match(frag, /if \(\(flags & 4u\) == 0u && uFaceSpace\.x > 0\.0\) \{\s*finalColor = faceTexel\(vec2\(254\.0 \/ 255\.0\), max\(vFootY - vWorld\.y, 0\.0\) \/ uFaceSpace\.x, false\);/, 'a sprite without maps too');
  assert.equal(frag.split('/ uFaceSpace.x').length - 1, 2, 'no other card height that divides by heightScaleY');
  for (const name of ['instancedSprite.wgsl', 'instancedSpritePose.wgsl']) {
    const w = faceMapWgsl(shader(name), { gbuf: true });
    assert.match(w, /else if \(\(flags & 4u\) == 0u && uniforms\.uFaceSpace\.x > 0\.0\) \{ zw = max\(in\.vFootY - in\.vWorld\.y, 0\.0\) \/ uniforms\.uFaceSpace\.x; \}/, name);
    assert.match(w, /if \(\(flags & 4u\) == 0u && uniforms\.uFaceSpace\.x > 0\.0\) \{\s*return faceTexel\([^,]+, max\(in\.vFootY - in\.vWorld\.y, 0\.0\) \/ uniforms\.uFaceSpace\.x, false\);/, `${name}: without maps too`);
    assert.equal(w.split('/ uniforms.uFaceSpace.x').length - 1, 2, `${name}: no other card height that divides by heightScaleY`);
  }
  assert.match(frag, /bool sobel = \(normals == 2u \|\| !TWIN_NORMALS\) && \(twinHeights\(vMapsWin\) \|\| twinRelief\(vMapsWin\)\);/);
  const depth = pixelDepthFragment(shader('instancedSprite.frag.glsl'), { gbuf: true });
  assert.match(depth, /if \(twinPresent\(md\) && twinHeights\(vMapsWin\) && !glow\) \{\s*floorY = /);
  assert.match(pixelDepthWgsl(shader('instancedSprite.wgsl'), { gbuf: true }), /if \(twinPresent\(md\) && twinHeights\(in\.vMapsWin\) && !glow\)/);
  assert.match(sunMapColumnsVertex(shader('instancedSpriteShadow.vert.glsl')), /float z = twinHeights\(win\) \? twinZ\(m\)/);
  assert.match(lampMapColumnsVertex(shader('instancedSpriteShadow.vert.glsl')), /float z = twinHeights\(win\) \? twinZ\(m\)/);
  assert.match(sunMapColumnsWgsl(shader('instancedSpriteShadow.wgsl')), /let z = select\(0\.0, twinZ\(m\) \* height \* abs\(aInstScale\.y\), twinHeights\(win\)\);/);
  assert.match(lampMapColumnsWgsl(shader('instancedSpriteShadow.wgsl')), /let z = select\(0\.0, twinZ\(m\) \* height \* abs\(aInstScale\.y\), twinHeights\(win\)\);/);
});

// DX-FACEDEPTH: spawnMany takes innerZ one a decoration; a face carries it in its height's top bits (0..7), and it still
// sorts the decoration (DecorationComponent.innerZ) as it always did.
test('spawnMany takes innerZ a decoration, and a face carries it in its row', () => {
  buildPoolScene({ decorations: 8 });
  const D = DecorationComponent;
  const out = new Int32Array(3);
  const n = DecorationPool.spawnMany({
    x: [0, 1, 2], y: [0, 0, 0], innerZ: [0, 2, 9],
    faceNormalX: [0, 0, 0], faceNormalY: [1, 1, 1], faceNormalZ: [0, 0, 0], faceHeight: [20, 20, 20], out,
  });
  assert.equal(n, 3);
  assert.deepEqual([...out].map((i) => D.faceZ[i] >>> 21), [0, 2, 7], 'innerZ in the top bits, 7 at most');
  assert.deepEqual([...out].map((i) => (D.faceZ[i] & 2097151) / 64), [20, 20, 20], 'the height below');
  assert.deepEqual([...out].map((i) => D.innerZ[i]), [0, 2, 9], 'the sort keeps its own innerZ');
});
