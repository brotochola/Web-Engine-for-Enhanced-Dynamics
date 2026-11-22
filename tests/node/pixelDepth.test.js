/** DX-DEPTH (F5 v2): the depth the entities' pixels write and test (src/render/pixelDepth.js), on the real code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PIXEL_DEPTH_MARGIN,
  pixelDepthFragment,
  pixelDepthTerms,
  pixelDepthVertex,
  pixelDepthWgsl,
} from '../../src/render/pixelDepth.js';
import { pixelDepthValue } from '../reference/renderMathJs.mjs';
import { spriteIndexedWgsl } from '../../src/render/spriteIndexed.js';
import { readEngineShader } from './engineShaderSources.mjs';

const shader = readEngineShader;

test('a higher zIndex band is in front whatever the floor place, a nearer place in front within a band', () => {
  assert.ok(pixelDepthValue(1, 0, 0) < pixelDepthValue(0, 1, 127), 'band first');
  assert.ok(pixelDepthValue(0, 0.6, 0) < pixelDepthValue(0, 0.5, 127), 'then the floor place');
  assert.ok(pixelDepthValue(3, 0.5, 9) < pixelDepthValue(3, 0.5, 8), 'then the painter: a later row in front on a tie');
  assert.ok(pixelDepthValue(0, 0, 0) < 1, 'below the cleared depth');
  assert.equal(pixelDepthValue(7, 1, 127), 0);
  for (const v of [pixelDepthValue(2, 0.37, 77), pixelDepthValue(5, 0.91, 3)]) {
    assert.equal(Math.fround(v), v, 'a float32 the depth buffer keeps');
    assert.equal(Number.isInteger(v * 2 ** 23), true, '23 bits');
  }
});

test('the floor span covers the view and its margin', () => {
  const t = pixelDepthTerms(new Float32Array(4), 0.5, 0.8, 100, 600);
  assert.equal(t[0], 2);
  assert.equal(t[2], 200 - PIXEL_DEPTH_MARGIN);
  assert.ok(Math.abs(t[3] - 1 / (1200 + 2 * PIXEL_DEPTH_MARGIN)) < 1e-9);
});

test('the opaque pass keeps the opaque pixels and the edge pass the others, in both languages', () => {
  const frag = shader('instancedSprite.frag.glsl');
  assert.match(pixelDepthFragment(frag), /if \(!solid\) discard;/);
  assert.match(pixelDepthFragment(frag, { edge: true }), /if \(solid\) discard;/);
  assert.match(pixelDepthFragment(frag, { gbuf: true }), /flat in vec2 vDepthWord;/);
  const vert = pixelDepthVertex(shader('instancedSprite.vert.glsl'), { gbuf: true });
  assert.match(vert, /vPainter = vec2\(float\(\(gl_InstanceID \+ uWeedFirstInstance\) & 127\), abs\(aInstScale\.y\)\);/);
  assert.match(vert, /in vec3 aInstGbuf;/);
  const wgsl = pixelDepthWgsl(shader('instancedSprite.wgsl'));
  assert.match(wgsl, /fn mainFrag\(in: VertexOut\) -> WeedDepthOut/);
  assert.match(wgsl, /fn mainFragEdge\(in: VertexOut\) -> WeedDepthOut/);
  assert.match(wgsl, /@builtin\(instance_index\) weedInstance: u32,/);
});

test('H-EDGE: each pass leaves before the twin page and the depth for the pixels it draws nothing for, in both languages', () => {
  const frag = shader('instancedSprite.frag.glsl');
  // The opaque pass keeps no pixel under alpha 0.5; the edge pass draws one of alpha 0 as nothing (premultiplied 0, no
  // depth written), nor a solid one of a plain frame's instance (no soft or glowing texel, no emissive word: it cannot
  // glow), so neither needs the twin page's texel or the depth for them.
  for (const [edge, early] of [[false, 'if (ad < 0.5) discard;'], [true, 'if (ad <= 0.0 || (ad >= 0.5 && vPlain > 0.5)) discard;']]) {
    for (const gbuf of [false, true]) {
      const src = pixelDepthFragment(frag, { edge, gbuf });
      const at = src.indexOf(early);
      assert.ok(at > 0, `edge ${edge}, gbuf ${gbuf}: ${early}`);
      assert.ok(at > src.indexOf('float ad = texture(uTexture, uvd).a * vColor.a;'), 'after the alpha');
      assert.ok(at < src.indexOf('twinTexel(uvd, vMapsWin)'), 'before the twin page (E-496: through its window)');
      assert.ok(at < src.indexOf('gl_FragDepth ='), 'before the depth');
      assert.match(src, /bool solid = ad >= 0\.5 && !glow;/, 'the pass keeps its pixels as before');
      assert.equal(src.split('texture(uTexture, uvd)').length, 2, 'the alpha read once in the depth body');
    }
  }
  const wgsl = pixelDepthWgsl(shader('instancedSprite.wgsl'), { gbuf: true });
  const early = wgsl.indexOf('if (select(ad < 0.5, ad <= 0.0 || (ad >= 0.5 && in.vPlain > 0.5), edge)) { discard; }');
  assert.ok(early > wgsl.indexOf('let ad = textureSample(uTexture, uSampler, uvd).a * in.vColor.a;'), 'after the alpha');
  assert.ok(early < wgsl.indexOf('twinTexel(uvd, in.vMapsWin)'), 'before the twin page (E-496: through its window)');
  assert.match(wgsl, /fn mainFrag\(in: VertexOut\) -> WeedDepthOut \{[^}]*weedPixelDepth\(in, false\)/);
  assert.match(wgsl, /fn mainFragEdge\(in: VertexOut\) -> WeedDepthOut \{[^}]*weedPixelDepth\(in, true\)/);
  // The colour's textureSample still comes first, in uniform control flow.
  assert.match(wgsl, /o\.color = mainFragColor\(in\);\n  let d = weedPixelDepth\(in, true\);/);
});

// E-378: with a nearest atlas (no mipmaps) a plain frame's texel alphas are 0 or 128/255 and up, so at a tint alpha of 1
// every pixel is the opaque pass's or nothing: the edge pass leaves those instances out in the vertex, before any pixel.
// Under 1, a texel of 128 to 254 (FRAME_HALF) falls under 0.5 and is the edge pass's: those instances stay.
test('the edge pass leaves out a plain frame\'s instance at a tint alpha of 1 when the atlas is nearest', () => {
  const cull = 'if (vPlain > 0.5 && instA * uColor.a >= 1.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);';
  for (const name of ['instancedSprite.vert.glsl', 'instancedSpritePose.vert.glsl']) {
    for (const gbuf of [false, true]) {
      for (const faces of [false, true]) {
        const plain = pixelDepthVertex(shader(name), { gbuf, faces });
        assert.ok(!plain.includes(cull), `${name}: none without the option`);
        const edge = pixelDepthVertex(shader(name), { gbuf, faces, plainEdge: true });
        const at = edge.indexOf(cull);
        assert.ok(at > 0, `${name}, gbuf ${gbuf}, faces ${faces}: the cull`);
        // After vPlain is known (and, with words, after an unshaded word clears it), so a glowing instance is drawn.
        assert.ok(at > edge.lastIndexOf('vPlain = '), 'after vPlain is final');
      }
    }
  }
  assert.throws(() => pixelDepthVertex('out vec2 vTileOff;\nvoid main() {\n  gl_Position = vec4(clip.xy, aInstDepth, 1.0);\n}\n',
    { plainEdge: true }), /instA and uColor/);
});

// DX-FACEDEPTH: a face's plane depth from its vertices (linear on the screen), its innerZ in the painter's 7 bits, no
// floor() of the floor place; the opaque pass in two programs, the frames with heights writing gl_FragDepth and every other
// instance the depth its vertices wrote (E-378), in both languages. Without faces, the programs are as they were.
test('faces: the plane depth comes from the vertex, innerZ breaks ties, and only frames with heights write their depth', async () => {
  const { FACE_INNER_Z_TIE } = await import('../../src/render/pixelDepth.js');
  const { encodeFaceHeight, encodeFaceNormal } = await import('../../src/render/faceMap.js');
  const vert = shader('instancedSprite.vert.glsl');
  const frag = shader('instancedSprite.frag.glsl');
  for (const gbuf of [false, true]) {
    assert.equal(pixelDepthVertex(vert, { gbuf }), pixelDepthVertex(vert, { gbuf, faces: false, cull: 'heights' }), 'no faces: no cull');
    assert.doesNotMatch(pixelDepthVertex(vert, { gbuf }), /vDepthFloor|dfCode/);
    const v = pixelDepthVertex(vert, { gbuf, faces: true, cull: 'flat' });
    assert.match(v, /out float vDepthFloor;/);
    // N-271: innerZ brings a face nearer by FACE_INNER_Z_TIE floor px a step; its painter step is 0.
    assert.match(v, /depthFloor = \(world\.y \+ uDepth\.y \* dfZ\) \* uDepth\.x \+ dfInner \* 0\.2500;\n\s*depthPainter = 0\.0;/);
    assert.match(v, /if \(!twinHeights\(vMapsWin\)\) gl_Position = vec4\(2\.0, 2\.0, 2\.0, 1\.0\);/);
    const vd = pixelDepthVertex(vert, { gbuf, faces: true, cull: 'heights' });
    assert.match(vd, /gl_Position\.z = \(/);
    assert.doesNotMatch(vd, /floor\(u \*/, 'continuous');
    const f = pixelDepthFragment(frag, { gbuf, faces: true });
    assert.match(f, /in float vDepthFloor;/);
    assert.match(f, /float floorY = vDepthFloor;/);
    assert.doesNotMatch(f, /floor\(u \*/, 'no floor() of the floor place with faces');
    assert.match(pixelDepthFragment(frag, { gbuf }), /floor\(u \*/, 'without faces, as it was');
    const fd = pixelDepthFragment(frag, { gbuf, vertexDepth: true });
    assert.doesNotMatch(fd, /gl_FragDepth/, 'the vertex-depth program keeps early depth');
    assert.match(fd, /if \(ad < 0\.5 \|\| glow\) discard;/);
  }
  for (const name of ['instancedSprite.wgsl', 'instancedSpritePose.wgsl']) {
    const w = pixelDepthWgsl(shader(name), { gbuf: true, faces: true, cull: 'flat' });
    assert.match(w, /@location\(6\) vDepthFloor: f32,/, name);
    assert.match(w, /depthFloor = \(world\.y \+ uniforms\.uDepth\.y \* dfZ\) \* uniforms\.uDepth\.x \+ dfInner \* 0\.2500;/, name);
    assert.match(w, /fn mainFragEdge\(in: VertexOut\) -> WeedDepthOut/, name);
    const wd = pixelDepthWgsl(shader(name), { gbuf: true, faces: true, cull: 'heights' });
    assert.match(wd, /out\.position\.z = /, name);
    assert.match(wd, /fn mainFrag\(in: VertexOut\) -> @location\(0\) vec4<f32> \{\n  let c = mainFragColor\(in\);\n  if \(!weedVertexDepthKeep\(in\)\) \{ discard; \}/, name);
    assert.doesNotMatch(wd, /fn mainFragEdge/, name);
    const out = w.slice(w.indexOf('struct VertexOut {'), w.indexOf('}', w.indexOf('struct VertexOut {')));
    const locs = [...out.matchAll(/@location\((\d+)\)/g)].map((m) => +m[1]);
    assert.ok(Math.max(...locs) <= 15 && new Set(locs).size === locs.length, `${name}: within 16 outputs, each its own`);
  }
  // The values (N-271): a face's floor place is its plane's plus innerZ · FACE_INNER_Z_TIE. In a view whose depth spans
  // 3300 floor px (zoom 1.2, 720 px: pixelDepthTerms' view / floorScaleY + 2048), a poster (innerZ 1) whose plane rounds
  // 0.07 floor px behind its wall's is in front of it, and a thing 2 floor px in front of a wall is in front of what is
  // stuck on it at innerZ 7 (1.75 floor px).
  assert.equal(FACE_INNER_Z_TIE, 0.25);
  const range = 3300;
  const face = (floorPx, innerZ) => pixelDepthValue(0, (2000 + floorPx + innerZ * FACE_INNER_Z_TIE) / range, 0, true);
  assert.ok(face(-0.07, 1) < face(0, 0), 'the poster is nearer than its wall');
  assert.ok(face(0, 7) > face(2, 0), 'a thing 2 floor px in front of the wall is nearer than its trim');
  // The row carries innerZ in its height's top bits; the normal is any face's.
  assert.equal(encodeFaceHeight(10, 2) >>> 21, 2);
  assert.ok(encodeFaceNormal(0, 1, 0) > 0);
});

