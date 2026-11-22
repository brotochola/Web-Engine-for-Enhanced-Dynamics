import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PIXI_GROUPS_WGSL, WEED_UV_GLSL, WEED_UV_WGSL, withShaderChunks } from '../../src/render/shaderChunks.js';
import { RENDER_TILES_WGSL, RENDER_VIEW_WGSL } from '../../src/render/renderViews.js';
import { UNSHADED_COMPOSITE_WGSL } from '../../src/render/unshadedComposite.js';
import { LAMP_CACHE_COPY_WGSL } from '../../src/render/volumeShadowMap.js';
import { LIGHT_EDGES_KINDS, lightEdgesWgsl } from '../../src/render/lightEdges.js';
import { buildLookPrelude, buildWorldRectWgsl } from '../../src/render/webgpu/wgslPrelude.js';
import { readEngineShader } from './engineShaderSources.mjs';

// N-303 CR-15: the Pixi groups header and weedUv are written once, in shaderChunks.js. A shader file includes them by
// name; the JS-written programs take the constants. When the copies went, every file resolved to its old text byte for
// byte, and so did every JS-written program.

const SHADER_DIR = new URL('../../src/shaders/', import.meta.url);
const FILES = fs.readdirSync(SHADER_DIR).sort();
const raw = (name) => fs.readFileSync(new URL(name, SHADER_DIR), 'utf8');

test('every include of the engine shaders resolves, and no file keeps a copy of a chunk', () => {
  let included = 0;
  for (const name of FILES) {
    const text = raw(name);
    included += (text.match(/^\/\/ #include /gm) || []).length;
    assert.doesNotMatch(withShaderChunks(text), /\/\/ #include /, name);
    for (const chunk of [PIXI_GROUPS_WGSL, WEED_UV_GLSL, WEED_UV_WGSL]) assert.ok(!text.includes(chunk), `${name} copies a chunk`);
  }
  assert.ok(included >= 16, `${included} includes`);
});

test('a WGSL mesh program gets the groups header, a sprite fragment weedUv, from the include', () => {
  for (const name of ['instancedSprite.wgsl', 'instancedSpriteShadow.wgsl', 'colliderFill.wgsl', 'meshUvFill.wgsl', 'lightingBasic.wgsl']) {
    assert.ok(readEngineShader(name).startsWith(`${PIXI_GROUPS_WGSL}\n`), name);
  }
  assert.ok(readEngineShader('instancedSprite.wgsl').includes(`${WEED_UV_WGSL}\n`));
  for (const name of ['instancedSprite.frag.glsl', 'colliderFill.frag.glsl', 'faceMap.frag.glsl']) {
    assert.ok(readEngineShader(name).includes(`${WEED_UV_GLSL}\n`), name);
  }
});

test('the JS-written WGSL programs start with the same groups header', () => {
  const programs = [RENDER_VIEW_WGSL, RENDER_TILES_WGSL, UNSHADED_COMPOSITE_WGSL, LAMP_CACHE_COPY_WGSL,
    ...LIGHT_EDGES_KINDS.map((kind) => lightEdgesWgsl(kind)), buildLookPrelude(null, null), buildWorldRectWgsl('', null, null, [])];
  for (const program of programs) assert.ok(program.startsWith(`${PIXI_GROUPS_WGSL}\n`));
});

test('a source without includes comes back as it is; an unknown chunk throws a WeedJS error', () => {
  const plain = '@vertex fn main() {}\n// #included is not an include\n';
  assert.equal(withShaderChunks(plain), plain);
  assert.equal(withShaderChunks('a\n// #include weedUv.glsl\nb\n'), `a\n${WEED_UV_GLSL}\nb\n`);
  assert.throws(() => withShaderChunks('// #include nothing.wgsl\n'), /WeedJS: a shader includes "nothing\.wgsl", which is not an engine chunk/);
});
