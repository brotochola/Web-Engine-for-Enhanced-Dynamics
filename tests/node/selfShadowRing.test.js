// N-272: WebGL's self-shadow march samples the face map with clamp-to-edge, so its steps past the screen read the edge's
// texel (the wall standing there) and shaded pixels near the edge. The face map is drawn a texel inside its edges instead,
// so its edge ring stays empty and those steps read nothing; the march itself stays as it was (any code added to it cost an
// Intel HD 620 about 4.5 % of its drawn frames), and a pixel on the screen's edge reads its neighbour inside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { lightingSource } from '../../src/render/faceMap.js';

const read = (path) => fs.readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('N-272: the light pass reads a pixel\'s own face and id a texel inside the edge ring, GLSL and WGSL', () => {
  const flags = { faces: true, sunMap: true, selfShadow: true, ids: true };
  const glsl = lightingSource(read('src/shaders/lightingBasic.frag.glsl'), flags);
  assert.ok(glsl.includes('vec2 faceAt = clamp(gl_FragCoord.xy, vec2(1.5), uViewport - 1.5) / uViewport;'));
  assert.ok(glsl.includes('textureLod(uFaceMap, faceAt, 0.0)') && glsl.includes('textureLod(uFaceIds, faceAt, 0.0)'));
  assert.ok(!glsl.includes('gl_FragCoord.xy / uViewport'), 'no unclamped read of the face map is left');
  const wgsl = lightingSource(read('src/shaders/lightingBasic.wgsl'), flags);
  assert.ok(wgsl.includes('clamp(in.position.xy, vec2<f32>(1.5), vec2<f32>(textureDimensions(uFaceMap, 0)) - 1.5)'));
  assert.ok(wgsl.includes('textureLoad(uFaceMap, faceAt, 0)') && wgsl.includes('textureLoad(uFaceIds, faceAt, 0)'));
  assert.ok(!wgsl.includes('vec2<i32>(in.position.xy)'), 'no unclamped read of the face map is left');
});

test('N-272: the self-shadow march has no edge code of its own (the ring does it)', () => {
  const glsl = read('src/shaders/lightingBasic.frag.glsl');
  const march = glsl.slice(glsl.indexOf('float selfShadowToward('), glsl.indexOf('float selfShadow(vec3'));
  assert.ok(march.includes('if (t >= reach) break;'));
  assert.ok(!/mapExit|tEnd|fc0/.test(march), 'the loop as before N-272');
});

test('N-272: the face map pass draws inside a frame a texel in from each edge, its transform a texel back', () => {
  const src = read('src/workers/pixiWorker.js');
  const create = src.slice(src.indexOf('  _createFaceMap('), src.indexOf('  _createFaceMap(') + 900);
  assert.ok(create.includes('this._faceRtFrame.width = Math.max(1, this.faceRT.width - 2);'));
  assert.ok(create.includes('this._faceRtFrame.height = Math.max(1, this.faceRT.height - 2);'));
  assert.ok(src.includes('this._faceRtFrame = new PIXI.Rectangle(1, 1, 1, 1);'));
  const pass = src.slice(src.indexOf('  _renderFaceMap() {'), src.indexOf('  _ensureGbufTarget() {'));
  assert.ok(/mx\.tx -= 1;\s+mx\.ty -= 1;/.test(pass), 'the transform moved a texel');
  assert.ok(pass.includes('opts.frame = this._faceRtFrame;'));
  // Both ways out of the pass hand the shared options back without the frame.
  assert.equal(pass.split('opts.frame = null;').length - 1, 2);
});
