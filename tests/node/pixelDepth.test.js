/** DX-DEPTH (F5 v2): the depth the entities' pixels write and test (src/render/pixelDepth.js), on the real code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  PIXEL_DEPTH_MARGIN,
  pixelDepthFragment,
  pixelDepthTerms,
  pixelDepthValue,
  pixelDepthVertex,
  pixelDepthWgsl,
} from '../../src/render/pixelDepth.js';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');

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
  const frag = shader('instancedSpriteBlend.frag.glsl');
  assert.match(pixelDepthFragment(frag), /if \(!solid\) discard;/);
  assert.match(pixelDepthFragment(frag, { edge: true }), /if \(solid\) discard;/);
  assert.match(pixelDepthFragment(frag, { gbuf: true }), /flat in vec2 vDepthWord;/);
  const vert = pixelDepthVertex(shader('instancedSprite.vert.glsl'), { gbuf: true });
  assert.match(vert, /vPainter = vec2\(float\(gl_InstanceID & 127\), abs\(aInstScale\.y\)\);/);
  assert.match(vert, /in vec2 aInstGbuf;/);
  const wgsl = pixelDepthWgsl(shader('instancedSprite.wgsl'));
  assert.match(wgsl, /fn mainFrag\(in: VertexOut\) -> WeedDepthOut/);
  assert.match(wgsl, /fn mainFragEdge\(in: VertexOut\) -> WeedDepthOut/);
  assert.match(wgsl, /@builtin\(instance_index\) weedInstance: u32,/);
});

test('H-EDGE: each pass leaves before the twin page and the depth for the pixels it draws nothing for, in both languages', () => {
  const frag = shader('instancedSpriteBlend.frag.glsl');
  // The opaque pass keeps no pixel under alpha 0.5; the edge pass draws one of alpha 0 as nothing (premultiplied 0, no
  // depth written), so neither needs the twin page's texel or the depth for them.
  for (const [edge, early] of [[false, 'if (ad < 0.5) discard;'], [true, 'if (ad <= 0.0) discard;']]) {
    for (const gbuf of [false, true]) {
      const src = pixelDepthFragment(frag, { edge, gbuf });
      const at = src.indexOf(early);
      assert.ok(at > 0, `edge ${edge}, gbuf ${gbuf}: ${early}`);
      assert.ok(at > src.indexOf('float ad = texture(uTexture, uvd).a * vColor.a;'), 'after the alpha');
      assert.ok(at < src.indexOf('texelFetch(uMaps'), 'before the twin page');
      assert.ok(at < src.indexOf('gl_FragDepth ='), 'before the depth');
      assert.match(src, /bool solid = ad >= 0\.5 && !glow;/, 'the pass keeps its pixels as before');
      assert.equal(src.split('texture(uTexture, uvd)').length, 2, 'the alpha read once in the depth body');
    }
  }
  const wgsl = pixelDepthWgsl(shader('instancedSprite.wgsl'), { gbuf: true });
  const early = wgsl.indexOf('if (select(ad < 0.5, ad <= 0.0, edge)) { discard; }');
  assert.ok(early > wgsl.indexOf('let ad = textureSample(uTexture, uSampler, uvd).a * in.vColor.a;'), 'after the alpha');
  assert.ok(early < wgsl.indexOf('textureLoad(uMaps'), 'before the twin page');
  assert.match(wgsl, /fn mainFrag\(in: VertexOut\) -> WeedDepthOut \{[^}]*weedPixelDepth\(in, false\)/);
  assert.match(wgsl, /fn mainFragEdge\(in: VertexOut\) -> WeedDepthOut \{[^}]*weedPixelDepth\(in, true\)/);
  // The colour's textureSample still comes first, in uniform control flow.
  assert.match(wgsl, /o\.color = mainFragColor\(in\);\n  let d = weedPixelDepth\(in, true\);/);
});
