// E-455 step 3: an indexed sprite program that reads the G-buffer words takes a statics frame's word from the slot's
// statics row (spriteIndexed.js gbufWordFromStaticsGlsl / Wgsl, applied by glProgramFrom and
// instancedSpriteIndexedGpuProgram): every read of the word goes through weedGbufWord, set from the instance's word or,
// where the instance carries GBUF_STATICS_MARK, from the statics row's last lane; the band and the foot stay the
// instance's. A shader that is not indexed, or reads no words, is left as it is; a second pass changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readEngineShader } from './engineShaderSources.mjs';
import {
  GBUF_STATICS_MARK, gbufWordFromStaticsGlsl, gbufWordFromStaticsWgsl, spriteIndexedVertex, spriteIndexedWgsl,
} from '../../src/render/spriteIndexed.js';
import { faceMapVertex, faceMapWgsl, gbufAttributeGlsl, gbufAttributeWgsl } from '../../src/render/faceMap.js';
import { pixelDepthVertex } from '../../src/render/pixelDepth.js';

const spriteVert = readEngineShader('instancedSprite.vert.glsl');
const spriteWgsl = readEngineShader('instancedSprite.wgsl');

/** The reads of the word left on the instance's own stream: only weedGbufWord's own line may read aInstGbuf.x. */
function wordReadsOutside(source, assignment) {
  return source.split('\n').filter((l) => /aInstGbuf\.x(?![a-z])/.test(l) && !l.includes(assignment)).length;
}

test('E-455 step 3: the indexed GLSL programs read the word through weedGbufWord, the plain ones are left alone', () => {
  const cases = [
    ['the G-buffer pass (face map, indexed)', spriteIndexedVertex(faceMapVertex(spriteVert, { gbuf: true }))],
    ['a colour program with pixel depth (indexed first)', pixelDepthVertex(spriteIndexedVertex(spriteVert), { gbuf: true, faces: false, cull: 'none' })],
    ['a colour program taking the words (indexed first)', gbufAttributeGlsl(spriteIndexedVertex(spriteVert))],
  ];
  for (const [label, source] of cases) {
    assert.ok(source.includes('in vec3 aInstGbuf;'), `${label}: reads the words`);
    const out = gbufWordFromStaticsGlsl(source);
    assert.match(out, /weedGbufWord = aInstGbuf\.x < -1\.5 \? uintBitsToFloat\(weedS2\.w\) : aInstGbuf\.x;/, `${label}: the word set`);
    assert.equal(wordReadsOutside(out, 'weedGbufWord ='), 0, `${label}: every other read goes through weedGbufWord`);
    assert.ok(out.indexOf('weedGbufWord =') > out.indexOf('uvec4 weedS2 ='), `${label}: set after the statics are fetched`);
    assert.equal(gbufWordFromStaticsGlsl(out), out, `${label}: a second pass changes nothing`);
  }
  // Not indexed, or no words: as it is.
  const plain = faceMapVertex(spriteVert, { gbuf: true });
  assert.equal(gbufWordFromStaticsGlsl(plain), plain, 'a plain instanced program');
  const noWords = spriteIndexedVertex(spriteVert);
  assert.equal(gbufWordFromStaticsGlsl(noWords), noWords, 'an indexed program without words');
  assert.equal(GBUF_STATICS_MARK + 0.5, -1.5, 'the mark under every word (an id + 1 and flags, never negative)');
});

test('E-455 step 3: the indexed WGSL programs read the word through weedGbufWord, the plain ones are left alone', () => {
  for (const [label, source] of [
    ['the G-buffer pass (face map, indexed)', spriteIndexedWgsl(faceMapWgsl(spriteWgsl, { gbuf: true }))],
    ['a colour program taking the words', spriteIndexedWgsl(gbufAttributeWgsl(spriteWgsl))],
  ]) {
    assert.ok(source.includes('aInstGbuf: vec3<f32>'), `${label}: reads the words`);
    const out = gbufWordFromStaticsWgsl(source);
    assert.match(out, /let weedGbufWord = select\(aInstGbuf\.x, bitcast<f32>\(weedS2\.w\), aInstGbuf\.x < -1\.5\);/, `${label}: the word set`);
    assert.equal(wordReadsOutside(out, 'let weedGbufWord'), 0, `${label}: every other read goes through weedGbufWord`);
    assert.equal(gbufWordFromStaticsWgsl(out), out, `${label}: a second pass changes nothing`);
  }
  const plain = faceMapWgsl(spriteWgsl, { gbuf: true });
  assert.equal(gbufWordFromStaticsWgsl(plain), plain, 'a plain instanced program');
});