/** The source without its comments, which may hold a lone parenthesis ("1)") that the compiler never reads. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function assertBalanced(source, label) {
  const body = code(source);
  for (const [open, close] of [['(', ')'], ['{', '}'], ['[', ']']]) {
    let depth = 0;
    for (const ch of body) {
      if (ch === open) depth++;
      else if (ch === close && --depth < 0) break;
    }
    assert.equal(depth, 0, `${label}: unbalanced ${open}${close}`);
  }
}

test('every depth variant the batch builds is balanced, in both languages (an unbalanced formula drew no entity)', () => {
  const bools = [false, true];
  for (const vert of ['instancedSprite.vert.glsl', 'instancedSpritePose.vert.glsl']) {
    for (const gbuf of bools) {
      for (const faces of bools) {
        for (const cull of faces ? ['none', 'flat', 'heights'] : ['none']) {
          assertBalanced(pixelDepthVertex(shader(vert), { gbuf, faces, cull }), `${vert} gbuf ${gbuf} faces ${faces} cull ${cull}`);
        }
      }
    }
  }
  for (const frag of ['instancedSprite.frag.glsl']) {
    for (const gbuf of bools) {
      for (const edge of bools) {
        for (const faces of bools) {
          assertBalanced(pixelDepthFragment(shader(frag), { edge, gbuf, faces }), `${frag} edge ${edge} gbuf ${gbuf} faces ${faces}`);
        }
      }
      assertBalanced(pixelDepthFragment(shader(frag), { gbuf, vertexDepth: true }), `${frag} gbuf ${gbuf} vertexDepth`);
    }
  }
  const plain = shader('instancedSprite.wgsl');
  for (const [name, source, poseAlphas] of [['instancedSprite.wgsl', plain, [false]], ['indexed', spriteIndexedWgsl(plain), bools]]) {
    for (const poseAlpha of poseAlphas) {
      for (const gbuf of bools) {
        for (const faces of bools) {
          for (const cull of ['none', 'flat', 'heights']) {
            assertBalanced(pixelDepthWgsl(source, { poseAlpha, gbuf, faces, cull }), `${name} poseAlpha ${poseAlpha} gbuf ${gbuf} faces ${faces} cull ${cull}`);
          }
        }
      }
    }
  }
});

// E-378 on WebGPU: one vertex entry serves every entry of a module, so the edge program gets a module of its own whose
// vertex leaves out a plain frame's instance at a tint alpha of 1 (the GLSL cull's twin).
test("the WebGPU edge module leaves out a plain frame's instance at a tint alpha of 1 when the atlas is nearest", () => {
  const cull = 'if (out.vPlain > 0.5 && instA * localUniforms.uColor.a >= 1.0) { out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0); }';
  const plain = shader('instancedSprite.wgsl');
  const sources = [['instancedSprite.wgsl', plain], ['instancedSpritePose.wgsl', shader('instancedSpritePose.wgsl')], ['indexed', spriteIndexedWgsl(plain)]];
  for (const [name, source] of sources) {
    for (const gbuf of [false, true]) {
      for (const faces of [false, true]) {
        assert.ok(!pixelDepthWgsl(source, { gbuf, faces }).includes(cull), `${name}: none without the option`);
        const edge = pixelDepthWgsl(source, { gbuf, faces, plainEdge: true });
        const at = edge.indexOf(cull);
        assert.ok(at > 0, `${name}, gbuf ${gbuf}, faces ${faces}: the cull`);
        assert.ok(at > edge.lastIndexOf('out.vPlain = '), 'after vPlain is final');
        assert.ok(at < edge.indexOf('@fragment'), 'in the vertex entry');
      }
    }
  }
  assert.throws(() => pixelDepthWgsl(plain.split('let instA = ').join('let instAlpha = '), { plainEdge: true }), /instA and uColor/);
});
