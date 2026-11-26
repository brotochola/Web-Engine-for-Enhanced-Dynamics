import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyMipmapBias, mipmapBiasSource } from '../../src/render/mipmapBias.js';

const SHADERS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const read = (name) => fs.readFileSync(path.join(SHADERS, name), 'utf8');

test('E-204: every atlas colour read of the engine shaders gets the mip bias, GLSL and WGSL', () => {
  const shaders = {
    spriteFrag: read('instancedSprite.frag.glsl'),
    sprite: read('instancedSprite.wgsl'),
    shadow: read('instancedSpriteShadow.wgsl'),
    colliderFillFrag: read('colliderFill.frag.glsl'),
    colliderFill: read('colliderFill.wgsl'),
    meshUvFillFrag: read('meshUvFill.frag.glsl'),
    meshUvFill: read('meshUvFill.wgsl'),
    spriteVert: read('instancedSprite.vert.glsl'),
    notASource: 3,
  };
  const vert = shaders.spriteVert;
  applyMipmapBias(shaders, -1);
  assert.match(shaders.spriteFrag, /texture\(uTexture, weedUv\(\), -1\.000\)/);
  for (const key of ['sprite', 'shadow', 'colliderFill', 'meshUvFill']) {
    assert.match(shaders[key], /textureSampleBias\(uTexture, uSampler, (weedUv|meshUv)\([^()]*\), -1\.000\)/, key);
    assert.doesNotMatch(shaders[key], /textureSample\(uTexture, uSampler, (weedUv|meshUv)/, key);
  }
  for (const key of ['spriteFrag', 'colliderFillFrag', 'meshUvFillFrag']) {
    assert.doesNotMatch(shaders[key], /texture\(uTexture, weedUv\(\)\)/, key);
  }
  assert.equal(shaders.spriteVert, vert);
  assert.equal(shaders.notASource, 3);
});

test('E-204: a bias of 0 leaves the shaders as they are', () => {
  const shaders = { spriteFrag: read('instancedSprite.frag.glsl') };
  const before = shaders.spriteFrag;
  applyMipmapBias(shaders, 0);
  assert.equal(shaders.spriteFrag, before);
  assert.equal(mipmapBiasSource('vec4 t = texture(uTexture, weedUv());', -0.5), 'vec4 t = texture(uTexture, weedUv(), -0.500);');
});
